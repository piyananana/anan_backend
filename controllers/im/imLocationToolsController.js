// controllers/im/imLocationToolsController.js
// เครื่องมือของหน้าจอตำแหน่งจัดเก็บ (user 2026-11-25):
//   - usageCounts(warehouseId): ต่อตำแหน่ง — สินค้าที่มียอดในช่องนั้น, สินค้าที่ตั้งเป็นตำแหน่งเริ่มต้น (ใช้กับ ?with_usage=1)
//   - GET /im_location/:id/summary  ตัวเลขสรุป + สินค้าในตำแหน่ง (ยอดแยกล็อต + สินค้าที่ตั้งเป็นตำแหน่งเริ่มต้น)
//     + ตำแหน่งย่อย (เมื่อเป็นกลุ่ม) — ยอดของกลุ่ม = รวมช่องเก็บทุกระดับใต้กลุ่ม
//   - PUT /im_location/:id/move { parent_id }  ย้ายไปอยู่ใต้กลุ่มอื่นในคลังเดียวกัน (null = ระดับบนสุด) + คำนวณ level ใหม่ทั้งกิ่ง
'use strict';

const tableExists = async (client, name) =>
    !!(await client.query(`SELECT to_regclass($1) AS t`, [`public.${name}`])).rows[0].t;

const subtreeIds = async (client, id) => (await client.query(`
    WITH RECURSIVE t AS (SELECT id FROM im_location WHERE id = $1
                         UNION ALL SELECT c.id FROM im_location c JOIN t ON c.parent_id = t.id)
    SELECT id FROM t`, [id])).rows.map(r => r.id);

const usageCounts = async (client, warehouseId) => {
    const out = {};
    const bump = (id, k, n) => { (out[id] ||= { item_count: 0, default_count: 0 })[k] = n; };
    const wh = warehouseId ? 'AND warehouse_id = $1' : '';
    const params = warehouseId ? [warehouseId] : [];
    if (await tableExists(client, 'im_stock_balance')) {
        const r = await client.query(`
            SELECT location_id, COUNT(DISTINCT item_id)::int AS n FROM im_stock_balance
             WHERE location_id IS NOT NULL AND qty_on_hand <> 0 ${wh} GROUP BY location_id`, params);
        for (const x of r.rows) bump(x.location_id, 'item_count', x.n);
    }
    if (await tableExists(client, 'im_item_warehouse')) {
        const r = await client.query(`
            SELECT default_location_id, COUNT(*)::int AS n FROM im_item_warehouse
             WHERE default_location_id IS NOT NULL ${wh} GROUP BY default_location_id`, params);
        for (const x of r.rows) bump(x.default_location_id, 'default_count', x.n);
    }
    return out;
};

// GET /im_location/:id/summary
const fetchSummary = async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'location id ไม่ถูกต้อง' });
    const client = await req.dbPool.connect();
    try {
        const loc = (await client.query(`SELECT id, warehouse_id, location_type FROM im_location WHERE id = $1`, [id])).rows[0];
        if (!loc) return res.status(404).json({ message: 'ไม่พบตำแหน่งจัดเก็บ' });
        const ids = await subtreeIds(client, id);
        const binCount = (await client.query(
            `SELECT COUNT(*)::int AS n FROM im_location WHERE id = ANY($1::int[]) AND id <> $2 AND location_type = 'BIN'`, [ids, id])).rows[0].n;

        const hasBal = await tableExists(client, 'im_stock_balance');
        const hasIw = await tableExists(client, 'im_item_warehouse');
        let itemCount = 0, value = 0, defaultCount = 0;
        if (hasBal) {
            const r = (await client.query(`
                SELECT COUNT(DISTINCT item_id) FILTER (WHERE qty_on_hand <> 0)::int AS n, COALESCE(SUM(total_value), 0) AS v
                  FROM im_stock_balance WHERE location_id = ANY($1::int[])`, [ids])).rows[0];
            itemCount = r.n; value = Number(r.v);
        }
        if (hasIw) {
            defaultCount = (await client.query(
                `SELECT COUNT(*)::int AS n FROM im_item_warehouse WHERE default_location_id = ANY($1::int[])`, [ids])).rows[0].n;
        }

        // สินค้าในตำแหน่ง: ยอดคงเหลือแยกล็อต + สินค้าที่ตั้งเป็นตำแหน่งเริ่มต้น (ยังไม่มียอดก็แสดง) — สูงสุด 100 แถว
        const parts = [];
        if (hasBal) parts.push(`
            SELECT b.item_id, b.location_id, b.lot_no, b.qty_on_hand AS qty, b.total_value AS value
              FROM im_stock_balance b WHERE b.location_id = ANY($1::int[]) AND b.qty_on_hand <> 0`);
        if (hasIw) parts.push(`
            SELECT iw.item_id, iw.default_location_id, NULL, 0, 0
              FROM im_item_warehouse iw
             WHERE iw.default_location_id = ANY($1::int[])
               ${hasBal ? `AND NOT EXISTS (SELECT 1 FROM im_stock_balance b WHERE b.item_id = iw.item_id
                                 AND b.location_id = iw.default_location_id AND b.qty_on_hand <> 0)` : ''}`);
        let items = [];
        if (parts.length) {
            items = (await client.query(`
                SELECT x.item_id, i.item_code, i.item_name_th, i.item_name_en, u.uom_code, u.uom_name_th, u.uom_name_en,
                       l.location_code, x.lot_no, x.qty, x.value,
                       ${hasIw ? `EXISTS (SELECT 1 FROM im_item_warehouse iw WHERE iw.item_id = x.item_id AND iw.default_location_id = x.location_id)` : 'false'} AS is_default
                  FROM (${parts.join(' UNION ALL ')}) x
                  JOIN im_item i ON i.id = x.item_id
                  LEFT JOIN im_uom u ON u.id = i.base_uom_id
                  LEFT JOIN im_location l ON l.id = x.location_id
                 ORDER BY l.location_code, i.item_code, x.lot_no NULLS FIRST
                 LIMIT 100`, [ids])).rows.map(r => ({ ...r, qty: Number(r.qty), value: Number(r.value) }));
        }

        // ตำแหน่งย่อยระดับถัดไป (กลุ่ม)
        const counts = await usageCounts(client, loc.warehouse_id);
        const children = (await client.query(`
            SELECT l.id, l.location_code, l.location_name, l.location_name_en, l.location_type, l.sort_order, l.is_active,
                   c.category_code
              FROM im_location l LEFT JOIN im_item_category c ON c.id = l.category_id
             WHERE l.parent_id = $1
             ORDER BY COALESCE(l.sort_order, 999999), l.location_code`, [id])).rows
            .map(r => ({ ...r, item_count: counts[r.id]?.item_count || 0, default_count: counts[r.id]?.default_count || 0 }));

        res.status(200).json({ item_count: itemCount, stock_value: value, default_count: defaultCount, bin_count: binCount, items, children });
    } catch (error) {
        console.error('Error fetching im_location summary:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// PUT /im_location/:id/move  { parent_id: null | id }
const moveNode = async (req, res) => {
    const id = Number(req.params.id);
    const parentId = req.body?.parent_id ? Number(req.body.parent_id) : null;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const node = (await client.query(`SELECT id, warehouse_id FROM im_location WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!node) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบตำแหน่งจัดเก็บ' }); }
        let level = 1;
        if (parentId) {
            if ((await subtreeIds(client, id)).includes(parentId)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'ย้ายไปอยู่ใต้ตำแหน่งของตัวเองหรือตำแหน่งย่อยของตัวเองไม่ได้' });
            }
            const p = (await client.query(`SELECT level, warehouse_id, location_type FROM im_location WHERE id = $1`, [parentId])).rows[0];
            if (!p) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ไม่พบตำแหน่งปลายทาง' }); }
            if (Number(p.warehouse_id) !== Number(node.warehouse_id)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'ย้ายข้ามคลังไม่ได้' });
            }
            if (p.location_type !== 'GROUP') {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'ย้ายไปอยู่ใต้กลุ่ม (GROUP) ได้เท่านั้น' });
            }
            level = Number(p.level) + 1;
        }
        await client.query(`UPDATE im_location SET parent_id = $1, level = $2, updated_by = $3, updated_at = NOW() WHERE id = $4`,
            [parentId, level, userName, id]);
        await client.query(`
            WITH RECURSIVE t AS (
                SELECT id, level::int AS level FROM im_location WHERE id = $1
                UNION ALL
                SELECT c.id, t.level + 1 FROM im_location c JOIN t ON c.parent_id = t.id
            )
            UPDATE im_location c SET level = t.level FROM t WHERE c.id = t.id AND c.level <> t.level`, [id]);
        await client.query('COMMIT');
        res.status(200).json({ id, parent_id: parentId, level });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error moving im_location:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { usageCounts, fetchSummary, moveNode };
