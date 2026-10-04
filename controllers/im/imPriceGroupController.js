// controllers/im/imPriceGroupController.js — กลุ่มราคา (ค้าปลีก/ค้าส่ง/ตัวแทนจำหน่าย/VIP ฯลฯ) สำหรับผูกกับ
// im_price_list (customer_price_group_id/vendor_price_group_id) — แยกจาก ar_customer_group/ap_vendor_group
// โดยสิ้นเชิง (กลุ่มนั้นคือนโยบายบัญชี/เครดิต ไม่เกี่ยวกับการตั้งราคา) มิเรอร์ imUomController.js ทุกประการ
'use strict';

const ensureImPriceGroupTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_price_group (
            id                     SERIAL PRIMARY KEY,
            price_group_code       VARCHAR(20)  NOT NULL UNIQUE,
            price_group_name_th    VARCHAR(100) NOT NULL,
            price_group_name_en    VARCHAR(100),
            description            TEXT,
            is_active              BOOLEAN      NOT NULL DEFAULT true,
            created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by             VARCHAR(100),
            updated_by             VARCHAR(100)
        )
    `);
};

// GET all
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceGroupTable(client);
        const result = await client.query(`SELECT * FROM im_price_group ORDER BY price_group_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_price_group:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchActiveRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceGroupTable(client);
        const result = await client.query(`SELECT * FROM im_price_group WHERE is_active = true ORDER BY price_group_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching active im_price_group:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceGroupTable(client);
        const result = await client.query(`SELECT * FROM im_price_group WHERE id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบกลุ่มราคา' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching im_price_group row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const { price_group_code, price_group_name_th, price_group_name_en, description, is_active } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImPriceGroupTable(client);
        const result = await client.query(
            `INSERT INTO im_price_group (price_group_code, price_group_name_th, price_group_name_en, description, is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$6)
             RETURNING *`,
            [(price_group_code || '').trim().toUpperCase(), price_group_name_th || '', price_group_name_en || null, description || null, is_active ?? true, userName]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `รหัสกลุ่มราคา '${price_group_code}' มีอยู่แล้ว` });
        console.error('Error adding im_price_group:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const { price_group_name_th, price_group_name_en, description, is_active } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImPriceGroupTable(client);
        const result = await client.query(
            `UPDATE im_price_group SET
                price_group_name_th = $1, price_group_name_en = $2, description = $3, is_active = $4,
                updated_by          = $5, updated_at          = NOW()
             WHERE id = $6
             RETURNING *`,
            [price_group_name_th || '', price_group_name_en || null, description || null, is_active ?? true, userName, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบกลุ่มราคา' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating im_price_group:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceGroupTable(client);
        const result = await client.query(`DELETE FROM im_price_group WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบกลุ่มราคา' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting im_price_group:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImPriceGroupTable, fetchRows, fetchActiveRows, fetchRow, addRow, updateRow, deleteRow };
