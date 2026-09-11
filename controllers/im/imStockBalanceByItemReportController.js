// controllers/im/imStockBalanceByItemReportController.js
// รายงานสินค้าคงเหลือตามตำแหน่งที่เก็บ — ยอดคงเหลือ ณ วันที่สิ้นสุดที่เลือก แยกตาม item/warehouse/location/lot/serial
//
// จุดสำคัญ: ไม่ได้อ่านจาก im_stock_balance/im_stock_layer ตรงๆ (ตารางนั้นมีแค่ยอด "ปัจจุบัน" เท่านั้น ไม่รองรับ
// การดูย้อนหลัง ณ วันที่ใดวันที่หนึ่ง) แต่คำนวณยอดคงเหลือ ณ วันที่สิ้นสุดด้วยการ SUM จาก im_transaction_detail
// ตรงๆ (มิเรอร์วิธีคำนวณ opening balance ของ im_stock_movement_report_screen) ซึ่งใช้ได้กับทุก costing method
// เหมือนกันหมด เพราะแต่ละแถวการเคลื่อนไหวบันทึก lot_no/serial_no ของตัวเองอยู่แล้ว การ group by
// (item, warehouse, location, lot_no, serial_no) จึงสมมูลกับผลรวมของ FIFO layer/serial layer ที่ยังไม่ถูกตัด
// จุดสำคัญอีกจุด (verify แล้ว ดู pattern_im_stock_movement_report ใน project memory): TRF สร้างแถวเดียว
// scope ที่ warehouse_id/location_id ต้นทางเท่านั้น (qty ติดลบ) ฝั่งปลายทาง (to_warehouse_id/to_location_id)
// ต้อง synthesize เองด้วย UNION ALL + flip sign เหมือนเดิม
'use strict';

// sort: '' (ไม่ระบุ) | qty | value | location | lot_serial — เป็น secondary sort ภายในแต่ละหมวดหมู่เท่านั้น
// (หมวดหมู่ยังคงเป็น outer grouping key เสมอ เพราะฝั่ง frontend เดินลิสต์แบบ linear-pass จัดกลุ่ม+ยอดรวมย่อย
// ตามหมวดหมู่ — ถ้าให้ sort ข้ามหมวดหมู่ได้ จะทำให้การจัดกลุ่มนั้นขาดตอน/ผิด)
const SORT_COLUMNS = {
    qty: 'b.qty',
    value: 'b.value',
    location: 'loc.location_code',
    lot_serial: 'COALESCE(b.lot_no, b.serial_no)',
};

const getStockBalanceByItemReport = async (req, res) => {
    const {
        date_to, category_ids, item_code_from, item_code_to, costing_method,
        warehouse_ids, location_code_from, location_code_to, balance_filter,
        sort, sort_dir,
    } = req.query;
    const dateTo = date_to || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        const params = [dateTo];
        let itemFilter = '';
        if (category_ids) {
            const ids = String(category_ids).split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
            if (ids.length > 0) {
                params.push(ids);
                itemFilter += ` AND it.category_id = ANY($${params.length}::int[])`;
            }
        }
        if (item_code_from) {
            params.push(item_code_from);
            itemFilter += ` AND it.item_code >= $${params.length}`;
        }
        if (item_code_to) {
            params.push(item_code_to);
            itemFilter += ` AND it.item_code <= $${params.length}`;
        }
        if (costing_method) {
            params.push(costing_method);
            itemFilter += ` AND it.costing_method = $${params.length}`;
        }

        let warehouseFilter = '';
        if (warehouse_ids) {
            const ids = String(warehouse_ids).split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
            if (ids.length > 0) {
                params.push(ids);
                warehouseFilter = ` AND w.id = ANY($${params.length}::int[])`;
            }
        }

        let locationFilter = '';
        if (location_code_from) {
            params.push(location_code_from);
            locationFilter += ` AND loc.location_code >= $${params.length}`;
        }
        if (location_code_to) {
            params.push(location_code_to);
            locationFilter += ` AND loc.location_code <= $${params.length}`;
        }

        // has = มียอดคงเหลือ (default), none = ไม่มียอดคงเหลือ (เคลื่อนไหวแล้วหักกันหมดพอดี), all = ทั้งหมด
        let balanceHaving = ' AND b.qty <> 0';
        if (balance_filter === 'none') balanceHaving = ' AND b.qty = 0';
        else if (balance_filter === 'all') balanceHaving = '';

        let orderBy = 'cat.category_code';
        if (sort && SORT_COLUMNS[sort]) {
            const dir = sort_dir === 'desc' ? 'DESC' : 'ASC';
            orderBy += `, ${SORT_COLUMNS[sort]} ${dir} NULLS LAST`;
        }
        orderBy += ', it.item_code, w.warehouse_code, loc.location_code NULLS FIRST, b.lot_no NULLS FIRST, b.serial_no NULLS FIRST';

        const sql = `
            WITH movement AS (
                SELECT
                    t.warehouse_id AS effective_warehouse_id, dt.location_id AS effective_location_id,
                    dt.item_id, dt.qty, dt.total_value_lc, dt.lot_no, dt.serial_no
                FROM im_transaction t
                JOIN sa_module_document d ON d.id = t.doc_id
                JOIN im_transaction_detail dt ON dt.header_id = t.id
                WHERE t.status IN ('Posted', 'Received', 'Delivered')
                  AND t.doc_date <= $1::date

                UNION ALL

                -- ฝั่งปลายทางของ TRF (โอนเข้า) — ไม่มีแถวจริงใน im_transaction_detail จึงสร้างขึ้นเองโดย flip
                -- sign ของ qty/total_value_lc แล้วใช้ to_warehouse_id/to_location_id เป็นคลัง/ตำแหน่งที่มีผล
                SELECT
                    t.to_warehouse_id AS effective_warehouse_id, dt.to_location_id AS effective_location_id,
                    dt.item_id, -dt.qty AS qty, -dt.total_value_lc AS total_value_lc, dt.lot_no, dt.serial_no
                FROM im_transaction t
                JOIN sa_module_document d ON d.id = t.doc_id
                JOIN im_transaction_detail dt ON dt.header_id = t.id
                WHERE t.status IN ('Posted', 'Received', 'Delivered')
                  AND t.doc_date <= $1::date
                  AND d.sys_doc_type = '70'
                  AND t.to_warehouse_id IS NOT NULL
            ),
            balance AS (
                SELECT effective_warehouse_id, effective_location_id, item_id, lot_no, serial_no,
                       SUM(qty) AS qty, SUM(total_value_lc) AS value
                FROM movement
                WHERE effective_warehouse_id IS NOT NULL
                GROUP BY effective_warehouse_id, effective_location_id, item_id, lot_no, serial_no
            )
            SELECT
                b.qty, b.value, b.lot_no, b.serial_no,
                it.id AS item_id, it.item_code, it.item_name_th, it.item_name_en, it.costing_method,
                it.is_lot_tracked, it.is_serial_tracked,
                cat.id AS category_id, cat.category_code, cat.category_name_th, cat.category_name_en,
                w.id AS warehouse_id, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                loc.id AS location_id, loc.location_code, loc.location_name,
                loc.parent_id AS location_parent_id, loc.level AS location_level,
                u.uom_code, u.uom_name_th, u.uom_name_en
            FROM balance b
            JOIN im_item it                ON it.id = b.item_id
            LEFT JOIN im_item_category cat ON cat.id = it.category_id
            JOIN im_warehouse w             ON w.id = b.effective_warehouse_id
            LEFT JOIN im_location loc       ON loc.id = b.effective_location_id
            LEFT JOIN im_uom u              ON u.id = it.base_uom_id
            WHERE 1=1
              ${itemFilter}
              ${warehouseFilter}
              ${locationFilter}
              ${balanceHaving}
            ORDER BY ${orderBy}
        `;

        const result = await client.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error('IM Stock Balance By Item Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getStockBalanceByItemReport };
