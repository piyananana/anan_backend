// controllers/pr/prTransactionController.js — ใบขอซื้อ (Purchase Requisition, sys_module='51', อยู่ใต้โหนด PO เดิม)
// เอกสารขอ/อนุมัติภายในเท่านั้น — ไม่แตะ GL, ไม่แตะสต็อก, ไม่แตะผู้ขาย/คลังโดยจำเป็น (ต่างจาก PO ที่ทั้งสองฟิลด์บังคับ)
// workflow: Draft (แก้ไขได้) -> Submitted (เข้าคิวอนุมัติจริงผ่าน sa_module_approver/syncMenuApprovers มิเรอร์
// apPaymentRunController.js ทุกประการ) -> Approved/Rejected (Rejected แก้ไข+ส่งใหม่ได้เหมือน Draft) ->
// PartiallyConverted/FullyConverted (คำนวณอัตโนมัติจาก PO ที่อ้างอิงเข้ามา ไม่ใช่การกดเอง) -> Closed (กดปิดเอง
// ไม่ auto-close แม้แปลงครบ 100% — มิเรอร์ po_transaction ที่ Approve/Close ต้องเป็นการกดของคน) กิ่ง Void แยกได้
// จาก Draft/Rejected/Approved/PartiallyConverted แต่บล็อกถ้ามี PO อ้างอิงเข้ามาแล้ว (มิเรอร์ po_transaction เอง)
'use strict';

const { generateDocNo } = require('../im/imTransactionController');

const ensurePrTransactionTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS pr_transaction (
            id              SERIAL PRIMARY KEY,
            doc_id          INTEGER NOT NULL REFERENCES sa_module_document(id),
            doc_no          VARCHAR(50) NOT NULL,
            doc_code        VARCHAR(10) NOT NULL,
            doc_date        DATE NOT NULL,
            requested_by    INTEGER,
            vendor_id       INTEGER REFERENCES ap_vendor(id),
            vendor_code     VARCHAR(50),
            vendor_name_th  VARCHAR(255),
            warehouse_id    INTEGER REFERENCES im_warehouse(id),
            currency_id     INTEGER REFERENCES cd_currency(id),
            currency_code   VARCHAR(10) DEFAULT 'THB',
            exchange_rate   NUMERIC(15,6) NOT NULL DEFAULT 1,
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pr_transaction_date   ON pr_transaction(doc_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pr_transaction_status ON pr_transaction(status)`);

    await client.query(`
        CREATE TABLE IF NOT EXISTS pr_transaction_detail (
            id                SERIAL PRIMARY KEY,
            header_id         INTEGER NOT NULL REFERENCES pr_transaction(id) ON DELETE CASCADE,
            line_no           INTEGER NOT NULL,
            item_id           INTEGER NOT NULL REFERENCES im_item(id),
            item_code         VARCHAR(30),
            item_name         VARCHAR(200),
            uom_id            INTEGER REFERENCES im_uom(id),
            qty_requested     NUMERIC(18,4) NOT NULL,
            needed_by_date    DATE,
            estimated_unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
            total_value_lc    NUMERIC(18,4) NOT NULL DEFAULT 0,
            description       TEXT
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pr_transaction_detail_header ON pr_transaction_detail(header_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pr_transaction_detail_item   ON pr_transaction_detail(item_id)`);

    // มิเรอร์ ap_payment_run_approval ทุกประการ — ดูเหตุผล/รูปแบบใน apPaymentRunController.js
    await client.query(`
        CREATE TABLE IF NOT EXISTS pr_transaction_approval (
            id                  SERIAL PRIMARY KEY,
            header_id           INTEGER NOT NULL REFERENCES pr_transaction(id) ON DELETE CASCADE,
            approver_user_id    INTEGER NOT NULL,
            approver_user_name  VARCHAR(100),
            sequence_no         INTEGER NOT NULL,
            status              VARCHAR(20) NOT NULL DEFAULT 'Pending',
            remarks             TEXT,
            approved_at         TIMESTAMPTZ,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pr_transaction_approval_header ON pr_transaction_approval(header_id)`);

    // คอลัมน์อ้างอิงกลับที่ po_transaction/po_transaction_detail ต้องมีอยู่ก่อนจึง query qty_converted ได้ —
    // ALTER ไว้ที่นี่ด้วย (ไม่ require poTransactionController.js) เพื่อไม่ต้องพึ่งว่ามีคนเรียก endpoint ฝั่ง PO
    // มาก่อนแล้วเท่านั้น (ทั้งสองไฟล์ ALTER คอลัมน์เดียวกันแบบ idempotent ซ้ำกันได้อย่างปลอดภัย)
    await client.query(`ALTER TABLE po_transaction ADD COLUMN IF NOT EXISTS ref_pr_id INTEGER`);
    await client.query(`ALTER TABLE po_transaction_detail ADD COLUMN IF NOT EXISTS ref_pr_detail_id INTEGER`);

    // เผื่อตาราง pr_transaction ถูกสร้างไว้แล้วก่อนเพิ่มฟีลด์สกุลเงิน (CREATE TABLE IF NOT EXISTS ด้านบนจะไม่เพิ่ม
    // คอลัมน์ให้ตารางที่มีอยู่แล้ว) — รองรับการสั่งซื้อ/ขอซื้อสินค้าจากต่างประเทศเป็นสกุลเงินต่างประเทศได้
    await client.query(`ALTER TABLE pr_transaction ADD COLUMN IF NOT EXISTS currency_id INTEGER REFERENCES cd_currency(id)`);
    await client.query(`ALTER TABLE pr_transaction ADD COLUMN IF NOT EXISTS currency_code VARCHAR(10) DEFAULT 'THB'`);
    await client.query(`ALTER TABLE pr_transaction ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(15,6) NOT NULL DEFAULT 1`);
};

// --- Fetch helpers ---
const fetchRowById = async (pool, id) => {
    const hRes = await pool.query(`
        SELECT t.*,
               d.doc_code AS d_doc_code, d.doc_name_thai, d.doc_name_eng, d.is_auto_numbering,
               v.vendor_code AS v_vendor_code, v.vendor_name_th AS v_vendor_name_th,
               w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
               b.branch_code, b.branch_name_thai,
               u.user_name AS requested_by_name
        FROM pr_transaction t
        JOIN sa_module_document d ON d.id = t.doc_id
        LEFT JOIN ap_vendor v     ON v.id = t.vendor_id
        LEFT JOIN im_warehouse w  ON w.id = t.warehouse_id
        LEFT JOIN cd_branch b     ON b.id = t.branch_id
        LEFT JOIN sa_user u       ON u.id = t.requested_by
        WHERE t.id = $1`, [id]);
    if (hRes.rows.length === 0) return null;
    const dRes = await pool.query(`
        SELECT dt.*, u.uom_code,
               COALESCE((
                   SELECT SUM(pod.qty_ordered) FROM po_transaction_detail pod
                   JOIN po_transaction po ON po.id = pod.header_id
                   WHERE pod.ref_pr_detail_id = dt.id AND po.status <> 'Void'
               ), 0) AS qty_converted
        FROM pr_transaction_detail dt
        LEFT JOIN im_uom u ON u.id = dt.uom_id
        WHERE dt.header_id = $1 ORDER BY dt.line_no`, [id]);
    const aRes = await pool.query(`
        SELECT * FROM pr_transaction_approval WHERE header_id = $1 ORDER BY sequence_no`, [id]);
    return { ...hRes.rows[0], details: dRes.rows, approvals: aRes.rows };
};

// --- GET list ---
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensurePrTransactionTable(client);
        const { status, vendor_id, requested_by, date_from, date_to, search } = req.query;
        let query = `
            SELECT t.id, t.doc_no, t.doc_date, t.status, t.vendor_id, t.vendor_code, t.vendor_name_th,
                   t.warehouse_id, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                   t.requested_by, u.user_name AS requested_by_name,
                   t.total_qty, t.total_value_lc, t.description,
                   d.doc_code, d.doc_name_thai, d.doc_name_eng
            FROM pr_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            LEFT JOIN im_warehouse w  ON w.id = t.warehouse_id
            LEFT JOIN sa_user u       ON u.id = t.requested_by
            WHERE 1=1`;
        const params = [];
        let pi = 1;
        if (status)       { params.push(status);       query += ` AND t.status = $${pi++}`; }
        if (vendor_id)    { params.push(vendor_id);    query += ` AND t.vendor_id = $${pi++}`; }
        if (requested_by) { params.push(requested_by); query += ` AND t.requested_by = $${pi++}`; }
        if (date_from)    { params.push(date_from);    query += ` AND t.doc_date >= $${pi++}`; }
        if (date_to)      { params.push(date_to);      query += ` AND t.doc_date <= $${pi++}`; }
        if (search) {
            params.push(`%${search.toUpperCase()}%`);
            query += ` AND (UPPER(t.doc_no) LIKE $${pi} OR UPPER(COALESCE(t.vendor_name_th,'')) LIKE $${pi})`;
            pi++;
        }
        query += ` ORDER BY t.doc_date DESC, t.id DESC`;
        const result = await client.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching pr_transaction list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- GET one ---
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensurePrTransactionTable(client);
        const data = await fetchRowById(req.dbPool, req.params.id);
        if (!data) return res.status(404).json({ message: 'Not found.' });
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching pr_transaction row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- 1. Create (always Draft) ---
const createTransaction = async (req, res) => {
    const { header, details } = req.body;
    const userId = req.headers['userid'] || null;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensurePrTransactionTable(client);

        if (!details || details.length === 0) throw new Error('ต้องมีรายการขอซื้ออย่างน้อย 1 รายการ');

        let vendorCode = null, vendorNameTh = null;
        if (header.vendor_id) {
            const vendorRes = await client.query(`SELECT vendor_code, vendor_name_th FROM ap_vendor WHERE id=$1`, [header.vendor_id]);
            if (vendorRes.rows.length === 0) throw new Error('ไม่พบผู้ขายที่ระบุ');
            vendorCode = vendorRes.rows[0].vendor_code;
            vendorNameTh = vendorRes.rows[0].vendor_name_th;
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
            INSERT INTO pr_transaction
            (doc_id, doc_no, doc_code, doc_date, requested_by, vendor_id, vendor_code, vendor_name_th, warehouse_id,
             currency_id, currency_code, exchange_rate,
             description, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id, branch_id, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
            RETURNING id
        `, [
            header.doc_id, docNo, docCode, header.doc_date, header.requested_by || userId || null,
            header.vendor_id || null, vendorCode, vendorNameTh, header.warehouse_id || null,
            header.currency_id || null, header.currency_code || 'THB', header.exchange_rate || 1,
            header.description || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, userName,
        ]);
        const headerId = hRes.rows[0].id;

        let lineNo = 1, totalQty = 0, totalValue = 0;
        for (const d of details) {
            const qty = Number(d.qty_requested) || 0;
            const cost = Number(d.estimated_unit_cost) || 0;
            const value = qty * cost * (Number(header.exchange_rate) || 1);
            totalQty += qty;
            totalValue += value;
            await client.query(`
                INSERT INTO pr_transaction_detail
                (header_id, line_no, item_id, item_code, item_name, uom_id, qty_requested, needed_by_date, estimated_unit_cost, total_value_lc, description)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `, [headerId, lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                qty, d.needed_by_date || null, cost, value, d.description || null]);
        }
        await client.query(`UPDATE pr_transaction SET total_qty=$1, total_value_lc=$2 WHERE id=$3`, [totalQty, totalValue, headerId]);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, headerId);
        res.status(201).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating pr_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 2. Update (Draft/Rejected only — Rejected แก้ไข+ส่งใหม่ได้เหมือน Draft, ไม่แยกสถานะแก้ไขต่างหาก) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, details } = req.body;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM pr_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (!['Draft', 'Rejected'].includes(existing.rows[0].status)) throw new Error('แก้ไขได้เฉพาะเอกสาร Draft หรือ Rejected เท่านั้น');

        if (!details || details.length === 0) throw new Error('ต้องมีรายการขอซื้ออย่างน้อย 1 รายการ');

        let vendorCode = null, vendorNameTh = null;
        if (header.vendor_id) {
            const vendorRes = await client.query(`SELECT vendor_code, vendor_name_th FROM ap_vendor WHERE id=$1`, [header.vendor_id]);
            if (vendorRes.rows.length === 0) throw new Error('ไม่พบผู้ขายที่ระบุ');
            vendorCode = vendorRes.rows[0].vendor_code;
            vendorNameTh = vendorRes.rows[0].vendor_name_th;
        }

        await client.query(`
            UPDATE pr_transaction SET
                doc_date=$1, vendor_id=$2, vendor_code=$3, vendor_name_th=$4, warehouse_id=$5, description=$6,
                currency_id=$7, currency_code=$8, exchange_rate=$9,
                dim1_id=$10, dim2_id=$11, dim3_id=$12, dim4_id=$13, dim5_id=$14, branch_id=$15,
                status='Draft', updated_by=$16, updated_at=NOW()
            WHERE id=$17
        `, [
            header.doc_date, header.vendor_id || null, vendorCode, vendorNameTh, header.warehouse_id || null,
            header.description || null,
            header.currency_id || null, header.currency_code || 'THB', header.exchange_rate || 1,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, userName, id,
        ]);

        // แก้ไขแล้วถือว่าเป็นรอบ Draft ใหม่ — ล้างคิวอนุมัติเดิมทิ้ง (ถ้ามีจากรอบที่ถูกปฏิเสธ)
        await client.query(`DELETE FROM pr_transaction_approval WHERE header_id=$1`, [id]);

        await client.query(`DELETE FROM pr_transaction_detail WHERE header_id=$1`, [id]);
        let lineNo = 1, totalQty = 0, totalValue = 0;
        for (const d of details) {
            const qty = Number(d.qty_requested) || 0;
            const cost = Number(d.estimated_unit_cost) || 0;
            const value = qty * cost * (Number(header.exchange_rate) || 1);
            totalQty += qty;
            totalValue += value;
            await client.query(`
                INSERT INTO pr_transaction_detail
                (header_id, line_no, item_id, item_code, item_name, uom_id, qty_requested, needed_by_date, estimated_unit_cost, total_value_lc, description)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `, [id, lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                qty, d.needed_by_date || null, cost, value, d.description || null]);
        }
        await client.query(`UPDATE pr_transaction SET total_qty=$1, total_value_lc=$2 WHERE id=$3`, [totalQty, totalValue, id]);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating pr_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 3. Submit (Draft/Rejected -> Submitted, ข้ามไป Approved อัตโนมัติถ้าไม่มีผู้อนุมัติ) ---
// มิเรอร์ apPaymentRunController.js:submitRun ทุกประการ — คิวผู้อนุมัติ sync จาก sa_user_menu.can_approve ผ่าน
// syncMenuApprovers เมนูนี้ (PrTransactionScreen, sa_menu.uses_doc_type=false) ใช้คิวระดับเมนู (doc_type=NULL)
// เหมือน ap_payment_run — ถ้าในอนาคตตั้ง uses_doc_type=true ค่อยแยกคิวต่อประเภทเอกสารด้วย doc_code แทน
const submitTransaction = async (req, res) => {
    const { id } = req.params;
    const { menu_id } = req.body || {};
    const userName = req.headers['username'] || null;
    if (!menu_id) return res.status(400).json({ message: 'ต้องระบุ menu_id' });
    const client = await req.dbPool.connect();
    try {
        const { ensureMenuApproverSchema, syncMenuApprovers } = require('../../utils/menuApproverSync');
        await ensureMenuApproverSchema(client);
        await client.query('BEGIN');
        await ensurePrTransactionTable(client);

        const existing = await client.query(`SELECT status, doc_code FROM pr_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (!['Draft', 'Rejected'].includes(existing.rows[0].status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ส่งอนุมัติได้เฉพาะเอกสาร Draft หรือ Rejected เท่านั้น' });
        }

        const menuRes = await client.query(`SELECT approval_mode, uses_doc_type FROM sa_menu WHERE id=$1`, [menu_id]);
        const approvalMode = menuRes.rows[0]?.approval_mode === 'ANY' ? 'ANY' : 'ALL';
        const docType = menuRes.rows[0]?.uses_doc_type ? existing.rows[0].doc_code : null;

        await syncMenuApprovers(client, menu_id, docType);

        const approvers = await client.query(`
            SELECT a.approval_level, a.approver_user_id, u.user_name
            FROM sa_module_approver a
            JOIN sa_user u ON u.id = a.approver_user_id
            WHERE a.menu_id=$1 AND a.doc_type IS NOT DISTINCT FROM $2 AND a.is_active=true
            ORDER BY a.approval_level`, [menu_id, docType]);

        await client.query(`DELETE FROM pr_transaction_approval WHERE header_id=$1`, [id]);

        if (approvers.rows.length === 0) {
            // ไม่มีผู้มีสิทธิ์อนุมัติเลย — ข้ามขั้นตอนอนุมัติไปเลย ผ่านตรงไป Approved
            await client.query(`
                UPDATE pr_transaction SET status='Approved', approval_mode=$1, submitted_at=NOW(), submitted_by=$2,
                    updated_at=NOW(), updated_by=$2 WHERE id=$3`,
                [approvalMode, userName, id]);
            await client.query('COMMIT');
            const full = await fetchRowById(req.dbPool, id);
            return res.status(200).json(full);
        }

        await client.query(`
            UPDATE pr_transaction SET status='Submitted', approval_mode=$1, submitted_at=NOW(), submitted_by=$2,
                updated_at=NOW(), updated_by=$2 WHERE id=$3`,
            [approvalMode, userName, id]);
        for (const apr of approvers.rows) {
            await client.query(`
                INSERT INTO pr_transaction_approval (header_id, approver_user_id, approver_user_name, sequence_no, status)
                VALUES ($1,$2,$3,$4,'Pending')`,
                [id, apr.approver_user_id, apr.user_name, apr.approval_level]);
        }
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error submitting pr_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 4. Approve (Submitted -> Approved when all/any approve per approval_mode) ---
const approveTransaction = async (req, res) => {
    const { id } = req.params;
    const { remarks } = req.body || {};
    const userId = req.headers['userid'];
    const userName = req.headers['username'] || null;
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const pr = await client.query(`SELECT status, approval_mode FROM pr_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (pr.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (pr.rows[0].status !== 'Submitted') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'อนุมัติได้เฉพาะเอกสาร Submitted เท่านั้น' }); }
        const isAnyMode = pr.rows[0].approval_mode === 'ANY';

        const myRecord = await client.query(`
            SELECT a.id FROM pr_transaction_approval a
            WHERE a.header_id=$1 AND a.approver_user_id=$2 AND a.status='Pending'
              AND ($3::boolean OR NOT EXISTS (
                SELECT 1 FROM pr_transaction_approval a2
                WHERE a2.header_id=$1 AND a2.sequence_no < a.sequence_no AND a2.status='Pending'
              ))`, [id, userId, isAnyMode]);

        if (myRecord.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'ไม่มีสิทธิ์อนุมัติ หรือยังรอการอนุมัติจากลำดับก่อนหน้า' });
        }

        await client.query(`
            UPDATE pr_transaction_approval SET status='Approved', remarks=$1, approved_at=NOW() WHERE id=$2`,
            [remarks || null, myRecord.rows[0].id]);

        if (isAnyMode) {
            await client.query(
                `UPDATE pr_transaction_approval SET status='Skipped' WHERE header_id=$1 AND status='Pending'`, [id]);
            await client.query(
                `UPDATE pr_transaction SET status='Approved', updated_at=NOW(), updated_by=$1 WHERE id=$2`,
                [userName, id]);
        } else {
            const remaining = await client.query(
                `SELECT COUNT(*) FROM pr_transaction_approval WHERE header_id=$1 AND status='Pending'`, [id]);
            if (parseInt(remaining.rows[0].count) === 0) {
                await client.query(
                    `UPDATE pr_transaction SET status='Approved', updated_at=NOW(), updated_by=$1 WHERE id=$2`,
                    [userName, id]);
            }
        }
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error approving pr_transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- 5. Reject (Submitted -> Rejected — แก้ไข+ส่งใหม่ได้เหมือน Draft, ไม่ย้อนกลับไปเป็น Draft ตรงๆ เพื่อให้
// เห็นประวัติว่าเคยถูกปฏิเสธ) ---
const rejectTransaction = async (req, res) => {
    const { id } = req.params;
    const { remarks } = req.body || {};
    const userId = req.headers['userid'];
    const userName = req.headers['username'] || null;
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const pr = await client.query(`SELECT status FROM pr_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (pr.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (pr.rows[0].status !== 'Submitted') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ปฏิเสธได้เฉพาะเอกสาร Submitted เท่านั้น' }); }

        const myRecord = await client.query(`
            SELECT id FROM pr_transaction_approval
            WHERE header_id=$1 AND approver_user_id=$2 AND status='Pending'`, [id, userId]);
        if (myRecord.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'ไม่มีสิทธิ์ปฏิเสธ หรืออนุมัติไปแล้ว' });
        }

        await client.query(`
            UPDATE pr_transaction_approval SET status='Rejected', remarks=$1, approved_at=NOW() WHERE id=$2`,
            [remarks || null, myRecord.rows[0].id]);
        await client.query(`
            UPDATE pr_transaction_approval SET status='Skipped' WHERE header_id=$1 AND status='Pending'`, [id]);
        await client.query(`
            UPDATE pr_transaction SET status='Rejected', updated_at=NOW(), updated_by=$1 WHERE id=$2`,
            [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error rejecting pr_transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- 6. Close (Approved/PartiallyConverted/FullyConverted -> Closed) ---
const closeTransaction = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM pr_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (!['Approved', 'PartiallyConverted', 'FullyConverted'].includes(existing.rows[0].status)) {
            throw new Error('ปิดได้เฉพาะเอกสารสถานะ Approved, PartiallyConverted หรือ FullyConverted เท่านั้น');
        }
        await client.query(`UPDATE pr_transaction SET status='Closed', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error closing pr_transaction:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 7. Void (Draft/Rejected/Approved/PartiallyConverted -> Void — บล็อกถ้ามี PO อ้างอิงแล้ว) ---
const voidTransaction = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM pr_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (!['Draft', 'Rejected', 'Approved', 'PartiallyConverted'].includes(existing.rows[0].status)) {
            throw new Error('ยกเลิกได้เฉพาะเอกสารสถานะ Draft, Rejected, Approved หรือ PartiallyConverted เท่านั้น (FullyConverted ต้องปิดเอกสารแทนการยกเลิก)');
        }
        const convertedRes = await client.query(`
            SELECT COUNT(*) FROM po_transaction_detail pod
            JOIN po_transaction po ON po.id = pod.header_id
            JOIN pr_transaction_detail prd ON prd.id = pod.ref_pr_detail_id
            WHERE prd.header_id = $1 AND po.status <> 'Void'
        `, [id]);
        if (Number(convertedRes.rows[0].count) > 0) {
            throw new Error('ไม่สามารถยกเลิกได้ เนื่องจากมีใบสั่งซื้อ (PO) อ้างอิงใบขอซื้อนี้ไปแล้ว');
        }
        await client.query(`UPDATE pr_transaction SET status='Void', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error voiding pr_transaction:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 8. Delete (Draft only) ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM pr_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (existing.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ลบได้เฉพาะเอกสาร Draft เท่านั้น' }); }
        await client.query(`DELETE FROM pr_transaction WHERE id=$1`, [id]);
        await client.query('COMMIT');
        res.status(204).send();
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting pr_transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- GET pr_transaction pending current user's approval ---
const fetchMyPending = async (req, res) => {
    const userId = req.headers['userid'];
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    try {
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.description, t.total_value_lc, t.status
            FROM pr_transaction t
            WHERE t.status = 'Submitted'
              AND EXISTS (
                SELECT 1 FROM pr_transaction_approval a
                WHERE a.header_id = t.id AND a.approver_user_id = $1 AND a.status = 'Pending'
              )
            ORDER BY t.doc_date DESC, t.id DESC`, [userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching pr_transaction my_pending:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /pr_transaction/convertible_lines?search= — PR ที่ Approved/PartiallyConverted พร้อมจำนวนคงเหลือที่แปลงเป็น
// PO ได้ต่อบรรทัด ใช้โดย document picker ในหน้าจอ PO (อ้างอิง PR) — สูตรเดียวกับ validatePrConvertibleQty
const fetchConvertibleLines = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensurePrTransactionTable(client);
        const { search } = req.query;
        let query = `
            SELECT t.id AS header_id, t.doc_no, t.doc_date, t.status, t.currency_code, t.exchange_rate,
                   dt.id AS detail_id, dt.line_no, dt.item_id, dt.item_code, dt.item_name, dt.uom_id,
                   dt.qty_requested, dt.estimated_unit_cost, u.uom_code,
                   COALESCE((
                       SELECT SUM(pod.qty_ordered) FROM po_transaction_detail pod
                       JOIN po_transaction po ON po.id = pod.header_id
                       WHERE pod.ref_pr_detail_id = dt.id AND po.status <> 'Void'
                   ), 0) AS qty_converted
            FROM pr_transaction_detail dt
            JOIN pr_transaction t ON t.id = dt.header_id
            LEFT JOIN im_uom u ON u.id = dt.uom_id
            WHERE t.status IN ('Approved', 'PartiallyConverted')`;
        const params = [];
        let pi = 1;
        if (search) { params.push(`%${search.toUpperCase()}%`); query += ` AND UPPER(t.doc_no) LIKE $${pi++}`; }
        query += ` ORDER BY t.doc_date DESC, t.id DESC, dt.line_no`;
        const result = await client.query(query, params);
        const lines = result.rows
            .map(r => ({ ...r, qty_remaining: Number(r.qty_requested) - Number(r.qty_converted) }))
            .filter(r => r.qty_remaining > 0.0001);
        res.status(200).json(lines);
    } catch (error) {
        console.error('Error fetching pr_transaction convertible_lines:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- Cross-module helpers, called from poTransactionController.js's line-save path ---

// มิเรอร์ validatePoReceivableQty ใน poTransactionController.js ทุกประการ — ดูเหตุผลเรื่อง computed-on-read ที่นั่น
const validatePrConvertibleQty = async (client, { refPrDetailId, requestedQty }) => {
    const origRes = await client.query(`
        SELECT prd.qty_requested, prd.item_code, prd.header_id, pr.status AS pr_status
        FROM pr_transaction_detail prd JOIN pr_transaction pr ON pr.id = prd.header_id
        WHERE prd.id = $1
    `, [refPrDetailId]);
    if (origRes.rows.length === 0) throw new Error('ไม่พบรายการใบขอซื้อต้นฉบับที่อ้างอิง');
    const orig = origRes.rows[0];
    if (!['Approved', 'PartiallyConverted'].includes(orig.pr_status)) {
        throw new Error(`ใบขอซื้อ ${orig.item_code} ต้องอยู่สถานะ Approved หรือ PartiallyConverted เท่านั้นจึงจะแปลงเป็น PO เพิ่มได้`);
    }
    const convertedRes = await client.query(`
        SELECT COALESCE(SUM(pod.qty_ordered), 0) AS converted
        FROM po_transaction_detail pod JOIN po_transaction po ON po.id = pod.header_id
        WHERE pod.ref_pr_detail_id = $1 AND po.status <> 'Void'
    `, [refPrDetailId]);
    const remaining = Number(orig.qty_requested) - Number(convertedRes.rows[0].converted);
    if (requestedQty > remaining + 0.0001) {
        throw new Error(`จำนวนที่สั่งซื้อเกินกว่าคงเหลือที่ขอซื้อของ ${orig.item_code} (คงเหลือแปลงได้ ${remaining})`);
    }
    return { prTransactionId: orig.header_id };
};

// เรียกหลัง PO บันทึกสำเร็จ (บรรทัดที่อ้างอิง PR) ในทรานแซกชันเดียวกัน — คำนวณสถานะ PR ใหม่จากผลรวมจำนวนที่แปลง
// เป็น PO แล้วเทียบกับจำนวนที่ขอทั้งหมด ไม่แตะสถานะ Closed/Void (ถือว่าเป็นการตัดสินใจของคนแล้ว)
const refreshPrStatus = async (client, prTransactionId) => {
    const statusRes = await client.query(`SELECT status FROM pr_transaction WHERE id=$1 FOR UPDATE`, [prTransactionId]);
    if (statusRes.rows.length === 0) return;
    if (!['Approved', 'PartiallyConverted', 'FullyConverted'].includes(statusRes.rows[0].status)) return;

    const sumRes = await client.query(`
        SELECT
            COALESCE(SUM(prd.qty_requested), 0) AS requested,
            COALESCE(SUM((
                SELECT SUM(pod.qty_ordered) FROM po_transaction_detail pod
                JOIN po_transaction po ON po.id = pod.header_id
                WHERE pod.ref_pr_detail_id = prd.id AND po.status <> 'Void'
            )), 0) AS converted
        FROM pr_transaction_detail prd WHERE prd.header_id = $1
    `, [prTransactionId]);
    const { requested, converted } = sumRes.rows[0];
    let newStatus = 'Approved';
    if (Number(converted) > 0) {
        newStatus = Number(converted) < Number(requested) ? 'PartiallyConverted' : 'FullyConverted';
    }
    await client.query(`UPDATE pr_transaction SET status=$1, updated_at=NOW() WHERE id=$2`, [newStatus, prTransactionId]);
};

module.exports = {
    ensurePrTransactionTable,
    fetchRows, fetchRow, fetchRowById, fetchConvertibleLines, fetchMyPending,
    createTransaction, updateTransaction, submitTransaction, approveTransaction, rejectTransaction,
    closeTransaction, voidTransaction, deleteTransaction,
    validatePrConvertibleQty, refreshPrStatus,
};
