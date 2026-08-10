// controllers/im/imUomController.js
'use strict';

const ensureImUomTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_uom (
            id            SERIAL PRIMARY KEY,
            uom_code      VARCHAR(10)  NOT NULL UNIQUE,
            uom_name_th   VARCHAR(100) NOT NULL,
            uom_name_en   VARCHAR(100),
            is_active     BOOLEAN      NOT NULL DEFAULT true,
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by    VARCHAR(100),
            updated_by    VARCHAR(100)
        )
    `);
};

// GET all
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImUomTable(client);
        const result = await client.query(`SELECT * FROM im_uom ORDER BY uom_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_uom:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchActiveRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImUomTable(client);
        const result = await client.query(`SELECT * FROM im_uom WHERE is_active = true ORDER BY uom_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching active im_uom:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImUomTable(client);
        const result = await client.query(`SELECT * FROM im_uom WHERE id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบหน่วยนับ' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching im_uom row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const { uom_code, uom_name_th, uom_name_en, is_active } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImUomTable(client);
        const result = await client.query(
            `INSERT INTO im_uom (uom_code, uom_name_th, uom_name_en, is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$5)
             RETURNING *`,
            [(uom_code || '').trim().toUpperCase(), uom_name_th || '', uom_name_en || null, is_active ?? true, userName]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `รหัสหน่วยนับ '${uom_code}' มีอยู่แล้ว` });
        console.error('Error adding im_uom:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const { uom_name_th, uom_name_en, is_active } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImUomTable(client);
        const result = await client.query(
            `UPDATE im_uom SET
                uom_name_th = $1, uom_name_en = $2, is_active = $3,
                updated_by  = $4, updated_at  = NOW()
             WHERE id = $5
             RETURNING *`,
            [uom_name_th || '', uom_name_en || null, is_active ?? true, userName, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบหน่วยนับ' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating im_uom:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImUomTable(client);
        const tableCheck = await client.query(`SELECT to_regclass('public.im_item') AS reg`);
        if (tableCheck.rows[0].reg) {
            const inUse = await client.query(`SELECT 1 FROM im_item WHERE base_uom_id = $1 LIMIT 1`, [id]);
            if (inUse.rows.length > 0) {
                return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีสินค้าอ้างอิงหน่วยนับนี้' });
            }
        }
        const result = await client.query(`DELETE FROM im_uom WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบหน่วยนับ' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting im_uom:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImUomTable, fetchRows, fetchActiveRows, fetchRow, addRow, updateRow, deleteRow };
