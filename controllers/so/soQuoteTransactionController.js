// controllers/so/soQuoteTransactionController.js — ใบเสนอราคา (Sale Quote, sys_module='41', อยู่ใต้โหนด SO)
// มิเรอร์ poPrTransactionController.js ทุกประการ (vendor->customer) — ไม่แตะ GL, ไม่แตะสต็อก, ไม่แตะลูกค้า/คลัง
// โดยจำเป็น (ต่างจาก SO ที่ทั้งสองฟิลด์บังคับ) workflow: Draft (แก้ไขได้) -> Submitted (เข้าคิวอนุมัติจริงผ่าน
// sa_module_approver/syncMenuApprovers มิเรอร์ poPrTransactionController.js ทุกประการ) -> Approved/Rejected
// (Rejected แก้ไข+ส่งใหม่ได้เหมือน Draft) -> PartiallyConverted/FullyConverted (คำนวณอัตโนมัติจาก SO ที่อ้างอิง
// เข้ามา ไม่ใช่การกดเอง) -> Closed (กดปิดเอง ไม่ auto-close แม้แปลงครบ 100%) กิ่ง Void แยกได้จาก
// Draft/Rejected/Approved/PartiallyConverted แต่บล็อกถ้ามี SO อ้างอิงเข้ามาแล้ว — ต่างจาก PR ตรงที่มี
// valid_until_date ระดับหัวเอกสาร (ไม่ใช่ต่อบรรทัดแบบ needed_by_date ของ PR) เพราะวันหมดอายุใบเสนอราคาเป็นค่าเดียว
// ต่อทั้งใบตามธรรมชาติ
'use strict';

const { generateDocNo } = require('../im/imTransactionController');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
const { reasonOf, userIdOf, sendErr, blk } = require('../../utils/docAction');
const DA = require('../../utils/docApproval');
const KIND = 'QUOTE';
const { ensureSalespersonTable, saveDocSalespersons, loadSalespersons } = require('../../utils/docSalesperson');

// พนักงานขายของใบเสนอราคา (รายชื่อ — สัดส่วนอยู่ที่ข้อมูลลูกค้า)
const ensureDocSalesperson = (db) => ensureSalespersonTable(db, 'quote_transaction_salesperson', 'quote_transaction', 'header_id');
const { ensureSoTransactionTable } = require('./soTransactionController');

const ensureQuoteTransactionTable = async (client) => {
    // quote_transaction_detail.ref_quote_detail_id ฝั่ง so_transaction ต้องมีตาราง so_transaction อยู่ก่อนจึง ALTER
    // ได้ — เรียกทางเดียว (quote ensure so ได้ แต่ so ensure ต้องไม่เรียกกลับมาที่นี่ ป้องกัน recursion) มิเรอร์
    // แนวทางที่ so_transaction ensure im_transaction แบบทางเดียวเช่นกัน (ปลอดภัยกว่า PR ที่ ALTER po_transaction
    // ตรงๆ โดยไม่มี guard)
    await ensureSoTransactionTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS quote_transaction (
            id              SERIAL PRIMARY KEY,
            doc_id          INTEGER NOT NULL REFERENCES sa_module_document(id),
            doc_no          VARCHAR(50) NOT NULL,
            doc_code        VARCHAR(10) NOT NULL,
            doc_date        DATE NOT NULL,
            prepared_by     INTEGER,
            customer_id     INTEGER REFERENCES ar_customer(id),
            customer_code   VARCHAR(50),
            customer_name_th VARCHAR(255),
            warehouse_id    INTEGER REFERENCES im_warehouse(id),
            currency_id     INTEGER REFERENCES cd_currency(id),
            currency_code   VARCHAR(10) DEFAULT 'THB',
            exchange_rate   NUMERIC(15,6) NOT NULL DEFAULT 1,
            valid_until_date DATE,
            status          VARCHAR(20) NOT NULL DEFAULT 'Draft',
            approval_mode   VARCHAR(10) NOT NULL DEFAULT 'ALL',
            total_qty       NUMERIC(18,4) NOT NULL DEFAULT 0,
            total_value_lc  NUMERIC(18,4) NOT NULL DEFAULT 0,
            description     TEXT,
            dim1_id INTEGER, dim2_id INTEGER, dim3_id INTEGER, dim4_id INTEGER, dim5_id INTEGER,
            branch_id       INTEGER REFERENCES cd_branch(id),
            submitted_at    TIMESTAMPTZ,
            submitted_by    VARCHAR(100),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by      VARCHAR(100),
            updated_by      VARCHAR(100)
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_quote_transaction_date   ON quote_transaction(doc_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_quote_transaction_status ON quote_transaction(status)`);

    await client.query(`
        CREATE TABLE IF NOT EXISTS quote_transaction_detail (
            id             SERIAL PRIMARY KEY,
            header_id      INTEGER NOT NULL REFERENCES quote_transaction(id) ON DELETE CASCADE,
            line_no        INTEGER NOT NULL,
            item_id        INTEGER NOT NULL REFERENCES im_item(id),
            item_code      VARCHAR(30),
            item_name      VARCHAR(200),
            uom_id         INTEGER REFERENCES im_uom(id),
            qty_quoted     NUMERIC(18,4) NOT NULL,
            unit_price_fc  NUMERIC(18,4) NOT NULL DEFAULT 0,
            total_value_lc NUMERIC(18,4) NOT NULL DEFAULT 0,
            description    TEXT
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_quote_transaction_detail_header ON quote_transaction_detail(header_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_quote_transaction_detail_item   ON quote_transaction_detail(item_id)`);

    // คิวผู้อนุมัติอยู่ที่ตารางกลาง doc_approval (utils/docApproval.js, doc_kind 'QUOTE') — ตาราง quote_transaction_approval เดิมเลิกใช้แล้ว

    // คอลัมน์อ้างอิงกลับที่ so_transaction/so_transaction_detail ต้องมีอยู่ก่อนจึง query qty_converted ได้ — ปลอดภัย
    // เพราะเรียก ensureSoTransactionTable ไว้ด้านบนแล้ว
    await client.query(`ALTER TABLE so_transaction ADD COLUMN IF NOT EXISTS ref_quote_id INTEGER`);
    await client.query(`ALTER TABLE so_transaction_detail ADD COLUMN IF NOT EXISTS ref_quote_detail_id INTEGER`);
    // ยกเลิกแบบมีเหตุผล (sql/quote_transaction_reverse_to_draft.sql)
    await client.query(`
        ALTER TABLE quote_transaction
            ADD COLUMN IF NOT EXISTS void_reason TEXT,
            ADD COLUMN IF NOT EXISTS voided_by   VARCHAR(100),
            ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ`);
};

// --- Fetch helpers ---
const fetchRowById = async (pool, id) => {
    const hRes = await pool.query(`
        SELECT t.*,
               d.doc_code AS d_doc_code, d.doc_name_thai, d.doc_name_eng, d.is_auto_numbering,
               c.customer_code AS c_customer_code, c.customer_name_th AS c_customer_name_th,
               w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
               b.branch_code, b.branch_name_thai,
               u.user_name AS prepared_by_name
        FROM quote_transaction t
        JOIN sa_module_document d ON d.id = t.doc_id
        LEFT JOIN ar_customer c  ON c.id = t.customer_id
        LEFT JOIN im_warehouse w ON w.id = t.warehouse_id
        LEFT JOIN cd_branch b    ON b.id = t.branch_id
        LEFT JOIN sa_user u      ON u.id = t.prepared_by
        WHERE t.id = $1`, [id]);
    if (hRes.rows.length === 0) return null;
    const dRes = await pool.query(`
        SELECT dt.*, u.uom_code,
               COALESCE((
                   SELECT SUM(sod.qty_ordered) FROM so_transaction_detail sod
                   JOIN so_transaction so ON so.id = sod.header_id
                   WHERE sod.ref_quote_detail_id = dt.id AND so.status NOT IN ('Void', 'Deleted')
               ), 0) AS qty_converted
        FROM quote_transaction_detail dt
        LEFT JOIN im_uom u ON u.id = dt.uom_id
        WHERE dt.header_id = $1 ORDER BY dt.line_no`, [id]);
    await ensureDocSalesperson(pool);
    const salespersons = await loadSalespersons(pool, 'quote_transaction_salesperson', 'header_id', id);
    await DA.ensureDocApprovalSchema(pool);
    return { ...hRes.rows[0], details: dRes.rows, approvals: await DA.loadApprovals(pool, KIND, Number(id)), salespersons };
};

// --- GET list ---
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureQuoteTransactionTable(client);
        const { status, customer_id, prepared_by, date_from, date_to, search } = req.query;
        let query = `
            SELECT t.id, t.doc_no, t.doc_date, t.status, t.customer_id, t.customer_code, t.customer_name_th,
                   t.warehouse_id, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                   t.prepared_by, u.user_name AS prepared_by_name,
                   t.valid_until_date, t.total_qty, t.total_value_lc, t.description,
                   d.doc_code, d.doc_name_thai, d.doc_name_eng
            FROM quote_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            LEFT JOIN im_warehouse w  ON w.id = t.warehouse_id
            LEFT JOIN sa_user u       ON u.id = t.prepared_by
            WHERE 1=1`;
        const params = [];
        let pi = 1;
        if (status)      { params.push(status);      query += ` AND t.status = $${pi++}`; }
        else query += ` AND t.status <> 'Deleted'`; // ใบที่ลบแล้วแสดงเฉพาะเมื่อเลือกสถานะ Deleted
        if (customer_id)  { params.push(customer_id);  query += ` AND t.customer_id = $${pi++}`; }
        if (prepared_by)  { params.push(prepared_by);  query += ` AND t.prepared_by = $${pi++}`; }
        if (date_from)    { params.push(date_from);    query += ` AND t.doc_date >= $${pi++}`; }
        if (date_to)      { params.push(date_to);      query += ` AND t.doc_date <= $${pi++}`; }
        if (search) {
            params.push(`%${search.toUpperCase()}%`);
            query += ` AND (UPPER(t.doc_no) LIKE $${pi} OR UPPER(COALESCE(t.customer_name_th,'')) LIKE $${pi})`;
            pi++;
        }
        query += ` ORDER BY t.doc_date DESC, t.id DESC`;
        const result = await client.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching quote_transaction list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- GET one ---
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureQuoteTransactionTable(client);
        const data = await fetchRowById(req.dbPool, req.params.id);
        if (!data) return res.status(404).json({ message: 'Not found.' });
        Object.assign(data, await computeBlocks(client, req.params.id));
        data.reverse_history = await getReverseHistory(client, 'quote_transaction', req.params.id);
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching quote_transaction row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- 1. Create (always Draft) ---
const createTransaction = async (req, res) => {
    const { header, details } = req.body;
    const userId = req.headers['userid'] || null;
    const userName = req.headers['username'] || null;
    await ensureDocSalesperson(req.dbPool);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureQuoteTransactionTable(client);

        if (!details || details.length === 0) throw new Error('ต้องมีรายการเสนอราคาอย่างน้อย 1 รายการ');

        let customerCode = null, customerNameTh = null;
        if (header.customer_id) {
            const customerRes = await client.query(`SELECT customer_code, customer_name_th FROM ar_customer WHERE id=$1`, [header.customer_id]);
            if (customerRes.rows.length === 0) throw new Error('ไม่พบลูกค้าที่ระบุ');
            customerCode = customerRes.rows[0].customer_code;
            customerNameTh = customerRes.rows[0].customer_name_th;
        }

        const docTypeRes = await client.query(`SELECT doc_code FROM sa_module_document WHERE id=$1`, [header.doc_id]);
        if (docTypeRes.rows.length === 0) throw new Error('ไม่พบประเภทเอกสาร');
        const docCode = docTypeRes.rows[0].doc_code;

        let docNo = header.doc_no;
        if (!docNo || docNo === 'AUTO') {
            docNo = await generateDocNo(client, header.doc_id, header.doc_date, header.branch_id || null);
            if (!docNo) throw new Error('Auto numbering failed or manual doc_no required');
        }

        const hRes = await client.query(`
            INSERT INTO quote_transaction
            (doc_id, doc_no, doc_code, doc_date, prepared_by, customer_id, customer_code, customer_name_th, warehouse_id,
             currency_id, currency_code, exchange_rate, valid_until_date,
             description, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id, branch_id, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
            RETURNING id
        `, [
            header.doc_id, docNo, docCode, header.doc_date, header.prepared_by || userId || null,
            header.customer_id || null, customerCode, customerNameTh, header.warehouse_id || null,
            header.currency_id || null, header.currency_code || 'THB', header.exchange_rate || 1,
            header.valid_until_date || null,
            header.description || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, userName,
        ]);
        const headerId = hRes.rows[0].id;

        let lineNo = 1, totalQty = 0, totalValue = 0;
        for (const d of details) {
            const qty = Number(d.qty_quoted) || 0;
            const price = Number(d.unit_price_fc) || 0;
            const value = qty * price * (Number(header.exchange_rate) || 1);
            totalQty += qty;
            totalValue += value;
            await client.query(`
                INSERT INTO quote_transaction_detail
                (header_id, line_no, item_id, item_code, item_name, uom_id, qty_quoted, unit_price_fc, total_value_lc, description)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            `, [headerId, lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                qty, price, value, d.description || null]);
        }
        await client.query(`UPDATE quote_transaction SET total_qty=$1, total_value_lc=$2 WHERE id=$3`, [totalQty, totalValue, headerId]);
        await saveDocSalespersons(client, 'quote_transaction_salesperson', 'header_id', headerId, req.body.salespersons);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, headerId);
        res.status(201).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating quote_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 2. Update (Draft/Rejected only — Rejected แก้ไข+ส่งใหม่ได้เหมือน Draft) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, details } = req.body;
    const userName = req.headers['username'] || null;
    await ensureDocSalesperson(req.dbPool);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM quote_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (!['Draft', 'Rejected'].includes(existing.rows[0].status)) throw new Error('แก้ไขได้เฉพาะเอกสาร Draft หรือ Rejected เท่านั้น');

        if (!details || details.length === 0) throw new Error('ต้องมีรายการเสนอราคาอย่างน้อย 1 รายการ');

        let customerCode = null, customerNameTh = null;
        if (header.customer_id) {
            const customerRes = await client.query(`SELECT customer_code, customer_name_th FROM ar_customer WHERE id=$1`, [header.customer_id]);
            if (customerRes.rows.length === 0) throw new Error('ไม่พบลูกค้าที่ระบุ');
            customerCode = customerRes.rows[0].customer_code;
            customerNameTh = customerRes.rows[0].customer_name_th;
        }

        await client.query(`
            UPDATE quote_transaction SET
                doc_date=$1, customer_id=$2, customer_code=$3, customer_name_th=$4, warehouse_id=$5, description=$6,
                currency_id=$7, currency_code=$8, exchange_rate=$9, valid_until_date=$10,
                dim1_id=$11, dim2_id=$12, dim3_id=$13, dim4_id=$14, dim5_id=$15, branch_id=$16,
                status='Draft', updated_by=$17, updated_at=NOW()
            WHERE id=$18
        `, [
            header.doc_date, header.customer_id || null, customerCode, customerNameTh, header.warehouse_id || null,
            header.description || null,
            header.currency_id || null, header.currency_code || 'THB', header.exchange_rate || 1, header.valid_until_date || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, userName, id,
        ]);

        // แก้ไขแล้วถือว่าเป็นรอบ Draft ใหม่ — ล้างคิวอนุมัติเดิมทิ้ง (ถ้ามีจากรอบที่ถูกปฏิเสธ)
        await DA.ensureDocApprovalSchema(client);
        await client.query(`DELETE FROM doc_approval WHERE doc_kind=$1 AND record_id=$2`, [KIND, Number(id)]);

        // แก้ไขบรรทัดแบบ diff (UPDATE ของเดิม / INSERT ใหม่ / DELETE ที่ถูกลบ) — มิเรอร์ pr_transaction_detail ทุกประการ
        const existingIdsRes = await client.query(`SELECT id FROM quote_transaction_detail WHERE header_id=$1`, [id]);
        const existingIds = new Set(existingIdsRes.rows.map(r => r.id));
        const incomingIds = new Set(details.filter(d => d.id).map(d => d.id));
        const removedIds = [...existingIds].filter(x => !incomingIds.has(x));

        if (removedIds.length > 0) {
            const { deleteAttachmentsForEntities } = require('../sa/saAttachmentController');
            await deleteAttachmentsForEntities(client, 'quote_transaction_detail', removedIds);
            await client.query(`DELETE FROM quote_transaction_detail WHERE id = ANY($1::int[])`, [removedIds]);
        }

        let lineNo = 1, totalQty = 0, totalValue = 0;
        for (const d of details) {
            const qty = Number(d.qty_quoted) || 0;
            const price = Number(d.unit_price_fc) || 0;
            const value = qty * price * (Number(header.exchange_rate) || 1);
            totalQty += qty;
            totalValue += value;
            if (d.id && existingIds.has(d.id)) {
                await client.query(`
                    UPDATE quote_transaction_detail SET
                        line_no=$1, item_id=$2, item_code=$3, item_name=$4, uom_id=$5, qty_quoted=$6,
                        unit_price_fc=$7, total_value_lc=$8, description=$9
                    WHERE id=$10
                `, [lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                    qty, price, value, d.description || null, d.id]);
            } else {
                await client.query(`
                    INSERT INTO quote_transaction_detail
                    (header_id, line_no, item_id, item_code, item_name, uom_id, qty_quoted, unit_price_fc, total_value_lc, description)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                `, [id, lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                    qty, price, value, d.description || null]);
            }
        }
        await client.query(`UPDATE quote_transaction SET total_qty=$1, total_value_lc=$2 WHERE id=$3`, [totalQty, totalValue, id]);
        await saveDocSalespersons(client, 'quote_transaction_salesperson', 'header_id', id, req.body.salespersons);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating quote_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 3-5. ส่งอนุมัติ / อนุมัติ / ปฏิเสธ — คิวผู้อนุมัติของเมนูที่ตารางกลาง doc_approval (utils/docApproval.js)
// ไม่มีผู้อนุมัติ = ตาม sa_menu.no_approver_action (ให้ผ่าน -> Approved ทันที / ไม่ให้ผ่าน -> ส่งไม่ได้)
// Rejected แก้ไข+ส่งใหม่ได้เหมือน Draft (ไม่ย้อนกลับเป็น Draft ตรงๆ เพื่อให้เห็นประวัติว่าเคยถูกปฏิเสธ)
const approvalAction = (label, work) => async (req, res) => {
    const { id } = req.params;
    const ctx = {
        userId: Number(req.headers.userid) || null, userName: req.headers.username || null,
        menuId: req.body?.menu_id, remarks: req.body?.remarks,
    };
    if (label !== 'submitting' && !ctx.userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    await DA.ensureDocApprovalSchema(req.dbPool);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureQuoteTransactionTable(client);
        const t = (await client.query(`SELECT * FROM quote_transaction WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!t) throw DA.httpErr(404, 'Not found');
        await work(client, t, ctx);
        await client.query('COMMIT');
        res.status(200).json(await fetchRowById(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK');
        if (!error.status) console.error(`Error ${label} quote_transaction:`, error);
        res.status(error.status || 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

const markApproved = (client, id, userName) => client.query(`
    UPDATE quote_transaction SET status='Approved', updated_at=NOW(), updated_by=$1 WHERE id=$2`, [userName, id]);

const submitTransaction = approvalAction('submitting', async (client, t, { menuId, userName }) => {
    if (!['Draft', 'Rejected'].includes(t.status)) throw DA.httpErr(400, 'ส่งอนุมัติได้เฉพาะเอกสาร Draft หรือ Rejected เท่านั้น');
    const q = await DA.buildQueue(client, { kind: KIND, recordId: t.id, menuId, docCode: t.doc_code });
    await client.query(`
        UPDATE quote_transaction SET status='Submitted', approval_mode=$1, submitted_at=NOW(), submitted_by=$2,
            updated_at=NOW(), updated_by=$2 WHERE id=$3`, [q.mode, userName, t.id]);
    if (q.count === 0) await markApproved(client, t.id, userName);
});

const approveTransaction = approvalAction('approving', async (client, t, { userId, userName, remarks }) => {
    if (t.status !== 'Submitted') throw DA.httpErr(400, 'อนุมัติได้เฉพาะเอกสาร Submitted เท่านั้น');
    const done = await DA.approveStep(client, { kind: KIND, recordId: t.id, userId, mode: t.approval_mode, remarks });
    if (done) await markApproved(client, t.id, userName);
});

const rejectTransaction = approvalAction('rejecting', async (client, t, { userId, userName, remarks }) => {
    if (t.status !== 'Submitted') throw DA.httpErr(400, 'ปฏิเสธได้เฉพาะเอกสาร Submitted เท่านั้น');
    await DA.rejectStep(client, { kind: KIND, recordId: t.id, userId, remarks });
    await client.query(`UPDATE quote_transaction SET status='Rejected', updated_at=NOW(), updated_by=$1 WHERE id=$2`, [userName, t.id]);
});

// --- 6. Close (Approved/PartiallyConverted/FullyConverted -> Closed) ---
const closeTransaction = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM quote_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (!['Approved', 'PartiallyConverted', 'FullyConverted'].includes(existing.rows[0].status)) {
            throw new Error('ปิดได้เฉพาะเอกสารสถานะ Approved, PartiallyConverted หรือ FullyConverted เท่านั้น');
        }
        await client.query(`UPDATE quote_transaction SET status='Closed', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error closing quote_transaction:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- ถอย / ยกเลิก / ลบ: เงื่อนไข ---
// ใบสั่งขายที่แปลงจากใบนี้ (ทุกสถานะยกเว้น Void/Deleted — รวมร่าง เพราะแก้ร่างใบเสนอราคาจะสร้างบรรทัดใหม่)
const refDocsOf = async (client, id) => (await client.query(`
    SELECT string_agg(DISTINCT t.doc_no, ', ') AS docs
      FROM so_transaction_detail td JOIN so_transaction t ON t.id = td.header_id
      JOIN quote_transaction_detail d ON d.id = td.ref_quote_detail_id
     WHERE d.header_id = $1 AND t.status NOT IN ('Void', 'Deleted')`, [id])).rows[0].docs;

const computeBlocks = async (client, id) => {
    const t = (await client.query(`SELECT status FROM quote_transaction WHERE id = $1`, [id])).rows[0];
    if (!t) return {};
    const refs = await refDocsOf(client, id);
    const voided = blk('VOIDED', 'ใบเสนอราคานี้ถูกยกเลิกหรือลบแล้ว');
    const refBlock = refs
        ? blk('REF_DOCS', `มีใบสั่งขายแปลงจากใบเสนอราคานี้ (${refs}) ต้องถอยและลบใบสั่งขายเหล่านั้นก่อน`, refs)
        : null;
    const out = { reverse_block: null, void_block: null, delete_block: null };
    switch (t.status) {
        case 'Submitted': out.reverse_block = refBlock; out.void_block = blk('NOT_APPROVED', 'ใบเสนอราคาที่รออนุมัติให้ถอยเป็นร่างแล้วลบแทนการยกเลิก'); break;
        case 'Approved': out.reverse_block = refBlock; out.void_block = refBlock; break;
        case 'Closed': out.void_block = blk('NOT_APPROVED', 'ใบเสนอราคาที่ปิดแล้วยกเลิกไม่ได้ ถอยการปิดก่อน'); break;
        case 'PartiallyConverted':
        case 'FullyConverted':
            out.reverse_block = blk('REF_DOCS', `มีใบสั่งขายแปลงจากใบนี้แล้ว (${refs || '-'}) ถอยใบสั่งขายก่อน หรือปิดใบเสนอราคาแทน`, refs);
            out.void_block = out.reverse_block;
            break;
        case 'Draft':
        case 'Rejected':
            out.reverse_block = blk('NOT_REVERSIBLE', 'ถอยได้เฉพาะใบเสนอราคาที่ส่งอนุมัติ อนุมัติแล้ว หรือปิดแล้ว');
            out.void_block = blk('NOT_POSTED', 'ใบเสนอราคาที่ยังไม่อนุมัติให้ลบแทนการยกเลิก');
            break;
        default: out.reverse_block = voided; out.void_block = voided;
    }
    if (!['Draft', 'Rejected'].includes(t.status)) {
        out.delete_block = ['Void', 'Deleted'].includes(t.status)
            ? voided : blk('NOT_DRAFT', 'ลบได้เฉพาะร่างหรือใบที่ถูกปฏิเสธ ใบที่ส่งอนุมัติแล้วต้องถอยเป็นร่างก่อน');
    }
    return out;
};

const lockedAction = async (req, res, kind, label, work) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, `กรุณาระบุเหตุผล${label}`);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureQuoteTransactionTable(client);
        const t = (await client.query(`SELECT * FROM quote_transaction WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!t) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeBlocks(client, id))[kind];
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }
        const userName = req.headers.username || null;
        const toStatus = await work(client, t, { reason, userName });
        await logReverse(client, {
            sysModule: '41', tableName: 'quote_transaction', recordId: Number(id), docNo: t.doc_no,
            fromStatus: t.status, toStatus, reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        if (toStatus === 'Deleted') return res.status(200).json({ message: 'Deleted' });
        res.status(200).json(await fetchRowById(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error ${kind} quote_transaction:`, error);
        sendErr(res, 500, error.message || 'Internal server error');
    } finally { client.release(); }
};

// --- 7. ถอย (ต้องมีเหตุผล) ---
// Submitted / Approved -> Draft: ยังไม่มีใบสั่งขายแปลงจากใบนี้ ผู้อนุมัติที่ยังไม่ตัดสินถูกข้าม แก้ไขแล้วส่งอนุมัติใหม่ได้
// Closed -> เปิดใหม่: สถานะคำนวณจากใบสั่งขายที่แปลงไปแล้ว (Approved / PartiallyConverted / FullyConverted)
const reverseTransaction = (req, res) => lockedAction(req, res, 'reverse_block', 'การถอยเอกสาร', async (client, t, { userName }) => {
    if (['Submitted', 'Approved'].includes(t.status)) {
        await DA.ensureDocApprovalSchema(client);
        await DA.skipPending(client, KIND, t.id);
        await client.query(`
            UPDATE quote_transaction SET status='Draft', submitted_at=NULL, submitted_by=NULL, updated_by=$1, updated_at=NOW()
             WHERE id=$2`, [userName, t.id]);
        return 'Draft';
    }
    await client.query(`UPDATE quote_transaction SET status='Approved', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, t.id]);
    await refreshQuoteStatus(client, t.id);
    return (await client.query(`SELECT status FROM quote_transaction WHERE id=$1`, [t.id])).rows[0].status;
});

// --- 8. ยกเลิก (Approved เท่านั้น ต้องมีเหตุผล — บล็อกถ้ามีใบสั่งขายแปลงจากใบนี้) ---
const voidTransaction = (req, res) => lockedAction(req, res, 'void_block', 'การยกเลิก', async (client, t, { reason, userName }) => {
    await client.query(`
        UPDATE quote_transaction SET status='Void', void_reason=$1, voided_by=$2, voided_at=NOW(), updated_by=$2, updated_at=NOW()
         WHERE id=$3`, [reason, userName, t.id]);
    return 'Void';
});

// --- 9. ลบ (Draft/Rejected ต้องมีเหตุผล — เก็บไว้ด้วยสถานะ Deleted ตรวจสอบได้แต่นำกลับมาใช้ไม่ได้) ---
const deleteTransaction = (req, res) => lockedAction(req, res, 'delete_block', 'การลบ', async (client, t, { userName }) => {
    await client.query(`UPDATE quote_transaction SET status='Deleted', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, t.id]);
    return 'Deleted';
});

// --- GET quote_transaction pending current user's approval ---
const fetchMyPending = async (req, res) => {
    const userId = Number(req.headers['userid']);
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    try {
        await DA.ensureDocApprovalSchema(req.dbPool);
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.description, t.total_value_lc, t.status, t.submitted_by
            FROM quote_transaction t
            WHERE t.status = 'Submitted' AND ${DA.myTurnSql('t', '$1', '$2')}
            ORDER BY t.doc_date DESC, t.id DESC`, [KIND, userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching quote_transaction my_pending:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /quote_transaction/convertible_lines?search= — Quote ที่ Approved/PartiallyConverted พร้อมจำนวนคงเหลือที่
// แปลงเป็น SO ได้ต่อบรรทัด ใช้โดย document picker ในหน้าจอ SO (อ้างอิง Quote) — สูตรเดียวกับ validateQuoteConvertibleQty
const fetchConvertibleLines = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureQuoteTransactionTable(client);
        const { search } = req.query;
        let query = `
            SELECT t.id AS header_id, t.doc_no, t.doc_date, t.status, t.currency_code, t.exchange_rate,
                   dt.id AS detail_id, dt.line_no, dt.item_id, dt.item_code, dt.item_name, dt.uom_id,
                   dt.qty_quoted, dt.unit_price_fc, u.uom_code,
                   COALESCE((
                       SELECT SUM(sod.qty_ordered) FROM so_transaction_detail sod
                       JOIN so_transaction so ON so.id = sod.header_id
                       WHERE sod.ref_quote_detail_id = dt.id AND so.status NOT IN ('Void', 'Deleted')
                   ), 0) AS qty_converted
            FROM quote_transaction_detail dt
            JOIN quote_transaction t ON t.id = dt.header_id
            LEFT JOIN im_uom u ON u.id = dt.uom_id
            WHERE t.status IN ('Approved', 'PartiallyConverted')`;
        const params = [];
        let pi = 1;
        if (search) { params.push(`%${search.toUpperCase()}%`); query += ` AND UPPER(t.doc_no) LIKE $${pi++}`; }
        query += ` ORDER BY t.doc_date DESC, t.id DESC, dt.line_no`;
        const result = await client.query(query, params);
        const lines = result.rows
            .map(r => ({ ...r, qty_remaining: Number(r.qty_quoted) - Number(r.qty_converted) }))
            .filter(r => r.qty_remaining > 0.0001);
        res.status(200).json(lines);
    } catch (error) {
        console.error('Error fetching quote_transaction convertible_lines:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- Cross-module helpers, called from soTransactionController.js's line-save path ---

// มิเรอร์ validatePrConvertibleQty ใน poPrTransactionController.js ทุกประการ
const validateQuoteConvertibleQty = async (client, { refQuoteDetailId, requestedQty }) => {
    const origRes = await client.query(`
        SELECT qtd.qty_quoted, qtd.item_code, qtd.header_id, qt.status AS quote_status
        FROM quote_transaction_detail qtd JOIN quote_transaction qt ON qt.id = qtd.header_id
        WHERE qtd.id = $1
    `, [refQuoteDetailId]);
    if (origRes.rows.length === 0) throw new Error('ไม่พบรายการใบเสนอราคาต้นฉบับที่อ้างอิง');
    const orig = origRes.rows[0];
    if (!['Approved', 'PartiallyConverted'].includes(orig.quote_status)) {
        throw new Error(`ใบเสนอราคา ${orig.item_code} ต้องอยู่สถานะ Approved หรือ PartiallyConverted เท่านั้นจึงจะแปลงเป็น SO เพิ่มได้`);
    }
    const convertedRes = await client.query(`
        SELECT COALESCE(SUM(sod.qty_ordered), 0) AS converted
        FROM so_transaction_detail sod JOIN so_transaction so ON so.id = sod.header_id
        WHERE sod.ref_quote_detail_id = $1 AND so.status NOT IN ('Void', 'Deleted')
    `, [refQuoteDetailId]);
    const remaining = Number(orig.qty_quoted) - Number(convertedRes.rows[0].converted);
    if (requestedQty > remaining + 0.0001) {
        throw new Error(`จำนวนที่สั่งขายเกินกว่าคงเหลือที่เสนอราคาของ ${orig.item_code} (คงเหลือแปลงได้ ${remaining})`);
    }
    return { quoteTransactionId: orig.header_id };
};

// เรียกหลัง SO บันทึกสำเร็จ (บรรทัดที่อ้างอิง Quote) ในทรานแซกชันเดียวกัน — คำนวณสถานะ Quote ใหม่จากผลรวมจำนวนที่
// แปลงเป็น SO แล้วเทียบกับจำนวนที่เสนอราคาทั้งหมด ไม่แตะสถานะ Closed/Void — มิเรอร์ refreshPrStatus ทุกประการ
const refreshQuoteStatus = async (client, quoteTransactionId) => {
    const statusRes = await client.query(`SELECT status FROM quote_transaction WHERE id=$1 FOR UPDATE`, [quoteTransactionId]);
    if (statusRes.rows.length === 0) return;
    if (!['Approved', 'PartiallyConverted', 'FullyConverted'].includes(statusRes.rows[0].status)) return;

    const sumRes = await client.query(`
        SELECT
            COALESCE(SUM(qtd.qty_quoted), 0) AS quoted,
            COALESCE(SUM((
                SELECT SUM(sod.qty_ordered) FROM so_transaction_detail sod
                JOIN so_transaction so ON so.id = sod.header_id
                WHERE sod.ref_quote_detail_id = qtd.id AND so.status NOT IN ('Void', 'Deleted')
            )), 0) AS converted
        FROM quote_transaction_detail qtd WHERE qtd.header_id = $1
    `, [quoteTransactionId]);
    const { quoted, converted } = sumRes.rows[0];
    let newStatus = 'Approved';
    if (Number(converted) > 0) {
        newStatus = Number(converted) < Number(quoted) ? 'PartiallyConverted' : 'FullyConverted';
    }
    await client.query(`UPDATE quote_transaction SET status=$1, updated_at=NOW() WHERE id=$2`, [newStatus, quoteTransactionId]);
};

module.exports = {
    ensureQuoteTransactionTable,
    fetchRows, fetchRow, fetchRowById, fetchConvertibleLines, fetchMyPending,
    createTransaction, updateTransaction, submitTransaction, approveTransaction, rejectTransaction,
    closeTransaction, voidTransaction, deleteTransaction, reverseTransaction,
    validateQuoteConvertibleQty, refreshQuoteStatus,
};
