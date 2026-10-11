// controllers/mo/moBomController.js — ย้ายมาจาก controllers/im/imBomController.js (BOM ย้ายจาก IM ไปอยู่ใต้
// โมดูล MO/สั่งผลิต เพราะเป็น "สูตรการผลิต" ซึ่งเป็นแนวคิดของงานผลิตโดยตรง ไม่ใช่ของคลังสินค้า) ดูแผนการออกแบบ
// โมดูล MO เต็มใน plan file
'use strict';

const { ensureImItemTable } = require('../im/imItemController');
const { ensureImUomTable } = require('../im/imUomController');
const { ensureMoWorkCenterTable } = require('./moWorkCenterController');

const ISSUE_METHODS = ['BACKFLUSH', 'EXPLICIT'];
const COSTING_METHODS = ['ACTUAL', 'STANDARD'];
const COSTING_MODES = ['OVERHEAD_PERCENT', 'ROUTING'];

const ensureMoBomTable = async (client) => {
    // mo_bom_header/detail reference im_item and im_uom, so they must exist first
    await ensureImItemTable(client);
    await ensureImUomTable(client);

    // ย้าย+เปลี่ยนชื่อตารางจาก im_bom_header/detail (ตอน BOM ยังอยู่ใต้ IM module) — เช็คว่าตารางเก่ายังอยู่จริง
    // ก่อน RENAME ทุกครั้ง (เหตุผลเดียวกับ migration อื่นๆในระบบนี้: ถ้าตารางเก่าไม่อยู่แล้วและยิง SQL error ไปตรงๆ
    // ภายใน transaction ของ addRow/updateRow ที่เรียก ensureMoBomTable นี้ transaction ทั้งก้อนจะ aborted แม้
    // promise ฝั่ง JS จะถูก catch กลืนไว้ก็ตาม — รันครั้งเดียวพอตอนตารางเก่ายังอยู่ หลังจากนั้นข้าม block นี้ไปตลอด)
    const oldTableExists = await client.query(`
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'im_bom_header'
    `);
    if (oldTableExists.rows.length > 0) {
        await client.query(`ALTER TABLE im_bom_header RENAME TO mo_bom_header`);
        await client.query(`ALTER TABLE im_bom_detail RENAME TO mo_bom_detail`);
        await client.query(`ALTER INDEX IF EXISTS idx_im_bom_header_parent RENAME TO idx_mo_bom_header_parent`);
        await client.query(`ALTER INDEX IF EXISTS idx_im_bom_detail_header RENAME TO idx_mo_bom_detail_header`);
    }

    await client.query(`
        CREATE TABLE IF NOT EXISTS mo_bom_header (
            id                SERIAL PRIMARY KEY,
            parent_item_id    INTEGER NOT NULL REFERENCES im_item(id),
            bom_version       VARCHAR(20)   NOT NULL DEFAULT '1',
            bom_qty           NUMERIC(18,4) NOT NULL DEFAULT 1,
            output_uom_id     INTEGER REFERENCES im_uom(id),
            is_active         BOOLEAN       NOT NULL DEFAULT true,
            effective_date    DATE,
            created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            created_by        VARCHAR(100),
            updated_by        VARCHAR(100)
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mo_bom_header_parent ON mo_bom_header(parent_item_id)`);
    await client.query(`
        CREATE TABLE IF NOT EXISTS mo_bom_detail (
            id                  SERIAL PRIMARY KEY,
            bom_header_id       INTEGER NOT NULL REFERENCES mo_bom_header(id) ON DELETE CASCADE,
            line_no             SMALLINT      NOT NULL,
            component_item_id   INTEGER NOT NULL REFERENCES im_item(id),
            quantity_per        NUMERIC(18,6) NOT NULL DEFAULT 0,
            uom_id              INTEGER REFERENCES im_uom(id),
            scrap_percent       NUMERIC(5,2)  NOT NULL DEFAULT 0
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mo_bom_detail_header ON mo_bom_detail(bom_header_id)`);

    // ขยายสำหรับโมดูล MO: วิธีเบิกวัตถุดิบ (BACKFLUSH/EXPLICIT), วิธีตีมูลค่าผลผลิต (ACTUAL/STANDARD), โหมดต้นทุน
    // แปรรูป (OVERHEAD_PERCENT/ROUTING) + เปอร์เซ็นต์ overhead เมื่อเลือกโหมด OVERHEAD_PERCENT — ทั้งหมดเป็นค่า
    // default ของสูตรนี้ ใบสั่งผลิต (mo_header) override ได้เป็นรายใบ (ดูแผนออกแบบโมดูล MO)
    await client.query(`ALTER TABLE mo_bom_header ADD COLUMN IF NOT EXISTS issue_method VARCHAR(10) NOT NULL DEFAULT 'EXPLICIT'`).catch(() => {});
    await client.query(`ALTER TABLE mo_bom_header ADD COLUMN IF NOT EXISTS costing_method VARCHAR(10) NOT NULL DEFAULT 'ACTUAL'`).catch(() => {});
    await client.query(`ALTER TABLE mo_bom_header ADD COLUMN IF NOT EXISTS costing_mode VARCHAR(10) NOT NULL DEFAULT 'OVERHEAD_PERCENT'`).catch(() => {});
    await client.query(`ALTER TABLE mo_bom_header ADD COLUMN IF NOT EXISTS overhead_percent NUMERIC(5,2) NOT NULL DEFAULT 0`).catch(() => {});

    // component_bom_header_id — ปักหมุดว่า component ตัวนี้ (ถ้าผลิตเองและมี BOM ของตัวเอง) ใช้ mo_bom_header
    // เวอร์ชันไหนตอน explode เป็น MO ย่อย (ดู process "สร้างใบสั่งผลิตย่อย") — NULL = เป็นสินค้าซื้อ/สต็อกปกติ (leaf)
    // ทำให้ไล่ต้นทุน/explode หลายชั้นได้ด้วย WITH RECURSIVE ตัวเดียวจาก mo_bom_header บนสุด
    await client.query(`ALTER TABLE mo_bom_detail ADD COLUMN IF NOT EXISTS component_bom_header_id INTEGER REFERENCES mo_bom_header(id)`).catch(() => {});

    // ผลิตภัณฑ์ร่วม (co-products) — ผลผลิตเพิ่มเติมนอกจาก parent_item_id/bom_qty/output_uom_id ที่เป็นผลผลิตหลัก
    // อยู่แล้วบน header (ไม่ย้ายมาตารางนี้ เพื่อไม่กระทบ BOM เดิมที่มีผลผลิตเดียวอยู่แล้วเลย)
    await client.query(`
        CREATE TABLE IF NOT EXISTS mo_bom_output_detail (
            id                SERIAL PRIMARY KEY,
            bom_header_id     INTEGER NOT NULL REFERENCES mo_bom_header(id) ON DELETE CASCADE,
            line_no           SMALLINT NOT NULL,
            output_item_id    INTEGER NOT NULL REFERENCES im_item(id),
            output_qty_per    NUMERIC(18,6) NOT NULL DEFAULT 0,
            uom_id            INTEGER REFERENCES im_uom(id)
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mo_bom_output_detail_header ON mo_bom_output_detail(bom_header_id)`);

    // ขั้นตอนการผลิต (Routing) — ใช้จริงเมื่อ costing_mode='ROUTING' เท่านั้น (เก็บไว้ได้แม้ไม่ใช้โหมดนี้ ไม่บังคับ
    // ลบ ถ้าผู้ใช้สลับโหมดไปมา) ต้องมี mo_work_center อยู่ก่อนเสมอ
    await ensureMoWorkCenterTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS mo_bom_operation_detail (
            id                      SERIAL PRIMARY KEY,
            bom_header_id           INTEGER NOT NULL REFERENCES mo_bom_header(id) ON DELETE CASCADE,
            line_no                 SMALLINT NOT NULL,
            work_center_id          INTEGER NOT NULL REFERENCES mo_work_center(id),
            operation_name          VARCHAR(100),
            standard_labor_hours    NUMERIC(10,4) NOT NULL DEFAULT 0,
            standard_machine_hours  NUMERIC(10,4) NOT NULL DEFAULT 0,
            setup_hours             NUMERIC(10,4) NOT NULL DEFAULT 0
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mo_bom_operation_detail_header ON mo_bom_operation_detail(bom_header_id)`);
};

const HEADER_SELECT = `
    SELECT h.*,
           pi.item_code AS parent_item_code, pi.item_name_th AS parent_item_name_th, pi.item_name_en AS parent_item_name_en,
           u.uom_code AS output_uom_code, u.uom_name_th AS output_uom_name_th, u.uom_name_en AS output_uom_name_en,
           (SELECT COUNT(*) FROM mo_bom_detail d WHERE d.bom_header_id = h.id) AS component_count,
           (SELECT COUNT(*) FROM mo_bom_output_detail o WHERE o.bom_header_id = h.id) AS output_count,
           (SELECT COUNT(*) FROM mo_bom_operation_detail op WHERE op.bom_header_id = h.id) AS operation_count
    FROM mo_bom_header h
    LEFT JOIN im_item pi ON pi.id = h.parent_item_id
    LEFT JOIN im_uom u   ON u.id  = h.output_uom_id
`;

// component_active_bom_id — บอกฝั่ง UI ว่า component ตัวนี้มี BOM ของตัวเอง (ผลิตเองได้) อยู่หรือไม่ แม้บรรทัดนี้
// ยังไม่ได้ปักหมุด component_bom_header_id ไว้ก็ตาม — ใช้โชว์ตัวเลือก "สร้างใบสั่งผลิตย่อย" ให้ผู้ใช้เลือกเอง
const DETAIL_SELECT = `
    SELECT d.*,
           ci.item_code AS component_item_code, ci.item_name_th AS component_item_name_th, ci.item_name_en AS component_item_name_en,
           u.uom_code AS uom_code, u.uom_name_th AS uom_name_th, u.uom_name_en AS uom_name_en,
           cb.bom_version AS component_bom_version,
           (SELECT id FROM mo_bom_header b2 WHERE b2.parent_item_id = d.component_item_id AND b2.is_active = true LIMIT 1) AS component_active_bom_id
    FROM mo_bom_detail d
    LEFT JOIN im_item ci ON ci.id = d.component_item_id
    LEFT JOIN im_uom u   ON u.id  = d.uom_id
    LEFT JOIN mo_bom_header cb ON cb.id = d.component_bom_header_id
    WHERE d.bom_header_id = $1
    ORDER BY d.line_no
`;

const OUTPUT_SELECT = `
    SELECT o.*,
           oi.item_code AS output_item_code, oi.item_name_th AS output_item_name_th, oi.item_name_en AS output_item_name_en,
           u.uom_code AS uom_code, u.uom_name_th AS uom_name_th, u.uom_name_en AS uom_name_en
    FROM mo_bom_output_detail o
    LEFT JOIN im_item oi ON oi.id = o.output_item_id
    LEFT JOIN im_uom u   ON u.id  = o.uom_id
    WHERE o.bom_header_id = $1
    ORDER BY o.line_no
`;

const OPERATION_SELECT = `
    SELECT op.*,
           wc.work_center_code, wc.work_center_name_th, wc.work_center_name_en
    FROM mo_bom_operation_detail op
    LEFT JOIN mo_work_center wc ON wc.id = op.work_center_id
    WHERE op.bom_header_id = $1
    ORDER BY op.line_no
`;

// GET all (headers only, list view)
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureMoBomTable(client);
        const { parent_item_id } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (parent_item_id) { where += ` AND h.parent_item_id = $1`; params.push(parent_item_id); }
        const result = await client.query(`${HEADER_SELECT} ${where} ORDER BY pi.item_code, h.bom_version`, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching mo_bom_header:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET one (header + component/output/operation lines)
const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureMoBomTable(client);
        const header = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        if (header.rows.length === 0) return res.status(404).json({ message: 'ไม่พบสูตรการผลิต (BOM)' });
        const details = await client.query(DETAIL_SELECT, [id]);
        const outputs = await client.query(OUTPUT_SELECT, [id]);
        const operations = await client.query(OPERATION_SELECT, [id]);
        res.status(200).json({ ...header.rows[0], details: details.rows, outputs: outputs.rows, operations: operations.rows });
    } catch (error) {
        console.error('Error fetching mo_bom_header row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const validateCostingFields = (b) => {
    if (b.issue_method && !ISSUE_METHODS.includes(b.issue_method)) return `issue_method ต้องเป็นหนึ่งใน ${ISSUE_METHODS.join(', ')}`;
    if (b.costing_method && !COSTING_METHODS.includes(b.costing_method)) return `costing_method ต้องเป็นหนึ่งใน ${COSTING_METHODS.join(', ')}`;
    if (b.costing_mode && !COSTING_MODES.includes(b.costing_mode)) return `costing_mode ต้องเป็นหนึ่งใน ${COSTING_MODES.join(', ')}`;
    return null;
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const b = req.body;
    const userName = req.headers.username || null;
    try {
        await client.query('BEGIN');
        await ensureMoBomTable(client);

        if (!b.parent_item_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'กรุณาระบุสินค้าที่ผลิต (Parent Item)' });
        }
        const parent = await client.query(`SELECT is_manufactured FROM im_item WHERE id = $1`, [b.parent_item_id]);
        if (parent.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ไม่พบสินค้าที่ผลิต' });
        }
        if (!parent.rows[0].is_manufactured) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'สินค้าที่เลือกต้องตั้งค่า "ผลิตเอง (is_manufactured)" ก่อนจึงจะสร้างสูตรการผลิตได้' });
        }
        if (!Array.isArray(b.details) || b.details.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'กรุณาระบุส่วนประกอบอย่างน้อย 1 รายการ' });
        }
        const costingErr = validateCostingFields(b);
        if (costingErr) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: costingErr });
        }

        const isActive = b.is_active ?? true;
        if (isActive) {
            await client.query(
                `UPDATE mo_bom_header SET is_active = false WHERE parent_item_id = $1 AND is_active = true`,
                [b.parent_item_id]
            );
        }

        const header = await client.query(
            `INSERT INTO mo_bom_header
                (parent_item_id, bom_version, bom_qty, output_uom_id, is_active, effective_date,
                 issue_method, costing_method, costing_mode, overhead_percent, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
             RETURNING id`,
            [
                b.parent_item_id, b.bom_version || '1', b.bom_qty ?? 1, b.output_uom_id || null, isActive, b.effective_date || null,
                b.issue_method || 'EXPLICIT', b.costing_method || 'ACTUAL', b.costing_mode || 'OVERHEAD_PERCENT', b.overhead_percent ?? 0,
                userName,
            ]
        );
        const headerId = header.rows[0].id;

        let lineNo = 1;
        for (const line of b.details) {
            if (!line.component_item_id) continue;
            await client.query(
                `INSERT INTO mo_bom_detail (bom_header_id, line_no, component_item_id, quantity_per, uom_id, scrap_percent, component_bom_header_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [headerId, lineNo++, line.component_item_id, line.quantity_per ?? 0, line.uom_id || null, line.scrap_percent ?? 0, line.component_bom_header_id || null]
            );
        }

        let outLineNo = 1;
        for (const out of (b.outputs || [])) {
            if (!out.output_item_id) continue;
            await client.query(
                `INSERT INTO mo_bom_output_detail (bom_header_id, line_no, output_item_id, output_qty_per, uom_id)
                 VALUES ($1,$2,$3,$4,$5)`,
                [headerId, outLineNo++, out.output_item_id, out.output_qty_per ?? 0, out.uom_id || null]
            );
        }

        let opLineNo = 1;
        for (const op of (b.operations || [])) {
            if (!op.work_center_id) continue;
            await client.query(
                `INSERT INTO mo_bom_operation_detail
                    (bom_header_id, line_no, work_center_id, operation_name, standard_labor_hours, standard_machine_hours, setup_hours)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [headerId, opLineNo++, op.work_center_id, op.operation_name || null, op.standard_labor_hours ?? 0, op.standard_machine_hours ?? 0, op.setup_hours ?? 0]
            );
        }

        await client.query('COMMIT');
        const newHeader = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [headerId]);
        const newDetails = await client.query(DETAIL_SELECT, [headerId]);
        const newOutputs = await client.query(OUTPUT_SELECT, [headerId]);
        const newOperations = await client.query(OPERATION_SELECT, [headerId]);
        res.status(201).json({ ...newHeader.rows[0], details: newDetails.rows, outputs: newOutputs.rows, operations: newOperations.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding mo_bom_header:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const b = req.body;
    const userName = req.headers.username || null;
    try {
        await client.query('BEGIN');
        await ensureMoBomTable(client);

        if (!Array.isArray(b.details) || b.details.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'กรุณาระบุส่วนประกอบอย่างน้อย 1 รายการ' });
        }
        const costingErr = validateCostingFields(b);
        if (costingErr) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: costingErr });
        }

        const isActive = b.is_active ?? true;
        if (isActive) {
            await client.query(
                `UPDATE mo_bom_header SET is_active = false WHERE parent_item_id = $1 AND id != $2 AND is_active = true`,
                [b.parent_item_id, id]
            );
        }

        const result = await client.query(
            `UPDATE mo_bom_header SET
                bom_version       = $1,
                bom_qty           = $2,
                output_uom_id     = $3,
                is_active         = $4,
                effective_date    = $5,
                issue_method      = $6,
                costing_method    = $7,
                costing_mode      = $8,
                overhead_percent  = $9,
                updated_by        = $10,
                updated_at        = NOW()
             WHERE id = $11
             RETURNING id`,
            [
                b.bom_version || '1', b.bom_qty ?? 1, b.output_uom_id || null, isActive, b.effective_date || null,
                b.issue_method || 'EXPLICIT', b.costing_method || 'ACTUAL', b.costing_mode || 'OVERHEAD_PERCENT', b.overhead_percent ?? 0,
                userName, id,
            ]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'ไม่พบสูตรการผลิต (BOM)' });
        }

        await client.query(`DELETE FROM mo_bom_detail WHERE bom_header_id = $1`, [id]);
        let lineNo = 1;
        for (const line of b.details) {
            if (!line.component_item_id) continue;
            await client.query(
                `INSERT INTO mo_bom_detail (bom_header_id, line_no, component_item_id, quantity_per, uom_id, scrap_percent, component_bom_header_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [id, lineNo++, line.component_item_id, line.quantity_per ?? 0, line.uom_id || null, line.scrap_percent ?? 0, line.component_bom_header_id || null]
            );
        }

        await client.query(`DELETE FROM mo_bom_output_detail WHERE bom_header_id = $1`, [id]);
        let outLineNo = 1;
        for (const out of (b.outputs || [])) {
            if (!out.output_item_id) continue;
            await client.query(
                `INSERT INTO mo_bom_output_detail (bom_header_id, line_no, output_item_id, output_qty_per, uom_id)
                 VALUES ($1,$2,$3,$4,$5)`,
                [id, outLineNo++, out.output_item_id, out.output_qty_per ?? 0, out.uom_id || null]
            );
        }

        await client.query(`DELETE FROM mo_bom_operation_detail WHERE bom_header_id = $1`, [id]);
        let opLineNo = 1;
        for (const op of (b.operations || [])) {
            if (!op.work_center_id) continue;
            await client.query(
                `INSERT INTO mo_bom_operation_detail
                    (bom_header_id, line_no, work_center_id, operation_name, standard_labor_hours, standard_machine_hours, setup_hours)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [id, opLineNo++, op.work_center_id, op.operation_name || null, op.standard_labor_hours ?? 0, op.standard_machine_hours ?? 0, op.setup_hours ?? 0]
            );
        }

        await client.query('COMMIT');
        const updatedHeader = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        const updatedDetails = await client.query(DETAIL_SELECT, [id]);
        const updatedOutputs = await client.query(OUTPUT_SELECT, [id]);
        const updatedOperations = await client.query(OPERATION_SELECT, [id]);
        res.status(200).json({ ...updatedHeader.rows[0], details: updatedDetails.rows, outputs: updatedOutputs.rows, operations: updatedOperations.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating mo_bom_header:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureMoBomTable(client);
        const result = await client.query(`DELETE FROM mo_bom_header WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบสูตรการผลิต (BOM)' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting mo_bom_header:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureMoBomTable, fetchRows, fetchRow, addRow, updateRow, deleteRow, ISSUE_METHODS, COSTING_METHODS, COSTING_MODES };
