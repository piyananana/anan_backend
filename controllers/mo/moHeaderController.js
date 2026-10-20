// controllers/mo/moHeaderController.js — ใบสั่งผลิต (Manufacturing Order, sys_module='61')
// เอกสารแผนงานเท่านั้น — ไม่แตะ GL/สต็อกเลย (มิเรอร์ po_transaction/so_transaction ทุกประการ) ผลกระทบจริงต่อสต็อก/
// บัญชีเกิดที่ธุรกรรม IM sys_doc_type '90' (เบิกวัตถุดิบเข้าผลิต) / '95' (รับสินค้าเข้าคลังจากการผลิต) ซึ่งอ้างอิง
// กลับมาที่ mo_header (ref_mo_id) / mo_component_detail (ref_mo_component_detail_id) / mo_output_detail
// (ref_mo_output_detail_id) — ดู validateMoComponentIssueQty/validateMoOutputReceiptQty/refreshMoStatus ด้านล่าง
// และ postDetailLines ใน imTransactionController.js สำหรับฝั่งที่เรียกใช้จริงตอน Post
//
// workflow: Draft (แก้ไขได้ทั้งหมด) -> Submitted (ส่งขออนุมัติ — คิวผู้อนุมัติของเมนู utils/docApproval.js doc_kind 'MO';
//   ไม่อนุมัติ = Rejected แก้ไขแล้วส่งใหม่ได้เหมือน Draft) -> Released (อนุมัติครบ — ผูกพันแล้ว พร้อมให้ฝ่ายผลิตเริ่มเบิก/รับ)
//   -> InProgress (auto เมื่อมีการเบิก/รับครั้งแรก) -> Completed (auto เมื่อรับผลผลิตครบตามแผนทุกรายการ)
//   Released -> Cancelled (ยกเลิกได้ถ้ายังไม่มีการเบิก/รับใดๆ อ้างอิงเข้ามาเลย ต้องมีเหตุผล)
//   Completed -> Closed (ปิดพร้อม WIP true-up เข้าบัญชีผลต่าง)
// ถอยสถานะ (ต้องมีเหตุผล บันทึกที่ sa_document_reverse_log): Released -> Draft (ยังไม่มีเบิก/รับ/บันทึกเวลา/ใบสั่ง
//   ผลิตย่อย) และ Closed -> Completed (ลบรายการปรับ WIP ถ้างวดยังเปิด ไม่เช่นนั้นลงรายการกลับวันนี้)
// ลบ: เฉพาะ Draft เก็บไว้ด้วยสถานะ Deleted (ไม่แสดงในรายการ เว้นแต่เลือกสถานะ Deleted)
// สถานะ Closed (ปิดพร้อม WIP true-up เข้าบัญชีผลต่าง) จะเพิ่มพร้อมกับ costing engine ('95' unit_cost) ในขั้นถัดไป
'use strict';

const { generateDocNo } = require('../im/imTransactionController');
const { fetchSetupByDocCode } = require('../im/imGlAccountSetupController');
const { ensureImItemTable } = require('../im/imItemController');
const { ensureImUomTable } = require('../im/imUomController');
const { ensureImWarehouseTable } = require('../im/imWarehouseController');
const { ensureImLocationTable } = require('../im/imLocationController');
const { ensureMoBomTable } = require('./moBomController');
const { today } = require('../../utils/dateUtil');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
const DA = require('../../utils/docApproval');
const KIND = 'MO';

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
    // Closed (ปิดใบสั่งผลิตพร้อม WIP true-up) — ดู closeTransaction ด้านล่าง
    await client.query(`ALTER TABLE mo_header ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE mo_header ADD COLUMN IF NOT EXISTS closed_by VARCHAR(100)`).catch(() => {});
    // คิวผู้อนุมัติ (utils/docApproval.js)
    await client.query(`
        ALTER TABLE mo_header
            ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(10) DEFAULT 'ALL',
            ADD COLUMN IF NOT EXISTS submitted_at  TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS submitted_by  VARCHAR(100)`).catch(() => {});
    // ถอยสถานะ / ยกเลิกมีเหตุผล (sql/mo_header_reverse_to_draft.sql)
    await client.query(`
        ALTER TABLE mo_header
            ADD COLUMN IF NOT EXISTS close_gl_entry_id    INTEGER,
            ADD COLUMN IF NOT EXISTS close_date           DATE,
            ADD COLUMN IF NOT EXISTS kept_close_gl_doc_no VARCHAR(50),
            ADD COLUMN IF NOT EXISTS cancel_reason        TEXT,
            ADD COLUMN IF NOT EXISTS cancelled_by         VARCHAR(100),
            ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ`).catch(() => {});

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
    await DA.ensureDocApprovalSchema(pool);
    return {
        ...hRes.rows[0], components: components.rows, outputs: outputs.rows, operations: operations.rows,
        approvals: await DA.loadApprovals(pool, KIND, Number(id)),
    };
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
        else query += ` AND h.status <> 'Deleted'`;
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

// --- รายงานสถานะใบสั่งผลิต (MO Status Report) — เหมือน fetchRows แต่เพิ่มยอดสรุปเบิก/รับสะสม+% สำเร็จต่อ MO —
// แยก endpoint ต่างหากจาก fetchRows เพราะ fetchRows ถูกใช้เป็น picker ในหลายหน้าจอ (Issue/Receipt/Explode/
// Availability) ที่ไม่ต้องการ subquery เพิ่มเติมเหล่านี้ทุกครั้งที่เรียก ===
const fetchStatusReport = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureMoHeaderTable(client);
        const { status, warehouse_id, date_from, date_to, search } = req.query;
        let query = `
            SELECT h.id, h.doc_no, h.doc_date, h.due_date, h.status, h.warehouse_id, h.order_qty, h.wip_balance_lc,
                   w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                   u.uom_code, u.uom_name_th, u.uom_name_en,
                   bh.parent_item_id AS bom_parent_item_id, pi.item_code AS bom_parent_item_code,
                   pi.item_name_th AS bom_parent_item_name_th, pi.item_name_en AS bom_parent_item_name_en,
                   COALESCE((SELECT SUM(c.planned_qty) FROM mo_component_detail c WHERE c.header_id = h.id), 0) AS component_planned_qty,
                   COALESCE((SELECT SUM(c.issued_qty)  FROM mo_component_detail c WHERE c.header_id = h.id), 0) AS component_issued_qty,
                   COALESCE((SELECT SUM(o.planned_qty)  FROM mo_output_detail o    WHERE o.header_id = h.id), 0) AS output_planned_qty,
                   COALESCE((SELECT SUM(o.received_qty) FROM mo_output_detail o    WHERE o.header_id = h.id), 0) AS output_received_qty
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
        else query += ` AND h.status <> 'Deleted'`;
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
        const rows = result.rows.map((r) => {
            const outputPlanned = Number(r.output_planned_qty);
            const outputReceived = Number(r.output_received_qty);
            const percentComplete = outputPlanned > 0 ? (outputReceived / outputPlanned) * 100 : 0;
            return { ...r, percent_complete: percentComplete };
        });
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error fetching MO status report:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- รายงานต้นทุนการผลิต/ผลต่าง (Cost/Variance Report) — ต่อ MO: material/labor/machine/overhead breakdown,
// ต้นทุนเฉลี่ย/หน่วยที่ตีมูลค่าจริงตอนรับเข้าคลัง (ถัวเฉลี่ยตาม qty รับจริงทุกครั้ง), และผลต่างมาตรฐาน/จริงที่
// โพสต์ไปแล้ว (เกิดเฉพาะ MO ที่ costing_method='STANDARD' เท่านั้น — ACTUAL จะเป็น 0 เสมอเพราะ unit_cost ที่ตีสต็อก
// เท่ากับต้นทุนจริงพอดี ไม่มีผลต่างให้โพสต์) สูตรคำนวณ labor/machine/overhead มิเรอร์ computeMoReceiptUnitCost
// ทุกประการ แต่รวมทั้ง MO ไม่ได้ปันส่วนต่อหน่วย/ต่อบรรทัดผลผลิตแบบตอน Post จริง
const fetchCostVarianceReport = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureMoHeaderTable(client);
        const { status, warehouse_id, date_from, date_to, search } = req.query;
        let query = `
            SELECT h.id, h.doc_no, h.doc_date, h.status, h.costing_method, h.costing_mode, h.overhead_percent, h.wip_balance_lc,
                   w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                   u.uom_code, u.uom_name_th, u.uom_name_en,
                   bh.parent_item_id AS bom_parent_item_id, pi.item_code AS bom_parent_item_code,
                   pi.item_name_th AS bom_parent_item_name_th, pi.item_name_en AS bom_parent_item_name_en,
                   COALESCE((
                       SELECT SUM(ABS(imd.qty) * imd.unit_cost) FROM im_transaction_detail imd
                       JOIN im_transaction imt ON imt.id = imd.header_id
                       WHERE imt.ref_mo_id = h.id AND imd.ref_mo_component_detail_id IS NOT NULL AND imt.status = 'Posted'
                   ), 0) AS material_cost,
                   COALESCE((
                       SELECT SUM(op.actual_labor_hours * wc.labor_rate_per_hour)
                       FROM mo_operation_detail op JOIN mo_work_center wc ON wc.id = op.work_center_id
                       WHERE op.header_id = h.id
                   ), 0) AS routing_labor_cost,
                   COALESCE((
                       SELECT SUM(op.actual_machine_hours * wc.machine_rate_per_hour)
                       FROM mo_operation_detail op JOIN mo_work_center wc ON wc.id = op.work_center_id
                       WHERE op.header_id = h.id
                   ), 0) AS routing_machine_cost,
                   COALESCE((
                       SELECT SUM(op.actual_machine_hours * wc.overhead_rate_per_hour)
                       FROM mo_operation_detail op JOIN mo_work_center wc ON wc.id = op.work_center_id
                       WHERE op.header_id = h.id
                   ), 0) AS routing_overhead_cost,
                   COALESCE((
                       SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                       JOIN im_transaction imt ON imt.id = imd.header_id
                       WHERE imt.ref_mo_id = h.id AND imd.ref_mo_output_detail_id IS NOT NULL AND imt.status = 'Posted'
                   ), 0) AS output_received_qty,
                   COALESCE((
                       SELECT SUM(ABS(imd.qty) * imd.unit_cost) FROM im_transaction_detail imd
                       JOIN im_transaction imt ON imt.id = imd.header_id
                       WHERE imt.ref_mo_id = h.id AND imd.ref_mo_output_detail_id IS NOT NULL AND imt.status = 'Posted'
                   ), 0) AS output_weighted_value,
                   COALESCE((
                       SELECT SUM(ABS(imd.qty) * (imd.unit_cost - COALESCE(imd.mo_actual_unit_cost, imd.unit_cost))) FROM im_transaction_detail imd
                       JOIN im_transaction imt ON imt.id = imd.header_id
                       WHERE imt.ref_mo_id = h.id AND imd.ref_mo_output_detail_id IS NOT NULL AND imt.status = 'Posted'
                   ), 0) AS variance_posted
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
        else query += ` AND h.status <> 'Deleted'`;
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
        const rows = result.rows.map((r) => {
            const isRouting = r.costing_mode === 'ROUTING';
            const materialCost = Number(r.material_cost);
            const laborCost = isRouting ? Number(r.routing_labor_cost) : 0;
            const machineCost = isRouting ? Number(r.routing_machine_cost) : 0;
            const overheadCost = isRouting ? Number(r.routing_overhead_cost) : materialCost * (Number(r.overhead_percent) || 0) / 100;
            const totalCost = materialCost + laborCost + machineCost + overheadCost;
            const outputReceivedQty = Number(r.output_received_qty);
            const avgUnitCost = outputReceivedQty > 0 ? Number(r.output_weighted_value) / outputReceivedQty : 0;
            return {
                ...r, material_cost: materialCost, labor_cost: laborCost, machine_cost: machineCost,
                overhead_cost: overheadCost, total_cost: totalCost, avg_unit_cost: avgUnitCost,
                variance_posted: Number(r.variance_posted),
            };
        });
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error fetching MO cost/variance report:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- รายงานมูลค่างานระหว่างผลิต (WIP Valuation Report) — ยอด wip_balance_lc ของทุก MO ที่ยังเปิดอยู่ (Released/
// InProgress/Completed — Closed แล้ว wip_balance_lc=0 เสมอ ไม่มีความหมายให้แสดง, Draft/Cancelled ยังไม่เคย Post
// เข้า WIP เลย) เทียบกับยอดจริงในบัญชี wip_account_id (ของ MOR) รวมตรงจาก gl_entry_detail (ดูหมายเหตุที่ query
// ด้านล่างว่าทำไมไม่ใช้ gl_balance_accum) — ถ้าไม่มีการ journal entry อื่นใดแตะบัญชีนี้นอกจากธุรกรรม '90'/'95'/
// Close MO ยอดทั้งสองฝั่งควรเท่ากันเป๊ะเสมอ ถ้าไม่เท่ากันคือสัญญาณว่ามีผลต่างต้องตรวจสอบ (เช่น manual journal
// entry เข้าบัญชีนี้ตรงๆ)
const fetchWipValuationReport = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureMoHeaderTable(client);
        const { warehouse_id, date_from, date_to, search } = req.query;
        let query = `
            SELECT h.id, h.doc_no, h.doc_date, h.status, h.wip_balance_lc,
                   w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                   bh.parent_item_id AS bom_parent_item_id, pi.item_code AS bom_parent_item_code,
                   pi.item_name_th AS bom_parent_item_name_th, pi.item_name_en AS bom_parent_item_name_en
            FROM mo_header h
            JOIN sa_module_document d ON d.id = h.doc_id
            LEFT JOIN im_warehouse w  ON w.id = h.warehouse_id
            LEFT JOIN mo_bom_header bh ON bh.id = h.bom_header_id
            LEFT JOIN im_item pi      ON pi.id = bh.parent_item_id
            WHERE h.status IN ('Released', 'InProgress', 'Completed')`;
        const params = [];
        let pi2 = 1;
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

        const setup = await fetchSetupByDocCode(client, 'MOR');
        let glBalance = null;
        let wipAccountCode = null;
        let wipAccountName = null;
        if (setup?.wip_account_id) {
            const accRes = await client.query(`SELECT account_code, account_name_thai, account_name_eng FROM gl_account WHERE id = $1`, [setup.wip_account_id]);
            if (accRes.rows.length > 0) {
                wipAccountCode = accRes.rows[0].account_code;
                wipAccountName = accRes.rows[0].account_name_thai;
            }
            // gl_balance_accum ไม่ใช่แหล่งข้อมูลที่เชื่อถือได้ที่นี่ — มันถูกอัปเดตเฉพาะตอน Post ผ่าน
            // glEntryController.js (รายการบัญชีที่สร้างตรงจากโมดูล GL เอง) เท่านั้น ธุรกรรม IM ('90'/'95'/Close MO)
            // insert ตรงเข้า gl_entry_header/gl_entry_detail โดยไม่เคยเรียก updateBalanceAccum เลย จึงต้องรวมยอด
            // จาก gl_entry_detail ตรงๆ ซึ่งเป็นแหล่งข้อมูลจริงที่ทุก module ใช้ร่วมกันเสมอ
            const balRes = await client.query(`
                SELECT COALESCE(SUM(ged.debit_lc - ged.credit_lc), 0) AS balance
                FROM gl_entry_detail ged
                JOIN gl_entry_header geh ON geh.id = ged.header_id
                WHERE ged.account_id = $1 AND geh.status = 'Posted' AND geh.posting_date <= CURRENT_DATE
            `, [setup.wip_account_id]);
            glBalance = Number(balRes.rows[0].balance);
        }

        const totalMoWip = result.rows.reduce((s, r) => s + Number(r.wip_balance_lc), 0);
        res.status(200).json({
            lines: result.rows,
            total_mo_wip: totalMoWip,
            wip_account_code: wipAccountCode,
            wip_account_name: wipAccountName,
            gl_balance: glBalance,
            difference: glBalance != null ? glBalance - totalMoWip : null,
        });
    } catch (error) {
        console.error('Error fetching MO WIP valuation report:', error);
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
        Object.assign(data, await computeMoBlocks(client, req.params.id));
        data.reverse_history = await getReverseHistory(client, 'mo_header', req.params.id);
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
        if (!['Draft', 'Rejected'].includes(existing.rows[0].status)) throw new Error('แก้ไขได้เฉพาะเอกสาร Draft หรือ Rejected เท่านั้น');

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

// --- 3. ส่งขออนุมัติ / อนุมัติ (= ปล่อยใบสั่งผลิต) / ไม่อนุมัติ — คิวผู้อนุมัติของเมนู (utils/docApproval.js) ---
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
        await ensureMoHeaderTable(client);
        const mo = (await client.query(`SELECT * FROM mo_header WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!mo) throw DA.httpErr(404, 'Not found');
        await work(client, mo, ctx);
        await client.query('COMMIT');
        res.status(200).json(await fetchRowById(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK');
        if (!error.status) console.error(`Error ${label} mo_header:`, error);
        res.status(error.status || 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// อนุมัติครบ = ปล่อยใบสั่งผลิต (ผูกพันแล้ว พร้อมให้ฝ่ายผลิตเริ่มเบิก/รับ)
const markReleased = (client, id, userName) => client.query(`
    UPDATE mo_header SET status='Released', released_at=NOW(), released_by=$1, updated_by=$1, updated_at=NOW()
     WHERE id=$2`, [userName, id]);

// PUT /:id/submit { menu_id } — Draft/Rejected -> Submitted / ไม่มีผู้อนุมัติ + ให้ผ่าน -> Released ทันที
const submitTransaction = approvalAction('submitting', async (client, mo, { menuId, userName }) => {
    if (!['Draft', 'Rejected'].includes(mo.status)) throw DA.httpErr(400, 'ส่งขออนุมัติได้เฉพาะเอกสาร Draft หรือ Rejected เท่านั้น');
    const q = await DA.buildQueue(client, { kind: KIND, recordId: mo.id, menuId, docCode: mo.doc_code });
    await client.query(`
        UPDATE mo_header SET status='Submitted', approval_mode=$1, submitted_at=NOW(), submitted_by=$2,
               updated_by=$2, updated_at=NOW() WHERE id=$3`, [q.mode, userName, mo.id]);
    if (q.count === 0) await markReleased(client, mo.id, userName);
});

// PUT /:id/approve { remarks } (และ /:id/release เดิม) — Submitted -> Released เมื่ออนุมัติครบ (หรือคนใดคนหนึ่งถ้า ANY)
const approveTransaction = approvalAction('approving', async (client, mo, { userId, userName, remarks }) => {
    if (mo.status !== 'Submitted') throw DA.httpErr(400, 'อนุมัติได้เฉพาะใบสั่งผลิตที่ส่งขออนุมัติแล้ว (Submitted) เท่านั้น');
    const done = await DA.approveStep(client, { kind: KIND, recordId: mo.id, userId, mode: mo.approval_mode, remarks });
    if (done) await markReleased(client, mo.id, userName);
});
const releaseTransaction = approveTransaction;

// PUT /:id/reject { remarks } — Submitted -> Rejected (แก้ไขแล้วส่งใหม่ได้)
const rejectTransaction = approvalAction('rejecting', async (client, mo, { userId, userName, remarks }) => {
    if (mo.status !== 'Submitted') throw DA.httpErr(400, 'ไม่อนุมัติได้เฉพาะใบสั่งผลิตที่ส่งขออนุมัติแล้ว (Submitted) เท่านั้น');
    await DA.rejectStep(client, { kind: KIND, recordId: mo.id, userId, remarks });
    await client.query(`UPDATE mo_header SET status='Rejected', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, mo.id]);
});

// GET /mo_header/my_pending — ใบสั่งผลิตที่ถึงคิวผู้ใช้นี้อนุมัติ (กระดิ่งหน้า Home)
const fetchMyPending = async (req, res) => {
    const userId = Number(req.headers.userid);
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    try {
        await DA.ensureDocApprovalSchema(req.dbPool);
        const client = await req.dbPool.connect();
        try { await ensureMoHeaderTable(client); } finally { client.release(); }
        const r = await req.dbPool.query(`
            SELECT h.id, h.doc_no, h.doc_date, i.item_name_th, h.submitted_by
              FROM mo_header h
              LEFT JOIN mo_bom_header b ON b.id = h.bom_header_id
              LEFT JOIN im_item i ON i.id = b.parent_item_id
             WHERE h.status = 'Submitted' AND ${DA.myTurnSql('h', '$1', '$2')}
             ORDER BY h.doc_date DESC, h.id DESC`, [KIND, userId]);
        res.status(200).json(r.rows);
    } catch (error) {
        console.error('Error fetching mo_header my_pending:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- ถอยสถานะ / ยกเลิก / ลบ: เงื่อนไข ---
// ส่งให้หน้าจอเป็น reverse_block / void_block / delete_block = { code, ref, message } (null = ทำได้)
const reasonOf = (req) => (req.body?.reason || '').trim();
const userIdOf = (req) => { const v = Number(req.headers['userid']); return Number.isFinite(v) && v > 0 ? v : null; };
const sendErr = (res, status, message, extra = {}) => res.status(status).json({ error: message, message, ...extra });
const blk = (code, message, ref = null) => ({ code, ref, message });

// งวดบัญชีที่ลงรายการได้ (GL และ IM เปิด) ของวันที่ — null = ไม่มี
const openPeriodId = async (client, date) => (await client.query(
    `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date
       AND gl_status = 'OPEN' AND im_status = 'OPEN' LIMIT 1`, [date])).rows[0]?.id || null;

// รายการปรับ WIP ตอนปิด — MO ที่ปิดก่อนมีคอลัมน์ close_gl_entry_id หาจากเลขที่อ้างอิง
const findCloseGlEntryId = async (client, mo) => {
    if (mo.close_gl_entry_id) return mo.close_gl_entry_id;
    const r = await client.query(`
        SELECT id FROM gl_entry_header
         WHERE ref_doc_id = $1 AND ref_doc_no = $2 AND description LIKE 'ปิดใบสั่งผลิต%'
         ORDER BY id DESC LIMIT 1`, [mo.doc_id, mo.doc_no]);
    return r.rows[0]?.id || null;
};

const computeMoBlocks = async (client, id) => {
    const mo = (await client.query(`SELECT * FROM mo_header WHERE id = $1`, [id])).rows[0];
    if (!mo) return {};
    const refs = (await client.query(`
        SELECT string_agg(doc_no, ', ' ORDER BY id) AS docs FROM im_transaction
         WHERE ref_mo_id = $1 AND status NOT IN ('Void', 'Deleted')`, [id])).rows[0].docs;
    const out = { reverse_block: null, void_block: null, delete_block: null };

    if (mo.status === 'Released') {
        const timeLogged = (await client.query(`
            SELECT 1 FROM mo_operation_detail
             WHERE header_id = $1 AND (actual_labor_hours <> 0 OR actual_machine_hours <> 0 OR status <> 'Pending') LIMIT 1`, [id])).rows.length > 0;
        const children = (await client.query(`
            SELECT string_agg(doc_no, ', ' ORDER BY id) AS docs FROM mo_header
             WHERE parent_mo_id = $1 AND status NOT IN ('Cancelled', 'Deleted')`, [id])).rows[0].docs;
        if (refs) out.reverse_block = blk('REF_DOCS', `มีเอกสารเบิก/รับอ้างอิงใบสั่งผลิตนี้ (${refs}) ต้องถอยและลบเอกสารเหล่านั้นก่อน`, refs);
        else if (timeLogged) out.reverse_block = blk('TIME_LOGGED', 'มีการบันทึกเวลาปฏิบัติงานแล้ว');
        else if (children) out.reverse_block = blk('CHILD_MO', `มีใบสั่งผลิตย่อยที่สร้างจากใบนี้ (${children}) ต้องยกเลิกหรือลบก่อน`, children);
    } else if (mo.status === 'Closed') {
        const glId = await findCloseGlEntryId(client, mo);
        if (glId) {
            const gl = (await client.query(`
                SELECT g.doc_no, p.gl_status, p.im_status FROM gl_entry_header g
                  LEFT JOIN gl_posting_period p ON p.id = g.period_id WHERE g.id = $1`, [glId])).rows[0];
            const sameOpen = gl && gl.gl_status === 'OPEN' && gl.im_status === 'OPEN';
            if (!sameOpen && !(await openPeriodId(client, today()))) {
                out.reverse_block = blk('PERIOD_CLOSED', 'งวดบัญชีของรายการปรับ WIP และงวดบัญชีวันนี้ปิดแล้ว', gl?.doc_no || null);
            }
        }
    } else if (mo.status === 'Submitted') {
        // ถอนคำขออนุมัติ -> Draft ได้เสมอ
    } else if (['Draft', 'Rejected'].includes(mo.status)) {
        out.reverse_block = blk('NOT_REVERSIBLE', 'ถอยได้เฉพาะใบสั่งผลิตที่ส่งขออนุมัติ ปล่อยแล้ว (ยังไม่เริ่มผลิต) หรือปิดแล้ว');
    } else if (['InProgress', 'Completed'].includes(mo.status)) {
        out.reverse_block = blk('REF_DOCS', `ใบสั่งผลิตเริ่มผลิตแล้ว ถอยเอกสารเบิก/รับที่อ้างอิง (${refs || '-'}) ก่อน สถานะจะกลับเป็นปล่อยแล้วเอง`, refs);
    } else {
        out.reverse_block = blk('VOIDED', 'ใบสั่งผลิตนี้ถูกยกเลิกหรือลบแล้ว');
    }

    if (mo.status === 'Released') {
        if (refs) out.void_block = blk('REF_DOCS', `มีเอกสารเบิก/รับอ้างอิงใบสั่งผลิตนี้ (${refs}) ต้องถอยและลบเอกสารเหล่านั้นก่อน`, refs);
    } else if (['Draft', 'Rejected', 'Submitted'].includes(mo.status)) {
        out.void_block = blk('NOT_POSTED', 'ใบสั่งผลิตที่ยังไม่อนุมัติให้ถอยเป็นร่างแล้วลบแทนการยกเลิก');
    } else if (['Cancelled', 'Deleted'].includes(mo.status)) {
        out.void_block = blk('VOIDED', 'ใบสั่งผลิตนี้ถูกยกเลิกหรือลบแล้ว');
    } else {
        out.void_block = blk('NOT_RELEASED', 'ยกเลิกได้เฉพาะใบสั่งผลิตที่ปล่อยแล้วและยังไม่เริ่มผลิต');
    }

    if (!['Draft', 'Rejected'].includes(mo.status)) {
        out.delete_block = ['Cancelled', 'Deleted'].includes(mo.status)
            ? blk('VOIDED', 'ใบสั่งผลิตนี้ถูกยกเลิกหรือลบแล้ว')
            : blk('NOT_DRAFT', 'ลบได้เฉพาะร่างหรือใบที่ไม่อนุมัติ ใบที่ส่งขออนุมัติ/ปล่อยแล้วต้องถอยเป็นร่างก่อน');
    }
    return out;
};

// --- 4. Cancel (Released -> Cancelled — ต้องมีเหตุผล บล็อกถ้ามีการเบิก/รับใดๆ อ้างอิงเข้ามาแล้ว) ---
const cancelTransaction = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการยกเลิก');
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureMoHeaderTable(client);
        const mo = (await client.query(`SELECT * FROM mo_header WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!mo) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeMoBlocks(client, id)).void_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }
        await client.query(`
            UPDATE mo_header SET status='Cancelled', cancel_reason=$1, cancelled_by=$2, cancelled_at=NOW(),
                   updated_by=$2, updated_at=NOW() WHERE id=$3`, [reason, userName, id]);
        await logReverse(client, {
            sysModule: '61', tableName: 'mo_header', recordId: Number(id), docNo: mo.doc_no,
            fromStatus: mo.status, toStatus: 'Void', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.status(200).json(await fetchRowById(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error cancelling mo_header:', error);
        sendErr(res, 500, error.message || 'Internal server error');
    } finally { client.release(); }
};

// --- ถอยสถานะ (ต้องมีเหตุผล) ---
// Submitted -> Draft: ถอนคำขออนุมัติ (ผู้อนุมัติที่ยังไม่ตัดสินถูกข้าม)
// Released -> Draft: ยังไม่มีเอกสารเบิก/รับ (รวมร่าง) บันทึกเวลา หรือใบสั่งผลิตย่อย — แก้ไขแล้วส่งขออนุมัติใหม่ได้
// Closed -> Completed: ลบรายการปรับ WIP (เก็บเลขที่ไว้ใช้ตอนปิดใหม่) ถ้างวดของรายการยังเปิด ไม่เช่นนั้นลงรายการ
//   กลับในวันนี้ แล้วคำนวณยอด WIP ใหม่ — หลังถอยแล้วถอยเอกสารเบิก/รับที่อ้างอิงได้อีกครั้ง
const reverseTransaction = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการถอยเอกสาร');
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureMoHeaderTable(client);
        const mo = (await client.query(`SELECT * FROM mo_header WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!mo) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeMoBlocks(client, id)).reverse_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }

        let toStatus;
        if (['Released', 'Submitted'].includes(mo.status)) {
            toStatus = 'Draft';
            await DA.ensureDocApprovalSchema(client);
            await DA.skipPending(client, KIND, Number(id));
            await client.query(`
                UPDATE mo_header SET status='Draft', released_at=NULL, released_by=NULL, submitted_at=NULL, submitted_by=NULL,
                       updated_by=$1, updated_at=NOW()
                 WHERE id=$2`, [userName, id]);
        } else {
            toStatus = 'Completed';
            const glId = await findCloseGlEntryId(client, mo);
            let keptNo = null;
            if (glId) {
                const gl = (await client.query(`
                    SELECT g.*, p.gl_status, p.im_status FROM gl_entry_header g
                      LEFT JOIN gl_posting_period p ON p.id = g.period_id WHERE g.id = $1`, [glId])).rows[0];
                if (gl.gl_status === 'OPEN' && gl.im_status === 'OPEN') {
                    keptNo = gl.doc_no;
                    await client.query(`DELETE FROM gl_entry_header WHERE id=$1`, [glId]);
                } else {
                    const date = today();
                    const periodId = await openPeriodId(client, date);
                    let revNo = await generateDocNo(client, gl.doc_id, date, mo.branch_id || null);
                    if (!revNo) revNo = `GL-REOPEN-${mo.doc_no}-${glId}`;
                    const description = `ยกเลิกการปิดใบสั่งผลิต ${mo.doc_no} - ${reason}`;
                    const revId = (await client.query(`
                        INSERT INTO gl_entry_header
                        (doc_id, doc_no, doc_date, posting_date, period_id, description,
                         currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
                         created_by, ref_doc_id, ref_doc_no, ref_doc_date)
                        VALUES ($1,$2,$3,$3,$4,$5,$6,1,'Posted',$7,$8,0,0,$9,$10,$11,$12)
                        RETURNING id`, [gl.doc_id, revNo, date, periodId, description, gl.currency_id,
                        gl.total_credit_lc, gl.total_debit_lc, userIdOf(req), mo.doc_id, mo.doc_no, mo.doc_date])).rows[0].id;
                    await client.query(`
                        INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                        SELECT $1, line_no, account_id, $2, credit_lc, debit_lc, 0, 0
                          FROM gl_entry_detail WHERE header_id = $3 ORDER BY line_no`, [revId, description, glId]);
                }
            }
            await client.query(`
                UPDATE mo_header SET status='Completed', closed_at=NULL, closed_by=NULL, close_gl_entry_id=NULL,
                       close_date=NULL, kept_close_gl_doc_no=COALESCE($1, kept_close_gl_doc_no),
                       updated_by=$2, updated_at=NOW() WHERE id=$3`, [keptNo, userName, id]);
            await refreshMoStatus(client, id); // คำนวณ wip_balance_lc กลับจากเอกสารเบิก/รับ
        }
        await logReverse(client, {
            sysModule: '61', tableName: 'mo_header', recordId: Number(id), docNo: mo.doc_no,
            fromStatus: mo.status, toStatus, reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.status(200).json(await fetchRowById(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error reversing mo_header:', error);
        sendErr(res, 500, error.message || 'Internal server error');
    } finally { client.release(); }
};

// --- ปิดใบสั่งผลิต (Close MO / WIP True-up) — Completed -> Closed เท่านั้น ---
// wip_balance_lc ที่เหลืออยู่ตอนนี้คือต้นทุนแปรรูป (overhead%/routing hours) ที่ถูก "พักไว้ที่ WIP" ตอนรับสินค้า
// เข้าคลัง (Dr สินค้า / Cr WIP เต็มมูลค่ารวมต้นทุนแปรรูป) แต่ไม่มี leg ใดเคย Dr WIP ด้วยต้นทุนแปรรูปนี้มาก่อนเลย
// (ดู comment ที่ computeMoReceiptUnitCost — เป็น simplification ที่ตั้งใจไว้แต่แรก) Close MO จึงต้อง Post GL อีก
// รายการเพื่อเกลี่ย WIP ของ MO นี้ให้เป็น 0 โดยอีกฝั่งลงที่ variance_account_id (ใช้ชุดบัญชีเดียวกับ MOR เพราะเป็น
// บัญชีผลต่างต้นทุนการผลิตชุดเดียวกัน ไม่แยกตั้งค่าใหม่) หลังจาก Closed แล้ว Issue/Receipt/Time Log ทั้งหมดจะถูก
// ปฏิเสธอัตโนมัติอยู่แล้วเพราะ validateMoComponentIssueQty/validateMoOutputReceiptQty/logOperationTime ข้างบน
// ทั้งหมดเช็ค mo_header.status ต้องเป็น Released/InProgress เท่านั้น — ไม่ต้องเพิ่ม guard ซ้ำที่นี่
const closeTransaction = async (req, res) => {
    const { id } = req.params;
    const { close_date } = req.body || {};
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT * FROM mo_header WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        const mo = existing.rows[0];
        if (mo.status !== 'Completed') {
            throw new Error('ปิดใบสั่งผลิตได้เฉพาะเอกสารที่รับสินค้าครบตามแผนแล้ว (สถานะ Completed) เท่านั้น');
        }

        const residual = Number(mo.wip_balance_lc) || 0;
        const closeDate = close_date || today();
        let glEntryId = null;

        if (Math.abs(residual) > 0.0001) {
            const setup = await fetchSetupByDocCode(client, 'MOR');
            if (!setup || !setup.wip_account_id || !setup.variance_account_id || !setup.gl_doc_id) {
                throw new Error('ยังไม่ได้ตั้งค่าบัญชีงานระหว่างผลิต (wip_account_id) และบัญชีผลต่างต้นทุนการผลิต (variance_account_id) ใน im_gl_account_setup ของ MOR ให้ครบก่อนปิดใบสั่งผลิตได้');
            }

            const periodRes = await client.query(
                `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date AND gl_status = 'OPEN' AND im_status = 'OPEN' LIMIT 1`,
                [closeDate]
            );
            if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ปิด ${closeDate}`);
            const periodId = periodRes.rows[0].id;

            let createdByUserId = null;
            if (userName) {
                const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
                if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
            }

            let glDocNo = mo.kept_close_gl_doc_no || await generateDocNo(client, setup.gl_doc_id, closeDate, mo.branch_id || null);
            if (!glDocNo) glDocNo = `GL-CLOSE-${mo.doc_no}-${Date.now()}`;

            const amount = Math.abs(residual);
            // residual < 0 = WIP ถูก Cr ไปมากกว่าที่เคย Dr (ต้นทุนแปรรูปที่ไม่เคยเข้า WIP) -> Dr WIP / Cr ผลต่าง
            // residual > 0 = WIP ยังเหลือค้าง (เบิกเข้าแล้วแต่ยังไม่ได้ตัดออกเท่าที่ควร) -> Dr ผลต่าง / Cr WIP
            const wipDebit = residual < 0 ? amount : 0;
            const wipCredit = residual > 0 ? amount : 0;
            const varianceDebit = residual > 0 ? amount : 0;
            const varianceCredit = residual < 0 ? amount : 0;
            const description = `ปิดใบสั่งผลิต ${mo.doc_no} - ปรับปรุงยอดคงเหลือ WIP`;

            const glHeaderRes = await client.query(`
                INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id, description,
                 currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
                 created_by, ref_doc_id, ref_doc_no, ref_doc_date)
                VALUES ($1,$2,$3,$3,$4,$5,1,1,'Posted',$6,$6,0,0,$7,$8,$9,$10)
                RETURNING id
            `, [
                setup.gl_doc_id, glDocNo, closeDate, periodId, description,
                amount, createdByUserId, mo.doc_id, mo.doc_no, mo.doc_date,
            ]);
            glEntryId = glHeaderRes.rows[0].id;

            await client.query(`
                INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                VALUES ($1,1,$2,$3,$4,$5,0,0)
            `, [glEntryId, setup.wip_account_id, description, wipDebit, wipCredit]);
            await client.query(`
                INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                VALUES ($1,2,$2,$3,$4,$5,0,0)
            `, [glEntryId, setup.variance_account_id, description, varianceDebit, varianceCredit]);
        }

        await client.query(`
            UPDATE mo_header SET status='Closed', wip_balance_lc=0, closed_at=NOW(), closed_by=$1, updated_by=$1, updated_at=NOW(),
                   close_gl_entry_id=$3, close_date=$4, kept_close_gl_doc_no=CASE WHEN $3::int IS NULL THEN kept_close_gl_doc_no END
            WHERE id=$2
        `, [userName, id, glEntryId, closeDate]);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json({ ...full, close_gl_entry_id: glEntryId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error closing mo_header:', error);
        res.status(error.message === 'Not found' ? 404 : 500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- ตรวจสอบวัตถุดิบพร้อมผลิต (Material Availability Check) — read-only, ไม่แก้ไขอะไรเลย เทียบจำนวนที่ยังต้อง
// เบิกอีก (planned_qty - issued_qty ต่อบรรทัด) กับคงเหลือในคลังปลายทางของ MO ตอนนี้ ใช้เช็คก่อน Release/ก่อนเบิกจริง
// ได้ (ไม่บังคับสถานะ Released เท่านั้น — Draft ก็เช็คได้เพื่อวางแผนล่วงหน้า) กันไว้แค่ Closed/Cancelled ที่ไม่มี
// ประโยชน์จะเช็คแล้ว
const checkMaterialAvailability = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const moRes = await client.query(`SELECT id, doc_no, warehouse_id, status FROM mo_header WHERE id = $1`, [id]);
        if (moRes.rows.length === 0) return res.status(404).json({ message: 'ไม่พบใบสั่งผลิต' });
        const mo = moRes.rows[0];
        if (['Closed', 'Cancelled'].includes(mo.status)) {
            return res.status(400).json({ message: 'ใบสั่งผลิตนี้ปิดหรือยกเลิกไปแล้ว ไม่ต้องตรวจสอบวัตถุดิบอีก' });
        }

        const compRes = await client.query(`
            SELECT c.id, c.component_item_id, c.item_code, c.item_name, c.planned_qty, c.issued_qty, c.uom_id,
                   u.uom_code, u.uom_name_th, u.uom_name_en,
                   COALESCE((
                       SELECT SUM(b.qty_on_hand) FROM im_stock_balance b
                       WHERE b.item_id = c.component_item_id AND b.warehouse_id = $2
                   ), 0) AS available_qty
            FROM mo_component_detail c
            LEFT JOIN im_uom u ON u.id = c.uom_id
            WHERE c.header_id = $1
            ORDER BY c.line_no
        `, [id, mo.warehouse_id]);

        const lines = compRes.rows.map((r) => {
            const remainingQty = Number(r.planned_qty) - Number(r.issued_qty);
            const availableQty = Number(r.available_qty);
            const shortageQty = Math.max(0, remainingQty - availableQty);
            return {
                ...r,
                remaining_qty: remainingQty,
                available_qty: availableQty,
                shortage_qty: shortageQty,
                is_short: shortageQty > 0.0001,
            };
        });

        res.status(200).json({
            mo_id: mo.id, doc_no: mo.doc_no, warehouse_id: mo.warehouse_id,
            lines, has_shortage: lines.some((l) => l.is_short),
        });
    } catch (error) {
        console.error('Error checking MO material availability:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- สร้างใบสั่งผลิตย่อย (Explode Sub-Assembly) — รายการที่เสนอให้ explode ได้ ---
// เดินแค่ "ชั้นเดียว" จากส่วนประกอบของ MO นี้ (ไม่ไล่ลึกหลายชั้นในคำขอเดียว) เพราะ explodeSubAssembly ด้านล่าง
// สร้าง MO ย่อยทีละใบต่อทีละ component เท่านั้น — ถ้าส่วนประกอบของ MO ย่อยที่สร้างใหม่นั้นมี sub-BOM ของตัวเองอีก
// ผู้ใช้ (Planning) ก็แค่เรียก endpoint นี้ซ้ำกับ MO ย่อยที่สร้างไปแล้ว ไล่ลึกได้ "หลายชั้นเท่าที่ต้องการ" ตามแผน
// โดยไม่ต้องมี UI/transaction ที่ซับซ้อนสำหรับเดินทั้งต้นไม้ในครั้งเดียว
const fetchExplosionCandidates = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const moRes = await client.query(`SELECT id, status FROM mo_header WHERE id = $1`, [id]);
        if (moRes.rows.length === 0) return res.status(404).json({ message: 'ไม่พบใบสั่งผลิต' });

        const result = await client.query(`
            SELECT c.id AS component_detail_id, c.component_item_id, c.item_code, c.item_name,
                   c.planned_qty, c.issued_qty, c.uom_id, u.uom_code, u.uom_name_th, u.uom_name_en,
                   bh.id AS candidate_bom_header_id, bh.bom_version AS candidate_bom_version
            FROM mo_component_detail c
            LEFT JOIN im_uom u ON u.id = c.uom_id
            LEFT JOIN mo_bom_header bh ON bh.parent_item_id = c.component_item_id AND bh.is_active = true
            WHERE c.header_id = $1
            ORDER BY c.line_no
        `, [id]);

        const lines = result.rows.map((r) => {
            const remainingQty = Number(r.planned_qty) - Number(r.issued_qty);
            return { ...r, remaining_qty: remainingQty, can_explode: r.candidate_bom_header_id != null && remainingQty > 0.0001 };
        });
        res.status(200).json({ mo_id: Number(id), lines });
    } catch (error) {
        console.error('Error fetching MO explosion candidates:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// สร้างใบสั่งผลิตย่อย (Draft) จากส่วนประกอบหนึ่งรายการของ MO หลัก ที่เลือก opt-in เอง — ปริมาณ = ส่วนที่ยังไม่ได้
// เบิก (planned_qty - issued_qty) ของบรรทัดนั้น ขยายสัดส่วนทุกรายการของสูตร (component/output/operation) ด้วย
// scale = remainingQty / bom.bom_qty มิเรอร์สูตรการสเกลเดียวกับ _loadFromBom ใน mo_header_detail_widget.dart
// ทุกประการ ผูก parent_mo_id/parent_mo_detail_id ไว้สำหรับ traceability แต่ไม่ auto-link อะไรเพิ่มเติม (ไม่หัก
// planned_qty ของ MO หลัก, ไม่เปลี่ยน status ของ MO หลัก) — MO ย่อยที่สร้างขึ้นเป็น Draft ปกติทุกประการ ต้อง Release
// เองต่างหาก
const explodeSubAssembly = async (req, res) => {
    const { id } = req.params;
    const { component_detail_id, due_date } = req.body;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureMoHeaderTable(client);

        const parentRes = await client.query(`SELECT * FROM mo_header WHERE id = $1`, [id]);
        if (parentRes.rows.length === 0) throw new Error('ไม่พบใบสั่งผลิตหลัก');
        const parentMo = parentRes.rows[0];

        const compRes = await client.query(`SELECT * FROM mo_component_detail WHERE id = $1 AND header_id = $2`, [component_detail_id, id]);
        if (compRes.rows.length === 0) throw new Error('ไม่พบรายการส่วนประกอบที่ระบุ');
        const comp = compRes.rows[0];

        const remainingQty = Number(comp.planned_qty) - Number(comp.issued_qty);
        if (remainingQty <= 0.0001) throw new Error('ส่วนประกอบนี้เบิกครบแล้ว ไม่มีจำนวนคงเหลือให้สร้างใบสั่งผลิตย่อย');

        const bomRes = await client.query(`SELECT * FROM mo_bom_header WHERE parent_item_id = $1 AND is_active = true LIMIT 1`, [comp.component_item_id]);
        if (bomRes.rows.length === 0) throw new Error('สินค้านี้ไม่มีสูตรการผลิต (BOM) ที่ใช้งานอยู่ ไม่สามารถสร้างใบสั่งผลิตย่อยได้');
        const bom = bomRes.rows[0];
        const bomQty = Number(bom.bom_qty) || 1;
        const scale = remainingQty / bomQty;

        const docDate = due_date || today();
        let docNo = await generateDocNo(client, parentMo.doc_id, docDate, parentMo.branch_id || null);
        if (!docNo) throw new Error('สร้างเลขที่เอกสารอัตโนมัติไม่สำเร็จ');

        const hRes = await client.query(`
            INSERT INTO mo_header
                (doc_id, doc_no, doc_code, doc_date, bom_header_id, warehouse_id, order_qty, uom_id,
                 issue_method, costing_method, costing_mode, overhead_percent, due_date,
                 parent_mo_id, parent_mo_detail_id, branch_id, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
            RETURNING id
        `, [
            parentMo.doc_id, docNo, parentMo.doc_code, docDate, bom.id, parentMo.warehouse_id, remainingQty, bom.output_uom_id,
            bom.issue_method, bom.costing_method, bom.costing_mode, bom.overhead_percent, due_date || null,
            parentMo.id, comp.id, parentMo.branch_id || null, userName,
        ]);
        const childId = hRes.rows[0].id;

        const bomDetailsRes = await client.query(`
            SELECT d.*, ci.item_code, ci.item_name_th, ci.item_name_en
            FROM mo_bom_detail d LEFT JOIN im_item ci ON ci.id = d.component_item_id
            WHERE d.bom_header_id = $1 ORDER BY d.line_no
        `, [bom.id]);
        let lineNo = 1;
        for (const d of bomDetailsRes.rows) {
            const plannedQty = Number(d.quantity_per) * scale * (1 + Number(d.scrap_percent) / 100);
            await client.query(`
                INSERT INTO mo_component_detail (header_id, line_no, component_item_id, item_code, item_name, planned_qty, uom_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
            `, [childId, lineNo++, d.component_item_id, d.item_code, d.item_name_th, plannedQty, d.uom_id]);
        }

        const parentItemRes = await client.query(`SELECT item_code, item_name_th FROM im_item WHERE id = $1`, [bom.parent_item_id]);
        await client.query(`
            INSERT INTO mo_output_detail (header_id, line_no, output_item_id, item_code, item_name, planned_qty, uom_id, is_primary_output)
            VALUES ($1,1,$2,$3,$4,$5,$6,true)
        `, [childId, bom.parent_item_id, parentItemRes.rows[0]?.item_code, parentItemRes.rows[0]?.item_name_th, remainingQty, bom.output_uom_id]);

        const bomOutputsRes = await client.query(`
            SELECT o.*, oi.item_code, oi.item_name_th
            FROM mo_bom_output_detail o LEFT JOIN im_item oi ON oi.id = o.output_item_id
            WHERE o.bom_header_id = $1 ORDER BY o.line_no
        `, [bom.id]);
        let outLineNo = 2;
        for (const o of bomOutputsRes.rows) {
            const plannedQty = Number(o.output_qty_per) * scale;
            await client.query(`
                INSERT INTO mo_output_detail (header_id, line_no, output_item_id, item_code, item_name, planned_qty, uom_id, is_primary_output)
                VALUES ($1,$2,$3,$4,$5,$6,$7,false)
            `, [childId, outLineNo++, o.output_item_id, o.item_code, o.item_name_th, plannedQty, o.uom_id]);
        }

        const bomOperationsRes = await client.query(`SELECT * FROM mo_bom_operation_detail WHERE bom_header_id = $1 ORDER BY line_no`, [bom.id]);
        let opLineNo = 1;
        for (const op of bomOperationsRes.rows) {
            const plannedLaborHours = Number(op.standard_labor_hours) * scale + Number(op.setup_hours);
            const plannedMachineHours = Number(op.standard_machine_hours) * scale;
            await client.query(`
                INSERT INTO mo_operation_detail (header_id, line_no, work_center_id, operation_name, planned_labor_hours, planned_machine_hours)
                VALUES ($1,$2,$3,$4,$5,$6)
            `, [childId, opLineNo++, op.work_center_id, op.operation_name, plannedLaborHours, plannedMachineHours]);
        }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, childId);
        res.status(201).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error exploding MO sub-assembly:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 5. Delete (Draft only — ต้องมีเหตุผล เก็บไว้ด้วยสถานะ Deleted ตรวจสอบได้แต่นำกลับมาใช้ไม่ได้) ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการลบ');
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureMoHeaderTable(client);
        const mo = (await client.query(`SELECT * FROM mo_header WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!mo) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeMoBlocks(client, id)).delete_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }
        await client.query(`UPDATE mo_header SET status='Deleted', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await logReverse(client, {
            sysModule: '61', tableName: 'mo_header', recordId: Number(id), docNo: mo.doc_no,
            fromStatus: 'Draft', toStatus: 'Deleted', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.status(200).json({ message: 'Deleted' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting mo_header:', error);
        sendErr(res, 500, error.message || 'Internal server error');
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
                -- ใช้ mo_actual_unit_cost ถ้ามี (MO costing_method='STANDARD') ไม่ใช่ unit_cost (ค่ามาตรฐานที่โชว์/
                -- ตีมูลค่าสต็อก) เพราะ WIP ถูก Cr ออกด้วยต้นทุนจริงเสมอ (ดู postGlEntry sysDocType==='95' branch ใน
                -- imTransactionController.js) — ถ้าใช้ unit_cost ที่นี่ wip_balance_lc จะไม่ตรงกับยอด WIP จริงใน GL เลย
                SELECT SUM(ABS(imd.qty) * COALESCE(imd.mo_actual_unit_cost, imd.unit_cost)) FROM im_transaction_detail imd
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

// คำนวณต้นทุนต่อหน่วยของผลผลิตที่กำลังจะรับเข้าคลังจากการผลิต (ธุรกรรม '95') ตามนโยบายต้นทุนของใบสั่งผลิต
//
// ต้นทุนจริงรวม (actualUnitCost) = ต้นทุนวัตถุดิบที่เบิกเข้า WIP สะสมจริงของ MO นี้ (ธุรกรรม '90' ที่ Posted ทั้งหมด)
// + ต้นทุนแปรรูป (overhead % ของต้นทุนวัตถุดิบ หรือผลรวมชั่วโมงแรงงาน/เครื่องจักร×อัตราศูนย์งาน ตาม costing_mode) —
// ปันส่วนตามสัดส่วน planned_qty ของผลผลิตแต่ละบรรทัดเทียบกับผลผลิตทั้งหมดที่วางแผนไว้ (ไม่ใช่ received_qty เพราะ
// ต้นทุนทั้งก้อนควรกระจายตามแผนเดิมเสมอ) แล้วหารด้วย planned_qty ของบรรทัดนั้นเพื่อให้ได้ต้นทุน/หน่วยที่คงที่ไม่
// ผันแปรตามว่ารับครั้งไหนก่อน/หลัง (ยกเว้นต้นทุนวัตถุดิบสะสมเองที่ยังเพิ่มขึ้นได้ถ้ามีการเบิกเพิ่มทีหลัง — เป็น
// ข้อจำกัดที่ทราบอยู่แล้วของระบบตีมูลค่าแบบ actual-cost ที่รับหลายรอบ ได้รับการแก้ไขให้ตรงเป๊ะตอน Close MO)
//
// ACTUAL: ตีมูลค่าสต็อก (unitCost) ด้วยต้นทุนจริงนี้เลย — unitCost===actualUnitCost เสมอ จึงไม่มีผลต่างให้
// postGlEntry โพสต์ (ดู sysDocType==='95' branch ใน imTransactionController.js)
// STANDARD: ตีมูลค่าสต็อกด้วย im_item.standard_cost ที่ตรึงไว้แทน (unitCost!==actualUnitCost โดยทั่วไป) ส่วนต่าง
// ระหว่างสองค่านี้โพสต์เข้า variance_account_id ทันทีที่ Receipt นี้เลย ไม่ต้องรอ Close MO (ต่างจากผลต่างของ
// ต้นทุนแปรรูปที่ยังไม่มี GL leg เข้า WIP เลยและยังต้องรอ Close MO ไปเกลี่ยเสมอไม่ว่า costing_method จะเป็นอะไร)
const computeMoReceiptUnitCost = async (client, { moHeader, outputDetail }) => {
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
    const actualUnitCost = plannedQty > 0 ? allocatedCost / plannedQty : 0;

    if (moHeader.costing_method === 'STANDARD') {
        const itemRes = await client.query(`SELECT standard_cost, item_code FROM im_item WHERE id = $1`, [outputDetail.output_item_id]);
        if (itemRes.rows.length === 0) throw new Error('ไม่พบสินค้าผลผลิต');
        const standardCost = Number(itemRes.rows[0].standard_cost) || 0;
        if (standardCost <= 0) {
            throw new Error(`กรุณาตั้งค่าต้นทุนมาตรฐาน (standard_cost) ของสินค้า ${itemRes.rows[0].item_code} ก่อนรับเข้าคลังจากการผลิตแบบ STANDARD`);
        }
        return { unitCost: standardCost, actualUnitCost };
    }
    return { unitCost: actualUnitCost, actualUnitCost };
};

// บันทึกเวลาปฏิบัติงาน (Operation Time Log) — ใช้เฉพาะ MO ที่ costing_mode='ROUTING' เท่านั้น ไม่ใช่ธุรกรรม
// im_transaction (ไม่มีผล GL/สต็อกตรงนี้เลย) แค่สะสมชั่วโมงแรงงาน/เครื่องจักรจริงไว้ที่ mo_operation_detail ให้
// computeMoReceiptUnitCost ด้านบนไปอ่านตอน Post ธุรกรรม '95' — เป็นการ "เพิ่มสะสม" (actual_*_hours += delta) ไม่ใช่
// ตั้งค่าทับ เพราะฝ่ายผลิตอาจบันทึกเวลาหลายรอบระหว่างทำงานขั้นตอนเดียวกัน (เช้า/บ่าย) ก่อนจะกดเสร็จสิ้นครั้งเดียว
const logOperationTime = async (req, res) => {
    const { moId, opId } = req.params;
    const { labor_hours, machine_hours, mark_done } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureMoHeaderTable(client);

        const moRes = await client.query(`SELECT status, costing_mode FROM mo_header WHERE id = $1 FOR UPDATE`, [moId]);
        if (moRes.rows.length === 0) throw new Error('ไม่พบใบสั่งผลิต');
        if (!['Released', 'InProgress'].includes(moRes.rows[0].status)) {
            throw new Error('ใบสั่งผลิตต้องอยู่สถานะ Released หรือ InProgress เท่านั้นจึงจะบันทึกเวลาปฏิบัติงานได้');
        }
        if (moRes.rows[0].costing_mode !== 'ROUTING') {
            throw new Error('ใบสั่งผลิตนี้ไม่ได้ใช้การคิดต้นทุนแบบ Routing จึงไม่ต้องบันทึกเวลาปฏิบัติงาน');
        }

        const opRes = await client.query(`SELECT status FROM mo_operation_detail WHERE id = $1 AND header_id = $2`, [opId, moId]);
        if (opRes.rows.length === 0) throw new Error('ไม่พบขั้นตอนการผลิตที่ระบุ');
        if (opRes.rows[0].status === 'Done') throw new Error('ขั้นตอนนี้บันทึกเสร็จสิ้นแล้ว ไม่สามารถบันทึกเพิ่มได้');

        const laborDelta = Number(labor_hours) || 0;
        const machineDelta = Number(machine_hours) || 0;
        if (laborDelta <= 0 && machineDelta <= 0 && !mark_done) {
            throw new Error('กรุณาระบุชั่วโมงแรงงานหรือเครื่องจักรที่บันทึก หรือเลือกเสร็จสิ้นขั้นตอน');
        }
        const newStatus = mark_done ? 'Done' : 'InProgress';
        await client.query(`
            UPDATE mo_operation_detail
            SET actual_labor_hours = actual_labor_hours + $1,
                actual_machine_hours = actual_machine_hours + $2,
                status = $3
            WHERE id = $4
        `, [laborDelta, machineDelta, newStatus, opId]);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, moId);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error logging operation time:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = {
    ensureMoHeaderTable, fetchRows, fetchRow, createTransaction, updateTransaction,
    releaseTransaction, submitTransaction, approveTransaction, rejectTransaction, fetchMyPending,
    cancelTransaction, closeTransaction, deleteTransaction, reverseTransaction,
    validateMoComponentIssueQty, validateMoOutputReceiptQty, refreshMoStatus,
    computeMoReceiptUnitCost, logOperationTime, checkMaterialAvailability,
    fetchExplosionCandidates, explodeSubAssembly, fetchStatusReport, fetchCostVarianceReport,
    fetchWipValuationReport,
};
