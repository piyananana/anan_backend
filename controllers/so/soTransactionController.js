// controllers/so/soTransactionController.js — ใบสั่งขาย (Sale Order, sys_module='41')
// เอกสารข้อผูกพันกับลูกค้าเท่านั้น — ไม่แตะ GL, ไม่แตะสต็อกเลย (ต่างจาก DLN/im_transaction ทุกประการ) ผลกระทบจริง
// ต่อสต็อก/บัญชียังเกิดที่ DLN เหมือนเดิม — SO แค่เป็นข้อผูกพัน+ต้นทาง reference ให้ DLN อ้างอิงกลับมา (ดู ref_so_id/
// ref_so_detail_id ใน imTransactionController.js) มิเรอร์ poTransactionController.js ทุกประการ (sys_module='51')
// เพียงสลับ vendor->customer เท่านั้น — ยังไม่มีขั้น "ใบเสนอราคา" (Sale Quote, sys_doc_type='05') นำหน้าเหมือน PR
// นำหน้า PO ในรอบนี้ (ดู soSysDocType ใน sa_anan_module.dart ที่จองรหัสไว้แล้วสำหรับต่อยอดในอนาคต) workflow:
// Draft (แก้ไขได้) -> Approved (ผูกพันแล้ว, DLN อ้างอิงได้) -> PartiallyDelivered (คำนวณอัตโนมัติจาก DLN ที่อ้างอิง
// เข้ามา ไม่ใช่การกดเอง) -> Closed (กดปิดเอง เมื่อไม่มีการส่งเพิ่มแล้ว ไม่ auto-close แม้ส่งครบ 100%) กิ่ง Void แยกจาก
// Draft/Approved/PartiallyDelivered ได้ แต่บล็อกถ้ามี DLN Posted/Delivered อ้างอิงเข้ามาแล้ว
'use strict';

const { generateDocNo, ensureImTransactionTable } = require('../im/imTransactionController');

const ensureSoTransactionTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS so_transaction (
            id              SERIAL PRIMARY KEY,
            doc_id          INTEGER NOT NULL REFERENCES sa_module_document(id),
            doc_no          VARCHAR(50) NOT NULL,
            doc_code        VARCHAR(10) NOT NULL,
            doc_date        DATE NOT NULL,
            customer_id     INTEGER NOT NULL REFERENCES ar_customer(id),
            customer_code   VARCHAR(50),
            customer_name_th VARCHAR(255),
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_so_transaction_date     ON so_transaction(doc_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_so_transaction_status   ON so_transaction(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_so_transaction_customer ON so_transaction(customer_id)`);

    await client.query(`
        CREATE TABLE IF NOT EXISTS so_transaction_detail (
            id             SERIAL PRIMARY KEY,
            header_id      INTEGER NOT NULL REFERENCES so_transaction(id) ON DELETE CASCADE,
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_so_transaction_detail_header ON so_transaction_detail(header_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_so_transaction_detail_item   ON so_transaction_detail(item_id)`);
};

// --- Fetch helpers ---
const fetchRowById = async (pool, id) => {
    // ต้องมี im_transaction_detail.ref_so_detail_id อยู่ก่อนเสมอ (คำนวณ qty_delivered ด้านล่าง) แม้ยังไม่มี endpoint
    // ฝั่ง IM ถูกเรียกเลยก็ตาม — เรียกทางเดียว (so ensure im ได้ แต่ im ensure so ต้องไม่เรียกกลับมาที่นี่ ป้องกัน
    // recursion) ดู ensureImTransactionTable ที่เรียก ensureSoTransactionTable ด้านเดียวสำหรับสร้างตาราง
    await ensureImTransactionTable(pool);
    // lazy require — เลี่ยง circular require ตอน module load (soQuoteTransactionController.js เอง require
    // soTransactionController.js ที่ระดับบนสุดของไฟล์อยู่แล้วสำหรับ ensureSoTransactionTable) — join ด้านล่างต้องมี
    // ตาราง quote_transaction อยู่ก่อนเสมอแม้ยังไม่มี endpoint ฝั่ง Quote ถูกเรียกเลยก็ตาม
    await require('./soQuoteTransactionController').ensureQuoteTransactionTable(pool);
    const hRes = await pool.query(`
        SELECT t.*,
               d.doc_code AS d_doc_code, d.doc_name_thai, d.doc_name_eng, d.is_auto_numbering,
               c.customer_code AS c_customer_code, c.customer_name_th AS c_customer_name_th,
               w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
               b.branch_code, b.branch_name_thai,
               qt.doc_no AS ref_quote_doc_no
        FROM so_transaction t
        JOIN sa_module_document d  ON d.id = t.doc_id
        LEFT JOIN ar_customer c    ON c.id = t.customer_id
        LEFT JOIN im_warehouse w   ON w.id = t.warehouse_id
        LEFT JOIN cd_branch b      ON b.id = t.branch_id
        LEFT JOIN quote_transaction qt ON qt.id = t.ref_quote_id
        WHERE t.id = $1`, [id]);
    if (hRes.rows.length === 0) return null;
    const dRes = await pool.query(`
        SELECT dt.*, u.uom_code,
               COALESCE((
                   SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                   JOIN im_transaction imt ON imt.id = imd.header_id
                   WHERE imd.ref_so_detail_id = dt.id AND imt.status IN ('Posted', 'Delivered')
               ), 0) AS qty_delivered
        FROM so_transaction_detail dt
        LEFT JOIN im_uom u ON u.id = dt.uom_id
        WHERE dt.header_id = $1 ORDER BY dt.line_no`, [id]);
    return { ...hRes.rows[0], details: dRes.rows };
};

// --- GET list ---
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureSoTransactionTable(client);
        const { status, customer_id, date_from, date_to, search } = req.query;
        let query = `
            SELECT t.id, t.doc_no, t.doc_date, t.status, t.customer_id, t.customer_code, t.customer_name_th,
                   t.warehouse_id, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                   t.total_qty, t.total_value_lc, t.due_date, t.description,
                   d.doc_code, d.doc_name_thai, d.doc_name_eng
            FROM so_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            LEFT JOIN im_warehouse w  ON w.id = t.warehouse_id
            WHERE 1=1`;
        const params = [];
        let pi = 1;
        if (status)      { params.push(status);      query += ` AND t.status = $${pi++}`; }
        if (customer_id) { params.push(customer_id);  query += ` AND t.customer_id = $${pi++}`; }
        if (date_from)   { params.push(date_from);    query += ` AND t.doc_date >= $${pi++}`; }
        if (date_to)     { params.push(date_to);      query += ` AND t.doc_date <= $${pi++}`; }
        if (search) {
            params.push(`%${search.toUpperCase()}%`);
            query += ` AND (UPPER(t.doc_no) LIKE $${pi} OR UPPER(COALESCE(t.customer_name_th,'')) LIKE $${pi})`;
            pi++;
        }
        query += ` ORDER BY t.doc_date DESC, t.id DESC`;
        const result = await client.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching so_transaction list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- GET one ---
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureSoTransactionTable(client);
        const data = await fetchRowById(req.dbPool, req.params.id);
        if (!data) return res.status(404).json({ message: 'Not found.' });
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching so_transaction row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- 1. Create (always Draft — Approve is a separate explicit action) ---
const createTransaction = async (req, res) => {
    const { header, details } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureSoTransactionTable(client);
        await require('./soQuoteTransactionController').ensureQuoteTransactionTable(client); // ต้องมี ref_quote_id/ref_quote_detail_id อยู่ก่อนเสมอ

        if (!header.customer_id) throw new Error('กรุณาระบุลูกค้า');
        if (!header.warehouse_id) throw new Error('กรุณาระบุคลังต้นทาง');
        if (!details || details.length === 0) throw new Error('ต้องมีรายการสั่งขายอย่างน้อย 1 รายการ');

        const customerRes = await client.query(`SELECT customer_code, customer_name_th FROM ar_customer WHERE id=$1`, [header.customer_id]);
        if (customerRes.rows.length === 0) throw new Error('ไม่พบลูกค้าที่ระบุ');
        const customer = customerRes.rows[0];

        const docTypeRes = await client.query(`SELECT doc_code FROM sa_module_document WHERE id=$1`, [header.doc_id]);
        if (docTypeRes.rows.length === 0) throw new Error('ไม่พบประเภทเอกสาร');
        const docCode = docTypeRes.rows[0].doc_code;

        let docNo = header.doc_no;
        if (!docNo || docNo === 'AUTO') {
            docNo = await generateDocNo(client, header.doc_id, header.doc_date, header.branch_id || null);
            if (!docNo) throw new Error('Auto numbering failed or manual doc_no required');
        }

        const hRes = await client.query(`
            INSERT INTO so_transaction
            (doc_id, doc_no, doc_code, doc_date, customer_id, customer_code, customer_name_th, warehouse_id,
             currency_id, currency_code, exchange_rate, due_date, description, ref_quote_id,
             dim1_id, dim2_id, dim3_id, dim4_id, dim5_id, branch_id, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
            RETURNING id
        `, [
            header.doc_id, docNo, docCode, header.doc_date, header.customer_id, customer.customer_code, customer.customer_name_th,
            header.warehouse_id, header.currency_id || null, header.currency_code || 'THB', header.exchange_rate || 1,
            header.due_date || null, header.description || null, header.ref_quote_id || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, header.created_by || null,
        ]);
        const headerId = hRes.rows[0].id;

        // อ้างอิงบรรทัดใบเสนอราคา (ถ้ามี) — ตรวจคงเหลือที่แปลงได้ก่อนบันทึกทุกบรรทัด แล้วรีเฟรชสถานะ Quote ต้นทาง
        // ทั้งหมดที่ถูกอ้างอิงหลังบันทึกครบ — มิเรอร์ poTransactionController.js:createTransaction ทุกประการ
        const { validateQuoteConvertibleQty, refreshQuoteStatus } = require('./soQuoteTransactionController');
        const { copyAttachmentsToEntity } = require('../sa/saAttachmentController');
        const dbName = req.header('X-Database-Name');
        const affectedQuoteIds = new Set();
        let lineNo = 1, totalQty = 0, totalValue = 0;
        for (const d of details) {
            const qty = Number(d.qty_ordered) || 0;
            const price = Number(d.unit_price_fc) || 0;
            const value = qty * price * (Number(header.exchange_rate) || 1);
            totalQty += qty;
            totalValue += value;
            if (d.ref_quote_detail_id) {
                const { quoteTransactionId } = await validateQuoteConvertibleQty(client, { refQuoteDetailId: d.ref_quote_detail_id, requestedQty: qty });
                affectedQuoteIds.add(quoteTransactionId);
            }
            const newDetailRes = await client.query(`
                INSERT INTO so_transaction_detail
                (header_id, line_no, item_id, item_code, item_name, uom_id, qty_ordered, unit_price_fc, total_value_lc, description, ref_quote_detail_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                RETURNING id
            `, [headerId, lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                qty, price, value, d.description || null, d.ref_quote_detail_id || null]);
            if (d.ref_quote_detail_id) {
                await copyAttachmentsToEntity(client, {
                    dbName, sourceModule: 'quote_transaction_detail', sourceEntityId: d.ref_quote_detail_id,
                    targetModule: 'so_transaction_detail', targetEntityId: newDetailRes.rows[0].id,
                    uploadedBy: header.created_by || null,
                });
            }
        }
        await client.query(`UPDATE so_transaction SET total_qty=$1, total_value_lc=$2 WHERE id=$3`, [totalQty, totalValue, headerId]);
        for (const quoteId of affectedQuoteIds) { await refreshQuoteStatus(client, quoteId); }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, headerId);
        res.status(201).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating so_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 2. Update (Draft only — full header+lines replace, mirrors po_transaction's updateTransaction) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, details } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await require('./soQuoteTransactionController').ensureQuoteTransactionTable(client);
        const existing = await client.query(`SELECT status FROM so_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (existing.rows[0].status !== 'Draft') throw new Error('แก้ไขได้เฉพาะเอกสาร Draft เท่านั้น');

        if (!header.customer_id) throw new Error('กรุณาระบุลูกค้า');
        if (!header.warehouse_id) throw new Error('กรุณาระบุคลังต้นทาง');
        if (!details || details.length === 0) throw new Error('ต้องมีรายการสั่งขายอย่างน้อย 1 รายการ');

        const customerRes = await client.query(`SELECT customer_code, customer_name_th FROM ar_customer WHERE id=$1`, [header.customer_id]);
        if (customerRes.rows.length === 0) throw new Error('ไม่พบลูกค้าที่ระบุ');
        const customer = customerRes.rows[0];

        await client.query(`
            UPDATE so_transaction SET
                doc_date=$1, customer_id=$2, customer_code=$3, customer_name_th=$4, warehouse_id=$5,
                currency_id=$6, currency_code=$7, exchange_rate=$8, due_date=$9, description=$10,
                dim1_id=$11, dim2_id=$12, dim3_id=$13, dim4_id=$14, dim5_id=$15, branch_id=$16,
                updated_by=$17, updated_at=NOW()
            WHERE id=$18
        `, [
            header.doc_date, header.customer_id, customer.customer_code, customer.customer_name_th, header.warehouse_id,
            header.currency_id || null, header.currency_code || 'THB', header.exchange_rate || 1,
            header.due_date || null, header.description || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, header.updated_by || null, id,
        ]);

        const { validateQuoteConvertibleQty, refreshQuoteStatus } = require('./soQuoteTransactionController');
        const affectedQuoteIds = new Set();
        const oldQuoteLines = await client.query(`SELECT DISTINCT qtd.header_id FROM so_transaction_detail sod
            JOIN quote_transaction_detail qtd ON qtd.id = sod.ref_quote_detail_id WHERE sod.header_id=$1`, [id]);
        for (const r of oldQuoteLines.rows) affectedQuoteIds.add(r.header_id);

        // แก้ไขบรรทัดแบบ diff (UPDATE ของเดิม / INSERT ใหม่ / DELETE ที่ถูกลบ) แทนการ DELETE ทั้งหมดแล้ว INSERT ใหม่
        // ทุกครั้ง — มิเรอร์ po_transaction_detail ทุกประการ (ดู comment เดียวกันที่นั่น)
        const { copyAttachmentsToEntity, deleteAttachmentsForEntities } = require('../sa/saAttachmentController');
        const dbName = req.header('X-Database-Name');

        const existingIdsRes = await client.query(`SELECT id FROM so_transaction_detail WHERE header_id=$1`, [id]);
        const existingIds = new Set(existingIdsRes.rows.map(r => r.id));
        const incomingIds = new Set(details.filter(d => d.id).map(d => d.id));
        const removedIds = [...existingIds].filter(x => !incomingIds.has(x));

        if (removedIds.length > 0) {
            await deleteAttachmentsForEntities(client, 'so_transaction_detail', removedIds);
            await client.query(`DELETE FROM so_transaction_detail WHERE id = ANY($1::int[])`, [removedIds]);
        }

        let lineNo = 1, totalQty = 0, totalValue = 0;
        for (const d of details) {
            const qty = Number(d.qty_ordered) || 0;
            const price = Number(d.unit_price_fc) || 0;
            const value = qty * price * (Number(header.exchange_rate) || 1);
            totalQty += qty;
            totalValue += value;
            if (d.ref_quote_detail_id) {
                const { quoteTransactionId } = await validateQuoteConvertibleQty(client, { refQuoteDetailId: d.ref_quote_detail_id, requestedQty: qty });
                affectedQuoteIds.add(quoteTransactionId);
            }
            if (d.id && existingIds.has(d.id)) {
                await client.query(`
                    UPDATE so_transaction_detail SET
                        line_no=$1, item_id=$2, item_code=$3, item_name=$4, uom_id=$5, qty_ordered=$6,
                        unit_price_fc=$7, total_value_lc=$8, description=$9, ref_quote_detail_id=$10
                    WHERE id=$11
                `, [lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                    qty, price, value, d.description || null, d.ref_quote_detail_id || null, d.id]);
            } else {
                const newDetailRes = await client.query(`
                    INSERT INTO so_transaction_detail
                    (header_id, line_no, item_id, item_code, item_name, uom_id, qty_ordered, unit_price_fc, total_value_lc, description, ref_quote_detail_id)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    RETURNING id
                `, [id, lineNo++, d.item_id, d.item_code || null, d.item_name || null, d.uom_id || null,
                    qty, price, value, d.description || null, d.ref_quote_detail_id || null]);
                if (d.ref_quote_detail_id) {
                    await copyAttachmentsToEntity(client, {
                        dbName, sourceModule: 'quote_transaction_detail', sourceEntityId: d.ref_quote_detail_id,
                        targetModule: 'so_transaction_detail', targetEntityId: newDetailRes.rows[0].id,
                        uploadedBy: header.updated_by || null,
                    });
                }
            }
        }
        await client.query(`UPDATE so_transaction SET total_qty=$1, total_value_lc=$2 WHERE id=$3`, [totalQty, totalValue, id]);
        for (const quoteId of affectedQuoteIds) { await refreshQuoteStatus(client, quoteId); }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating so_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 3. Approve (Draft -> Approved) ---
const approveTransaction = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM so_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (existing.rows[0].status !== 'Draft') throw new Error('อนุมัติได้เฉพาะเอกสาร Draft เท่านั้น');
        await client.query(`
            UPDATE so_transaction SET status='Approved', approved_at=NOW(), approved_by=$1, updated_by=$1, updated_at=NOW()
            WHERE id=$2
        `, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error approving so_transaction:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 4. Close (Approved/PartiallyDelivered/FullyDelivered -> Closed — no more delivery expected, does not require 100% delivered) ---
const closeTransaction = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM so_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (!['Approved', 'PartiallyDelivered', 'FullyDelivered'].includes(existing.rows[0].status)) {
            throw new Error('ปิดได้เฉพาะเอกสารสถานะ Approved, PartiallyDelivered หรือ FullyDelivered เท่านั้น');
        }
        await client.query(`UPDATE so_transaction SET status='Closed', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error closing so_transaction:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 5. Void (Draft/Approved/PartiallyDelivered -> Void — blocked if any DLN has already Posted/Delivered against it) ---
const voidTransaction = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM so_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (!['Draft', 'Approved', 'PartiallyDelivered'].includes(existing.rows[0].status)) {
            throw new Error('ยกเลิกได้เฉพาะเอกสารสถานะ Draft, Approved หรือ PartiallyDelivered เท่านั้น (FullyDelivered ต้องปิดเอกสารแทนการยกเลิก)');
        }
        const deliveredRes = await client.query(`
            SELECT COUNT(*) FROM im_transaction_detail imd
            JOIN im_transaction imt ON imt.id = imd.header_id
            JOIN so_transaction_detail sod ON sod.id = imd.ref_so_detail_id
            WHERE sod.header_id = $1 AND imt.status IN ('Posted', 'Delivered')
        `, [id]);
        if (Number(deliveredRes.rows[0].count) > 0) {
            throw new Error('ไม่สามารถยกเลิกได้ เนื่องจากมีใบส่งสินค้า (DLN) อ้างอิงใบสั่งขายนี้ไปแล้ว');
        }
        await client.query(`UPDATE so_transaction SET status='Void', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error voiding so_transaction:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 6. Delete (Draft only) ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM so_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (existing.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ลบได้เฉพาะเอกสาร Draft เท่านั้น' }); }
        await client.query(`DELETE FROM so_transaction WHERE id=$1`, [id]);
        await client.query('COMMIT');
        res.status(204).send();
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting so_transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET /so_transaction/deliverable_lines?customer_id=&search= — SO ที่ Approved/PartiallyDelivered ของลูกค้านี้
// พร้อมจำนวนคงเหลือที่ส่งได้ต่อบรรทัด ใช้โดย document picker ในหน้าจอ DLN (อ้างอิง SO) — สูตรเดียวกับ
// validateSoDeliverableQty เพื่อให้ตัวเลขที่ผู้ใช้เห็นตอนเลือกตรงกับที่ระบบจะยอมให้ Post จริง
const fetchDeliverableLines = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureSoTransactionTable(client);
        await ensureImTransactionTable(client); // ต้องมี ref_so_detail_id อยู่ก่อนเสมอ (ดู fetchRowById)
        const { customer_id, search } = req.query;
        let query = `
            SELECT t.id AS header_id, t.doc_no, t.doc_date, t.status, t.currency_code, t.exchange_rate,
                   dt.id AS detail_id, dt.line_no, dt.item_id, dt.item_code, dt.item_name, dt.uom_id, dt.qty_ordered, dt.unit_price_fc,
                   u.uom_code,
                   COALESCE((
                       SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                       JOIN im_transaction imt ON imt.id = imd.header_id
                       WHERE imd.ref_so_detail_id = dt.id AND imt.status IN ('Posted', 'Delivered')
                   ), 0) AS qty_delivered
            FROM so_transaction_detail dt
            JOIN so_transaction t ON t.id = dt.header_id
            LEFT JOIN im_uom u ON u.id = dt.uom_id
            WHERE t.status IN ('Approved', 'PartiallyDelivered')`;
        const params = [];
        let pi = 1;
        if (customer_id) { params.push(customer_id); query += ` AND t.customer_id = $${pi++}`; }
        if (search) { params.push(`%${search.toUpperCase()}%`); query += ` AND UPPER(t.doc_no) LIKE $${pi++}`; }
        query += ` ORDER BY t.doc_date DESC, t.id DESC, dt.line_no`;
        const result = await client.query(query, params);
        const lines = result.rows
            .map(r => ({ ...r, qty_remaining: Number(r.qty_ordered) - Number(r.qty_delivered) }))
            .filter(r => r.qty_remaining > 0.0001);
        res.status(200).json(lines);
    } catch (error) {
        console.error('Error fetching so_transaction deliverable_lines:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- Cross-module helpers, called from imTransactionController.js's DLN posting path ---

// ตรวจสอบว่าจำนวนที่จะส่ง (ต่อบรรทัด DLN ที่อ้างอิง ref_so_detail_id) ไม่เกินจำนวนคงเหลือที่ส่งได้ของบรรทัด SO ต้นฉบับ
// เอกสาร SO หนึ่งบรรทัดอาจถูกส่งหลายครั้ง (คนละใบ DLN) คงเหลือคำนวณจากผลรวมการส่งที่ Posted/Delivered แล้วเท่านั้น —
// มิเรอร์ validatePoReceivableQty ใน poTransactionController.js ทุกประการ
const validateSoDeliverableQty = async (client, { refSoDetailId, requestedQty, customerId }) => {
    const origRes = await client.query(`
        SELECT sod.qty_ordered, sod.item_code, sod.header_id, so.customer_id, so.status AS so_status
        FROM so_transaction_detail sod JOIN so_transaction so ON so.id = sod.header_id
        WHERE sod.id = $1
    `, [refSoDetailId]);
    if (origRes.rows.length === 0) throw new Error('ไม่พบรายการใบสั่งขายต้นฉบับที่อ้างอิง');
    const orig = origRes.rows[0];
    if (!['Approved', 'PartiallyDelivered'].includes(orig.so_status)) {
        throw new Error(`ใบสั่งขาย ${orig.item_code} ต้องอยู่สถานะ Approved หรือ PartiallyDelivered เท่านั้นจึงจะส่งสินค้าเพิ่มได้`);
    }
    if (Number(orig.customer_id) !== Number(customerId)) {
        throw new Error('ลูกค้าของใบส่งสินค้าต้องตรงกับลูกค้าของใบสั่งขายที่อ้างอิง');
    }
    const deliveredRes = await client.query(`
        SELECT COALESCE(SUM(ABS(imd.qty)), 0) AS delivered
        FROM im_transaction_detail imd JOIN im_transaction imt ON imt.id = imd.header_id
        WHERE imd.ref_so_detail_id = $1 AND imt.status IN ('Posted', 'Delivered')
    `, [refSoDetailId]);
    const remaining = Number(orig.qty_ordered) - Number(deliveredRes.rows[0].delivered);
    if (requestedQty > remaining + 0.0001) {
        throw new Error(`จำนวนที่ส่งเกินกว่าคงเหลือที่สั่งขายของ ${orig.item_code} (คงเหลือส่งได้ ${remaining})`);
    }
    return { soTransactionId: orig.header_id };
};

// เรียกหลัง DLN Post สำเร็จ (บรรทัดที่อ้างอิง SO) ในทรานแซกชันเดียวกัน — คำนวณสถานะ SO ใหม่จากผลรวมจำนวนที่ส่งแล้ว
// เทียบกับจำนวนที่สั่งทั้งหมด ไม่แตะสถานะ Closed/Void (ถือว่าเป็นการตัดสินใจของคนแล้ว ไม่ควรถูก auto-flip กลับ) —
// มิเรอร์ refreshPoStatus ใน poTransactionController.js ทุกประการ
const refreshSoStatus = async (client, soTransactionId) => {
    const statusRes = await client.query(`SELECT status FROM so_transaction WHERE id=$1 FOR UPDATE`, [soTransactionId]);
    if (statusRes.rows.length === 0) return;
    if (!['Approved', 'PartiallyDelivered', 'FullyDelivered'].includes(statusRes.rows[0].status)) return;

    const sumRes = await client.query(`
        SELECT
            COALESCE(SUM(sod.qty_ordered), 0) AS ordered,
            COALESCE(SUM((
                SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                JOIN im_transaction imt ON imt.id = imd.header_id
                WHERE imd.ref_so_detail_id = sod.id AND imt.status IN ('Posted', 'Delivered')
            )), 0) AS delivered
        FROM so_transaction_detail sod WHERE sod.header_id = $1
    `, [soTransactionId]);
    const { ordered, delivered } = sumRes.rows[0];
    // FullyDelivered is distinct from Approved (all qty out, but user hasn't clicked Close yet) — the UI uses this to
    // prompt "ready to close" without auto-closing (Close stays a deliberate action, mirrors po_transaction/im_stock_count)
    let newStatus = 'Approved';
    if (Number(delivered) > 0) {
        newStatus = Number(delivered) < Number(ordered) ? 'PartiallyDelivered' : 'FullyDelivered';
    }
    await client.query(`UPDATE so_transaction SET status=$1, updated_at=NOW() WHERE id=$2`, [newStatus, soTransactionId]);
};

module.exports = {
    ensureSoTransactionTable,
    fetchRows, fetchRow, fetchRowById, fetchDeliverableLines,
    createTransaction, updateTransaction, approveTransaction, closeTransaction, voidTransaction, deleteTransaction,
    validateSoDeliverableQty, refreshSoStatus,
};
