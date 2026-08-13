// controllers/im/imLocationController.js
// im_location — standalone tree master (โซน/แถว/ช่องเก็บ) ต่อคลังสินค้า
// GROUP = จัดกลุ่มในผังเท่านั้น (โซน/แถว), BIN = ช่องเก็บจริง ผูกหมวดหมู่สินค้าที่ควรเก็บได้
'use strict';

const { ensureImWarehouseTable } = require('./imWarehouseController');
const { ensureImItemCategoryTable } = require('./imItemCategoryController');

const LOCATION_TYPES = ['GROUP', 'BIN'];

const ensureImLocationTable = async (client) => {
    await ensureImWarehouseTable(client);
    await ensureImItemCategoryTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_location (
            id              SERIAL PRIMARY KEY,
            warehouse_id    INTEGER NOT NULL,
            location_code   VARCHAR(20)  NOT NULL,
            location_name   VARCHAR(200),
            is_active       BOOLEAN NOT NULL DEFAULT true
        )
    `);
    await client.query(`
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'im_location_warehouse_id_fkey'
            ) THEN
                ALTER TABLE im_location ADD CONSTRAINT im_location_warehouse_id_fkey
                    FOREIGN KEY (warehouse_id) REFERENCES im_warehouse(id) ON DELETE CASCADE;
            END IF;
        END $$;
    `).catch(() => {});
    // idempotent migration: promote จาก list แบนต่อคลัง เป็นผัง tree ผูกหมวดหมู่
    await client.query(`ALTER TABLE im_location ADD COLUMN IF NOT EXISTS parent_id     INTEGER REFERENCES im_location(id)`).catch(() => {});
    await client.query(`ALTER TABLE im_location ADD COLUMN IF NOT EXISTS level         SMALLINT NOT NULL DEFAULT 1`).catch(() => {});
    await client.query(`ALTER TABLE im_location ADD COLUMN IF NOT EXISTS location_type VARCHAR(10) NOT NULL DEFAULT 'BIN'`).catch(() => {});
    await client.query(`ALTER TABLE im_location ADD COLUMN IF NOT EXISTS category_id   INTEGER REFERENCES im_item_category(id)`).catch(() => {});
    await client.query(`ALTER TABLE im_location ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()`).catch(() => {});
    await client.query(`ALTER TABLE im_location ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()`).catch(() => {});
    await client.query(`ALTER TABLE im_location ADD COLUMN IF NOT EXISTS created_by    VARCHAR(100)`).catch(() => {});
    await client.query(`ALTER TABLE im_location ADD COLUMN IF NOT EXISTS updated_by    VARCHAR(100)`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_location_warehouse ON im_location(warehouse_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_location_parent    ON im_location(parent_id)`);
};

const LOCATION_SELECT = `
    SELECT l.*,
           w.warehouse_code AS warehouse_code, w.warehouse_name_th AS warehouse_name_th, w.warehouse_name_en AS warehouse_name_en,
           c.category_code  AS category_code,  c.category_name_th  AS category_name_th,  c.category_name_en  AS category_name_en
    FROM im_location l
    LEFT JOIN im_warehouse     w ON w.id = l.warehouse_id
    LEFT JOIN im_item_category c ON c.id = l.category_id
`;

// GET /im_location?warehouse_id=&active=true  (tree order: level then code)
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImLocationTable(client);
        const { warehouse_id, active } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (warehouse_id) { params.push(warehouse_id); where += ` AND l.warehouse_id = $${params.length}`; }
        if (active !== undefined) { params.push(active === 'true'); where += ` AND l.is_active = $${params.length}`; }
        const result = await client.query(`${LOCATION_SELECT} ${where} ORDER BY l.level, l.location_code`, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_location:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchActiveRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImLocationTable(client);
        const { warehouse_id } = req.query;
        let where = 'WHERE l.is_active = true';
        const params = [];
        if (warehouse_id) { params.push(warehouse_id); where += ` AND l.warehouse_id = $${params.length}`; }
        const result = await client.query(`${LOCATION_SELECT} ${where} ORDER BY l.level, l.location_code`, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching active im_location:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImLocationTable(client);
        const result = await client.query(`${LOCATION_SELECT} WHERE l.id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบตำแหน่งจัดเก็บ' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching im_location row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const {
        warehouse_id, location_code, location_name, parent_id, location_type,
        category_id, is_active,
    } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImLocationTable(client);
        if (!warehouse_id) return res.status(400).json({ message: 'กรุณาระบุคลังสินค้า' });
        if (location_type && !LOCATION_TYPES.includes(location_type)) {
            return res.status(400).json({ message: `location_type ต้องเป็นหนึ่งใน ${LOCATION_TYPES.join(', ')}` });
        }
        const finalType = location_type || 'BIN';

        let level = 1;
        if (parent_id) {
            const parent = await client.query(`SELECT level, warehouse_id, location_type FROM im_location WHERE id = $1`, [parent_id]);
            if (parent.rows.length === 0) return res.status(400).json({ message: 'ไม่พบตำแหน่งแม่' });
            if (Number(parent.rows[0].warehouse_id) !== Number(warehouse_id)) {
                return res.status(400).json({ message: 'ตำแหน่งแม่ต้องอยู่ในคลังสินค้าเดียวกัน' });
            }
            if (parent.rows[0].location_type !== 'GROUP') {
                return res.status(400).json({ message: 'เพิ่มตำแหน่งย่อยได้เฉพาะใต้กลุ่ม (GROUP) เท่านั้น' });
            }
            level = parent.rows[0].level + 1;
        }

        const dup = await client.query(
            `SELECT 1 FROM im_location WHERE warehouse_id = $1 AND UPPER(location_code) = UPPER($2)`,
            [warehouse_id, (location_code || '').trim()]
        );
        if (dup.rows.length > 0) {
            return res.status(409).json({ message: `รหัสตำแหน่ง '${location_code}' มีอยู่แล้วในคลังนี้` });
        }

        const result = await client.query(
            `INSERT INTO im_location
                (warehouse_id, location_code, location_name, parent_id, level, location_type, category_id, is_active,
                 created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
             RETURNING id`,
            [
                warehouse_id,
                (location_code || '').trim().toUpperCase(),
                location_name || null,
                parent_id || null,
                level,
                finalType,
                finalType === 'BIN' ? (category_id || null) : null,
                is_active ?? true,
                userName,
            ]
        );
        const newRow = await client.query(`${LOCATION_SELECT} WHERE l.id = $1`, [result.rows[0].id]);
        res.status(201).json(newRow.rows[0]);
    } catch (error) {
        console.error('Error adding im_location:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const { location_code, location_name, parent_id, location_type, category_id, is_active } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImLocationTable(client);
        const currentResult = await client.query(`SELECT warehouse_id FROM im_location WHERE id = $1`, [id]);
        if (currentResult.rows.length === 0) return res.status(404).json({ message: 'ไม่พบตำแหน่งจัดเก็บ' });
        const warehouseId = currentResult.rows[0].warehouse_id;

        if (location_type && !LOCATION_TYPES.includes(location_type)) {
            return res.status(400).json({ message: `location_type ต้องเป็นหนึ่งใน ${LOCATION_TYPES.join(', ')}` });
        }
        const finalType = location_type || 'BIN';
        if (parent_id && Number(parent_id) === Number(id)) {
            return res.status(400).json({ message: 'ตำแหน่งแม่ต้องไม่ใช่ตัวเอง' });
        }

        let level = 1;
        if (parent_id) {
            const parent = await client.query(`SELECT level, warehouse_id, location_type FROM im_location WHERE id = $1`, [parent_id]);
            if (parent.rows.length === 0) return res.status(400).json({ message: 'ไม่พบตำแหน่งแม่' });
            if (Number(parent.rows[0].warehouse_id) !== Number(warehouseId)) {
                return res.status(400).json({ message: 'ตำแหน่งแม่ต้องอยู่ในคลังสินค้าเดียวกัน' });
            }
            if (parent.rows[0].location_type !== 'GROUP') {
                return res.status(400).json({ message: 'เพิ่มตำแหน่งย่อยได้เฉพาะใต้กลุ่ม (GROUP) เท่านั้น' });
            }
            level = parent.rows[0].level + 1;
        }

        const dup = await client.query(
            `SELECT 1 FROM im_location WHERE warehouse_id = $1 AND UPPER(location_code) = UPPER($2) AND id != $3`,
            [warehouseId, (location_code || '').trim(), id]
        );
        if (dup.rows.length > 0) {
            return res.status(409).json({ message: `รหัสตำแหน่ง '${location_code}' มีอยู่แล้วในคลังนี้` });
        }

        const result = await client.query(
            `UPDATE im_location SET
                location_code = $1, location_name = $2, parent_id = $3, level = $4,
                location_type = $5, category_id = $6, is_active = $7,
                updated_by = $8, updated_at = NOW()
             WHERE id = $9
             RETURNING id`,
            [
                (location_code || '').trim().toUpperCase(),
                location_name || null,
                parent_id || null,
                level,
                finalType,
                finalType === 'BIN' ? (category_id || null) : null,
                is_active ?? true,
                userName,
                id,
            ]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบตำแหน่งจัดเก็บ' });
        const updated = await client.query(`${LOCATION_SELECT} WHERE l.id = $1`, [id]);
        res.status(200).json(updated.rows[0]);
    } catch (error) {
        console.error('Error updating im_location:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImLocationTable(client);
        const hasChildren = await client.query(`SELECT 1 FROM im_location WHERE parent_id = $1 LIMIT 1`, [id]);
        if (hasChildren.rows.length > 0) {
            return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีตำแหน่งย่อยอ้างอิงอยู่' });
        }
        const tableCheck = await client.query(`SELECT to_regclass('public.im_item_warehouse') AS reg`);
        if (tableCheck.rows[0].reg) {
            const inUse = await client.query(`SELECT 1 FROM im_item_warehouse WHERE default_location_id = $1 LIMIT 1`, [id]);
            if (inUse.rows.length > 0) {
                return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีสินค้าอ้างอิงตำแหน่งนี้เป็นตำแหน่งจัดเก็บเริ่มต้น' });
            }
        }
        const result = await client.query(`DELETE FROM im_location WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบตำแหน่งจัดเก็บ' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting im_location:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = {
    ensureImLocationTable,
    fetchRows, fetchActiveRows, fetchRow, addRow, updateRow, deleteRow,
    LOCATION_TYPES,
};
