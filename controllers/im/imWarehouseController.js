// controllers/im/imWarehouseController.js
'use strict';

const ensureImWarehouseTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_warehouse (
            id                 SERIAL PRIMARY KEY,
            warehouse_code     VARCHAR(20)  NOT NULL UNIQUE,
            warehouse_name_th  VARCHAR(200) NOT NULL,
            warehouse_name_en  VARCHAR(200),
            branch_id          INTEGER REFERENCES cd_branch(id),
            address            TEXT,
            is_active          BOOLEAN      NOT NULL DEFAULT true,
            created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by         VARCHAR(100),
            updated_by         VARCHAR(100)
        )
    `);
};

const WAREHOUSE_SELECT = `
    SELECT w.*,
           b.branch_code AS branch_code, b.branch_name_thai AS branch_name_th, b.branch_name_eng AS branch_name_en
    FROM im_warehouse w
    LEFT JOIN cd_branch b ON b.id = w.branch_id
`;

// GET all
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImWarehouseTable(client);
        const result = await client.query(`${WAREHOUSE_SELECT} ORDER BY w.warehouse_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_warehouse:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchActiveRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImWarehouseTable(client);
        const result = await client.query(`${WAREHOUSE_SELECT} WHERE w.is_active = true ORDER BY w.warehouse_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching active im_warehouse:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImWarehouseTable(client);
        const result = await client.query(`${WAREHOUSE_SELECT} WHERE w.id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบคลังสินค้า' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching im_warehouse row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const { warehouse_code, warehouse_name_th, warehouse_name_en, branch_id, address, is_active } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImWarehouseTable(client);
        const result = await client.query(
            `INSERT INTO im_warehouse (warehouse_code, warehouse_name_th, warehouse_name_en, branch_id, address, is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
             RETURNING id`,
            [(warehouse_code || '').trim().toUpperCase(), warehouse_name_th || '', warehouse_name_en || null, branch_id || null, address || null, is_active ?? true, userName]
        );
        const newRow = await client.query(`${WAREHOUSE_SELECT} WHERE w.id = $1`, [result.rows[0].id]);
        res.status(201).json(newRow.rows[0]);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `รหัสคลังสินค้า '${warehouse_code}' มีอยู่แล้ว` });
        console.error('Error adding im_warehouse:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const { warehouse_name_th, warehouse_name_en, branch_id, address, is_active } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImWarehouseTable(client);
        const result = await client.query(
            `UPDATE im_warehouse SET
                warehouse_name_th = $1, warehouse_name_en = $2, branch_id = $3,
                address = $4, is_active = $5, updated_by = $6, updated_at = NOW()
             WHERE id = $7
             RETURNING id`,
            [warehouse_name_th || '', warehouse_name_en || null, branch_id || null, address || null, is_active ?? true, userName, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบคลังสินค้า' });
        const updated = await client.query(`${WAREHOUSE_SELECT} WHERE w.id = $1`, [id]);
        res.status(200).json(updated.rows[0]);
    } catch (error) {
        console.error('Error updating im_warehouse:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImWarehouseTable(client);
        const tableCheck = await client.query(`SELECT to_regclass('public.im_item') AS reg`);
        if (tableCheck.rows[0].reg) {
            const inUse = await client.query(`SELECT 1 FROM im_item WHERE default_warehouse_id = $1 LIMIT 1`, [id]);
            if (inUse.rows.length > 0) {
                return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีสินค้าอ้างอิงคลังสินค้านี้' });
            }
        }
        const result = await client.query(`DELETE FROM im_warehouse WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบคลังสินค้า' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting im_warehouse:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImWarehouseTable, fetchRows, fetchActiveRows, fetchRow, addRow, updateRow, deleteRow };
