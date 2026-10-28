// controllers/po/poPrTransactionController.js — ใบขอซื้อ (Purchase Requisition, sys_module='51', อยู่ใต้โหนด PO เดิม)
// ย้ายมารวมกับโฟลเดอร์ po (เดิมอยู่ controllers/pr/) เพราะ PR เป็นส่วนหนึ่งของ workflow จัดซื้อเดียวกับ PO —
// ชื่อฟังก์ชัน/export/schema/URL sub-path (/pr_transaction/...) ทั้งหมดยังคงเดิมทุกประการ ย้ายแค่ตำแหน่งไฟล์
// เอกสารขอ/อนุมัติภายในเท่านั้น — ไม่แตะ GL, ไม่แตะสต็อก, ไม่แตะผู้ขาย/คลังโดยจำเป็น (ต่างจาก PO ที่ทั้งสองฟิลด์บังคับ)
// workflow: Draft (แก้ไขได้) -> Submitted (เข้าคิวอนุมัติจริงผ่าน sa_module_approver/syncMenuApprovers มิเรอร์
// apPaymentRunController.js ทุกประการ) -> Approved/Rejected (Rejected แก้ไข+ส่งใหม่ได้เหมือน Draft) ->
// PartiallyConverted/FullyConverted (คำนวณอัตโนมัติจาก PO ที่อ้างอิงเข้ามา ไม่ใช่การกดเอง) -> Closed (กดปิดเอง
// ไม่ auto-close แม้แปลงครบ 100% — มิเรอร์ po_transaction ที่ Approve/Close ต้องเป็นการกดของคน) กิ่ง Void แยกได้
// จาก Draft/Rejected/Approved/PartiallyConverted แต่บล็อกถ้ามี PO อ้างอิงเข้ามาแล้ว (มิเรอร์ po_transaction เอง)
'use strict';

const { generateDocNo } = require('../im/imTransactionController');
const { getBaseCurrencyCode } = require('../../utils/baseCurrency');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
const { reasonOf, userIdOf, sendErr, blk } = require('../../utils/docAction');
const DA = require('../../utils/docApproval');
const KIND = 'PR';

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

    // คิวผู้อนุมัติอยู่ที่ตารางกลาง doc_approval (utils/docApproval.js, doc_kind 'PR') — ตาราง pr_transaction_approval เดิมเลิกใช้แล้ว

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
    // ยกเลิกแบบมีเหตุผล (sql/pr_transaction_reverse_to_draft.sql)
    await client.query(`
        ALTER TABLE pr_transaction
            ADD COLUMN IF NOT EXISTS void_reason TEXT,
            ADD COLUMN IF NOT EXISTS voided_by   VARCHAR(100),
            ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ`);
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
                   WHERE pod.ref_pr_detail_id = dt.id AND po.status NOT IN ('Void', 'Deleted')
               ), 0) AS qty_converted
        FROM pr_transaction_detail dt
        LEFT JOIN im_uom u ON u.id = dt.uom_id
        WHERE dt.header_id = $1 ORDER BY dt.line_no`, [id]);
    await DA.ensureDocApprovalSchema(pool);
    return { ...hRes.rows[0], details: dRes.rows, approvals: await DA.loadApprovals(pool, KIND, Number(id)) };
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
        else query += ` AND t.status <> 'Deleted'`; // ใบที่ลบแล้วแสดงเฉพาะเมื่อเลือกสถานะ Deleted
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
        Object.assign(data, await computeBlocks(client, req.params.id));
        data.reverse_history = await getReverseHistory(client, 'pr_transaction', req.params.id);
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
            header.currency_id || null, header.currency_code || await getBaseCurrencyCode(client), header.exchange_rate || 1,
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
            header.currency_id || null, header.currency_code || await getBaseCurrencyCode(client), header.exchange_rate || 1,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, userName, id,
        ]);

        // แก้ไขแล้วถือว่าเป็นรอบ Draft ใหม่ — ล้างคิวอนุมัติเดิมทิ้ง (ถ้ามีจากรอบที่ถูกปฏิเสธ)
        await DA.ensureDocApprovalSchema(client);
        await client.query(`DELETE FROM doc_approval WHERE doc_kind=$1 AND record_id=$2`, [KIND, Number(id)]);

        // แก้ไขบรรทัดแบบ diff (UPDATE ของเดิม / INSERT ใหม่ / DELETE ที่ถูกลบ) แทนการ DELETE ทั้งหมดแล้ว INSERT ใหม่
        // ทุกครั้ง — เดิมทำให้ id ของทุกบรรทัดเปลี่ยนทุกครั้งที่ save แม้ไม่ได้แก้ไขอะไรเลย ซึ่งทำให้สิ่งที่ผูกกับ
        // id บรรทัดตรงๆ (เช่น ไฟล์แนบใน sa_attachment) หลุดหายทุกครั้งที่แก้ไขเอกสาร
        const existingIdsRes = await client.query(`SELECT id FROM pr_transaction_detail WHERE header_id=$1`, [id]);
        const existingIds = new Set(existingIdsRes.rows.map(r => r.id));
        const incomingIds = new Set(details.filter(d => d.id).map(d => d.id));
        const removedIds = [...existingIds].filter(x => !incomingIds.has(x));

        if (removedIds.length > 0) {
            const { deleteAttachmentsForEntities } = require('../sa/saAttachmentController');
            await deleteAttachmentsForEntities(client, 'pr_transaction_detail', removedIds);
            await client.query(`DELETE FROM pr_transaction_detail WHERE id = ANY($1::int[])`, [removedIds]);
        }

        let lineNo = 1, totalQty = 0, totalValue = 0;
        for (const d of details) {
            const qty = Number(d.qty_requested) || 0;
            const cost = Number(d.estimated_unit_cost) || 0;
            const value = qty * cost * (Number(header.exchange_rate) || 1);
            totalQty += qty;
            totalValue += value;
            if (d.id && existingIds.has(d.id)) {
                await client.query(`
                    UPDATE pr_transaction_detail SET
                        line_no=$1, item_id=$2, item_code=$3, item_name=$4, uom_id=$5, qty_requested=$6,
                        needed_by_date=$7, estimated_unit_cost=$8, total_value_lc=$9, description=$10
                    WHERE id=$11
                `, [lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                    qty, d.needed_by_date || null, cost, value, d.description || null, d.id]);
            } else {
                await client.query(`
                    INSERT INTO pr_transaction_detail
                    (header_id, line_no, item_id, item_code, item_name, uom_id, qty_requested, needed_by_date, estimated_unit_cost, total_value_lc, description)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                `, [id, lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                    qty, d.needed_by_date || null, cost, value, d.description || null]);
            }
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
        await ensurePrTransactionTable(client);
        const t = (await client.query(`SELECT * FROM pr_transaction WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!t) throw DA.httpErr(404, 'Not found');
        await work(client, t, ctx);
        await client.query('COMMIT');
        res.status(200).json(await fetchRowById(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK');
        if (!error.status) console.error(`Error ${label} pr_transaction:`, error);
        res.status(error.status || 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

const markApproved = (client, id, userName) => client.query(`
    UPDATE pr_transaction SET status='Approved', updated_at=NOW(), updated_by=$1 WHERE id=$2`, [userName, id]);

const submitTransaction = approvalAction('submitting', async (client, t, { menuId, userName }) => {
    if (!['Draft', 'Rejected'].includes(t.status)) throw DA.httpErr(400, 'ส่งอนุมัติได้เฉพาะเอกสาร Draft หรือ Rejected เท่านั้น');
    const q = await DA.buildQueue(client, { kind: KIND, recordId: t.id, menuId, docCode: t.doc_code });
    await client.query(`
        UPDATE pr_transaction SET status='Submitted', approval_mode=$1, submitted_at=NOW(), submitted_by=$2,
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
    await client.query(`UPDATE pr_transaction SET status='Rejected', updated_at=NOW(), updated_by=$1 WHERE id=$2`, [userName, t.id]);
});

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

// --- ถอย / ยกเลิก / ลบ: เงื่อนไข ---
// ใบสั่งซื้อที่แปลงจากใบนี้ (ทุกสถานะยกเว้น Void/Deleted — รวมร่าง เพราะแก้ร่างใบขอซื้อจะสร้างบรรทัดใหม่)
const refDocsOf = async (client, id) => (await client.query(`
    SELECT string_agg(DISTINCT t.doc_no, ', ') AS docs
      FROM po_transaction_detail td JOIN po_transaction t ON t.id = td.header_id
      JOIN pr_transaction_detail d ON d.id = td.ref_pr_detail_id
     WHERE d.header_id = $1 AND t.status NOT IN ('Void', 'Deleted')`, [id])).rows[0].docs;

const computeBlocks = async (client, id) => {
    const t = (await client.query(`SELECT status FROM pr_transaction WHERE id = $1`, [id])).rows[0];
    if (!t) return {};
    const refs = await refDocsOf(client, id);
    const voided = blk('VOIDED', 'ใบขอซื้อนี้ถูกยกเลิกหรือลบแล้ว');
    const refBlock = refs
        ? blk('REF_DOCS', `มีใบสั่งซื้อแปลงจากใบขอซื้อนี้ (${refs}) ต้องถอยและลบใบสั่งซื้อเหล่านั้นก่อน`, refs)
        : null;
    const out = { reverse_block: null, void_block: null, delete_block: null };
    switch (t.status) {
        case 'Submitted': out.reverse_block = refBlock; out.void_block = blk('NOT_APPROVED', 'ใบขอซื้อที่รออนุมัติให้ถอยเป็นร่างแล้วลบแทนการยกเลิก'); break;
        case 'Approved': out.reverse_block = refBlock; out.void_block = refBlock; break;
        case 'Closed': out.void_block = blk('NOT_APPROVED', 'ใบขอซื้อที่ปิดแล้วยกเลิกไม่ได้ ถอยการปิดก่อน'); break;
        case 'PartiallyConverted':
        case 'FullyConverted':
            out.reverse_block = blk('REF_DOCS', `มีใบสั่งซื้อแปลงจากใบนี้แล้ว (${refs || '-'}) ถอยใบสั่งซื้อก่อน หรือปิดใบขอซื้อแทน`, refs);
            out.void_block = out.reverse_block;
            break;
        case 'Draft':
        case 'Rejected':
            out.reverse_block = blk('NOT_REVERSIBLE', 'ถอยได้เฉพาะใบขอซื้อที่ส่งอนุมัติ อนุมัติแล้ว หรือปิดแล้ว');
            out.void_block = blk('NOT_POSTED', 'ใบขอซื้อที่ยังไม่อนุมัติให้ลบแทนการยกเลิก');
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
        await ensurePrTransactionTable(client);
        const t = (await client.query(`SELECT * FROM pr_transaction WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!t) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeBlocks(client, id))[kind];
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }
        const userName = req.headers.username || null;
        const toStatus = await work(client, t, { reason, userName });
        await logReverse(client, {
            sysModule: '51', tableName: 'pr_transaction', recordId: Number(id), docNo: t.doc_no,
            fromStatus: t.status, toStatus, reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        if (toStatus === 'Deleted') return res.status(200).json({ message: 'Deleted' });
        res.status(200).json(await fetchRowById(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error ${kind} pr_transaction:`, error);
        sendErr(res, 500, error.message || 'Internal server error');
    } finally { client.release(); }
};

// --- 7. ถอย (ต้องมีเหตุผล) ---
// Submitted / Approved -> Draft: ยังไม่มีใบสั่งซื้อแปลงจากใบนี้ ผู้อนุมัติที่ยังไม่ตัดสินถูกข้าม แก้ไขแล้วส่งอนุมัติใหม่ได้
// Closed -> เปิดใหม่: สถานะคำนวณจากใบสั่งซื้อที่แปลงไปแล้ว (Approved / PartiallyConverted / FullyConverted)
const reverseTransaction = (req, res) => lockedAction(req, res, 'reverse_block', 'การถอยเอกสาร', async (client, t, { userName }) => {
    if (['Submitted', 'Approved'].includes(t.status)) {
        await DA.ensureDocApprovalSchema(client);
        await DA.skipPending(client, KIND, t.id);
        await client.query(`
            UPDATE pr_transaction SET status='Draft', submitted_at=NULL, submitted_by=NULL, updated_by=$1, updated_at=NOW()
             WHERE id=$2`, [userName, t.id]);
        return 'Draft';
    }
    await client.query(`UPDATE pr_transaction SET status='Approved', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, t.id]);
    await refreshPrStatus(client, t.id);
    return (await client.query(`SELECT status FROM pr_transaction WHERE id=$1`, [t.id])).rows[0].status;
});

// --- 8. ยกเลิก (Approved เท่านั้น ต้องมีเหตุผล — บล็อกถ้ามีใบสั่งซื้อแปลงจากใบนี้) ---
const voidTransaction = (req, res) => lockedAction(req, res, 'void_block', 'การยกเลิก', async (client, t, { reason, userName }) => {
    await client.query(`
        UPDATE pr_transaction SET status='Void', void_reason=$1, voided_by=$2, voided_at=NOW(), updated_by=$2, updated_at=NOW()
         WHERE id=$3`, [reason, userName, t.id]);
    return 'Void';
});

// --- 9. ลบ (Draft/Rejected ต้องมีเหตุผล — เก็บไว้ด้วยสถานะ Deleted ตรวจสอบได้แต่นำกลับมาใช้ไม่ได้) ---
const deleteTransaction = (req, res) => lockedAction(req, res, 'delete_block', 'การลบ', async (client, t, { userName }) => {
    await client.query(`UPDATE pr_transaction SET status='Deleted', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, t.id]);
    return 'Deleted';
});

// --- GET pr_transaction pending current user's approval ---
const fetchMyPending = async (req, res) => {
    const userId = Number(req.headers['userid']);
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    try {
        await DA.ensureDocApprovalSchema(req.dbPool);
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.description, t.total_value_lc, t.status, t.submitted_by
            FROM pr_transaction t
            WHERE t.status = 'Submitted' AND ${DA.myTurnSql('t', '$1', '$2')}
            ORDER BY t.doc_date DESC, t.id DESC`, [KIND, userId]);
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
                       WHERE pod.ref_pr_detail_id = dt.id AND po.status NOT IN ('Void', 'Deleted')
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
        WHERE pod.ref_pr_detail_id = $1 AND po.status NOT IN ('Void', 'Deleted')
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
                WHERE pod.ref_pr_detail_id = prd.id AND po.status NOT IN ('Void', 'Deleted')
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
    closeTransaction, voidTransaction, deleteTransaction, reverseTransaction,
    validatePrConvertibleQty, refreshPrStatus,
};
