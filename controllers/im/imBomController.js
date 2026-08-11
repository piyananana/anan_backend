// controllers/im/imBomController.js
'use strict';

const { ensureImItemTable } = require('./imItemController');
const { ensureImUomTable } = require('./imUomController');

const ensureImBomTable = async (client) => {
    // im_bom_header/detail reference im_item and im_uom, so they must exist first
    await ensureImItemTable(client);
    await ensureImUomTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_bom_header (
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_bom_header_parent ON im_bom_header(parent_item_id)`);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_bom_detail (
            id                  SERIAL PRIMARY KEY,
            bom_header_id       INTEGER NOT NULL REFERENCES im_bom_header(id) ON DELETE CASCADE,
            line_no             SMALLINT      NOT NULL,
            component_item_id   INTEGER NOT NULL REFERENCES im_item(id),
            quantity_per        NUMERIC(18,6) NOT NULL DEFAULT 0,
            uom_id              INTEGER REFERENCES im_uom(id),
            scrap_percent       NUMERIC(5,2)  NOT NULL DEFAULT 0
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_bom_detail_header ON im_bom_detail(bom_header_id)`);
};

const HEADER_SELECT = `
    SELECT h.*,
           pi.item_code AS parent_item_code, pi.item_name_th AS parent_item_name_th, pi.item_name_en AS parent_item_name_en,
           u.uom_code AS output_uom_code, u.uom_name_th AS output_uom_name_th, u.uom_name_en AS output_uom_name_en,
           (SELECT COUNT(*) FROM im_bom_detail d WHERE d.bom_header_id = h.id) AS component_count
    FROM im_bom_header h
    LEFT JOIN im_item pi ON pi.id = h.parent_item_id
    LEFT JOIN im_uom u   ON u.id  = h.output_uom_id
`;

const DETAIL_SELECT = `
    SELECT d.*,
           ci.item_code AS component_item_code, ci.item_name_th AS component_item_name_th, ci.item_name_en AS component_item_name_en,
           u.uom_code AS uom_code, u.uom_name_th AS uom_name_th, u.uom_name_en AS uom_name_en
    FROM im_bom_detail d
    LEFT JOIN im_item ci ON ci.id = d.component_item_id
    LEFT JOIN im_uom u   ON u.id  = d.uom_id
    WHERE d.bom_header_id = $1
    ORDER BY d.line_no
`;

// GET all (headers only, list view)
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImBomTable(client);
        const { parent_item_id } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (parent_item_id) { where += ` AND h.parent_item_id = $1`; params.push(parent_item_id); }
        const result = await client.query(`${HEADER_SELECT} ${where} ORDER BY pi.item_code, h.bom_version`, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_bom_header:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET one (header + detail lines)
const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImBomTable(client);
        const header = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        if (header.rows.length === 0) return res.status(404).json({ message: 'ไม่พบสูตรการผลิต (BOM)' });
        const details = await client.query(DETAIL_SELECT, [id]);
        res.status(200).json({ ...header.rows[0], details: details.rows });
    } catch (error) {
        console.error('Error fetching im_bom_header row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const b = req.body;
    const userName = req.headers.username || null;
    try {
        await client.query('BEGIN');
        await ensureImBomTable(client);

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

        const isActive = b.is_active ?? true;
        if (isActive) {
            await client.query(
                `UPDATE im_bom_header SET is_active = false WHERE parent_item_id = $1 AND is_active = true`,
                [b.parent_item_id]
            );
        }

        const header = await client.query(
            `INSERT INTO im_bom_header (parent_item_id, bom_version, bom_qty, output_uom_id, is_active, effective_date, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
             RETURNING id`,
            [b.parent_item_id, b.bom_version || '1', b.bom_qty ?? 1, b.output_uom_id || null, isActive, b.effective_date || null, userName]
        );
        const headerId = header.rows[0].id;

        let lineNo = 1;
        for (const line of b.details) {
            if (!line.component_item_id) continue;
            await client.query(
                `INSERT INTO im_bom_detail (bom_header_id, line_no, component_item_id, quantity_per, uom_id, scrap_percent)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [headerId, lineNo++, line.component_item_id, line.quantity_per ?? 0, line.uom_id || null, line.scrap_percent ?? 0]
            );
        }

        await client.query('COMMIT');
        const newHeader = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [headerId]);
        const newDetails = await client.query(DETAIL_SELECT, [headerId]);
        res.status(201).json({ ...newHeader.rows[0], details: newDetails.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding im_bom_header:', error);
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
        await ensureImBomTable(client);

        if (!Array.isArray(b.details) || b.details.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'กรุณาระบุส่วนประกอบอย่างน้อย 1 รายการ' });
        }

        const isActive = b.is_active ?? true;
        if (isActive) {
            await client.query(
                `UPDATE im_bom_header SET is_active = false WHERE parent_item_id = $1 AND id != $2 AND is_active = true`,
                [b.parent_item_id, id]
            );
        }

        const result = await client.query(
            `UPDATE im_bom_header SET
                bom_version    = $1,
                bom_qty        = $2,
                output_uom_id  = $3,
                is_active      = $4,
                effective_date = $5,
                updated_by     = $6,
                updated_at     = NOW()
             WHERE id = $7
             RETURNING id`,
            [b.bom_version || '1', b.bom_qty ?? 1, b.output_uom_id || null, isActive, b.effective_date || null, userName, id]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'ไม่พบสูตรการผลิต (BOM)' });
        }

        await client.query(`DELETE FROM im_bom_detail WHERE bom_header_id = $1`, [id]);
        let lineNo = 1;
        for (const line of b.details) {
            if (!line.component_item_id) continue;
            await client.query(
                `INSERT INTO im_bom_detail (bom_header_id, line_no, component_item_id, quantity_per, uom_id, scrap_percent)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [id, lineNo++, line.component_item_id, line.quantity_per ?? 0, line.uom_id || null, line.scrap_percent ?? 0]
            );
        }

        await client.query('COMMIT');
        const updatedHeader = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        const updatedDetails = await client.query(DETAIL_SELECT, [id]);
        res.status(200).json({ ...updatedHeader.rows[0], details: updatedDetails.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating im_bom_header:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImBomTable(client);
        const result = await client.query(`DELETE FROM im_bom_header WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบสูตรการผลิต (BOM)' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting im_bom_header:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImBomTable, fetchRows, fetchRow, addRow, updateRow, deleteRow };
