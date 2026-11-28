// controllers/im/imItemCategoryToolsController.js
// เครื่องมือของหน้าจอหมวดหมู่สินค้า (user 2026-11-25):
//   - usageCounts: จำนวนสินค้าต่อหมวด (ตรง) — ใช้กับ GET im_item_category?with_usage=1 (หน้าจอรวมยอดหมวดย่อยเอง)
//   - GET /im_item_category/:id/summary  สินค้าในหมวด (รวมหมวดย่อย), มูลค่า, หมวดย่อย, ตำแหน่งที่กำหนดหมวดนี้,
//     รายการสินค้า 50 แรก และบัญชีที่ใช้เมื่อหมวดเว้นว่าง (ประเภทเอกสาร/ค่าเริ่มต้นบริษัท) — id 0 = เฉพาะบัญชีตั้งต้น
//   - PUT /im_item_category/:id/move { parent_id }  ย้ายไปอยู่ใต้หมวดอื่น (ลากบนต้นไม้) + คำนวณ level ทั้งกิ่งใหม่
'use strict';

const { fetchGlSources } = require('./imItemSummaryController');

const tableExists = async (client, name) =>
    !!(await client.query(`SELECT to_regclass($1) AS t`, [`public.${name}`])).rows[0].t;

const usageCounts = async (client) => {
    if (!(await tableExists(client, 'im_item'))) return {};
    const r = await client.query(`SELECT category_id, COUNT(*)::int AS n FROM im_item WHERE category_id IS NOT NULL GROUP BY category_id`);
    return Object.fromEntries(r.rows.map(x => [x.category_id, x.n]));
};

// id ของหมวดนี้ + หมวดย่อยทุกระดับ
const subtreeIds = async (client, id) => (await client.query(`
    WITH RECURSIVE t AS (SELECT id FROM im_item_category WHERE id = $1
                         UNION ALL SELECT c.id FROM im_item_category c JOIN t ON c.parent_id = t.id)
    SELECT id FROM t`, [id])).rows.map(r => r.id);

// GET /im_item_category/:id/summary
const fetchSummary = async (req, res) => {
    const id = Number(req.params.id) || 0;
    const client = await req.dbPool.connect();
    try {
        const glDefaults = (await fetchGlSources(client, 0)).map(g => ({ key: g.key, doc_type: g.doc_type, company_account: g.company_account }));
        if (!id) return res.status(200).json({ gl_defaults: glDefaults });
        const cat = (await client.query(`SELECT id FROM im_item_category WHERE id = $1`, [id])).rows[0];
        if (!cat) return res.status(404).json({ message: 'ไม่พบหมวดหมู่สินค้า' });
        const ids = await subtreeIds(client, id);
        const childCount = (await client.query(`SELECT COUNT(*)::int AS n FROM im_item_category WHERE parent_id = $1`, [id])).rows[0].n;

        let active = 0, inactive = 0, value = 0, items = [];
        if (await tableExists(client, 'im_item')) {
            const c = (await client.query(`
                SELECT COUNT(*) FILTER (WHERE is_active)::int AS a, COUNT(*) FILTER (WHERE NOT is_active)::int AS i
                  FROM im_item WHERE category_id = ANY($1::int[])`, [ids])).rows[0];
            active = c.a; inactive = c.i;
            const hasBal = await tableExists(client, 'im_stock_balance');
            if (hasBal) {
                value = Number((await client.query(`
                    SELECT COALESCE(SUM(b.total_value), 0) AS v FROM im_stock_balance b JOIN im_item i ON i.id = b.item_id
                     WHERE i.category_id = ANY($1::int[])`, [ids])).rows[0].v);
            }
            items = (await client.query(`
                SELECT i.id, i.item_code, i.item_name_th, i.item_name_en, i.item_type, i.is_active,
                       u.uom_code, u.uom_name_th, u.uom_name_en, cat.category_code,
                       ${hasBal ? '(SELECT COALESCE(SUM(qty_on_hand), 0) FROM im_stock_balance b WHERE b.item_id = i.id)' : '0'} AS on_hand
                  FROM im_item i
                  LEFT JOIN im_uom u ON u.id = i.base_uom_id
                  LEFT JOIN im_item_category cat ON cat.id = i.category_id
                 WHERE i.category_id = ANY($1::int[])
                 ORDER BY i.item_code LIMIT 50`, [ids])).rows.map(x => ({ ...x, on_hand: Number(x.on_hand) }));
        }

        let locations = [];
        if (await tableExists(client, 'im_location')) {
            locations = (await client.query(`
                SELECT w.warehouse_code, l.location_code, l.location_name
                  FROM im_location l JOIN im_warehouse w ON w.id = l.warehouse_id
                 WHERE l.category_id = $1 ORDER BY w.warehouse_code, l.location_code`, [id])).rows;
        }

        res.status(200).json({
            item_count: active + inactive, active_count: active, inactive_count: inactive,
            stock_value: value, child_count: childCount, locations, items, gl_defaults: glDefaults,
        });
    } catch (error) {
        console.error('Error fetching im_item_category summary:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// PUT /im_item_category/:id/move  { parent_id: null | id }
const moveNode = async (req, res) => {
    const id = Number(req.params.id);
    const parentId = req.body?.parent_id ? Number(req.body.parent_id) : null;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const node = (await client.query(`SELECT id, parent_id FROM im_item_category WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!node) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบหมวดหมู่สินค้า' }); }
        let level = 1;
        if (parentId) {
            const ids = await subtreeIds(client, id);
            if (ids.includes(parentId)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'ย้ายไปอยู่ใต้หมวดของตัวเองหรือหมวดย่อยของตัวเองไม่ได้' });
            }
            const p = (await client.query(`SELECT level FROM im_item_category WHERE id = $1`, [parentId])).rows[0];
            if (!p) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ไม่พบหมวดหมู่ปลายทาง' }); }
            level = Number(p.level) + 1;
        }
        await client.query(`UPDATE im_item_category SET parent_id = $1, level = $2, updated_by = $3, updated_at = NOW() WHERE id = $4`,
            [parentId, level, userName, id]);
        // level ของหมวดย่อยทุกระดับ = level ของแม่ + 1
        await client.query(`
            WITH RECURSIVE t AS (
                SELECT id, level::int AS level FROM im_item_category WHERE id = $1
                UNION ALL
                SELECT c.id, t.level + 1 FROM im_item_category c JOIN t ON c.parent_id = t.id
            )
            UPDATE im_item_category c SET level = t.level FROM t WHERE c.id = t.id AND c.level <> t.level`, [id]);
        await client.query('COMMIT');
        res.status(200).json({ id, parent_id: parentId, level });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error moving im_item_category:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { usageCounts, fetchSummary, moveNode };
