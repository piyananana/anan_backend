// File: controllers/gl/glEntriesController.js

// --- Helper: Validate required dimensions per detail line before Post ---
const validateDimRules = async (client, details) => {
    // โหลด dim type slot map ครั้งเดียว
    const typeRes = await client.query(
        `SELECT type_code, slot_no FROM gl_dimension_type WHERE is_active = true`
    );
    const slotByType = {};
    for (const r of typeRes.rows) slotByType[r.type_code] = r.slot_no;

    const errors = [];
    for (let i = 0; i < details.length; i++) {
        const row = details[i];
        if (!row.account_id) continue;
        const rulesRes = await client.query(
            `SELECT type_code FROM gl_account_dim_rule WHERE account_id = $1 AND is_required = true`,
            [row.account_id]
        );
        for (const rule of rulesRes.rows) {
            const slot = slotByType[rule.type_code];
            if (!slot) continue;
            const dimId = row[`dim${slot}_id`];
            if (!dimId) {
                errors.push(`บรรทัดที่ ${i + 1}: ต้องระบุ ${rule.type_code}`);
            }
        }
    }
    if (errors.length > 0) {
        throw new Error(`Dimension ไม่ครบ:\n${errors.join('\n')}`);
    }
};

// --- Helper: Get or create gl_dim_combination id ---
const getOrCreateComboId = async (client, { branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id }) => {
    const res = await client.query(`
        INSERT INTO gl_dim_combination (branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (combo_key) DO UPDATE SET id = gl_dim_combination.id
        RETURNING id
    `, [branch_id || 0, dim1_id || 0, dim2_id || 0, dim3_id || 0, dim4_id || 0, dim5_id || 0]);
    return res.rows[0].id;
};

// --- Helper: Update Accumulators (Post/Reverse) ---
const updateBalanceAccum = async (client, headerId, isReverse = false) => {
    const detailsRes = await client.query(`SELECT * FROM gl_entry_detail WHERE header_id = $1`, [headerId]);
    const headerRes  = await client.query(`SELECT * FROM gl_entry_header WHERE id = $1`, [headerId]);
    const header  = headerRes.rows[0];
    const details = detailsRes.rows;
    const multiplier = isReverse ? -1 : 1;

    for (const row of details) {
        // branch_id comes from header (document level), not detail line
        const comboId  = await getOrCreateComboId(client, {
            branch_id: header.branch_id,
            dim1_id: row.dim1_id, dim2_id: row.dim2_id,
            dim3_id: row.dim3_id, dim4_id: row.dim4_id, dim5_id: row.dim5_id,
        });
        const debit    = (Number(row.debit_lc)  || 0) * multiplier;
        const credit   = (Number(row.credit_lc) || 0) * multiplier;
        const netChange = debit - credit;

        await client.query(`
            INSERT INTO gl_balance_accum
                (period_id, account_id, combo_id, currency_id,
                 debit_amount, credit_amount, end_balance, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
            ON CONFLICT (period_id, account_id, combo_id, currency_id)
            DO UPDATE SET
                debit_amount  = gl_balance_accum.debit_amount  + EXCLUDED.debit_amount,
                credit_amount = gl_balance_accum.credit_amount + EXCLUDED.credit_amount,
                end_balance   = gl_balance_accum.end_balance   + (EXCLUDED.debit_amount - EXCLUDED.credit_amount),
                updated_at    = NOW()
        `, [header.period_id, row.account_id, comboId, header.currency_id || 1,
            debit, credit, netChange]);
    }
};

// --- Helper: Generate Document Number (supports per-branch counter) ---
const generateDocNo = async (client, docId, date, branchId = null) => {
    let config = null;
    let useBranchCounter = false;
    let branchRowId = null;

    // Try branch-specific config first
    if (branchId) {
        const branchRes = await client.query(
            `SELECT * FROM sa_doc_number_branch WHERE doc_id = $1 AND branch_id = $2 FOR UPDATE`,
            [docId, branchId]
        );
        if (branchRes.rows.length > 0) {
            const globalRes = await client.query(
                `SELECT * FROM sa_module_document WHERE id = $1`, [docId]
            );
            const global = globalRes.rows[0];
            if (!global || !global.is_auto_numbering) return null;
            const bc = branchRes.rows[0];
            config = {
                format_prefix:       bc.format_prefix      ?? global.format_prefix      ?? '',
                format_separator:    bc.format_separator   ?? global.format_separator   ?? '',
                format_suffix_date:  bc.format_suffix_date ?? global.format_suffix_date ?? '',
                running_length:      bc.running_length     ?? global.running_length     ?? 4,
                next_running_number: bc.next_running_number,
            };
            useBranchCounter = true;
            branchRowId = bc.id;
        }
    }

    // Fall back to global config
    if (!useBranchCounter) {
        const globalRes = await client.query(
            `SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]
        );
        const global = globalRes.rows[0];
        if (!global || !global.is_auto_numbering) return null;
        config = {
            format_prefix:       global.format_prefix      || '',
            format_separator:    global.format_separator   || '',
            format_suffix_date:  global.format_suffix_date || '',
            running_length:      global.running_length     || 4,
            next_running_number: global.next_running_number,
        };
    }

    // Build doc number
    let docNo = config.format_prefix;
    if (config.format_suffix_date) {
        const d = new Date(date);
        const year  = d.getFullYear().toString();
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const day   = d.getDate().toString().padStart(2, '0');
        if      (config.format_suffix_date === 'YY')       docNo += year.substring(2);
        else if (config.format_suffix_date === 'YYYY')     docNo += year;
        else if (config.format_suffix_date === 'YYMM')     docNo += year.substring(2) + month;
        else if (config.format_suffix_date === 'YYYYMM')   docNo += year + month;
        else if (config.format_suffix_date === 'YYYYMMDD') docNo += year + month + day;
    }
    if (config.format_separator) docNo += config.format_separator;
    docNo += config.next_running_number.toString().padStart(config.running_length, '0');

    // Increment the right counter
    if (useBranchCounter) {
        await client.query(
            `UPDATE sa_doc_number_branch SET next_running_number = next_running_number + 1 WHERE id = $1`,
            [branchRowId]
        );
    } else {
        await client.query(
            `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
            [docId]
        );
    }
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
            finalDocNo = await generateDocNo(client, header.doc_id, header.doc_date, header.branch_id);
            if (!finalDocNo) throw new Error('Auto numbering failed or manual doc no required');
        }

        // B. Insert Header
        const headerSql = `
            INSERT INTO gl_entry_header
            (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
             currency_id, exchange_rate, status,
             total_debit_lc, total_credit_lc,
             total_debit_fc, total_credit_fc,
             created_by, branch_id,
             ref_doc_id, ref_doc_no, ref_doc_date, external_source_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, $20)
            RETURNING id
        `;
        const status = action === 'Post' ? 'Posted' : 'Draft';
        const headerRes = await client.query(headerSql, [
            header.doc_id, finalDocNo, header.doc_date, header.posting_date,
            periodId,
            header.ref_no, header.description,
            header.currency_id, header.exchange_rate, status,
            header.total_debit_lc, header.total_credit_lc,
            header.total_debit_fc, header.total_credit_fc,
            header.created_by,
            header.branch_id || null,          // $16
            header.ref_doc_id || null,         // $17
            header.ref_doc_no || null,         // $18
            header.ref_doc_date || null,       // $19
            header.external_source_id || null  // $20
        ]);
        const newHeaderId = headerRes.rows[0].id;

        // C. Insert Details (branch_id is now at header level)
        const detailSql = `
            INSERT INTO gl_entry_detail
            (header_id, line_no, account_id, description,
             debit_lc, credit_lc, debit_fc, credit_fc,
             dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `;
        let lineNo = 1;
        for (const row of details) {
            await client.query(detailSql, [
                newHeaderId, lineNo++, row.account_id, row.description,
                row.debit_lc, row.credit_lc, row.debit_fc, row.credit_fc,
                row.dim1_id || null, row.dim2_id || null,
                row.dim3_id || null, row.dim4_id || null, row.dim5_id || null,
            ]);
        }

        // D. Validate dim rules + Update Accumulators if Post
        if (action === 'Post') {
            await validateDimRules(client, details);
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
            branch_id=$13,
            updated_at=NOW(),
            ref_doc_id=$14, ref_doc_no=$15, ref_doc_date=$16
            WHERE id=$17
        `, [header.doc_date, header.posting_date, periodId,
            header.ref_no, header.description,
            status,
            header.total_debit_lc, header.total_credit_lc,
            header.total_debit_fc, header.total_credit_fc,
            header.currency_id, header.exchange_rate,
            header.branch_id || null,
            header.ref_doc_id || null, header.ref_doc_no || null, header.ref_doc_date || null,
            id]);

        // Delete Old Details & Insert New (branch_id is now at header level)
        await client.query('DELETE FROM gl_entry_detail WHERE header_id=$1', [id]);

        const detailSql = `
            INSERT INTO gl_entry_detail
            (header_id, line_no, account_id, description,
             debit_lc, credit_lc, debit_fc, credit_fc,
             dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `;
        let lineNo = 1;
        for (const row of details) {
            await client.query(detailSql, [
                id, lineNo++, row.account_id, row.description,
                row.debit_lc, row.credit_lc, row.debit_fc, row.credit_fc,
                row.dim1_id || null, row.dim2_id || null,
                row.dim3_id || null, row.dim4_id || null, row.dim5_id || null,
            ]);
        }

        // Validate dim rules + Update Accumulators if Post
        if (action === 'Post') {
            await validateDimRules(client, details);
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

        // Check Status and source
        const checkRes = await client.query(
            'SELECT status, external_source_id FROM gl_entry_header WHERE id = $1', [id]
        );
        if (!checkRes.rows[0]) return res.status(404).json({ error: 'Not found' });

        // ถ้าสร้างมาจากโมดูลอื่น (AR, AP ฯลฯ) → ห้ามถอยจาก GL โดยตรง
        if (checkRes.rows[0].external_source_id) {
            return res.status(403).json({
                error: 'รายการนี้สร้างจากโมดูลอื่น ไม่สามารถถอยจาก GL ได้ กรุณายกเลิกจากโมดูลต้นทาง'
            });
        }

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
    const { search, status, period_id, fiscal_year_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id } = req.query;
    const d1 = dim1_id ? parseInt(dim1_id) : null;
    const d2 = dim2_id ? parseInt(dim2_id) : null;
    const d3 = dim3_id ? parseInt(dim3_id) : null;
    const d4 = dim4_id ? parseInt(dim4_id) : null;
    const d5 = dim5_id ? parseInt(dim5_id) : null;

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
    // Dim filter: กรองหัวเอกสารที่มีบรรทัดตรงกับ dimension ที่เลือก
    if (d1 || d2 || d3 || d4 || d5) {
        params.push(d1, d2, d3, d4, d5);
        const b = params.length;
        sql += ` AND EXISTS (
            SELECT 1 FROM gl_entry_detail det WHERE det.header_id = h.id
              AND ($${b-4}::int IS NULL OR det.dim1_id = $${b-4})
              AND ($${b-3}::int IS NULL OR det.dim2_id = $${b-3})
              AND ($${b-2}::int IS NULL OR det.dim3_id = $${b-2})
              AND ($${b-1}::int IS NULL OR det.dim4_id = $${b-1})
              AND ($${b}::int   IS NULL OR det.dim5_id = $${b})
        )`;
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
        // 1. Get Header (+ Document Type, Ref Doc Type, Branch)
        const headerRes = await req.dbPool.query(`
            SELECT h.*, d.doc_code, d.doc_name_thai, d.is_auto_numbering,
               ref_d.doc_code AS ref_doc_code, ref_d.doc_name_thai AS ref_doc_name,
               b.branch_code, b.branch_name_thai
            FROM gl_entry_header h
            LEFT JOIN sa_module_document d ON h.doc_id = d.id
            LEFT JOIN sa_module_document ref_d ON h.ref_doc_id = ref_d.id
            LEFT JOIN cd_branch b ON b.id = h.branch_id
            WHERE h.id = $1
        `, [id]);

        if (headerRes.rows.length === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        // 2. Get Details (join account + dim1-5 values; branch is now on header)
        const detailsRes = await req.dbPool.query(`
            SELECT d.*,
                   a.account_code, a.account_name_thai,
                   v1.value_code AS dim1_code, v1.value_name_thai AS dim1_name,
                   v2.value_code AS dim2_code, v2.value_name_thai AS dim2_name,
                   v3.value_code AS dim3_code, v3.value_name_thai AS dim3_name,
                   v4.value_code AS dim4_code, v4.value_name_thai AS dim4_name,
                   v5.value_code AS dim5_code, v5.value_name_thai AS dim5_name
            FROM gl_entry_detail d
            LEFT JOIN gl_account a ON a.id = d.account_id
            LEFT JOIN gl_dimension_value v1 ON v1.id = d.dim1_id
            LEFT JOIN gl_dimension_value v2 ON v2.id = d.dim2_id
            LEFT JOIN gl_dimension_value v3 ON v3.id = d.dim3_id
            LEFT JOIN gl_dimension_value v4 ON v4.id = d.dim4_id
            LEFT JOIN gl_dimension_value v5 ON v5.id = d.dim5_id
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
