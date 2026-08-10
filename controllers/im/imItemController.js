// controllers/im/imItemController.js
'use strict';

const { ensureImItemCategoryTable } = require('./imItemCategoryController');
const { generateNextCode } = require('./imItemRunningController');

const ITEM_TYPES = ['STOCK', 'SERVICE', 'NON_STOCK'];
const COSTING_METHODS = ['FIFO', 'AVG', 'STANDARD'];

const ensureImItemTable = async (client) => {
    // im_item.category_id references im_item_category, so that table must exist first
    await ensureImItemCategoryTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_item (
            id                    SERIAL PRIMARY KEY,
            item_code             VARCHAR(30)  NOT NULL UNIQUE,
            barcode               VARCHAR(50),
            item_name_th          VARCHAR(200) NOT NULL,
            item_name_en          VARCHAR(200),
            description           TEXT,
            category_id           INTEGER REFERENCES im_item_category(id),
            item_type             VARCHAR(10)  NOT NULL DEFAULT 'STOCK',
            base_uom_id           INTEGER,      -- logical FK -> im_uom.id (table not created yet)
            costing_method        VARCHAR(10)  NOT NULL DEFAULT 'AVG',
            standard_cost         NUMERIC(18,4) NOT NULL DEFAULT 0,
            is_purchase_item      BOOLEAN      NOT NULL DEFAULT true,
            is_sales_item         BOOLEAN      NOT NULL DEFAULT true,
            is_manufactured       BOOLEAN      NOT NULL DEFAULT false,
            is_lot_tracked        BOOLEAN      NOT NULL DEFAULT false,
            is_serial_tracked     BOOLEAN      NOT NULL DEFAULT false,
            shelf_life_days       INTEGER,
            default_warehouse_id  INTEGER,      -- logical FK -> im_warehouse.id (table not created yet)
            min_stock_qty         NUMERIC(18,4) NOT NULL DEFAULT 0,
            max_stock_qty         NUMERIC(18,4) NOT NULL DEFAULT 0,
            reorder_point         NUMERIC(18,4) NOT NULL DEFAULT 0,
            default_vat_type      VARCHAR(10)  NOT NULL DEFAULT 'VAT7',
            inventory_account_id  INTEGER REFERENCES gl_account(id),
            cogs_account_id       INTEGER REFERENCES gl_account(id),
            revenue_account_id    INTEGER REFERENCES gl_account(id),
            expense_account_id    INTEGER REFERENCES gl_account(id),
            dim1_id INTEGER, dim2_id INTEGER, dim3_id INTEGER, dim4_id INTEGER, dim5_id INTEGER,
            is_active             BOOLEAN      NOT NULL DEFAULT true,
            created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by            VARCHAR(100),
            updated_by            VARCHAR(100)
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_item_category ON im_item(category_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_item_barcode  ON im_item(barcode)`);
};

const ITEM_SELECT = `
    SELECT i.*,
           c.category_code AS category_code, c.category_name_th AS category_name,
           inv.account_code AS inventory_account_code, inv.account_name_thai AS inventory_account_name,
           cogs.account_code AS cogs_account_code,      cogs.account_name_thai AS cogs_account_name,
           rev.account_code AS revenue_account_code,    rev.account_name_thai AS revenue_account_name,
           exp.account_code AS expense_account_code,    exp.account_name_thai AS expense_account_name
    FROM im_item i
    LEFT JOIN im_item_category c ON c.id = i.category_id
    LEFT JOIN gl_account inv  ON inv.id  = i.inventory_account_id
    LEFT JOIN gl_account cogs ON cogs.id = i.cogs_account_id
    LEFT JOIN gl_account rev  ON rev.id  = i.revenue_account_id
    LEFT JOIN gl_account exp  ON exp.id  = i.expense_account_id
`;

const validateEnums = (item_type, costing_method) => {
    if (item_type && !ITEM_TYPES.includes(item_type)) return `item_type ต้องเป็นหนึ่งใน ${ITEM_TYPES.join(', ')}`;
    if (costing_method && !COSTING_METHODS.includes(costing_method)) return `costing_method ต้องเป็นหนึ่งใน ${COSTING_METHODS.join(', ')}`;
    return null;
};

// GET all
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImItemTable(client);
        const { category_id, item_type, is_active, keyword } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (category_id) { where += ` AND i.category_id = $${pi++}`; params.push(category_id); }
        if (item_type)   { where += ` AND i.item_type = $${pi++}`;   params.push(item_type); }
        if (is_active !== undefined) { where += ` AND i.is_active = $${pi++}`; params.push(is_active === 'true'); }
        if (keyword) {
            where += ` AND (i.item_code ILIKE $${pi} OR i.item_name_th ILIKE $${pi} OR i.item_name_en ILIKE $${pi} OR i.barcode ILIKE $${pi})`;
            params.push(`%${keyword}%`); pi++;
        }
        const result = await client.query(`${ITEM_SELECT} ${where} ORDER BY i.item_code`, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_item:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImItemTable(client);
        const result = await client.query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบสินค้า' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching im_item row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const b = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImItemTable(client);
        const enumErr = validateEnums(b.item_type, b.costing_method);
        if (enumErr) return res.status(400).json({ message: enumErr });

        let finalCode = b.item_code && b.item_code.trim() !== ''
            ? b.item_code.trim().toUpperCase()
            : null;
        if (!finalCode) {
            finalCode = await generateNextCode(client);
        }
        if (!finalCode) {
            return res.status(400).json({ message: 'กรุณาระบุรหัสสินค้า หรือเปิดใช้งานรหัสอัตโนมัติในการตั้งค่า' });
        }

        const result = await client.query(
            `INSERT INTO im_item
                (item_code, barcode, item_name_th, item_name_en, description, category_id,
                 item_type, base_uom_id, costing_method, standard_cost,
                 is_purchase_item, is_sales_item, is_manufactured, is_lot_tracked, is_serial_tracked,
                 shelf_life_days, default_warehouse_id,
                 min_stock_qty, max_stock_qty, reorder_point, default_vat_type,
                 inventory_account_id, cogs_account_id, revenue_account_id, expense_account_id,
                 dim1_id, dim2_id, dim3_id, dim4_id, dim5_id,
                 is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$32)
             RETURNING id`,
            [
                finalCode,
                b.barcode || null,
                b.item_name_th || '', b.item_name_en || null, b.description || null, b.category_id || null,
                b.item_type || 'STOCK', b.base_uom_id || null, b.costing_method || 'AVG', b.standard_cost ?? 0,
                b.is_purchase_item ?? true, b.is_sales_item ?? true, b.is_manufactured ?? false,
                b.is_lot_tracked ?? false, b.is_serial_tracked ?? false,
                b.shelf_life_days || null, b.default_warehouse_id || null,
                b.min_stock_qty ?? 0, b.max_stock_qty ?? 0, b.reorder_point ?? 0, b.default_vat_type || 'VAT7',
                b.inventory_account_id || null, b.cogs_account_id || null, b.revenue_account_id || null, b.expense_account_id || null,
                b.dim1_id || null, b.dim2_id || null, b.dim3_id || null, b.dim4_id || null, b.dim5_id || null,
                b.is_active ?? true, userName,
            ]
        );
        const newRow = await client.query(`${ITEM_SELECT} WHERE i.id = $1`, [result.rows[0].id]);
        res.status(201).json(newRow.rows[0]);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `รหัสสินค้า '${b.item_code}' มีอยู่แล้ว` });
        console.error('Error adding im_item:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const b = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImItemTable(client);
        const enumErr = validateEnums(b.item_type, b.costing_method);
        if (enumErr) return res.status(400).json({ message: enumErr });

        const result = await client.query(
            `UPDATE im_item SET
                barcode               = $1,
                item_name_th          = $2,
                item_name_en          = $3,
                description           = $4,
                category_id           = $5,
                item_type             = $6,
                base_uom_id           = $7,
                costing_method        = $8,
                standard_cost         = $9,
                is_purchase_item      = $10,
                is_sales_item         = $11,
                is_manufactured       = $12,
                is_lot_tracked        = $13,
                is_serial_tracked     = $14,
                shelf_life_days       = $15,
                default_warehouse_id  = $16,
                min_stock_qty         = $17,
                max_stock_qty         = $18,
                reorder_point         = $19,
                default_vat_type      = $20,
                inventory_account_id  = $21,
                cogs_account_id       = $22,
                revenue_account_id    = $23,
                expense_account_id    = $24,
                dim1_id = $25, dim2_id = $26, dim3_id = $27, dim4_id = $28, dim5_id = $29,
                is_active             = $30,
                updated_by            = $31,
                updated_at            = NOW()
             WHERE id = $32
             RETURNING id`,
            [
                b.barcode || null,
                b.item_name_th || '', b.item_name_en || null, b.description || null, b.category_id || null,
                b.item_type || 'STOCK', b.base_uom_id || null, b.costing_method || 'AVG', b.standard_cost ?? 0,
                b.is_purchase_item ?? true, b.is_sales_item ?? true, b.is_manufactured ?? false,
                b.is_lot_tracked ?? false, b.is_serial_tracked ?? false,
                b.shelf_life_days || null, b.default_warehouse_id || null,
                b.min_stock_qty ?? 0, b.max_stock_qty ?? 0, b.reorder_point ?? 0, b.default_vat_type || 'VAT7',
                b.inventory_account_id || null, b.cogs_account_id || null, b.revenue_account_id || null, b.expense_account_id || null,
                b.dim1_id || null, b.dim2_id || null, b.dim3_id || null, b.dim4_id || null, b.dim5_id || null,
                b.is_active ?? true, userName, id,
            ]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบสินค้า' });
        const updated = await client.query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
        res.status(200).json(updated.rows[0]);
    } catch (error) {
        console.error('Error updating im_item:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImItemTable(client);
        const result = await client.query(`DELETE FROM im_item WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบสินค้า' });
        res.status(204).send();
    } catch (error) {
        if (error.code === '23503') return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลอ้างอิงสินค้านี้อยู่' });
        console.error('Error deleting im_item:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = {
    ensureImItemTable,
    ITEM_TYPES, COSTING_METHODS,
    fetchRows, fetchRow, addRow, updateRow, deleteRow,
};
