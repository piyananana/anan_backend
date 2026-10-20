// controllers/po/poTransactionController.js — ใบสั่งซื้อ (Purchase Order, sys_module='51')
// เอกสารข้อผูกพันกับผู้ขายเท่านั้น — ไม่แตะ GL, ไม่แตะสต็อกเลย (ต่างจาก GRN/im_transaction ทุกประการ) ผลกระทบจริง
// ต่อสต็อก/บัญชียังเกิดที่ GRN เหมือนเดิม — PO แค่เป็นข้อผูกพัน+ต้นทาง reference ให้ GRN อ้างอิงกลับมา (ดู ref_po_id/
// ref_po_detail_id ใน imTransactionController.js) workflow: Draft (แก้ไขได้) -> Submitted (คิวผู้อนุมัติของเมนู
// utils/docApproval.js, doc_kind 'PO' — Rejected แก้ไข+ส่งใหม่ได้เหมือน Draft) -> Approved (ผูกพันแล้ว, GRN
// อ้างอิงได้) -> PartiallyReceived (คำนวณอัตโนมัติจาก GRN ที่อ้างอิงเข้ามา ไม่ใช่การกดเอง) -> Closed (กดปิดเอง เมื่อ
// ไม่มีการรับเพิ่มแล้ว ไม่ auto-close แม้รับครบ 100% — มิเรอร์ im_stock_count ที่ Approve/Close ต้องเป็นการกดของคน)
// กิ่ง Void แยกจาก Draft/Approved/PartiallyReceived ได้ แต่บล็อกถ้ามี GRN Posted/Received อ้างอิงเข้ามาแล้ว
// (มิเรอร์ paid/applied guard ที่ใช้ทั่วทั้งระบบสำหรับ "จะย้อนไม่ได้ถ้ามีอะไรอ้างอิงไปแล้ว")
'use strict';

const { generateDocNo } = require('../im/imTransactionController');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
const { reasonOf, userIdOf, sendErr, blk } = require('../../utils/docAction');
const DA = require('../../utils/docApproval');
const KIND = 'PO';

const ensurePoTransactionTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS po_transaction (
            id              SERIAL PRIMARY KEY,
            doc_id          INTEGER NOT NULL REFERENCES sa_module_document(id),
            doc_no          VARCHAR(50) NOT NULL,
            doc_code        VARCHAR(10) NOT NULL,
            doc_date        DATE NOT NULL,
            vendor_id       INTEGER NOT NULL REFERENCES ap_vendor(id),
            vendor_code     VARCHAR(50),
            vendor_name_th  VARCHAR(255),
            warehouse_id    INTEGER NOT NULL REFERENCES im_warehouse(id),
            currency_id     INTEGER REFERENCES cd_currency(id),
            currency_code   VARCHAR(10) DEFAULT 'THB',
            exchange_rate   NUMERIC(15,6) NOT NULL DEFAULT 1,
            due_date        DATE,
            status          VARCHAR(20) NOT NULL DEFAULT 'Draft',
            total_qty       NUMERIC(18,4) NOT NULL DEFAULT 0,
            total_value_lc  NUMERIC(18,4) NOT NULL DEFAULT 0,
            description     TEXT,
            dim1_id INTEGER, dim2_id INTEGER, dim3_id INTEGER, dim4_id INTEGER, dim5_id INTEGER,
            branch_id       INTEGER REFERENCES cd_branch(id),
            approved_at     TIMESTAMPTZ,
            approved_by     VARCHAR(100),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by      VARCHAR(100),
            updated_by      VARCHAR(100)
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_po_transaction_date   ON po_transaction(doc_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_po_transaction_status ON po_transaction(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_po_transaction_vendor ON po_transaction(vendor_id)`);
    // อ้างอิงใบขอซื้อ (PR) ต้นทาง — สะดวก/แสดงผลเท่านั้น การตรวจสอบจริงใช้ ref_pr_detail_id รายบรรทัดด้านล่าง
    // (มิเรอร์ ref_po_id/ref_po_detail_id ที่ im_transaction ใช้อ้างอิงกลับมาที่ po_transaction)
    await client.query(`ALTER TABLE po_transaction ADD COLUMN IF NOT EXISTS ref_pr_id INTEGER`);

    await client.query(`
        CREATE TABLE IF NOT EXISTS po_transaction_detail (
            id             SERIAL PRIMARY KEY,
            header_id      INTEGER NOT NULL REFERENCES po_transaction(id) ON DELETE CASCADE,
            line_no        INTEGER NOT NULL,
            item_id        INTEGER NOT NULL REFERENCES im_item(id),
            item_code      VARCHAR(30),
            item_name      VARCHAR(200),
            uom_id         INTEGER REFERENCES im_uom(id),
            qty_ordered    NUMERIC(18,4) NOT NULL,
            unit_price_fc  NUMERIC(18,4) NOT NULL DEFAULT 0,
            total_value_lc NUMERIC(18,4) NOT NULL DEFAULT 0,
            description    TEXT
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_po_transaction_detail_header ON po_transaction_detail(header_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_po_transaction_detail_item   ON po_transaction_detail(item_id)`);
    // บรรทัดนี้แปลงมาจากบรรทัดใบขอซื้อ (PR) ใบไหน — ใช้ตรวจคงเหลือที่แปลงได้ผ่าน validatePrConvertibleQty
    // (nullable — บรรทัด PO ที่เพิ่มเองโดยไม่มีต้นทางจาก PR ไม่ต้องมีค่านี้)
    await client.query(`ALTER TABLE po_transaction_detail ADD COLUMN IF NOT EXISTS ref_pr_detail_id INTEGER`);
    // ยกเลิกแบบมีเหตุผล (sql/po_transaction_reverse_to_draft.sql)
    await client.query(`
        ALTER TABLE po_transaction
            ADD COLUMN IF NOT EXISTS void_reason TEXT,
            ADD COLUMN IF NOT EXISTS voided_by   VARCHAR(100),
            ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ`);
    // คิวผู้อนุมัติ (utils/docApproval.js)
    await client.query(`
        ALTER TABLE po_transaction
            ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(10) DEFAULT 'ALL',
            ADD COLUMN IF NOT EXISTS submitted_at  TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS submitted_by  VARCHAR(100)`);
};

// --- Fetch helpers ---
const fetchRowById = async (pool, id) => {
    const hRes = await pool.query(`
        SELECT t.*,
               d.doc_code AS d_doc_code, d.doc_name_thai, d.doc_name_eng, d.is_auto_numbering,
               v.vendor_code AS v_vendor_code, v.vendor_name_th AS v_vendor_name_th,
               w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
               b.branch_code, b.branch_name_thai,
               pr.doc_no AS ref_pr_doc_no
        FROM po_transaction t
        JOIN sa_module_document d ON d.id = t.doc_id
        LEFT JOIN ap_vendor v     ON v.id = t.vendor_id
        LEFT JOIN im_warehouse w  ON w.id = t.warehouse_id
        LEFT JOIN cd_branch b     ON b.id = t.branch_id
        LEFT JOIN pr_transaction pr ON pr.id = t.ref_pr_id
        WHERE t.id = $1`, [id]);
    if (hRes.rows.length === 0) return null;
    const dRes = await pool.query(`
        SELECT dt.*, u.uom_code,
               COALESCE((
                   SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                   JOIN im_transaction imt ON imt.id = imd.header_id
                   WHERE imd.ref_po_detail_id = dt.id AND imt.status IN ('Posted', 'Received')
               ), 0) AS qty_received
        FROM po_transaction_detail dt
        LEFT JOIN im_uom u ON u.id = dt.uom_id
        WHERE dt.header_id = $1 ORDER BY dt.line_no`, [id]);
    await DA.ensureDocApprovalSchema(pool);
    return { ...hRes.rows[0], details: dRes.rows, approvals: await DA.loadApprovals(pool, KIND, Number(id)) };
};

// --- GET list ---
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensurePoTransactionTable(client);
        const { status, vendor_id, date_from, date_to, search } = req.query;
        let query = `
            SELECT t.id, t.doc_no, t.doc_date, t.status, t.vendor_id, t.vendor_code, t.vendor_name_th,
                   t.warehouse_id, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                   t.total_qty, t.total_value_lc, t.due_date, t.description,
                   d.doc_code, d.doc_name_thai, d.doc_name_eng
            FROM po_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            LEFT JOIN im_warehouse w  ON w.id = t.warehouse_id
            WHERE 1=1`;
        const params = [];
        let pi = 1;
        if (status)     { params.push(status);     query += ` AND t.status = $${pi++}`; }
        else query += ` AND t.status <> 'Deleted'`; // ใบที่ลบแล้วแสดงเฉพาะเมื่อเลือกสถานะ Deleted
        if (vendor_id)  { params.push(vendor_id);  query += ` AND t.vendor_id = $${pi++}`; }
        if (date_from)  { params.push(date_from);  query += ` AND t.doc_date >= $${pi++}`; }
        if (date_to)    { params.push(date_to);    query += ` AND t.doc_date <= $${pi++}`; }
        if (search) {
            params.push(`%${search.toUpperCase()}%`);
            query += ` AND (UPPER(t.doc_no) LIKE $${pi} OR UPPER(COALESCE(t.vendor_name_th,'')) LIKE $${pi})`;
            pi++;
        }
        query += ` ORDER BY t.doc_date DESC, t.id DESC`;
        const result = await client.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching po_transaction list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- GET one ---
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensurePoTransactionTable(client);
        const data = await fetchRowById(req.dbPool, req.params.id);
        if (!data) return res.status(404).json({ message: 'Not found.' });
        Object.assign(data, await computeBlocks(client, req.params.id));
        data.reverse_history = await getReverseHistory(client, 'po_transaction', req.params.id);
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching po_transaction row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- 1. Create (always Draft — Approve is a separate explicit action) ---
const createTransaction = async (req, res) => {
    const { header, details } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensurePoTransactionTable(client);

        if (!header.vendor_id) throw new Error('กรุณาระบุผู้ขาย');
        if (!header.warehouse_id) throw new Error('กรุณาระบุคลังปลายทาง');
        if (!details || details.length === 0) throw new Error('ต้องมีรายการสั่งซื้ออย่างน้อย 1 รายการ');

        const vendorRes = await client.query(`SELECT vendor_code, vendor_name_th FROM ap_vendor WHERE id=$1`, [header.vendor_id]);
        if (vendorRes.rows.length === 0) throw new Error('ไม่พบผู้ขายที่ระบุ');
        const vendor = vendorRes.rows[0];

        const docTypeRes = await client.query(`SELECT doc_code FROM sa_module_document WHERE id=$1`, [header.doc_id]);
        if (docTypeRes.rows.length === 0) throw new Error('ไม่พบประเภทเอกสาร');
        const docCode = docTypeRes.rows[0].doc_code;

        let docNo = header.doc_no;
        if (!docNo || docNo === 'AUTO') {
            docNo = await generateDocNo(client, header.doc_id, header.doc_date, header.branch_id || null);
            if (!docNo) throw new Error('Auto numbering failed or manual doc_no required');
        }

        const hRes = await client.query(`
            INSERT INTO po_transaction
            (doc_id, doc_no, doc_code, doc_date, vendor_id, vendor_code, vendor_name_th, warehouse_id,
             currency_id, currency_code, exchange_rate, due_date, description, ref_pr_id,
             dim1_id, dim2_id, dim3_id, dim4_id, dim5_id, branch_id, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
            RETURNING id
        `, [
            header.doc_id, docNo, docCode, header.doc_date, header.vendor_id, vendor.vendor_code, vendor.vendor_name_th,
            header.warehouse_id, header.currency_id || null, header.currency_code || 'THB', header.exchange_rate || 1,
            header.due_date || null, header.description || null, header.ref_pr_id || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, header.created_by || null,
        ]);
        const headerId = hRes.rows[0].id;

        // อ้างอิงบรรทัด PR (ถ้ามี) — ตรวจคงเหลือที่แปลงได้ก่อนบันทึกทุกบรรทัด แล้วรีเฟรชสถานะ PR ต้นทางทั้งหมด
        // ที่ถูกอ้างอิงหลังบันทึกครบ (lazy require กัน circular กับ poPrTransactionController.js ที่ require
        // imTransactionController.js ที่ระดับบนสุดของไฟล์อยู่แล้ว — มิเรอร์รูปแบบเดียวกับ im/po, ทั้งสองไฟล์อยู่ใน
        // controllers/po/ ด้วยกันแล้วตั้งแต่ PR ย้ายมารวม)
        const { validatePrConvertibleQty, refreshPrStatus } = require('./poPrTransactionController');
        const { copyAttachmentsToEntity } = require('../sa/saAttachmentController');
        const dbName = req.header('X-Database-Name');
        const affectedPrIds = new Set();
        let lineNo = 1, totalQty = 0, totalValue = 0;
        for (const d of details) {
            const qty = Number(d.qty_ordered) || 0;
            const price = Number(d.unit_price_fc) || 0;
            const value = qty * price * (Number(header.exchange_rate) || 1);
            totalQty += qty;
            totalValue += value;
            if (d.ref_pr_detail_id) {
                const { prTransactionId } = await validatePrConvertibleQty(client, { refPrDetailId: d.ref_pr_detail_id, requestedQty: qty });
                affectedPrIds.add(prTransactionId);
            }
            const newDetailRes = await client.query(`
                INSERT INTO po_transaction_detail
                (header_id, line_no, item_id, item_code, item_name, uom_id, qty_ordered, unit_price_fc, total_value_lc, description, ref_pr_detail_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                RETURNING id
            `, [headerId, lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                qty, price, value, d.description || null, d.ref_pr_detail_id || null]);
            // คัดลอกไฟล์แนบจากบรรทัด PR ต้นทาง (ถ้ามี) มาไว้ที่บรรทัด PO ใหม่นี้ทันที เพื่อให้ผู้อนุมัติ PO เห็น
            // หลักฐานชุดเดียวกับที่ผู้อนุมัติ PR เคยเห็น — ดู copyAttachmentsToEntity สำหรับเหตุผลที่คัดลอกไฟล์จริง
            // แทนการ share file_path เดียวกัน
            if (d.ref_pr_detail_id) {
                await copyAttachmentsToEntity(client, {
                    dbName, sourceModule: 'pr_transaction_detail', sourceEntityId: d.ref_pr_detail_id,
                    targetModule: 'po_transaction_detail', targetEntityId: newDetailRes.rows[0].id,
                    uploadedBy: header.created_by || null,
                });
            }
        }
        await client.query(`UPDATE po_transaction SET total_qty=$1, total_value_lc=$2 WHERE id=$3`, [totalQty, totalValue, headerId]);
        for (const prId of affectedPrIds) { await refreshPrStatus(client, prId); }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, headerId);
        res.status(201).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating po_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 2. Update (Draft only — full header+lines replace, mirrors im_transaction's updateTransaction) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, details } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM po_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (!['Draft', 'Rejected'].includes(existing.rows[0].status)) throw new Error('แก้ไขได้เฉพาะเอกสาร Draft หรือ Rejected เท่านั้น');

        if (!header.vendor_id) throw new Error('กรุณาระบุผู้ขาย');
        if (!header.warehouse_id) throw new Error('กรุณาระบุคลังปลายทาง');
        if (!details || details.length === 0) throw new Error('ต้องมีรายการสั่งซื้ออย่างน้อย 1 รายการ');

        const vendorRes = await client.query(`SELECT vendor_code, vendor_name_th FROM ap_vendor WHERE id=$1`, [header.vendor_id]);
        if (vendorRes.rows.length === 0) throw new Error('ไม่พบผู้ขายที่ระบุ');
        const vendor = vendorRes.rows[0];

        await client.query(`
            UPDATE po_transaction SET
                doc_date=$1, vendor_id=$2, vendor_code=$3, vendor_name_th=$4, warehouse_id=$5,
                currency_id=$6, currency_code=$7, exchange_rate=$8, due_date=$9, description=$10,
                dim1_id=$11, dim2_id=$12, dim3_id=$13, dim4_id=$14, dim5_id=$15, branch_id=$16,
                updated_by=$17, updated_at=NOW()
            WHERE id=$18
        `, [
            header.doc_date, header.vendor_id, vendor.vendor_code, vendor.vendor_name_th, header.warehouse_id,
            header.currency_id || null, header.currency_code || 'THB', header.exchange_rate || 1,
            header.due_date || null, header.description || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, header.updated_by || null, id,
        ]);

        const { validatePrConvertibleQty, refreshPrStatus } = require('./poPrTransactionController');
        const affectedPrIds = new Set();
        const oldPrLines = await client.query(`SELECT DISTINCT prd.header_id FROM po_transaction_detail pod
            JOIN pr_transaction_detail prd ON prd.id = pod.ref_pr_detail_id WHERE pod.header_id=$1`, [id]);
        for (const r of oldPrLines.rows) affectedPrIds.add(r.header_id);

        // แก้ไขบรรทัดแบบ diff (UPDATE ของเดิม / INSERT ใหม่ / DELETE ที่ถูกลบ) แทนการ DELETE ทั้งหมดแล้ว INSERT ใหม่
        // ทุกครั้ง — เดิมทำให้ id ของทุกบรรทัดเปลี่ยนทุกครั้งที่ save แม้ไม่ได้แก้ไขอะไรเลย ซึ่งทำให้สิ่งที่ผูกกับ
        // id บรรทัดตรงๆ (เช่น ไฟล์แนบใน sa_attachment) หลุดหายทุกครั้งที่แก้ไขเอกสาร (มิเรอร์ pr_transaction ทุกประการ)
        const { copyAttachmentsToEntity, deleteAttachmentsForEntities } = require('../sa/saAttachmentController');
        const dbName = req.header('X-Database-Name');

        const existingIdsRes = await client.query(`SELECT id FROM po_transaction_detail WHERE header_id=$1`, [id]);
        const existingIds = new Set(existingIdsRes.rows.map(r => r.id));
        const incomingIds = new Set(details.filter(d => d.id).map(d => d.id));
        const removedIds = [...existingIds].filter(x => !incomingIds.has(x));

        if (removedIds.length > 0) {
            await deleteAttachmentsForEntities(client, 'po_transaction_detail', removedIds);
            await client.query(`DELETE FROM po_transaction_detail WHERE id = ANY($1::int[])`, [removedIds]);
        }

        let lineNo = 1, totalQty = 0, totalValue = 0;
        for (const d of details) {
            const qty = Number(d.qty_ordered) || 0;
            const price = Number(d.unit_price_fc) || 0;
            const value = qty * price * (Number(header.exchange_rate) || 1);
            totalQty += qty;
            totalValue += value;
            if (d.ref_pr_detail_id) {
                const { prTransactionId } = await validatePrConvertibleQty(client, { refPrDetailId: d.ref_pr_detail_id, requestedQty: qty });
                affectedPrIds.add(prTransactionId);
            }
            if (d.id && existingIds.has(d.id)) {
                await client.query(`
                    UPDATE po_transaction_detail SET
                        line_no=$1, item_id=$2, item_code=$3, item_name=$4, uom_id=$5, qty_ordered=$6,
                        unit_price_fc=$7, total_value_lc=$8, description=$9, ref_pr_detail_id=$10
                    WHERE id=$11
                `, [lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                    qty, price, value, d.description || null, d.ref_pr_detail_id || null, d.id]);
            } else {
                const newDetailRes = await client.query(`
                    INSERT INTO po_transaction_detail
                    (header_id, line_no, item_id, item_code, item_name, uom_id, qty_ordered, unit_price_fc, total_value_lc, description, ref_pr_detail_id)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    RETURNING id
                `, [id, lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                    qty, price, value, d.description || null, d.ref_pr_detail_id || null]);
                if (d.ref_pr_detail_id) {
                    await copyAttachmentsToEntity(client, {
                        dbName, sourceModule: 'pr_transaction_detail', sourceEntityId: d.ref_pr_detail_id,
                        targetModule: 'po_transaction_detail', targetEntityId: newDetailRes.rows[0].id,
                        uploadedBy: header.updated_by || null,
                    });
                }
            }
        }
        await client.query(`UPDATE po_transaction SET total_qty=$1, total_value_lc=$2 WHERE id=$3`, [totalQty, totalValue, id]);
        for (const prId of affectedPrIds) { await refreshPrStatus(client, prId); }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating po_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 3. ส่งอนุมัติ / อนุมัติ / ปฏิเสธ (คิวผู้อนุมัติของเมนู — utils/docApproval.js) ---
// งานในคิวที่ล็อกแถวแล้ว: work(client, t, ctx) — error มี status ใช้เป็นรหัสตอบกลับ
const approvalAction = (label, work) => async (req, res) => {
    const { id } = req.params;
    const ctx = {
        userId: Number(req.headers.userid) || null, userName: req.headers.username || null,
        menuId: req.body?.menu_id, remarks: req.body?.remarks,
    };
    await DA.ensureDocApprovalSchema(req.dbPool);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensurePoTransactionTable(client);
        const t = (await client.query(`SELECT * FROM po_transaction WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!t) throw DA.httpErr(404, 'Not found');
        await work(client, t, ctx);
        await client.query('COMMIT');
        res.status(200).json(await fetchRowById(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK');
        if (!error.status) console.error(`Error ${label} po_transaction:`, error);
        res.status(error.status || 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

const markApproved = (client, id, userName) => client.query(`
    UPDATE po_transaction SET status='Approved', approved_at=NOW(), approved_by=$1, updated_by=$1, updated_at=NOW()
     WHERE id=$2`, [userName, id]);

// Draft/Rejected -> Submitted (ไม่มีผู้อนุมัติ + เมนูตั้ง "ให้ผ่าน" -> Approved ทันที)
const submitTransaction = approvalAction('submitting', async (client, t, { menuId, userName }) => {
    if (!['Draft', 'Rejected'].includes(t.status)) throw DA.httpErr(400, 'ส่งอนุมัติได้เฉพาะเอกสาร Draft หรือ Rejected เท่านั้น');
    const q = await DA.buildQueue(client, { kind: KIND, recordId: t.id, menuId, docCode: t.doc_code });
    await client.query(`
        UPDATE po_transaction SET status='Submitted', approval_mode=$1, submitted_at=NOW(), submitted_by=$2,
               updated_by=$2, updated_at=NOW() WHERE id=$3`, [q.mode, userName, t.id]);
    if (q.count === 0) await markApproved(client, t.id, userName);
});

// Submitted -> Approved เมื่ออนุมัติครบ (หรือคนใดคนหนึ่งถ้า ANY)
const approveTransaction = approvalAction('approving', async (client, t, { userId, userName, remarks }) => {
    if (t.status !== 'Submitted') throw DA.httpErr(400, 'อนุมัติได้เฉพาะเอกสารที่ส่งอนุมัติแล้ว (Submitted) เท่านั้น');
    const done = await DA.approveStep(client, { kind: KIND, recordId: t.id, userId, mode: t.approval_mode, remarks });
    if (done) await markApproved(client, t.id, userName);
});

// Submitted -> Rejected (แก้ไขแล้วส่งใหม่ได้)
const rejectTransaction = approvalAction('rejecting', async (client, t, { userId, userName, remarks }) => {
    if (t.status !== 'Submitted') throw DA.httpErr(400, 'ปฏิเสธได้เฉพาะเอกสารที่ส่งอนุมัติแล้ว (Submitted) เท่านั้น');
    await DA.rejectStep(client, { kind: KIND, recordId: t.id, userId, remarks });
    await client.query(`UPDATE po_transaction SET status='Rejected', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, t.id]);
});

// GET /po_transaction/my_pending — ใบสั่งซื้อที่ถึงคิวผู้ใช้นี้อนุมัติ (กระดิ่งหน้า Home)
const fetchMyPending = async (req, res) => {
    const userId = Number(req.headers.userid);
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    try {
        await DA.ensureDocApprovalSchema(req.dbPool);
        const client = await req.dbPool.connect();
        try { await ensurePoTransactionTable(client); } finally { client.release(); }
        const r = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.vendor_name_th, t.description, t.total_value_lc, t.submitted_by
              FROM po_transaction t
             WHERE t.status = 'Submitted' AND ${DA.myTurnSql('t', '$1', '$2')}
             ORDER BY t.doc_date DESC, t.id DESC`, [KIND, userId]);
        res.status(200).json(r.rows);
    } catch (error) {
        console.error('Error fetching po_transaction my_pending:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- 4. Close (Approved/PartiallyReceived -> Closed — no more receiving expected, does not require 100% received) ---
const closeTransaction = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM po_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (!['Approved', 'PartiallyReceived', 'FullyReceived'].includes(existing.rows[0].status)) {
            throw new Error('ปิดได้เฉพาะเอกสารสถานะ Approved, PartiallyReceived หรือ FullyReceived เท่านั้น');
        }
        await client.query(`UPDATE po_transaction SET status='Closed', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error closing po_transaction:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- ถอย / ยกเลิก / ลบ: เงื่อนไข ---
// เอกสารใบรับสินค้าที่อ้างอิง (ทุกสถานะยกเว้น Void/Deleted — รวมร่าง เพราะแก้ร่างใบสั่งซื้อจะสร้างบรรทัดใหม่)
const refDocsOf = async (client, id) => (await client.query(`
    SELECT string_agg(DISTINCT imt.doc_no, ', ') AS docs FROM im_transaction imt
     WHERE imt.status NOT IN ('Void', 'Deleted')
       AND (imt.ref_po_id = $1 OR EXISTS (
            SELECT 1 FROM im_transaction_detail imd JOIN po_transaction_detail d ON d.id = imd.ref_po_detail_id
             WHERE imd.header_id = imt.id AND d.header_id = $1))`, [id])).rows[0].docs;

const computeBlocks = async (client, id) => {
    const t = (await client.query(`SELECT status FROM po_transaction WHERE id = $1`, [id])).rows[0];
    if (!t) return {};
    const refs = await refDocsOf(client, id);
    const voided = blk('VOIDED', 'ใบสั่งซื้อนี้ถูกยกเลิกหรือลบแล้ว');
    const refBlock = refs
        ? blk('REF_DOCS', `มีใบรับสินค้าอ้างอิงใบสั่งซื้อนี้ (${refs}) ต้องถอยและลบเอกสารเหล่านั้นก่อน`, refs)
        : null;
    const out = { reverse_block: null, void_block: null, delete_block: null };
    switch (t.status) {
        case 'Submitted': out.void_block = blk('NOT_APPROVED', 'ใบสั่งซื้อที่รออนุมัติให้ถอยเป็นร่างแล้วลบแทนการยกเลิก'); break;
        case 'Approved': out.reverse_block = refBlock; out.void_block = refBlock; break;
        case 'Closed':
            out.void_block = blk('NOT_APPROVED', 'ใบสั่งซื้อที่ปิดแล้วยกเลิกไม่ได้ ถอยการปิดก่อน');
            break;
        case 'PartiallyReceived':
        case 'FullyReceived':
            out.reverse_block = blk('REF_DOCS', `มีใบรับสินค้าอ้างอิงแล้ว (${refs || '-'}) ถอยใบรับสินค้าก่อน หรือปิดใบสั่งซื้อแทน`, refs);
            out.void_block = out.reverse_block;
            break;
        case 'Draft':
        case 'Rejected':
            out.reverse_block = blk('NOT_REVERSIBLE', 'ถอยได้เฉพาะใบสั่งซื้อที่ส่งอนุมัติ อนุมัติแล้ว หรือปิดแล้ว');
            out.void_block = blk('NOT_POSTED', 'ใบสั่งซื้อที่ยังไม่อนุมัติให้ลบแทนการยกเลิก');
            break;
        default: out.reverse_block = voided; out.void_block = voided;
    }
    if (!['Draft', 'Rejected'].includes(t.status)) {
        out.delete_block = ['Void', 'Deleted'].includes(t.status)
            ? voided : blk('NOT_DRAFT', 'ลบได้เฉพาะร่างหรือใบที่ถูกปฏิเสธ ใบที่ส่งอนุมัติแล้วต้องถอยเป็นร่างก่อน');
    }
    return out;
};

// ต้นทางที่บรรทัดของใบนี้แปลงมา — คำนวณสถานะใหม่หลังยกเลิก/ลบ (จำนวนที่แปลงแล้วไม่นับใบ Void/Deleted)
const refreshSources = async (client, id) => {
    const { refreshPrStatus } = require('./poPrTransactionController');
    const r = await client.query(`
        SELECT DISTINCT s.header_id FROM po_transaction_detail d JOIN pr_transaction_detail s ON s.id = d.ref_pr_detail_id
         WHERE d.header_id = $1`, [id]);
    for (const x of r.rows) await refreshPrStatus(client, x.header_id);
};

const lockedAction = async (req, res, kind, label, work) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, `กรุณาระบุเหตุผล${label}`);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensurePoTransactionTable(client);
        const t = (await client.query(`SELECT * FROM po_transaction WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!t) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeBlocks(client, id))[kind];
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }
        const userName = req.headers.username || null;
        const toStatus = await work(client, t, { reason, userName });
        await logReverse(client, {
            sysModule: '51', tableName: 'po_transaction', recordId: Number(id), docNo: t.doc_no,
            fromStatus: t.status, toStatus, reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        if (toStatus === 'Deleted') return res.status(200).json({ message: 'Deleted' });
        res.status(200).json(await fetchRowById(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error ${kind} po_transaction:`, error);
        sendErr(res, 500, error.message || 'Internal server error');
    } finally { client.release(); }
};

// --- 5. ถอย (ต้องมีเหตุผล) ---
// Submitted / Approved -> Draft: ยังไม่มีใบรับสินค้าอ้างอิง ผู้อนุมัติที่ยังไม่ตัดสินถูกข้าม แก้ไขแล้วส่งอนุมัติใหม่ได้ด้วยเลขที่เดิม
// Closed -> เปิดใหม่: สถานะคำนวณจากใบรับสินค้าที่อ้างอิง (Approved / PartiallyReceived / FullyReceived)
const reverseTransaction = (req, res) => lockedAction(req, res, 'reverse_block', 'การถอยเอกสาร', async (client, t, { userName }) => {
    if (['Submitted', 'Approved'].includes(t.status)) {
        await DA.ensureDocApprovalSchema(client);
        await DA.skipPending(client, KIND, t.id);
        await client.query(`
            UPDATE po_transaction SET status='Draft', approved_at=NULL, approved_by=NULL, submitted_at=NULL, submitted_by=NULL,
                   updated_by=$1, updated_at=NOW()
             WHERE id=$2`, [userName, t.id]);
        return 'Draft';
    }
    await client.query(`UPDATE po_transaction SET status='Approved', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, t.id]);
    await refreshPoStatus(client, t.id);
    return (await client.query(`SELECT status FROM po_transaction WHERE id=$1`, [t.id])).rows[0].status;
});

// --- 6. ยกเลิก (Approved เท่านั้น ต้องมีเหตุผล — บล็อกถ้ามีใบรับสินค้าอ้างอิง) ---
const voidTransaction = (req, res) => lockedAction(req, res, 'void_block', 'การยกเลิก', async (client, t, { reason, userName }) => {
    await client.query(`
        UPDATE po_transaction SET status='Void', void_reason=$1, voided_by=$2, voided_at=NOW(), updated_by=$2, updated_at=NOW()
         WHERE id=$3`, [reason, userName, t.id]);
    await refreshSources(client, t.id);
    return 'Void';
});

// --- 7. ลบ (Draft เท่านั้น ต้องมีเหตุผล — เก็บไว้ด้วยสถานะ Deleted ตรวจสอบได้แต่นำกลับมาใช้ไม่ได้) ---
const deleteTransaction = (req, res) => lockedAction(req, res, 'delete_block', 'การลบ', async (client, t, { userName }) => {
    await client.query(`UPDATE po_transaction SET status='Deleted', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, t.id]);
    await refreshSources(client, t.id);
    return 'Deleted';
});

// GET /po_transaction/receivable_lines?vendor_id=&search= — PO ที่ Approved/PartiallyReceived ของผู้ขายนี้ พร้อม
// จำนวนคงเหลือที่รับได้ต่อบรรทัด ใช้โดย document picker ในหน้าจอ GRN (อ้างอิง PO) — สูตรเดียวกับ validatePoReceivableQty
// เพื่อให้ตัวเลขที่ผู้ใช้เห็นตอนเลือกตรงกับที่ระบบจะยอมให้ Post จริง
const fetchReceivableLines = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensurePoTransactionTable(client);
        const { vendor_id, search } = req.query;
        let query = `
            SELECT t.id AS header_id, t.doc_no, t.doc_date, t.status, t.currency_code, t.exchange_rate,
                   dt.id AS detail_id, dt.line_no, dt.item_id, dt.item_code, dt.item_name, dt.uom_id, dt.qty_ordered, dt.unit_price_fc,
                   u.uom_code,
                   COALESCE((
                       SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                       JOIN im_transaction imt ON imt.id = imd.header_id
                       WHERE imd.ref_po_detail_id = dt.id AND imt.status IN ('Posted', 'Received')
                   ), 0) AS qty_received
            FROM po_transaction_detail dt
            JOIN po_transaction t ON t.id = dt.header_id
            LEFT JOIN im_uom u ON u.id = dt.uom_id
            WHERE t.status IN ('Approved', 'PartiallyReceived')`;
        const params = [];
        let pi = 1;
        if (vendor_id) { params.push(vendor_id); query += ` AND t.vendor_id = $${pi++}`; }
        if (search) { params.push(`%${search.toUpperCase()}%`); query += ` AND UPPER(t.doc_no) LIKE $${pi++}`; }
        query += ` ORDER BY t.doc_date DESC, t.id DESC, dt.line_no`;
        const result = await client.query(query, params);
        const lines = result.rows
            .map(r => ({ ...r, qty_remaining: Number(r.qty_ordered) - Number(r.qty_received) }))
            .filter(r => r.qty_remaining > 0.0001);
        res.status(200).json(lines);
    } catch (error) {
        console.error('Error fetching po_transaction receivable_lines:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- Cross-module helpers, called from imTransactionController.js's GRN posting path ---

// ตรวจสอบว่าจำนวนที่จะรับ (ต่อบรรทัด GRN ที่อ้างอิง ref_po_detail_id) ไม่เกินจำนวนคงเหลือที่รับได้ของบรรทัด PO ต้นฉบับ
// เอกสาร PO หนึ่งบรรทัดอาจถูกรับหลายครั้ง (คนละใบ GRN) คงเหลือคำนวณจากผลรวมการรับที่ Posted/Received แล้วเท่านั้น —
// มิเรอร์ validateReturnableQty ใน imTransactionController.js ทุกประการ (ดูเหตุผลเรื่อง computed-on-read ที่นั่น)
const validatePoReceivableQty = async (client, { refPoDetailId, requestedQty, vendorId }) => {
    const origRes = await client.query(`
        SELECT pod.qty_ordered, pod.item_code, pod.header_id, po.vendor_id, po.status AS po_status
        FROM po_transaction_detail pod JOIN po_transaction po ON po.id = pod.header_id
        WHERE pod.id = $1
    `, [refPoDetailId]);
    if (origRes.rows.length === 0) throw new Error('ไม่พบรายการใบสั่งซื้อต้นฉบับที่อ้างอิง');
    const orig = origRes.rows[0];
    if (!['Approved', 'PartiallyReceived'].includes(orig.po_status)) {
        throw new Error(`ใบสั่งซื้อ ${orig.item_code} ต้องอยู่สถานะ Approved หรือ PartiallyReceived เท่านั้นจึงจะรับสินค้าเพิ่มได้`);
    }
    if (Number(orig.vendor_id) !== Number(vendorId)) {
        throw new Error('ผู้ขายของใบรับสินค้าต้องตรงกับผู้ขายของใบสั่งซื้อที่อ้างอิง');
    }
    const receivedRes = await client.query(`
        SELECT COALESCE(SUM(ABS(imd.qty)), 0) AS received
        FROM im_transaction_detail imd JOIN im_transaction imt ON imt.id = imd.header_id
        WHERE imd.ref_po_detail_id = $1 AND imt.status IN ('Posted', 'Received')
    `, [refPoDetailId]);
    const remaining = Number(orig.qty_ordered) - Number(receivedRes.rows[0].received);
    if (requestedQty > remaining + 0.0001) {
        throw new Error(`จำนวนที่รับเกินกว่าคงเหลือที่สั่งซื้อของ ${orig.item_code} (คงเหลือรับได้ ${remaining})`);
    }
    return { poTransactionId: orig.header_id };
};

// เรียกหลัง GRN Post สำเร็จ (บรรทัดที่อ้างอิง PO) ในทรานแซกชันเดียวกัน — คำนวณสถานะ PO ใหม่จากผลรวมจำนวนที่รับแล้ว
// เทียบกับจำนวนที่สั่งทั้งหมด ไม่แตะสถานะ Closed/Void (ถือว่าเป็นการตัดสินใจของคนแล้ว ไม่ควรถูก auto-flip กลับ)
const refreshPoStatus = async (client, poTransactionId) => {
    const statusRes = await client.query(`SELECT status FROM po_transaction WHERE id=$1 FOR UPDATE`, [poTransactionId]);
    if (statusRes.rows.length === 0) return;
    if (!['Approved', 'PartiallyReceived', 'FullyReceived'].includes(statusRes.rows[0].status)) return;

    const sumRes = await client.query(`
        SELECT
            COALESCE(SUM(pod.qty_ordered), 0) AS ordered,
            COALESCE(SUM((
                SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                JOIN im_transaction imt ON imt.id = imd.header_id
                WHERE imd.ref_po_detail_id = pod.id AND imt.status IN ('Posted', 'Received')
            )), 0) AS received
        FROM po_transaction_detail pod WHERE pod.header_id = $1
    `, [poTransactionId]);
    const { ordered, received } = sumRes.rows[0];
    // FullyReceived is distinct from Approved (all qty in, but user hasn't clicked Close yet) — the UI uses this to
    // prompt "ready to close" without auto-closing (Close stays a deliberate action, mirrors im_stock_count's Approve/Close)
    let newStatus = 'Approved';
    if (Number(received) > 0) {
        newStatus = Number(received) < Number(ordered) ? 'PartiallyReceived' : 'FullyReceived';
    }
    await client.query(`UPDATE po_transaction SET status=$1, updated_at=NOW() WHERE id=$2`, [newStatus, poTransactionId]);
};

module.exports = {
    ensurePoTransactionTable,
    fetchRows, fetchRow, fetchRowById, fetchReceivableLines,
    createTransaction, updateTransaction, submitTransaction, approveTransaction, rejectTransaction, fetchMyPending,
    closeTransaction, voidTransaction, deleteTransaction, reverseTransaction,
    validatePoReceivableQty, refreshPoStatus,
};
