// controllers/im/imPriceListController.js
'use strict';

const { ensureImItemTable } = require('./imItemController');
const { ensureImUomTable } = require('./imUomController');

const LIST_TYPES = ['SALES', 'PURCHASE'];

const ensureImPriceListTable = async (client) => {
    // im_price_list_detail references im_item/im_uom, so they must exist first
    await ensureImItemTable(client);
    await ensureImUomTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_price_list (
            id                SERIAL PRIMARY KEY,
            price_list_code   VARCHAR(20)  NOT NULL UNIQUE,
            price_list_name   VARCHAR(200) NOT NULL,
            list_type         VARCHAR(10)  NOT NULL DEFAULT 'SALES',
            currency_id       INTEGER REFERENCES cd_currency(id),
            is_active         BOOLEAN      NOT NULL DEFAULT true,
            created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by        VARCHAR(100),
            updated_by        VARCHAR(100)
        )
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_price_list_detail (
            id                SERIAL PRIMARY KEY,
            price_list_id     INTEGER NOT NULL REFERENCES im_price_list(id) ON DELETE CASCADE,
            item_id           INTEGER NOT NULL REFERENCES im_item(id),
            uom_id            INTEGER REFERENCES im_uom(id),
            min_qty           NUMERIC(18,4) NOT NULL DEFAULT 0,
            unit_price_fc     NUMERIC(18,4) NOT NULL DEFAULT 0,
            effective_from    DATE,
            effective_to      DATE
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_price_list_detail_list ON im_price_list_detail(price_list_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_price_list_detail_item ON im_price_list_detail(item_id)`);
};

const HEADER_SELECT = `
    SELECT h.*,
           c.currency_code AS currency_code, c.currency_name_th AS currency_name_th, c.currency_name_en AS currency_name_en,
           (SELECT COUNT(*) FROM im_price_list_detail d WHERE d.price_list_id = h.id) AS line_count
    FROM im_price_list h
    LEFT JOIN cd_currency c ON c.id = h.currency_id
`;

const DETAIL_SELECT = `
    SELECT d.*,
           i.item_code AS item_code, i.item_name_th AS item_name_th, i.item_name_en AS item_name_en,
           u.uom_code AS uom_code, u.uom_name_th AS uom_name_th, u.uom_name_en AS uom_name_en
    FROM im_price_list_detail d
    LEFT JOIN im_item i ON i.id = d.item_id
    LEFT JOIN im_uom u  ON u.id = d.uom_id
    WHERE d.price_list_id = $1
    ORDER BY d.id
`;

// GET all (headers only, list view)
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceListTable(client);
        const { list_type } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (list_type) { where += ` AND h.list_type = $1`; params.push(list_type); }
        const result = await client.query(`${HEADER_SELECT} ${where} ORDER BY h.price_list_code`, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_price_list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET one (header + detail lines)
const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceListTable(client);
        const header = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        if (header.rows.length === 0) return res.status(404).json({ message: 'ไม่พบตารางราคา' });
        const details = await client.query(DETAIL_SELECT, [id]);
        res.status(200).json({ ...header.rows[0], details: details.rows });
    } catch (error) {
        console.error('Error fetching im_price_list row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET price lines for a given item, across all price lists — used by the Item detail screen
const fetchByItem = async (req, res) => {
    const { itemId } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceListTable(client);
        const result = await client.query(
            `SELECT d.*,
                    h.price_list_code, h.price_list_name, h.list_type,
                    c.currency_code,
                    u.uom_code
             FROM im_price_list_detail d
             JOIN im_price_list h ON h.id = d.price_list_id
             LEFT JOIN cd_currency c ON c.id = h.currency_id
             LEFT JOIN im_uom u ON u.id = d.uom_id
             WHERE d.item_id = $1 AND h.is_active = true
             ORDER BY h.list_type, h.price_list_code, d.min_qty`,
            [itemId]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching price lines by item:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const validateDetails = (details) => {
    if (!Array.isArray(details) || details.length === 0) return 'กรุณาระบุรายการราคาอย่างน้อย 1 รายการ';
    for (const line of details) {
        if (!line.item_id) return 'กรุณาระบุสินค้าในทุกรายการ';
    }
    return null;
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const b = req.body;
    const userName = req.headers.username || null;
    try {
        await client.query('BEGIN');
        await ensureImPriceListTable(client);

        if (!b.price_list_code || !b.price_list_name) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'กรุณาระบุรหัสและชื่อตารางราคา' });
        }
        if (b.list_type && !LIST_TYPES.includes(b.list_type)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `list_type ต้องเป็นหนึ่งใน ${LIST_TYPES.join(', ')}` });
        }
        const detailErr = validateDetails(b.details || []);
        if (detailErr) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: detailErr });
        }

        const header = await client.query(
            `INSERT INTO im_price_list (price_list_code, price_list_name, list_type, currency_id, is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$6)
             RETURNING id`,
            [
                b.price_list_code.trim().toUpperCase(), b.price_list_name.trim(),
                b.list_type || 'SALES', b.currency_id || null, b.is_active ?? true, userName,
            ]
        );
        const headerId = header.rows[0].id;

        for (const line of (b.details || [])) {
            await client.query(
                `INSERT INTO im_price_list_detail (price_list_id, item_id, uom_id, min_qty, unit_price_fc, effective_from, effective_to)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [headerId, line.item_id, line.uom_id || null, line.min_qty ?? 0, line.unit_price_fc ?? 0, line.effective_from || null, line.effective_to || null]
            );
        }

        await client.query('COMMIT');
        const newHeader = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [headerId]);
        const newDetails = await client.query(DETAIL_SELECT, [headerId]);
        res.status(201).json({ ...newHeader.rows[0], details: newDetails.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') return res.status(409).json({ message: `รหัสตารางราคา '${b.price_list_code}' มีอยู่แล้ว` });
        console.error('Error adding im_price_list:', error);
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
        await ensureImPriceListTable(client);

        if (b.list_type && !LIST_TYPES.includes(b.list_type)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `list_type ต้องเป็นหนึ่งใน ${LIST_TYPES.join(', ')}` });
        }
        const detailErr = validateDetails(b.details || []);
        if (detailErr) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: detailErr });
        }

        const result = await client.query(
            `UPDATE im_price_list SET
                price_list_name = $1,
                list_type       = $2,
                currency_id     = $3,
                is_active       = $4,
                updated_by      = $5,
                updated_at      = NOW()
             WHERE id = $6
             RETURNING id`,
            [b.price_list_name || '', b.list_type || 'SALES', b.currency_id || null, b.is_active ?? true, userName, id]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'ไม่พบตารางราคา' });
        }

        await client.query(`DELETE FROM im_price_list_detail WHERE price_list_id = $1`, [id]);
        for (const line of (b.details || [])) {
            await client.query(
                `INSERT INTO im_price_list_detail (price_list_id, item_id, uom_id, min_qty, unit_price_fc, effective_from, effective_to)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [id, line.item_id, line.uom_id || null, line.min_qty ?? 0, line.unit_price_fc ?? 0, line.effective_from || null, line.effective_to || null]
            );
        }

        await client.query('COMMIT');
        const updatedHeader = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        const updatedDetails = await client.query(DETAIL_SELECT, [id]);
        res.status(200).json({ ...updatedHeader.rows[0], details: updatedDetails.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating im_price_list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceListTable(client);
        const result = await client.query(`DELETE FROM im_price_list WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบตารางราคา' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting im_price_list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImPriceListTable, fetchRows, fetchRow, fetchByItem, addRow, updateRow, deleteRow, LIST_TYPES };
