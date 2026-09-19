// controllers/po/poReplenishmentController.js — ใบแนะนำสั่งซื้อเพื่อเติมสต็อก (Purchase Replenishment Suggestion)
// อ่านอย่างเดียว ไม่เขียนอะไรเลย — ใช้ min_stock_qty/max_stock_qty/reorder_point ที่มีอยู่แล้วใน im_item/
// im_item_warehouse (เดิมไม่เคยถูกใช้คำนวณอะไรเลย) ผสมกับยอดขายจริงจาก DLN ('30'/'31'/'32') ในช่วงย้อนหลังที่เลือก
// เพื่อประมาณจำนวนที่ต้องสั่งให้พอสำหรับช่วงเวลาข้างหน้าที่เลือก — สูตรและเหตุผลแต่ละขั้นดู plan ตอนออกแบบ
'use strict';

const fetchSuggestions = async (req, res) => {
    const { warehouse_id, as_of, lookback_days, coverage_days, category_id } = req.query;
    if (!warehouse_id) return res.status(400).json({ message: 'กรุณาระบุคลังสินค้า' });

    const warehouseId = parseInt(warehouse_id, 10);
    const asOf = as_of || new Date().toISOString().slice(0, 10);
    const lookbackDays = Math.max(parseInt(lookback_days, 10) || 90, 1);
    const coverageDays = Math.max(parseInt(coverage_days, 10) || 30, 1);
    const categoryId = category_id ? parseInt(category_id, 10) : null;

    const client = await req.dbPool.connect();
    try {
        const params = [warehouseId, asOf, lookbackDays];
        let categoryFilter = '';
        if (categoryId) {
            params.push(categoryId);
            categoryFilter = ` AND i.category_id = $${params.length}`;
        }

        const result = await client.query(`
            WITH item_policy AS (
                SELECT i.id AS item_id, i.item_code, i.item_name_th, i.item_name_en, i.base_uom_id,
                       u.uom_code,
                       COALESCE(iw.reorder_point, i.reorder_point) AS reorder_point,
                       COALESCE(iw.max_stock_qty, i.max_stock_qty) AS max_stock_qty
                FROM im_item i
                LEFT JOIN im_item_warehouse iw ON iw.item_id = i.id AND iw.warehouse_id = $1
                LEFT JOIN im_uom u ON u.id = i.base_uom_id
                WHERE i.is_active = true AND i.is_purchase_item = true ${categoryFilter}
            ),
            on_hand AS (
                SELECT item_id, SUM(qty_on_hand) AS qty
                FROM im_stock_balance WHERE warehouse_id = $1 GROUP BY item_id
            ),
            -- จำนวนคงเหลือที่ยังไม่รับของ PO ที่ Approved/PartiallyReceived ต่อ item (รวมทุกผู้ขาย) — มิเรอร์
            -- fetchReceivableLines ใน poTransactionController.js ทุกประการ ต่างกันแค่ group by item_id แทน vendor
            incoming AS (
                SELECT pod.item_id, SUM(
                    pod.qty_ordered - COALESCE((
                        SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                        JOIN im_transaction imt ON imt.id = imd.header_id
                        WHERE imd.ref_po_detail_id = pod.id AND imt.status IN ('Posted', 'Received')
                    ), 0)
                ) AS qty
                FROM po_transaction_detail pod
                JOIN po_transaction po ON po.id = pod.header_id
                WHERE po.status IN ('Approved', 'PartiallyReceived')
                GROUP BY pod.item_id
            ),
            sales AS (
                SELECT dt.item_id, SUM(ABS(dt.qty)) AS total_sold
                FROM im_transaction_detail dt
                JOIN im_transaction t ON t.id = dt.header_id
                JOIN sa_module_document d ON d.id = t.doc_id
                WHERE d.sys_doc_type IN ('30', '31', '32')
                  AND t.status IN ('Posted', 'Delivered')
                  AND t.warehouse_id = $1
                  AND t.doc_date > ($2::date - $3::integer) AND t.doc_date <= $2::date
                GROUP BY dt.item_id
            )
            SELECT p.item_id, p.item_code, p.item_name_th, p.item_name_en, p.uom_code,
                   p.reorder_point, p.max_stock_qty,
                   COALESCE(oh.qty, 0) AS on_hand,
                   COALESCE(inc.qty, 0) AS incoming,
                   COALESCE(s.total_sold, 0) AS total_sold_in_lookback
            FROM item_policy p
            LEFT JOIN on_hand  oh  ON oh.item_id  = p.item_id
            LEFT JOIN incoming inc ON inc.item_id = p.item_id
            LEFT JOIN sales    s   ON s.item_id   = p.item_id
        `, params);

        // สูตรแนะนำจำนวนสั่งซื้อ — ผสม reorder_point/max_stock_qty (นโยบายที่ตั้งไว้ในข้อมูลหลักสินค้า) กับยอดขาย
        // เฉลี่ย/วันจริงจาก DLN คูณช่วงเวลาที่ต้องการให้พอ (coverage_days) — ดูรายละเอียดสูตรใน plan
        const suggestions = [];
        for (const r of result.rows) {
            const reorderPoint = Number(r.reorder_point) || 0;
            const maxStockQty = Number(r.max_stock_qty) || 0;
            const onHand = Number(r.on_hand) || 0;
            const incoming = Number(r.incoming) || 0;
            const avgDailySales = (Number(r.total_sold_in_lookback) || 0) / lookbackDays;
            const projectedDemand = avgDailySales * coverageDays;
            const available = onHand + incoming;
            const targetLevel = maxStockQty > 0
                ? Math.max(maxStockQty, reorderPoint + projectedDemand)
                : reorderPoint + projectedDemand;
            const needsReorder = available <= reorderPoint || available < projectedDemand;
            const suggestedQty = Math.max(targetLevel - available, 0);
            if (!needsReorder || suggestedQty <= 0.0001) continue;
            suggestions.push({
                item_id: r.item_id, item_code: r.item_code, item_name_th: r.item_name_th, item_name_en: r.item_name_en,
                uom_id: r.base_uom_id, uom_code: r.uom_code,
                on_hand: onHand, incoming, avg_daily_sales: avgDailySales, projected_demand: projectedDemand,
                reorder_point: reorderPoint, max_stock_qty: maxStockQty, suggested_qty: suggestedQty,
                vendor_id: null, vendor_code: null, vendor_name_th: null, last_price: null, last_purchase_date: null,
            });
        }

        // เติมผู้ขาย+ราคาที่เคยสั่งซื้อล่าสุด (จากประวัติ PO จริง ไม่ใช่ im_price_list) ให้เฉพาะรายการที่แนะนำให้สั่งซื้อ
        // เท่านั้น — มิเรอร์ fetchReceivableLines ที่ query ครั้งเดียวด้วย item_id = ANY(...) แทนการ query ทีละแถว
        if (suggestions.length > 0) {
            const itemIds = suggestions.map(s => s.item_id);
            const vendorRes = await client.query(`
                SELECT DISTINCT ON (pod.item_id)
                    pod.item_id, po.vendor_id, po.vendor_code, po.vendor_name_th, pod.unit_price_fc, po.doc_date
                FROM po_transaction_detail pod
                JOIN po_transaction po ON po.id = pod.header_id
                WHERE pod.item_id = ANY($1::int[]) AND po.status <> 'Void'
                ORDER BY pod.item_id, po.doc_date DESC, po.id DESC
            `, [itemIds]);
            const byItem = new Map(vendorRes.rows.map(v => [v.item_id, v]));
            for (const s of suggestions) {
                const v = byItem.get(s.item_id);
                if (v) {
                    s.vendor_id = v.vendor_id;
                    s.vendor_code = v.vendor_code;
                    s.vendor_name_th = v.vendor_name_th;
                    s.last_price = v.unit_price_fc;
                    s.last_purchase_date = v.doc_date;
                }
            }
        }

        suggestions.sort((a, b) => a.item_code.localeCompare(b.item_code));
        res.status(200).json(suggestions);
    } catch (error) {
        console.error('Error fetching po_replenishment suggestions:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchSuggestions };
