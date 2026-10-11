// controllers/mo/moHeaderController.js — ใบสั่งผลิต (Manufacturing Order, sys_module='61')
// เอกสารแผนงานเท่านั้น — ไม่แตะ GL/สต็อกเลย (มิเรอร์ po_transaction/so_transaction ทุกประการ) ผลกระทบจริงต่อสต็อก/
// บัญชีเกิดที่ธุรกรรม IM sys_doc_type '90' (เบิกวัตถุดิบเข้าผลิต) / '95' (รับสินค้าเข้าคลังจากการผลิต) ซึ่งอ้างอิง
// กลับมาที่ mo_header (ref_mo_id) / mo_component_detail (ref_mo_component_detail_id) / mo_output_detail
// (ref_mo_output_detail_id) — ดู validateMoComponentIssueQty/validateMoOutputReceiptQty/refreshMoStatus ด้านล่าง
// และ postDetailLines ใน imTransactionController.js สำหรับฝั่งที่เรียกใช้จริงตอน Post
//
// workflow: Draft (แก้ไขได้ทั้งหมด) -> Released (ผูกพันแล้ว พร้อมให้ฝ่ายผลิตเริ่มเบิก/รับ)
//   -> InProgress (auto เมื่อมีการเบิก/รับครั้งแรก) -> Completed (auto เมื่อรับผลผลิตครบตามแผนทุกรายการ)
//   Draft/Released -> Cancelled (ยกเลิกได้ถ้ายังไม่มีการเบิก/รับใดๆ โพสต์เข้ามาอ้างอิงเลย)
// สถานะ Closed (ปิดพร้อม WIP true-up เข้าบัญชีผลต่าง) จะเพิ่มพร้อมกับ costing engine ('95' unit_cost) ในขั้นถัดไป
'use strict';

const { generateDocNo } = require('../im/imTransactionController');
const { ensureImItemTable } = require('../im/imItemController');
const { ensureImUomTable } = require('../im/imUomController');
const { ensureImWarehouseTable } = require('../im/imWarehouseController');
const { ensureImLocationTable } = require('../im/imLocationController');
const { ensureMoBomTable } = require('./moBomController');

const ensureMoHeaderTable = async (client) => {
    await ensureImItemTable(client);
    await ensureImUomTable(client);
    await ensureImWarehouseTable(client);
    await ensureImLocationTable(client);
    await ensureMoBomTable(client); // cascades to ensureMoWorkCenterTable ด้วย

    await client.query(`
        CREATE TABLE IF NOT EXISTS mo_header (
            id                SERIAL PRIMARY KEY,
            doc_id            INTEGER NOT NULL REFERENCES sa_module_document(id),
            doc_no            VARCHAR(50) NOT NULL,
            doc_code          VARCHAR(10) NOT NULL,
            doc_date          DATE NOT NULL,
            bom_header_id     INTEGER REFERENCES mo_bom_header(id),
            warehouse_id      INTEGER NOT NULL REFERENCES im_warehouse(id),
            order_qty         NUMERIC(18,4) NOT NULL DEFAULT 0,
            uom_id            INTEGER REFERENCES im_uom(id),
            issue_method      VARCHAR(10) NOT NULL DEFAULT 'EXPLICIT',
            costing_method    VARCHAR(10) NOT NULL DEFAULT 'ACTUAL',
            costing_mode      VARCHAR(20) NOT NULL DEFAULT 'OVERHEAD_PERCENT',
            overhead_percent  NUMERIC(5,2) NOT NULL DEFAULT 0,
            due_date          DATE,
            status            VARCHAR(20) NOT NULL DEFAULT 'Draft',
            wip_balance_lc    NUMERIC(18,4) NOT NULL DEFAULT 0,
            parent_mo_id      INTEGER REFERENCES mo_header(id),
            description       TEXT,
            dim1_id INTEGER, dim2_id INTEGER, dim3_id INTEGER, dim4_id INTEGER, dim5_id INTEGER,
            branch_id         INTEGER REFERENCES cd_branch(id),
            released_at       TIMESTAMPTZ,
            released_by       VARCHAR(100),
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by        VARCHAR(100),
            updated_by        VARCHAR(100)
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mo_header_date      ON mo_header(doc_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mo_header_status    ON mo_header(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mo_header_warehouse ON mo_header(warehouse_id)`);
    // widen costing_mode for DBs where mo_header was created before this column was VARCHAR(20) —
    // 'OVERHEAD_PERCENT' is 16 chars, didn't fit the original VARCHAR(10)
    await client.query(`ALTER TABLE mo_header ALTER COLUMN costing_mode TYPE VARCHAR(20)`).catch(() => {});

    await client.query(`
        CREATE TABLE IF NOT EXISTS mo_component_detail (
            id                SERIAL PRIMARY KEY,
            header_id         INTEGER NOT NULL REFERENCES mo_header(id) ON DELETE CASCADE,
            line_no           INTEGER NOT NULL,
            component_item_id INTEGER NOT NULL REFERENCES im_item(id),
            item_code         VARCHAR(30),
            item_name         VARCHAR(200),
            planned_qty       NUMERIC(18,4) NOT NULL DEFAULT 0,
            issued_qty        NUMERIC(18,4) NOT NULL DEFAULT 0,
            uom_id            INTEGER REFERENCES im_uom(id),
            location_id       INTEGER REFERENCES im_location(id)
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mo_component_detail_header ON mo_component_detail(header_id)`);

    await client.query(`
        CREATE TABLE IF NOT EXISTS mo_output_detail (
            id                SERIAL PRIMARY KEY,
            header_id         INTEGER NOT NULL REFERENCES mo_header(id) ON DELETE CASCADE,
            line_no           INTEGER NOT NULL,
            output_item_id    INTEGER NOT NULL REFERENCES im_item(id),
            item_code         VARCHAR(30),
            item_name         VARCHAR(200),
            planned_qty       NUMERIC(18,4) NOT NULL DEFAULT 0,
            received_qty      NUMERIC(18,4) NOT NULL DEFAULT 0,
            uom_id            INTEGER REFERENCES im_uom(id),
            is_primary_output BOOLEAN NOT NULL DEFAULT false
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mo_output_detail_header ON mo_output_detail(header_id)`);

    await client.query(`
        CREATE TABLE IF NOT EXISTS mo_operation_detail (
            id                      SERIAL PRIMARY KEY,
            header_id               INTEGER NOT NULL REFERENCES mo_header(id) ON DELETE CASCADE,
            line_no                 INTEGER NOT NULL,
            work_center_id          INTEGER NOT NULL REFERENCES mo_work_center(id),
            operation_name          VARCHAR(100),
            planned_labor_hours     NUMERIC(10,4) NOT NULL DEFAULT 0,
            planned_machine_hours   NUMERIC(10,4) NOT NULL DEFAULT 0,
            actual_labor_hours      NUMERIC(10,4) NOT NULL DEFAULT 0,
            actual_machine_hours    NUMERIC(10,4) NOT NULL DEFAULT 0,
            status                  VARCHAR(20) NOT NULL DEFAULT 'Pending'
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mo_operation_detail_header ON mo_operation_detail(header_id)`);

    // parent_mo_detail_id — บรรทัดส่วนประกอบของ MO แม่ที่ MO ลูกนี้ถูกสร้างมาเพื่อผลิตให้ (ดู process "สร้างใบสั่ง
    // ผลิตย่อย") ต้องเพิ่มทีหลังสุด เพราะ mo_component_detail เพิ่งถูกสร้างขึ้นด้านบนนี้เอง (วน FK ไป-กลับกับ
    // mo_header ไม่ได้ถ้าสร้างสองตารางนี้พร้อมกันในคราวเดียว)
    await client.query(`ALTER TABLE mo_header ADD COLUMN IF NOT EXISTS parent_mo_detail_id INTEGER REFERENCES mo_component_detail(id)`).catch(() => {});
};

const HEADER_SELECT = `
    SELECT h.*,
           d.doc_code AS d_doc_code, d.doc_name_thai, d.doc_name_eng, d.is_auto_numbering,
           bh.bom_version AS bom_version, bh.parent_item_id AS bom_parent_item_id,
           bpi.item_code AS bom_parent_item_code, bpi.item_name_th AS bom_parent_item_name_th, bpi.item_name_en AS bom_parent_item_name_en,
           w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
           u.uom_code, u.uom_name_th, u.uom_name_en,
           b.branch_code, b.branch_name_thai,
           pm.doc_no AS parent_mo_doc_no
    FROM mo_header h
    JOIN sa_module_document d ON d.id = h.doc_id
    LEFT JOIN mo_bom_header bh ON bh.id = h.bom_header_id
    LEFT JOIN im_item bpi      ON bpi.id = bh.parent_item_id
    LEFT JOIN im_warehouse w   ON w.id  = h.warehouse_id
    LEFT JOIN im_uom u         ON u.id  = h.uom_id
    LEFT JOIN cd_branch b      ON b.id  = h.branch_id
    LEFT JOIN mo_header pm     ON pm.id = h.parent_mo_id
`;

const COMPONENT_SELECT = `
    SELECT c.*,
           ci.item_code AS component_item_code, ci.item_name_th AS component_item_name_th, ci.item_name_en AS component_item_name_en,
           u.uom_code, u.uom_name_th, u.uom_name_en,
           l.location_code, l.location_name
    FROM mo_component_detail c
    LEFT JOIN im_item ci ON ci.id = c.component_item_id
    LEFT JOIN im_uom u   ON u.id  = c.uom_id
    LEFT JOIN im_location l ON l.id = c.location_id
    WHERE c.header_id = $1
    ORDER BY c.line_no
`;

const OUTPUT_SELECT = `
    SELECT o.*,
           oi.item_code AS output_item_code, oi.item_name_th AS output_item_name_th, oi.item_name_en AS output_item_name_en,
           u.uom_code, u.uom_name_th, u.uom_name_en
    FROM mo_output_detail o
    LEFT JOIN im_item oi ON oi.id = o.output_item_id
    LEFT JOIN im_uom u   ON u.id  = o.uom_id
    WHERE o.header_id = $1
    ORDER BY o.line_no
`;

const OPERATION_SELECT = `
    SELECT op.*,
           wc.work_center_code, wc.work_center_name_th, wc.work_center_name_en
    FROM mo_operation_detail op
    LEFT JOIN mo_work_center wc ON wc.id = op.work_center_id
    WHERE op.header_id = $1
    ORDER BY op.line_no
`;

const fetchRowById = async (pool, id) => {
    const hRes = await pool.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
    if (hRes.rows.length === 0) return null;
    const [components, outputs, operations] = await Promise.all([
        pool.query(COMPONENT_SELECT, [id]),
        pool.query(OUTPUT_SELECT, [id]),
        pool.query(OPERATION_SELECT, [id]),
    ]);
    return { ...hRes.rows[0], components: components.rows, outputs: outputs.rows, operations: operations.rows };
};

// --- GET list ---
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureMoHeaderTable(client);
        const { status, warehouse_id, date_from, date_to, search } = req.query;
        let query = `
            SELECT h.id, h.doc_no, h.doc_date, h.status, h.warehouse_id, h.order_qty, h.due_date, h.description,
                   w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                   u.uom_code,
                   bh.parent_item_id AS bom_parent_item_id, pi.item_code AS bom_parent_item_code,
                   pi.item_name_th AS bom_parent_item_name_th, pi.item_name_en AS bom_parent_item_name_en,
                   d.doc_code, d.doc_name_thai, d.doc_name_eng
            FROM mo_header h
            JOIN sa_module_document d ON d.id = h.doc_id
            LEFT JOIN im_warehouse w  ON w.id = h.warehouse_id
            LEFT JOIN im_uom u        ON u.id = h.uom_id
            LEFT JOIN mo_bom_header bh ON bh.id = h.bom_header_id
            LEFT JOIN im_item pi      ON pi.id = bh.parent_item_id
            WHERE 1=1`;
        const params = [];
        let pi2 = 1;
        if (status)       { params.push(status);       query += ` AND h.status = $${pi2++}`; }
        if (warehouse_id)  { params.push(warehouse_id);  query += ` AND h.warehouse_id = $${pi2++}`; }
        if (date_from)     { params.push(date_from);     query += ` AND h.doc_date >= $${pi2++}`; }
        if (date_to)       { params.push(date_to);       query += ` AND h.doc_date <= $${pi2++}`; }
        if (search) {
            params.push(`%${search.toUpperCase()}%`);
            query += ` AND (UPPER(h.doc_no) LIKE $${pi2} OR UPPER(COALESCE(pi.item_code,'')) LIKE $${pi2})`;
            pi2++;
        }
        query += ` ORDER BY h.doc_date DESC, h.id DESC`;
        const result = await client.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching mo_header list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- GET one ---
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureMoHeaderTable(client);
        const data = await fetchRowById(req.dbPool, req.params.id);
        if (!data) return res.status(404).json({ message: 'ไม่พบใบสั่งผลิต' });
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching mo_header row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- 1. Create (always Draft) ---
const createTransaction = async (req, res) => {
    const { header, components, outputs, operations } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureMoHeaderTable(client);

        if (!header.warehouse_id) throw new Error('กรุณาระบุคลังปลายทาง');
        if (!header.order_qty || Number(header.order_qty) <= 0) throw new Error('กรุณาระบุจำนวนที่สั่งผลิตให้มากกว่า 0');
        if (!Array.isArray(components) || components.length === 0) throw new Error('ต้องมีส่วนประกอบอย่างน้อย 1 รายการ');
        if (!Array.isArray(outputs) || outputs.length === 0) throw new Error('ต้องมีผลผลิตอย่างน้อย 1 รายการ');

        const docTypeRes = await client.query(`SELECT doc_code FROM sa_module_document WHERE id=$1`, [header.doc_id]);
        if (docTypeRes.rows.length === 0) throw new Error('ไม่พบประเภทเอกสาร');
        const docCode = docTypeRes.rows[0].doc_code;

        let docNo = header.doc_no;
        if (!docNo || docNo === 'AUTO') {
            docNo = await generateDocNo(client, header.doc_id, header.doc_date, header.branch_id || null);
            if (!docNo) throw new Error('Auto numbering failed or manual doc_no required');
        }

        const hRes = await client.query(`
            INSERT INTO mo_header
                (doc_id, doc_no, doc_code, doc_date, bom_header_id, warehouse_id, order_qty, uom_id,
                 issue_method, costing_method, costing_mode, overhead_percent, due_date, description,
                 parent_mo_id, parent_mo_detail_id,
                 dim1_id, dim2_id, dim3_id, dim4_id, dim5_id, branch_id, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)
            RETURNING id
        `, [
            header.doc_id, docNo, docCode, header.doc_date, header.bom_header_id || null, header.warehouse_id,
            header.order_qty, header.uom_id || null,
            header.issue_method || 'EXPLICIT', header.costing_method || 'ACTUAL', header.costing_mode || 'OVERHEAD_PERCENT',
            header.overhead_percent ?? 0, header.due_date || null, header.description || null,
            header.parent_mo_id || null, header.parent_mo_detail_id || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, header.created_by || null,
        ]);
        const headerId = hRes.rows[0].id;

        let lineNo = 1;
        for (const c of components) {
            if (!c.component_item_id) continue;
            await client.query(`
                INSERT INTO mo_component_detail (header_id, line_no, component_item_id, item_code, item_name, planned_qty, uom_id, location_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `, [headerId, lineNo++, c.component_item_id, c.item_code || null, c.item_name || null, c.planned_qty ?? 0, c.uom_id || null, c.location_id || null]);
        }

        let outLineNo = 1;
        for (const o of outputs) {
            if (!o.output_item_id) continue;
            await client.query(`
                INSERT INTO mo_output_detail (header_id, line_no, output_item_id, item_code, item_name, planned_qty, uom_id, is_primary_output)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `, [headerId, outLineNo++, o.output_item_id, o.item_code || null, o.item_name || null, o.planned_qty ?? 0, o.uom_id || null, o.is_primary_output ?? false]);
        }

        let opLineNo = 1;
        for (const op of (operations || [])) {
            if (!op.work_center_id) continue;
            await client.query(`
                INSERT INTO mo_operation_detail (header_id, line_no, work_center_id, operation_name, planned_labor_hours, planned_machine_hours)
                VALUES ($1,$2,$3,$4,$5,$6)
            `, [headerId, opLineNo++, op.work_center_id, op.operation_name || null, op.planned_labor_hours ?? 0, op.planned_machine_hours ?? 0]);
        }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, headerId);
        res.status(201).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating mo_header:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 2. Update (Draft only — full header+lines replace) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, components, outputs, operations } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM mo_header WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (existing.rows[0].status !== 'Draft') throw new Error('แก้ไขได้เฉพาะเอกสาร Draft เท่านั้น');

        if (!header.warehouse_id) throw new Error('กรุณาระบุคลังปลายทาง');
        if (!header.order_qty || Number(header.order_qty) <= 0) throw new Error('กรุณาระบุจำนวนที่สั่งผลิตให้มากกว่า 0');
        if (!Array.isArray(components) || components.length === 0) throw new Error('ต้องมีส่วนประกอบอย่างน้อย 1 รายการ');
        if (!Array.isArray(outputs) || outputs.length === 0) throw new Error('ต้องมีผลผลิตอย่างน้อย 1 รายการ');

        await client.query(`
            UPDATE mo_header SET
                bom_header_id    = $1,
                warehouse_id     = $2,
                order_qty        = $3,
                uom_id           = $4,
                issue_method     = $5,
                costing_method   = $6,
                costing_mode     = $7,
                overhead_percent = $8,
                due_date         = $9,
                description      = $10,
                updated_by       = $11,
                updated_at       = NOW()
            WHERE id = $12
        `, [
            header.bom_header_id || null, header.warehouse_id, header.order_qty, header.uom_id || null,
            header.issue_method || 'EXPLICIT', header.costing_method || 'ACTUAL', header.costing_mode || 'OVERHEAD_PERCENT',
            header.overhead_percent ?? 0, header.due_date || null, header.description || null,
            header.updated_by || null, id,
        ]);

        await client.query(`DELETE FROM mo_component_detail WHERE header_id = $1`, [id]);
        let lineNo = 1;
        for (const c of components) {
            if (!c.component_item_id) continue;
            await client.query(`
                INSERT INTO mo_component_detail (header_id, line_no, component_item_id, item_code, item_name, planned_qty, uom_id, location_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `, [id, lineNo++, c.component_item_id, c.item_code || null, c.item_name || null, c.planned_qty ?? 0, c.uom_id || null, c.location_id || null]);
        }

        await client.query(`DELETE FROM mo_output_detail WHERE header_id = $1`, [id]);
        let outLineNo = 1;
        for (const o of outputs) {
            if (!o.output_item_id) continue;
            await client.query(`
                INSERT INTO mo_output_detail (header_id, line_no, output_item_id, item_code, item_name, planned_qty, uom_id, is_primary_output)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `, [id, outLineNo++, o.output_item_id, o.item_code || null, o.item_name || null, o.planned_qty ?? 0, o.uom_id || null, o.is_primary_output ?? false]);
        }

        await client.query(`DELETE FROM mo_operation_detail WHERE header_id = $1`, [id]);
        let opLineNo = 1;
        for (const op of (operations || [])) {
            if (!op.work_center_id) continue;
            await client.query(`
                INSERT INTO mo_operation_detail (header_id, line_no, work_center_id, operation_name, planned_labor_hours, planned_machine_hours)
                VALUES ($1,$2,$3,$4,$5,$6)
            `, [id, opLineNo++, op.work_center_id, op.operation_name || null, op.planned_labor_hours ?? 0, op.planned_machine_hours ?? 0]);
        }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating mo_header:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 3. Release (Draft -> Released — ผูกพันแล้ว พร้อมให้ฝ่ายผลิตเริ่มเบิก/รับ) ---
const releaseTransaction = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM mo_header WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (existing.rows[0].status !== 'Draft') throw new Error('ปล่อยใบสั่งผลิตได้เฉพาะเอกสาร Draft เท่านั้น');
        await client.query(`
            UPDATE mo_header SET status='Released', released_at=NOW(), released_by=$1, updated_by=$1, updated_at=NOW()
            WHERE id=$2
        `, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error releasing mo_header:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 4. Cancel (Draft/Released -> Cancelled — บล็อกถ้ามีการเบิก/รับใดๆ อ้างอิงเข้ามาแล้ว) ---
const cancelTransaction = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM mo_header WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (!['Draft', 'Released'].includes(existing.rows[0].status)) {
            throw new Error('ยกเลิกได้เฉพาะเอกสารสถานะ Draft หรือ Released เท่านั้น');
        }
        const postedRes = await client.query(`
            SELECT COALESCE(SUM(issued_qty), 0) AS issued FROM mo_component_detail WHERE header_id = $1
        `, [id]);
        const receivedRes = await client.query(`
            SELECT COALESCE(SUM(received_qty), 0) AS received FROM mo_output_detail WHERE header_id = $1
        `, [id]);
        if (Number(postedRes.rows[0].issued) > 0 || Number(receivedRes.rows[0].received) > 0) {
            throw new Error('ไม่สามารถยกเลิกได้ เนื่องจากมีการเบิกวัตถุดิบหรือรับสินค้าเข้าคลังจากใบสั่งผลิตนี้ไปแล้ว');
        }
        await client.query(`UPDATE mo_header SET status='Cancelled', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error cancelling mo_header:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 5. Delete (Draft only) ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM mo_header WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (existing.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ลบได้เฉพาะเอกสาร Draft เท่านั้น' }); }
        await client.query(`DELETE FROM mo_header WHERE id=$1`, [id]);
        await client.query('COMMIT');
        res.status(204).send();
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting mo_header:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// ตรวจคงเหลือที่เบิกได้ของบรรทัดส่วนประกอบ MO นี้ ก่อน Post ธุรกรรม '90' (เบิกวัตถุดิบเข้าผลิต) ที่อ้างอิงเข้ามา —
// มิเรอร์ validatePoReceivableQty ใน poTransactionController.js ทุกประการ (ไม่ต้องเทียบผู้ขาย/ลูกค้าเหมือน PO/SO
// เพราะธุรกรรม IM ที่อ้างอิง MO ไม่มีแนวคิดคู่ค้า)
const validateMoComponentIssueQty = async (client, { refMoComponentDetailId, requestedQty }) => {
    const origRes = await client.query(`
        SELECT c.planned_qty, c.item_code, c.header_id, h.status AS mo_status
        FROM mo_component_detail c JOIN mo_header h ON h.id = c.header_id
        WHERE c.id = $1
    `, [refMoComponentDetailId]);
    if (origRes.rows.length === 0) throw new Error('ไม่พบรายการส่วนประกอบของใบสั่งผลิตที่อ้างอิง');
    const orig = origRes.rows[0];
    if (!['Released', 'InProgress'].includes(orig.mo_status)) {
        throw new Error(`ใบสั่งผลิตของ ${orig.item_code} ต้องอยู่สถานะ Released หรือ InProgress เท่านั้นจึงจะเบิกวัตถุดิบเพิ่มได้`);
    }
    const issuedRes = await client.query(`
        SELECT COALESCE(SUM(ABS(imd.qty)), 0) AS issued
        FROM im_transaction_detail imd JOIN im_transaction imt ON imt.id = imd.header_id
        WHERE imd.ref_mo_component_detail_id = $1 AND imt.status = 'Posted'
    `, [refMoComponentDetailId]);
    const remaining = Number(orig.planned_qty) - Number(issuedRes.rows[0].issued);
    if (requestedQty > remaining + 0.0001) {
        throw new Error(`จำนวนที่เบิกเกินกว่าที่วางแผนไว้ของ ${orig.item_code} (คงเหลือเบิกได้ ${remaining})`);
    }
    return { moHeaderId: orig.header_id };
};

// ตรวจคงเหลือที่รับได้ของบรรทัดผลผลิต MO นี้ ก่อน Post ธุรกรรม '95' (รับสินค้าเข้าคลังจากการผลิต) ที่อ้างอิงเข้ามา —
// มิเรอร์ validateMoComponentIssueQty ข้างบนทุกประการ ฝั่งผลผลิต
const validateMoOutputReceiptQty = async (client, { refMoOutputDetailId, requestedQty }) => {
    const origRes = await client.query(`
        SELECT o.planned_qty, o.item_code, o.header_id, h.status AS mo_status
        FROM mo_output_detail o JOIN mo_header h ON h.id = o.header_id
        WHERE o.id = $1
    `, [refMoOutputDetailId]);
    if (origRes.rows.length === 0) throw new Error('ไม่พบรายการผลผลิตของใบสั่งผลิตที่อ้างอิง');
    const orig = origRes.rows[0];
    if (!['Released', 'InProgress'].includes(orig.mo_status)) {
        throw new Error(`ใบสั่งผลิตของ ${orig.item_code} ต้องอยู่สถานะ Released หรือ InProgress เท่านั้นจึงจะรับสินค้าเพิ่มได้`);
    }
    const receivedRes = await client.query(`
        SELECT COALESCE(SUM(ABS(imd.qty)), 0) AS received
        FROM im_transaction_detail imd JOIN im_transaction imt ON imt.id = imd.header_id
        WHERE imd.ref_mo_output_detail_id = $1 AND imt.status = 'Posted'
    `, [refMoOutputDetailId]);
    const remaining = Number(orig.planned_qty) - Number(receivedRes.rows[0].received);
    if (requestedQty > remaining + 0.0001) {
        throw new Error(`จำนวนที่รับเกินกว่าที่วางแผนไว้ของ ${orig.item_code} (คงเหลือรับได้ ${remaining})`);
    }
    return { moHeaderId: orig.header_id };
};

// เรียกหลัง Post ธุรกรรม '90'/'95' สำเร็จ (บรรทัดที่อ้างอิง MO) ในทรานแซกชันเดียวกัน — sync issued_qty/
// received_qty + wip_balance_lc จากผลรวมจริงใน im_transaction(_detail) ก่อนเสมอ (ไม่ไว้ใจ incremental update
// เพราะทนต่อการ Void/แก้ไขย้อนหลังได้ มิเรอร์ refreshPoStatus/refreshSoStatus) แล้วค่อยคำนวณสถานะใบสั่งผลิตใหม่ —
// ต่างจาก PO/SO ที่ดูทิศทางเดียว (รับ/ส่ง) MO ต้องดูทั้งสองทิศทาง (เบิก+รับ) เพราะอยู่ในใบเดียวกัน ไม่แตะ
// Draft/Cancelled/Closed (ถือว่าเป็นการตัดสินใจของคนแล้ว ไม่ควรถูก auto-flip กลับ)
const refreshMoStatus = async (client, moHeaderId) => {
    const statusRes = await client.query(`SELECT status FROM mo_header WHERE id=$1 FOR UPDATE`, [moHeaderId]);
    if (statusRes.rows.length === 0) return;
    if (!['Released', 'InProgress', 'Completed'].includes(statusRes.rows[0].status)) return;

    await client.query(`
        UPDATE mo_component_detail c SET issued_qty = COALESCE((
            SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
            JOIN im_transaction imt ON imt.id = imd.header_id
            WHERE imd.ref_mo_component_detail_id = c.id AND imt.status = 'Posted'
        ), 0) WHERE c.header_id = $1
    `, [moHeaderId]);
    await client.query(`
        UPDATE mo_output_detail o SET received_qty = COALESCE((
            SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
            JOIN im_transaction imt ON imt.id = imd.header_id
            WHERE imd.ref_mo_output_detail_id = o.id AND imt.status = 'Posted'
        ), 0) WHERE o.header_id = $1
    `, [moHeaderId]);

    // wip_balance_lc = มูลค่าเบิกเข้า WIP สะสม (ธุรกรรม '90') หักมูลค่ารับออกจาก WIP สะสม (ธุรกรรม '95') — ควรจะ
    // เท่ากับยอดคงเหลือจริงในบัญชี wip_account_id ของ MO ใบนี้เสมอ ถ้าไม่ตรงกันตอน Close (costing engine ขั้นถัดไป)
    // แสดงว่ามีผลต่างต้องโอนเข้าบัญชีผลต่าง (variance_account_id)
    const wipRes = await client.query(`
        SELECT
            COALESCE((
                SELECT SUM(ABS(imd.qty) * imd.unit_cost) FROM im_transaction_detail imd
                JOIN im_transaction imt ON imt.id = imd.header_id
                WHERE imd.header_id IN (SELECT id FROM im_transaction WHERE ref_mo_id = $1)
                  AND imd.ref_mo_component_detail_id IS NOT NULL AND imt.status = 'Posted'
            ), 0) AS issued_value,
            COALESCE((
                SELECT SUM(ABS(imd.qty) * imd.unit_cost) FROM im_transaction_detail imd
                JOIN im_transaction imt ON imt.id = imd.header_id
                WHERE imd.header_id IN (SELECT id FROM im_transaction WHERE ref_mo_id = $1)
                  AND imd.ref_mo_output_detail_id IS NOT NULL AND imt.status = 'Posted'
            ), 0) AS received_value
    `, [moHeaderId]);
    const wipBalance = Number(wipRes.rows[0].issued_value) - Number(wipRes.rows[0].received_value);

    const sumRes = await client.query(`
        SELECT
            COALESCE((SELECT SUM(c.issued_qty) FROM mo_component_detail c WHERE c.header_id = $1), 0) AS issued,
            COALESCE((SELECT SUM(o.planned_qty) FROM mo_output_detail o WHERE o.header_id = $1), 0) AS output_planned,
            COALESCE((SELECT SUM(o.received_qty) FROM mo_output_detail o WHERE o.header_id = $1), 0) AS output_received
    `, [moHeaderId]);
    const { issued, output_planned, output_received } = sumRes.rows[0];
    let newStatus = 'Released';
    if (Number(output_received) > 0 && Number(output_received) >= Number(output_planned)) {
        newStatus = 'Completed';
    } else if (Number(issued) > 0 || Number(output_received) > 0) {
        newStatus = 'InProgress';
    }
    await client.query(`UPDATE mo_header SET status=$1, wip_balance_lc=$2, updated_at=NOW() WHERE id=$3`, [newStatus, wipBalance, moHeaderId]);
};

// คำนวณต้นทุนต่อหน่วยของผลผลิตที่กำลังจะรับเข้าคลังจากการผลิต (ธุรกรรม '95') ตามนโยบายต้นทุนของใบสั่งผลิต — ใช้
// เฉพาะ costing_method='ACTUAL' ในเฟสนี้เท่านั้น (STANDARD ต้อง throw ชัดเจน ไม่คำนวณผิดแบบเงียบๆ เพราะต้องมี GL
// leg ที่ 3 สำหรับผลต่างมาตรฐาน/จริง ซึ่งยังไม่ได้ทำ — ดูแผนออกแบบโมดูล MO)
//
// ต้นทุนรวม = ต้นทุนวัตถุดิบที่เบิกเข้า WIP สะสมจริงของ MO นี้ (ธุรกรรม '90' ที่ Posted ทั้งหมด) + ต้นทุนแปรรูป
// (overhead % ของต้นทุนวัตถุดิบ หรือผลรวมชั่วโมงแรงงาน/เครื่องจักร×อัตราศูนย์งาน ตาม costing_mode) — ปันส่วนตาม
// สัดส่วน planned_qty ของผลผลิตแต่ละบรรทัดเทียบกับผลผลิตทั้งหมดที่วางแผนไว้ (ไม่ใช่ received_qty เพราะต้นทุนทั้งก้อน
// ควรกระจายตามแผนเดิมเสมอ) แล้วหารด้วย planned_qty ของบรรทัดนั้นเพื่อให้ได้ต้นทุน/หน่วยที่คงที่ไม่ผันแปรตามว่า
// รับครั้งไหนก่อน/หลัง (ยกเว้นต้นทุนวัตถุดิบสะสมเองที่ยังเพิ่มขึ้นได้ถ้ามีการเบิกเพิ่มทีหลัง — เป็นข้อจำกัดที่ทราบ
// อยู่แล้วของระบบตีมูลค่าแบบ actual-cost ที่รับหลายรอบ ได้รับการแก้ไขให้ตรงเป๊ะตอน Close MO ในขั้นถัดไป)
const computeMoReceiptUnitCost = async (client, { moHeader, outputDetail }) => {
    if (moHeader.costing_method !== 'ACTUAL') {
        throw new Error(`ยังไม่รองรับการตีมูลค่าแบบ ${moHeader.costing_method} สำหรับการรับสินค้าเข้าคลังจากการผลิต (รองรับเฉพาะ ACTUAL ในเวอร์ชันนี้)`);
    }

    const materialRes = await client.query(`
        SELECT COALESCE(SUM(ABS(imd.qty) * imd.unit_cost), 0) AS total
        FROM im_transaction_detail imd JOIN im_transaction imt ON imt.id = imd.header_id
        WHERE imt.ref_mo_id = $1 AND imd.ref_mo_component_detail_id IS NOT NULL AND imt.status = 'Posted'
    `, [moHeader.id]);
    const materialCost = Number(materialRes.rows[0].total);

    let conversionCost = 0;
    if (moHeader.costing_mode === 'ROUTING') {
        const opRes = await client.query(`
            SELECT COALESCE(SUM(op.actual_labor_hours * wc.labor_rate_per_hour
                + op.actual_machine_hours * (wc.machine_rate_per_hour + wc.overhead_rate_per_hour)), 0) AS total
            FROM mo_operation_detail op JOIN mo_work_center wc ON wc.id = op.work_center_id
            WHERE op.header_id = $1
        `, [moHeader.id]);
        conversionCost = Number(opRes.rows[0].total);
    } else {
        conversionCost = materialCost * (Number(moHeader.overhead_percent) || 0) / 100;
    }
    const totalCost = materialCost + conversionCost;

    const totalPlannedRes = await client.query(
        `SELECT COALESCE(SUM(planned_qty), 0) AS total FROM mo_output_detail WHERE header_id = $1`,
        [moHeader.id]
    );
    const totalPlannedQty = Number(totalPlannedRes.rows[0].total) || 1;
    const outputShare = Number(outputDetail.planned_qty) / totalPlannedQty;
    const allocatedCost = totalCost * outputShare;

    const plannedQty = Number(outputDetail.planned_qty);
    return plannedQty > 0 ? allocatedCost / plannedQty : 0;
};

module.exports = {
    ensureMoHeaderTable, fetchRows, fetchRow, createTransaction, updateTransaction,
    releaseTransaction, cancelTransaction, deleteTransaction,
    validateMoComponentIssueQty, validateMoOutputReceiptQty, refreshMoStatus,
    computeMoReceiptUnitCost,
};
