// controllers/im/imStockAgingReportController.js
// รายงานอายุสินค้าคงคลัง (Stock Aging Report) — แยกวิธีคำนวณอายุตาม costing_method ของสินค้า เพราะข้อมูลที่มีอยู่
// จริงต่างกันโดยพื้นฐาน:
//   - FIFO/SPECIFIC: มี im_stock_layer เก็บเป็นล็อตแยกทุก batch (layer_date, remaining_qty) จึงรู้ "อายุจริง"
//     ของแต่ละล็อตที่เหลืออยู่ได้ตรงๆ
//   - AVG/STANDARD: ทุกธุรกรรมผสมรวมเป็นยอดเดียวใน im_stock_balance (ดู upsertStockBalance ใน
//     imTransactionController.js) ไม่มีประวัติราย batch เหลืออยู่เลย จึงไม่มี "อายุ" ให้คำนวณจริง — ใช้ proxy
//     แทนคือ "ไม่มีการขายออกมากี่วันแล้ว" (วันที่ dt.qty < 0 ล่าสุด) หรือถ้าไม่เคยขายออกเลยให้ fallback เป็น
//     "รับเข้าครั้งแรกเมื่อไหร่" (dt.qty > 0 แรกสุด) กันไม่ให้ตีความผิดว่า "ไม่มีข้อมูล"
// สองค่านี้ (age_days / no_movement_days) ต้องไม่ปนกันในคอลัมน์เดียว — ฝั่ง frontend ต้องแสดงแยกคอลัมน์เสมอ
// ดู pattern การ grouping+filter (category เป็น outer key, ORDER BY จัดมาให้ ห้าม re-sort ฝั่ง frontend) จาก
// imStockBalanceByItemReportController.js — รายงานนี้มิเรอร์ pattern เดียวกัน
//
// ขอบเขต: เป็นรายงาน current-state เท่านั้น ไม่ใช่ point-in-time ย้อนหลัง — im_stock_layer.remaining_qty และ
// im_stock_balance.qty_on_hand เก็บแค่ยอด "ปัจจุบัน" เท่านั้น (ไม่รองรับ reconstruct ย้อนหลังแบบ balance-by-item
// report ที่ SUM จาก im_transaction_detail ได้ เพราะที่นี่ต้องการ "อายุระดับ batch" ซึ่งไม่มีข้อมูลเก็บย้อนหลัง)
// as_of_date จึงมีผลแค่เป็นจุดอ้างอิงคำนวณจำนวนวัน ไม่ใช่การ reconstruct ยอดคงเหลือ ณ วันนั้น
'use strict';

// sort: '' (ไม่ระบุ) | qty | value | age | location | lot_serial — secondary sort ภายในแต่ละหมวดหมู่เท่านั้น
// 'age' รวม age_days (FIFO/SPECIFIC) กับ no_movement_days (AVG/STANDARD) เข้าด้วยกันผ่าน COALESCE เพื่อให้
// เรียงปนกันได้อย่างสมเหตุสมผลภายในหมวดหมู่เดียวกัน
const SORT_COLUMNS = {
    qty: 'r.qty',
    value: 'r.value',
    age: 'COALESCE(r.age_days, r.no_movement_days)',
    location: 'loc.location_code',
    lot_serial: 'COALESCE(r.lot_no, r.serial_no)',
};

const getStockAgingReport = async (req, res) => {
    const {
        as_of_date, category_ids, item_code_from, item_code_to, costing_method,
        warehouse_ids, location_code_from, location_code_to,
        sort, sort_dir,
    } = req.query;
    const asOf = as_of_date || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        const params = [asOf];
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

        let orderBy = 'cat.category_code';
        if (sort && SORT_COLUMNS[sort]) {
            const dir = sort_dir === 'desc' ? 'DESC' : 'ASC';
            orderBy += `, ${SORT_COLUMNS[sort]} ${dir} NULLS LAST`;
        }
        orderBy += ', it.item_code, w.warehouse_code, loc.location_code NULLS FIRST, r.lot_no NULLS FIRST, r.serial_no NULLS FIRST';

        const sql = `
            WITH last_out AS (
                SELECT t.warehouse_id, dt.location_id, dt.item_id, MAX(t.doc_date) AS d
                FROM im_transaction t
                JOIN im_transaction_detail dt ON dt.header_id = t.id
                WHERE t.status IN ('Posted', 'Received', 'Delivered') AND dt.qty < 0
                GROUP BY t.warehouse_id, dt.location_id, dt.item_id
            ),
            first_in AS (
                SELECT t.warehouse_id, dt.location_id, dt.item_id, MIN(t.doc_date) AS d
                FROM im_transaction t
                JOIN im_transaction_detail dt ON dt.header_id = t.id
                WHERE t.status IN ('Posted', 'Received', 'Delivered') AND dt.qty > 0
                GROUP BY t.warehouse_id, dt.location_id, dt.item_id
            ),
            rows AS (
                -- FIFO/SPECIFIC: หนึ่งแถวต่อหนึ่ง layer ที่ยังเหลืออยู่ — อายุจริงจาก layer_date
                SELECT
                    l.item_id, l.warehouse_id, l.location_id, l.lot_no, l.serial_no,
                    l.remaining_qty AS qty, l.unit_cost, (l.remaining_qty * l.unit_cost) AS value,
                    ($1::date - l.layer_date) AS age_days,
                    NULL::int AS no_movement_days
                FROM im_stock_layer l
                JOIN im_item it2 ON it2.id = l.item_id
                WHERE l.remaining_qty > 0 AND l.layer_date <= $1::date
                  AND it2.costing_method IN ('FIFO', 'SPECIFIC')

                UNION ALL

                -- AVG/STANDARD: หนึ่งแถวต่อหนึ่ง balance key — ไม่มีล็อต ใช้ no_movement_days แทน age_days
                SELECT
                    b.item_id, b.warehouse_id, b.location_id, NULL::varchar AS lot_no, NULL::varchar AS serial_no,
                    b.qty_on_hand AS qty, b.avg_unit_cost AS unit_cost, (b.qty_on_hand * b.avg_unit_cost) AS value,
                    NULL::int AS age_days,
                    ($1::date - COALESCE(lo.d, fi.d)) AS no_movement_days
                FROM im_stock_balance b
                JOIN im_item it2 ON it2.id = b.item_id
                LEFT JOIN last_out lo ON lo.item_id = b.item_id AND lo.warehouse_id = b.warehouse_id
                    AND COALESCE(lo.location_id, 0) = COALESCE(b.location_id, 0)
                LEFT JOIN first_in fi ON fi.item_id = b.item_id AND fi.warehouse_id = b.warehouse_id
                    AND COALESCE(fi.location_id, 0) = COALESCE(b.location_id, 0)
                WHERE b.qty_on_hand <> 0 AND it2.costing_method IN ('AVG', 'STANDARD')
            )
            SELECT
                r.qty, r.unit_cost, r.value, r.lot_no, r.serial_no, r.age_days, r.no_movement_days,
                it.id AS item_id, it.item_code, it.item_name_th, it.item_name_en, it.costing_method,
                it.is_lot_tracked, it.is_serial_tracked,
                cat.id AS category_id, cat.category_code, cat.category_name_th, cat.category_name_en,
                w.id AS warehouse_id, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                loc.id AS location_id, loc.location_code, loc.location_name,
                loc.parent_id AS location_parent_id, loc.level AS location_level,
                u.uom_code, u.uom_name_th, u.uom_name_en
            FROM rows r
            JOIN im_item it                ON it.id = r.item_id
            LEFT JOIN im_item_category cat ON cat.id = it.category_id
            JOIN im_warehouse w             ON w.id = r.warehouse_id
            LEFT JOIN im_location loc       ON loc.id = r.location_id
            LEFT JOIN im_uom u              ON u.id = it.base_uom_id
            WHERE 1=1
              ${itemFilter}
              ${warehouseFilter}
              ${locationFilter}
            ORDER BY ${orderBy}
        `;

        const result = await client.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error('IM Stock Aging Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getStockAgingReport };
