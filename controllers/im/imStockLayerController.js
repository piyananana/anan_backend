// controllers/im/imStockLayerController.js
// im_stock_layer — ต้นทุนแยกตามรุ่นที่รับเข้า ใช้กับสินค้า costing_method='FIFO' (หลาย unit ต่อ layer)
// และ 'SPECIFIC' — ต้นทุนเฉพาะเจาะจงตาม serial_no (1 unit ต่อ layer เสมอ)
// เขียนโดยการ Post ใบนับสต็อก (im_stock_count, ยังไม่สร้าง) และในอนาคตคือ im_transaction
// ไม่มีหน้าจอ CRUD ตรงๆ ให้ผู้ใช้แก้เอง จึง export แค่ ensure + fetchRows (อ่านอย่างเดียว)
'use strict';

const { ensureImItemTable } = require('./imItemController');
const { ensureImWarehouseTable } = require('./imWarehouseController');
const { ensureImLocationTable } = require('./imLocationController');

const ensureImStockLayerTable = async (client) => {
    await ensureImItemTable(client);
    await ensureImWarehouseTable(client);
    await ensureImLocationTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_stock_layer (
            id              SERIAL PRIMARY KEY,
            item_id         INTEGER NOT NULL REFERENCES im_item(id),
            warehouse_id    INTEGER NOT NULL REFERENCES im_warehouse(id),
            location_id     INTEGER REFERENCES im_location(id),
            lot_no          VARCHAR(50),
            serial_no       VARCHAR(50),
            layer_date      DATE NOT NULL,
            received_qty    NUMERIC(18,4) NOT NULL,
            remaining_qty   NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (remaining_qty >= 0),
            unit_cost       NUMERIC(18,4) NOT NULL DEFAULT 0,
            source_doc_type VARCHAR(20)  NOT NULL,
            source_doc_id   INTEGER      NOT NULL,
            source_doc_no   VARCHAR(50),
            created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by      VARCHAR(100)
        )
    `);
    // serial เดียวกัน "เปิดอยู่" (ยังไม่ถูกตัด) ต้องมีได้แค่ที่เดียวในระบบ — ไม่รวม warehouse_id
    // เพราะ serial จริงมีที่อยู่เดียว ถ้าโอนคลังต้องปิด layer เก่าแล้วเปิดใหม่ ไม่ใช่มีสองที่พร้อมกัน
    await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_im_stock_layer_serial_open
            ON im_stock_layer (item_id, serial_no)
            WHERE serial_no IS NOT NULL AND remaining_qty > 0
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_im_stock_layer_consume
            ON im_stock_layer (item_id, warehouse_id, COALESCE(location_id, 0), COALESCE(lot_no, ''), layer_date)
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_stock_layer_source ON im_stock_layer(source_doc_type, source_doc_id)`);
};

const STOCK_LAYER_SELECT = `
    SELECT l.*,
           i.item_code, i.item_name_th, i.item_name_en,
           w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
           loc.location_code, loc.location_name
    FROM im_stock_layer l
    LEFT JOIN im_item      i   ON i.id = l.item_id
    LEFT JOIN im_warehouse w   ON w.id = l.warehouse_id
    LEFT JOIN im_location  loc ON loc.id = l.location_id
`;

// GET /im_stock_layer?item_id=&warehouse_id=&serial_no=&open_only=true
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImStockLayerTable(client);
        const { item_id, warehouse_id, serial_no, open_only } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (item_id)      { params.push(item_id);      where += ` AND l.item_id = $${params.length}`; }
        if (warehouse_id) { params.push(warehouse_id); where += ` AND l.warehouse_id = $${params.length}`; }
        if (serial_no)    { params.push(serial_no);    where += ` AND l.serial_no = $${params.length}`; }
        if (open_only === 'true') where += ` AND l.remaining_qty > 0`;
        const result = await client.query(`${STOCK_LAYER_SELECT} ${where} ORDER BY l.item_id, l.layer_date`, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_stock_layer:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImStockLayerTable, fetchRows };
