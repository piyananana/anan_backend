// controllers/im/imWarehouseSummaryController.js
// สรุปคลังสินค้า สำหรับหน้าจอคลังสินค้า (user 2026-11-25): จำนวนสินค้าที่มียอด/ตั้งค่าไว้, มูลค่า, สินค้าต่ำกว่าจุดสั่งซื้อ
// (เทียบกับจุดสั่งซื้อที่ตั้งต่อคลัง), เคลื่อนไหวล่าสุด, สรุปโซน และสินค้าในคลังเรียงตามมูลค่า — อ่านอย่างเดียว
'use strict';

const tableExists = async (client, name) =>
    !!(await client.query(`SELECT to_regclass($1) AS t`, [`public.${name}`])).rows[0].t;

const ymd = (d) => d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);

// ยอดต่อ (คลัง, สินค้า) + การตั้งค่าต่อคลัง — CTE ใช้ร่วมกันทั้งการ์ดรายการและหน้ารายละเอียด
const stockCte = async (client) => {
    const hasBal = await tableExists(client, 'im_stock_balance');
    const hasIw = await tableExists(client, 'im_item_warehouse');
    const bal = hasBal
        ? `SELECT warehouse_id, item_id, SUM(qty_on_hand) AS qty, SUM(total_value) AS value FROM im_stock_balance GROUP BY warehouse_id, item_id`
        : `SELECT NULL::int AS warehouse_id, NULL::int AS item_id, 0::numeric AS qty, 0::numeric AS value WHERE false`;
    const iw = hasIw
        ? `SELECT warehouse_id, item_id, reorder_point, max_stock_qty FROM im_item_warehouse`
        : `SELECT NULL::int AS warehouse_id, NULL::int AS item_id, 0::numeric AS reorder_point, 0::numeric AS max_stock_qty WHERE false`;
    return `b AS (${bal}), s AS (${iw}),
            k AS (SELECT warehouse_id, item_id FROM b UNION SELECT warehouse_id, item_id FROM s),
            ws AS (SELECT k.warehouse_id, k.item_id, COALESCE(b.qty, 0) AS qty, COALESCE(b.value, 0) AS value,
                          s.reorder_point, s.max_stock_qty, (s.item_id IS NOT NULL) AS has_setting
                     FROM k LEFT JOIN b ON b.warehouse_id = k.warehouse_id AND b.item_id = k.item_id
                            LEFT JOIN s ON s.warehouse_id = k.warehouse_id AND s.item_id = k.item_id)`;
};

// จำนวนต่อคลัง: สินค้ามียอด, มูลค่า, ต่ำกว่าจุดสั่งซื้อ
const warehouseTotals = async (client, warehouseId = null) => {
    const r = await client.query(`
        WITH ${await stockCte(client)}
        SELECT warehouse_id,
               COUNT(*) FILTER (WHERE qty <> 0)::int AS item_count,
               COUNT(*) FILTER (WHERE has_setting)::int AS setting_count,
               COALESCE(SUM(value), 0) AS total_value,
               COUNT(*) FILTER (WHERE reorder_point > 0 AND qty < reorder_point)::int AS below_count
          FROM ws ${warehouseId ? 'WHERE warehouse_id = $1' : ''}
         GROUP BY warehouse_id`, warehouseId ? [warehouseId] : []);
    return Object.fromEntries(r.rows.map(x => [x.warehouse_id, {
        item_count: x.item_count, setting_count: x.setting_count, total_value: Number(x.total_value), below_count: x.below_count,
    }]));
};

// GET /im_warehouse/:id/summary
const fetchSummary = async (req, res) => {
    const whId = Number(req.params.id);
    if (!whId) return res.status(400).json({ message: 'warehouse id ไม่ถูกต้อง' });
    const client = await req.dbPool.connect();
    try {
        const wh = (await client.query(`SELECT id FROM im_warehouse WHERE id = $1`, [whId])).rows[0];
        if (!wh) return res.status(404).json({ message: 'ไม่พบคลังสินค้า' });
        const t = (await warehouseTotals(client, whId))[whId] || { item_count: 0, setting_count: 0, total_value: 0, below_count: 0 };

        let lastMovement = null;
        if (await tableExists(client, 'im_transaction')) {
            const r = await client.query(`
                SELECT doc_date, doc_no, doc_code FROM im_transaction
                 WHERE (warehouse_id = $1 OR to_warehouse_id = $1) AND status IN ('Posted', 'Received')
                 ORDER BY doc_date DESC, id DESC LIMIT 1`, [whId]);
            if (r.rows[0]) lastMovement = { doc_date: ymd(r.rows[0].doc_date), doc_no: r.rows[0].doc_no, doc_code: r.rows[0].doc_code };
        }

        // โซน = ตำแหน่งระดับบนสุดของคลัง: จำนวนช่องเก็บ (BIN) ใต้โซน, หมวดที่กำหนด, สินค้าที่ตั้งเป็นตำแหน่งเริ่มต้นในโซน
        let zones = [];
        let binCount = 0;
        if (await tableExists(client, 'im_location')) {
            const hasIw = await tableExists(client, 'im_item_warehouse');
            const r = await client.query(`
                WITH RECURSIVE t AS (
                    SELECT id, id AS root_id, location_type FROM im_location WHERE warehouse_id = $1 AND parent_id IS NULL
                    UNION ALL
                    SELECT c.id, t.root_id, c.location_type FROM im_location c JOIN t ON c.parent_id = t.id
                )
                SELECT z.id, z.location_code, z.location_name, z.location_name_en, z.location_type, z.is_active,
                       cat.category_code,
                       (SELECT COUNT(*) FROM t WHERE t.root_id = z.id AND t.location_type = 'BIN')::int AS bin_count,
                       ${hasIw ? `(SELECT COUNT(*) FROM im_item_warehouse iw WHERE iw.warehouse_id = $1
                                    AND iw.default_location_id IN (SELECT id FROM t WHERE t.root_id = z.id))::int` : '0'} AS default_item_count
                  FROM im_location z
                  LEFT JOIN im_item_category cat ON cat.id = z.category_id
                 WHERE z.warehouse_id = $1 AND z.parent_id IS NULL
                 ORDER BY COALESCE(z.sort_order, 999999), z.location_code`, [whId]);
            zones = r.rows;
            binCount = (await client.query(
                `SELECT COUNT(*)::int AS n FROM im_location WHERE warehouse_id = $1 AND location_type = 'BIN'`, [whId])).rows[0].n;
        }

        // สินค้าในคลัง เรียงตามมูลค่า (สูงสุด 50) — ?below=1 = เฉพาะต่ำกว่าจุดสั่งซื้อ
        const below = ['1', 'true'].includes(String(req.query.below || ''));
        const items = (await client.query(`
            WITH ${await stockCte(client)}
            SELECT ws.item_id, i.item_code, i.item_name_th, i.item_name_en, u.uom_code, u.uom_name_th, u.uom_name_en,
                   ws.qty, ws.value, ws.reorder_point, ws.max_stock_qty,
                   (ws.reorder_point > 0 AND ws.qty < ws.reorder_point) AS below_reorder
              FROM ws JOIN im_item i ON i.id = ws.item_id
              LEFT JOIN im_uom u ON u.id = i.base_uom_id
             WHERE ws.warehouse_id = $1 AND (ws.qty <> 0 OR ws.has_setting)
               ${below ? 'AND ws.reorder_point > 0 AND ws.qty < ws.reorder_point' : ''}
             ORDER BY ws.value DESC, i.item_code
             LIMIT 50`, [whId])).rows.map(x => ({
                ...x, qty: Number(x.qty), value: Number(x.value),
                reorder_point: x.reorder_point == null ? null : Number(x.reorder_point),
                max_stock_qty: x.max_stock_qty == null ? null : Number(x.max_stock_qty),
            }));

        res.status(200).json({
            ...t,
            last_movement: lastMovement,
            zone_count: zones.length,
            bin_count: binCount,
            zones,
            items,
        });
    } catch (error) {
        console.error('Error fetching im_warehouse summary:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchSummary, warehouseTotals };
