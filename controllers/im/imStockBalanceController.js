// controllers/im/imStockBalanceController.js
// im_stock_balance — ยอดคงเหลือปัจจุบันต่อ item/warehouse/location/lot (ใช้ทุก costing method)
// เป็น sub-ledger ที่ถูกเขียนโดยการ Post ใบนับสต็อก (im_stock_count, ยังไม่สร้าง) และในอนาคตคือ
// im_transaction — ไม่มีหน้าจอ CRUD ตรงๆ ให้ผู้ใช้แก้เอง จึง export แค่ ensure + fetchRows (อ่านอย่างเดียว)
'use strict';

const { ensureImItemTable } = require('./imItemController');
const { ensureImWarehouseTable } = require('./imWarehouseController');
const { ensureImLocationTable } = require('./imLocationController');

const ensureImStockBalanceTable = async (client) => {
    await ensureImItemTable(client);
    await ensureImWarehouseTable(client);
    await ensureImLocationTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_stock_balance (
            id             SERIAL PRIMARY KEY,
            item_id        INTEGER NOT NULL REFERENCES im_item(id),
            warehouse_id   INTEGER NOT NULL REFERENCES im_warehouse(id),
            location_id    INTEGER REFERENCES im_location(id),
            lot_no         VARCHAR(50),
            qty_on_hand    NUMERIC(18,4) NOT NULL DEFAULT 0,
            avg_unit_cost  NUMERIC(18,4) NOT NULL DEFAULT 0,
            total_value    NUMERIC(18,4) GENERATED ALWAYS AS (qty_on_hand * avg_unit_cost) STORED,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by     VARCHAR(100)
        )
    `);
    await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_im_stock_balance_key
            ON im_stock_balance (item_id, warehouse_id, COALESCE(location_id, 0), COALESCE(lot_no, ''))
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_stock_balance_item      ON im_stock_balance(item_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_stock_balance_warehouse ON im_stock_balance(warehouse_id)`);
};

const STOCK_BALANCE_SELECT = `
    SELECT b.*,
           i.item_code, i.item_name_th, i.item_name_en,
           w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
           l.location_code, l.location_name
    FROM im_stock_balance b
    LEFT JOIN im_item      i ON i.id = b.item_id
    LEFT JOIN im_warehouse w ON w.id = b.warehouse_id
    LEFT JOIN im_location  l ON l.id = b.location_id
`;

// GET /im_stock_balance?item_id=&warehouse_id=&location_id=
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImStockBalanceTable(client);
        const { item_id, warehouse_id, location_id } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (item_id)      { params.push(item_id);      where += ` AND b.item_id = $${params.length}`; }
        if (warehouse_id) { params.push(warehouse_id); where += ` AND b.warehouse_id = $${params.length}`; }
        if (location_id)  { params.push(location_id);  where += ` AND b.location_id = $${params.length}`; }
        const result = await client.query(`${STOCK_BALANCE_SELECT} ${where} ORDER BY i.item_code, w.warehouse_code`, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_stock_balance:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImStockBalanceTable, fetchRows };
