// File: controllers/gl/glEntriesController.js

// --- Helper: Update Accumulators (Post/Reverse) ---
const updateBalanceAccum = async (client, headerId, isReverse = false) => {
    // ดึง Detail ทั้งหมด
    const detailsRes = await client.query(`SELECT * FROM gl_entry_detail WHERE header_id = $1`, [headerId]);
    const headerRes = await client.query(`SELECT * FROM gl_entry_header WHERE id = $1`, [headerId]);
    const header = headerRes.rows[0];
    const details = detailsRes.rows;

    const multiplier = isReverse ? -1 : 1; // ถ้า Reverse ให้ลดยอด

    for (const row of details) {
        // Upsert Logic (PostgreSQL 9.5+)
        const sql = `
            INSERT INTO gl_balance_accum 
            (period_id, account_id, branch_id, project_id, business_unit_id, currency_id, debit_amount, credit_amount, end_balance, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (period_id, account_id, branch_id, project_id, business_unit_id, currency_id)
            DO UPDATE SET 
                debit_amount = gl_balance_accum.debit_amount + EXCLUDED.debit_amount,
                credit_amount = gl_balance_accum.credit_amount + EXCLUDED.credit_amount,
                end_balance = gl_balance_accum.end_balance + (EXCLUDED.debit_amount - EXCLUDED.credit_amount),
                updated_at = NOW()
        `;

        // คำนวณยอดที่จะบวก/ลบ
        const debit = (Number(row.debit_lc) || 0) * multiplier;
        const credit = (Number(row.credit_lc) || 0) * multiplier;
        const netChange = debit - credit; // สินทรัพย์/ค่าใช้จ่าย เพิ่มทางเดบิต

        // Branch/Project/CostCenter อาจเป็น NULL ให้ใส่ค่าที่เหมาะสมหรือ NULL (ตาม Constraint)
        // หมายเหตุ: Constraint UNIQUE ต้องระวังเรื่อง NULL ใน PostgreSQL (NULL != NULL)
        // แนะนำให้ใช้ COALESCE หรือ Index ที่รองรับ NULL หรือใช้ ID 0 แทน 'ไม่ระบุ'
        // ในที่นี้สมมติว่าถ้าไม่ระบุให้เป็น NULL และ Unique constraint รองรับ (Postgres 15+ NULLs NOT DISTINCT) 
        // หรือใช้วิธี Check ก่อน Insert
        
        await client.query(sql, [
            // header.period_id, row.account_id, 
            // row.branch_id, row.project_id, row.business_unit_id, // business_unit map to business_unit
            // header.currency_id,
            // debit, credit, netChange
            header.period_id, 
            row.account_id, 
            row.branch_id || 0, 
            row.project_id || 0, 
            row.business_unit_id || 0, 
            header.currency_id || 1,
            debit, credit, netChange
        ]);
    }
};

// --- Helper: Generate Document Number ---
const generateDocNo = async (client, docId, date) => {
    // 1. ดึง Setting การรันเลขที่
    const docConfigRes = await client.query(
        `SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]
    );
    const config = docConfigRes.rows[0];

    if (!config.is_auto_numbering) return null; // ถ้าระบุเอง

    // 2. สร้าง Format (Prefix + Date + Running)
    let docNo = config.format_prefix || '';
    
    if (config.format_suffix_date) {
        const d = new Date(date);
        const year = d.getFullYear().toString(); // หรือปี พ.ศ. ตาม Logic องค์กร
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const day = d.getDate().toString().padStart(2, '0');
        
        if (config.format_suffix_date === 'YY') docNo += year.substring(2);
        else if (config.format_suffix_date === 'YYYY') docNo += year;
        else if (config.format_suffix_date === 'YYMM') docNo += year.substring(2) + month;
        else if (config.format_suffix_date === 'YYYYMM') docNo += year + month;
        else if (config.format_suffix_date === 'YYYYMMDD') docNo += year + month + day;
    }

    if (config.format_separator) docNo += config.format_separator;

    const running = config.next_running_number.toString().padStart(config.running_length, '0');
    docNo += running;

    // 3. Update Next Number
    await client.query(
        `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
        [docId]
    );

    return docNo;
};

// CRUD actions
// --- 1. Create Transaction (Draft/Post) ---
const createTransaction = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const { header, details, action } = req.body; // action: 'Draft' | 'Post'

        // --- 1. หา Period ID จาก Posting Date (เพิ่มส่วนนี้) ---
        // สมมติว่าตารางชื่อ gl_posting_period และมี field: id, start_date, end_date, status
        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period 
             WHERE $1::date BETWEEN period_start_date AND period_end_date 
             AND gl_status = 'OPEN' LIMIT 1`,
            // [header.posting_date]
            [header.doc_date]
        );

        if (periodRes.rows.length === 0) {
            // throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.posting_date}`);
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        }
        const periodId = periodRes.rows[0].id;
        // -----------------------------------------------------

        // A. Validate Doc No
        let finalDocNo = header.doc_no;
        if (!finalDocNo || finalDocNo === 'AUTO') {
            finalDocNo = await generateDocNo(client, header.doc_id, header.doc_date);
            if (!finalDocNo) throw new Error('Auto numbering failed or manual doc no required');
        }

        // B. Insert Header
        const headerSql = `
            INSERT INTO gl_entry_header 
            (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description, 
             currency_id, exchange_rate, status, 
             total_debit_lc, total_credit_lc, 
             total_debit_fc, total_credit_fc,
             created_by,
             ref_doc_id, ref_doc_no, ref_doc_date, external_source_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 
            $16, $17, $18, $19)
            RETURNING id
        `;
        const status = action === 'Post' ? 'Posted' : 'Draft';
        const headerRes = await client.query(headerSql, [
            header.doc_id, finalDocNo, header.doc_date, header.posting_date, 
            periodId, //header.period_id, 
            header.ref_no, header.description, 
            header.currency_id, header.exchange_rate, status, 
            header.total_debit_lc, header.total_credit_lc, // $11, $12
            header.total_debit_fc, header.total_credit_fc, // $13, $14            
            header.created_by,
            header.ref_doc_id || null,  // $16
            header.ref_doc_no || null,  // $17
            header.ref_doc_date || null,// $18
            header.external_source_id || null // $19
        ]);
        const newHeaderId = headerRes.rows[0].id;

        // C. Insert Details
        const detailSql = `
            INSERT INTO gl_entry_detail 
            (header_id, line_no, account_id, description, 
             debit_lc, credit_lc, debit_fc, credit_fc,
             branch_id, project_id, business_unit_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `;
        let lineNo = 1;
        for (const row of details) {
            await client.query(detailSql, [
                newHeaderId, lineNo++, row.account_id, row.description,
                row.debit_lc, row.credit_lc, row.debit_fc, row.credit_fc, // $5-$8
                row.branch_id, row.project_id, row.business_unit_id
            ]);
        }

        // D. Update Accumulators if Post
        if (action === 'Post') {
            await updateBalanceAccum(client, newHeaderId, false);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'Success', id: newHeaderId, doc_no: finalDocNo });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- 2. Update Transaction (Only Draft) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, details, action } = req.body;
    const client = await req.dbPool.connect();
    
    try {
        await client.query('BEGIN');
        
        // --- 1. หา Period ID ใหม่ (เพิ่มส่วนนี้) ---
        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period 
             WHERE $1::date BETWEEN period_start_date AND period_end_date 
             AND gl_status = 'OPEN' LIMIT 1`,
            // [header.posting_date]
            [header.doc_date]
        );

        if (periodRes.rows.length === 0) {
            // throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.posting_date}`);
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        }
        const periodId = periodRes.rows[0].id;
        // ------------------------------------------

        // Check Status
        const checkRes = await client.query('SELECT status FROM gl_entry_header WHERE id = $1', [id]);
        if (checkRes.rows[0].status !== 'Draft') throw new Error('Only Draft can be edited');

        // Update Header
        const status = action === 'Post' ? 'Posted' : 'Draft';
        await client.query(`
            UPDATE gl_entry_header SET 
            doc_date=$1, posting_date=$2, period_id=$3, 
            ref_no=$4, description=$5, 
            status=$6, 
            total_debit_lc=$7, total_credit_lc=$8, 
            total_debit_fc=$9, total_credit_fc=$10,
            currency_id=$11, exchange_rate=$12, 
            updated_at=NOW(),
            ref_doc_id=$13, ref_doc_no=$14, ref_doc_date=$15
            WHERE id=$16
        `, [header.doc_date, header.posting_date, periodId, 
            header.ref_no, header.description, 
            status, 
            header.total_debit_lc, header.total_credit_lc, 
            header.total_debit_fc, header.total_credit_fc,
            header.currency_id, header.exchange_rate,
            header.ref_doc_id || null, header.ref_doc_no || null, header.ref_doc_date || null,
            id]);

        // Delete Old Details & Insert New
        await client.query('DELETE FROM gl_entry_detail WHERE header_id=$1', [id]);
        
        const detailSql = `
            INSERT INTO gl_entry_detail 
            (header_id, line_no, account_id, description, 
             debit_lc, credit_lc, debit_fc, credit_fc,
             branch_id, project_id, business_unit_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `;
        let lineNo = 1;
        for (const row of details) {
            await client.query(detailSql, [
                id, lineNo++, row.account_id, row.description,
                row.debit_lc, row.credit_lc, row.debit_fc, row.credit_fc, // $5-$8
                row.branch_id, row.project_id, row.business_unit_id
            ]);
        }

        // Update Accumulators if Post
        if (action === 'Post') {
            await updateBalanceAccum(client, id, false);
        }

        await client.query('COMMIT');
        res.json({ message: 'Updated' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- 3. Soft Delete (Change Status) ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            `UPDATE gl_entry_header SET status = 'Deleted' WHERE id = $1 AND status = 'Draft' RETURNING id`, 
            [id]
        );
        if (result.rowCount === 0) return res.status(400).json({ error: 'Cannot delete: Not found or not Draft' });
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 4. Reverse Transaction ---
const reverseTransaction = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // Check Status
        const checkRes = await client.query('SELECT status FROM gl_entry_header WHERE id = $1', [id]);
        if (checkRes.rows[0].status !== 'Posted') throw new Error('Only Posted can be reversed');

        // Reverse Accumulators
        await updateBalanceAccum(client, id, true); // true = reverse

        // Update Status back to Draft
        await client.query(`UPDATE gl_entry_header SET status = 'Draft' WHERE id = $1`, [id]);

        await client.query('COMMIT');
        res.json({ message: 'Reversed to Draft' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- 5. Search / List ---
const getTransactions = async (req, res) => {
    const { search, status, period_id, fiscal_year_id } = req.query;
    let sql = `SELECT h.*, d.doc_code, d.doc_name_thai
               FROM gl_entry_header h
               JOIN sa_module_document d ON h.doc_id = d.id
               WHERE h.status != 'Deleted' `;
    const params = [];

    if (period_id) {
        sql += ` AND h.period_id = $${params.length + 1}`;
        params.push(period_id);
    } else if (fiscal_year_id) {
        sql += ` AND h.period_id IN (SELECT id FROM gl_posting_period WHERE fiscal_year_id = $${params.length + 1})`;
        params.push(fiscal_year_id);
    }
    if (search) {
        sql += ` AND (h.doc_no ILIKE $${params.length + 1} OR h.ref_no ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
    }
    if (status) {
        sql += ` AND h.status = $${params.length + 1}`;
        params.push(status);
    }

    // Sort: Draft First, then Doc No DESC (Latest)
    sql += ` ORDER BY CASE WHEN h.status = 'Draft' THEN 0 ELSE 1 END, h.doc_no DESC LIMIT 100`;

    try {
        const result = await req.dbPool.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 6. Get Single Transaction by ID (Header + Details) ---
const getTransactionById = async (req, res) => {
    const { id } = req.params;
    try {
        // 1. Get Header (Join กับ Document Type เพื่อดูว่าเป็น Auto Number หรือไม่)
        const headerRes = await req.dbPool.query(`
            SELECT h.*, d.doc_code, d.doc_name_thai, d.is_auto_numbering,
               ref_d.doc_code as ref_doc_code, ref_d.doc_name_thai as ref_doc_name
            FROM gl_entry_header h
            LEFT JOIN sa_module_document d ON h.doc_id = d.id
            LEFT JOIN sa_module_document ref_d ON h.ref_doc_id = ref_d.id
            WHERE h.id = $1
        `, [id]);

        if (headerRes.rows.length === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        // 2. Get Details (Join กับ Account เพื่อเอาชื่อบัญชีไปแสดง)
        // Order by line_no เพื่อให้รายการเรียงลำดับถูกต้อง
        const detailsRes = await req.dbPool.query(`
            SELECT d.*, a.account_code, a.account_name_thai, 
                   b.branch_code, b.branch_name_thai,
                   p.project_code, p.project_name_thai,
                   c.bu_code, c.bu_name_thai
            FROM gl_entry_detail d
            LEFT JOIN gl_account a ON d.account_id = a.id
            LEFT JOIN cd_branch b ON d.branch_id = b.id
            LEFT JOIN cd_project p ON d.project_id = p.id
            LEFT JOIN cd_business_unit c ON d.business_unit_id = c.id
            WHERE d.header_id = $1
            ORDER BY d.line_no ASC
        `, [id]);

        // ส่งกลับในรูปแบบที่ Frontend (Service) รอรับ คือมี key "header" และ "details"
        res.json({
            header: headerRes.rows[0],
            details: detailsRes.rows
        });

    } catch (err) {
        console.error('Error fetching transaction:', err);
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    createTransaction,
    updateTransaction,
    deleteTransaction,
    reverseTransaction,
    getTransactions,
    getTransactionById
};



// const { Pool } = require('pg');
// // const pool = require('../../config/db'); // ใช้ config DB ของคุณ

// // *** ตัวอย่าง Pool Connection ***
// const pool = new Pool({
//     user: 'your_user', host: 'localhost', database: 'your_db', password: 'your_password', port: 5432,
// });

// // --- Helper: Generate Document Number ---
// const generateDocNo = async (client, docId, date) => {
//     // 1. ดึง Setting การรันเลขที่ (Lock row for update)
//     const docConfigRes = await client.query(
//         `SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]
//     );
    
//     if (docConfigRes.rows.length === 0) return null;
//     const config = docConfigRes.rows[0];

//     if (!config.is_auto_numbering) return null; // ถ้าระบุเอง

//     // 2. สร้าง Format (Prefix + Date + Running)
//     let docNo = config.format_prefix || '';
    
//     if (config.format_suffix_date) {
//         const d = new Date(date);
//         const year = d.getFullYear().toString(); 
//         const month = (d.getMonth() + 1).toString().padStart(2, '0');
//         const day = d.getDate().toString().padStart(2, '0');
        
//         if (config.format_suffix_date === 'YYMM') docNo += year.substring(2) + month;
//         else if (config.format_suffix_date === 'YYYYMM') docNo += year + month;
//         else if (config.format_suffix_date === 'YYYYMMDD') docNo += year + month + day;
//     }

//     if (config.format_separator) docNo += config.format_separator;

//     const running = config.next_running_number.toString().padStart(config.running_length, '0');
//     docNo += running;

//     // 3. Update Next Number
//     await client.query(
//         `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
//         [docId]
//     );

//     return docNo;
// };

// // --- Helper: Update GL Balance (Post/Reverse) ---
// const updateGlBalance = async (client, headerId, isReverse = false) => {
//     // ดึงข้อมูล Header และ Detail
//     const headerRes = await client.query(`SELECT * FROM gl_entry_header WHERE id = $1`, [headerId]);
//     const detailsRes = await client.query(`SELECT * FROM gl_entry_detail WHERE header_id = $1`, [headerId]);
    
//     const header = headerRes.rows[0];
//     const details = detailsRes.rows;
//     const multiplier = isReverse ? -1 : 1;

//     for (const row of details) {
//         // คำนวณยอดที่จะกระทบยอดสะสม
//         const debit = (Number(row.debit_lc) || 0) * multiplier;
//         const credit = (Number(row.credit_lc) || 0) * multiplier;
//         const netChange = debit - credit; 

//         // Upsert Logic: ถ้ามีแถวอยู่แล้วให้อัปเดต ถ้าไม่มีให้สร้างใหม่
//         const sql = `
//             INSERT INTO gl_balance_accum 
//             (period_id, account_id, branch_id, project_id, business_unit_id, currency_id, 
//              debit_amount, credit_amount, end_balance)
//             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//             ON CONFLICT (period_id, account_id, branch_id, project_id, business_unit_id, currency_id)
//             DO UPDATE SET 
//                 debit_amount = gl_balance_accum.debit_amount + EXCLUDED.debit_amount,
//                 credit_amount = gl_balance_accum.credit_amount + EXCLUDED.credit_amount,
//                 end_balance = gl_balance_accum.end_balance + (EXCLUDED.debit_amount - EXCLUDED.credit_amount)
//         `;

//         await client.query(sql, [
//             header.period_id, row.account_id, 
//             row.branch_id, row.project_id, row.business_unit_id, // map business_unit -> business_unit
//             header.currency_id,
//             debit, credit, netChange
//         ]);
//     }
// };

// // --- API Functions ---

// // 1. Get List with Filter (Search Tab)
// exports.getEntries = async (req, res) => {
//     const { fiscal_year, period_number, search, status } = req.query;
//     const params = [];
//     let sql = `
//         SELECT h.*, d.doc_code, d.doc_name_thai 
//         FROM gl_entry_header h
//         LEFT JOIN sa_module_document d ON h.doc_id = d.id
//         LEFT JOIN gl_period p ON h.period_id = p.id
//         LEFT JOIN gl_fiscal_year fy ON p.fiscal_year_id = fy.id
//         WHERE 1=1
//     `;

//     // Filter by Fiscal Year & Period (ถ้ามีการส่งมา)
//     if (fiscal_year) {
//         params.push(fiscal_year);
//         sql += ` AND fy.fy_code = $${params.length}`;
//     }
//     if (period_number) {
//         params.push(period_number);
//         sql += ` AND p.period_number = $${params.length}`;
//     }

//     // Filter by Search Text (Doc No, Ref No, Description)
//     if (search) {
//         params.push(`%${search}%`);
//         sql += ` AND (h.doc_no ILIKE $${params.length} OR h.ref_no ILIKE $${params.length} OR h.description ILIKE $${params.length})`;
//     }

//     // Sorting: Draft First, then Latest Date
//     sql += ` ORDER BY CASE WHEN h.status = 'Draft' THEN 0 ELSE 1 END, h.doc_date DESC, h.doc_no DESC LIMIT 100`;

//     try {
//         const result = await pool.query(sql, params);
//         res.json(result.rows);
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// };

// // 2. Get Single Entry Details (For Edit/View)
// exports.getEntryById = async (req, res) => {
//     const { id } = req.params;
//     try {
//         const headerRes = await pool.query(`
//             SELECT h.*, d.doc_code, d.doc_name_thai, d.is_auto_numbering
//             FROM gl_entry_header h
//             JOIN sa_module_document d ON h.doc_id = d.id
//             WHERE h.id = $1
//         `, [id]);
        
//         if (headerRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

//         const detailsRes = await pool.query(`
//             SELECT d.*, a.account_code, a.account_name_thai
//             FROM gl_entry_detail d
//             JOIN gl_account a ON d.account_id = a.id
//             WHERE d.header_id = $1
//             ORDER BY d.line_no
//         `, [id]);

//         res.json({ header: headerRes.rows[0], details: detailsRes.rows });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// };

// // 3. Create Entry (Draft or Post)
// exports.createEntry = async (req, res) => {
//     const client = await pool.connect();
//     const { header, details, action } = req.body; // action: 'Draft' | 'Post'

//     try {
//         await client.query('BEGIN');

//         // A. Generate/Validate Doc No
//         let finalDocNo = header.doc_no;
//         if (!finalDocNo || finalDocNo === 'AUTO') {
//             finalDocNo = await generateDocNo(client, header.doc_id, header.doc_date);
//             if (!finalDocNo) throw new Error('Cannot generate document number');
//         } else {
//             // Check duplicate if manual
//             const dupCheck = await client.query('SELECT id FROM gl_entry_header WHERE doc_no = $1', [finalDocNo]);
//             if (dupCheck.rows.length > 0) throw new Error('Duplicate document number');
//         }

//         const status = action === 'Post' ? 'Posted' : 'Draft';

//         // B. Insert Header
//         const headerSql = `
//             INSERT INTO gl_entry_header 
//             (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description, 
//              currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, created_by)
//             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
//             RETURNING id
//         `;
//         const headerRes = await client.query(headerSql, [
//             header.doc_id, finalDocNo, header.doc_date, header.posting_date, header.period_id,
//             header.ref_no, header.description, header.currency_id, header.exchange_rate,
//             status, header.total_debit, header.total_credit, header.created_by
//         ]);
//         const newHeaderId = headerRes.rows[0].id;

//         // C. Insert Details
//         const detailSql = `
//             INSERT INTO gl_entry_detail 
//             (header_id, line_no, account_id, description, debit_lc, credit_lc, 
//              branch_id, project_id, business_unit_id)
//             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//         `;
//         let lineNo = 1;
//         for (const row of details) {
//             await client.query(detailSql, [
//                 newHeaderId, lineNo++, row.account_id, row.description,
//                 row.debit, row.credit, row.branch_id, row.project_id, row.business_unit_id
//             ]);
//         }

//         // D. Update Balance if Post
//         if (action === 'Post') {
//             await updateGlBalance(client, newHeaderId, false);
//         }

//         await client.query('COMMIT');
//         res.status(201).json({ message: 'Success', id: newHeaderId, doc_no: finalDocNo });
//     } catch (err) {
//         await client.query('ROLLBACK');
//         res.status(500).json({ error: err.message });
//     } finally {
//         client.release();
//     }
// };

// // 4. Update Entry (Only Draft)
// exports.updateEntry = async (req, res) => {
//     const { id } = req.params;
//     const { header, details, action } = req.body;
//     const client = await pool.connect();

//     try {
//         await client.query('BEGIN');

//         // Check Status
//         const oldEntry = await client.query('SELECT status FROM gl_entry_header WHERE id = $1', [id]);
//         if (oldEntry.rows.length === 0) throw new Error('Not found');
//         if (oldEntry.rows[0].status !== 'Draft') throw new Error('Only Draft can be edited');

//         const status = action === 'Post' ? 'Posted' : 'Draft';

//         // Update Header
//         await client.query(`
//             UPDATE gl_entry_header SET 
//             doc_date=$1, posting_date=$2, ref_no=$3, description=$4, 
//             status=$5, total_debit_lc=$6, total_credit_lc=$7, updated_at=NOW(), updated_by=$8
//             WHERE id=$9
//         `, [header.doc_date, header.posting_date, header.ref_no, header.description, 
//             status, header.total_debit, header.total_credit, header.updated_by, id]);

//         // Replace Details
//         await client.query('DELETE FROM gl_entry_detail WHERE header_id=$1', [id]);
        
//         const detailSql = `
//             INSERT INTO gl_entry_detail 
//             (header_id, line_no, account_id, description, debit_lc, credit_lc, 
//              branch_id, project_id, business_unit_id)
//             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//         `;
//         let lineNo = 1;
//         for (const row of details) {
//             await client.query(detailSql, [
//                 id, lineNo++, row.account_id, row.description,
//                 row.debit, row.credit, row.branch_id, row.project_id, row.business_unit_id
//             ]);
//         }

//         // Update Balance if Post
//         if (action === 'Post') {
//             await updateGlBalance(client, id, false);
//         }

//         await client.query('COMMIT');
//         res.json({ message: 'Updated' });
//     } catch (err) {
//         await client.query('ROLLBACK');
//         res.status(500).json({ error: err.message });
//     } finally {
//         client.release();
//     }
// };

// // 5. Delete Entry (Soft Delete)
// exports.deleteEntry = async (req, res) => {
//     const { id } = req.params;
//     try {
//         const result = await pool.query(
//             `UPDATE gl_entry_header SET status = 'Deleted' WHERE id = $1 AND status = 'Draft' RETURNING id`, 
//             [id]
//         );
//         if (result.rowCount === 0) return res.status(400).json({ error: 'Cannot delete: Not found or not Draft' });
//         res.json({ message: 'Deleted' });
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// };

// // 6. Reverse Entry
// exports.reverseEntry = async (req, res) => {
//     const { id } = req.params;
//     const client = await pool.connect();
//     try {
//         await client.query('BEGIN');

//         const checkRes = await client.query('SELECT status FROM gl_entry_header WHERE id = $1', [id]);
//         if (checkRes.rows[0].status !== 'Posted') throw new Error('Only Posted can be reversed');

//         // Reverse Balance (isReverse = true)
//         await updateGlBalance(client, id, true);

//         // Update Status to Draft
//         await client.query(`UPDATE gl_entry_header SET status = 'Draft' WHERE id = $1`, [id]);

//         await client.query('COMMIT');
//         res.json({ message: 'Reversed to Draft' });
//     } catch (err) {
//         await client.query('ROLLBACK');
//         res.status(500).json({ error: err.message });
//     } finally {
//         client.release();
//     }
// };
