// controllers/im/imItemSummaryController.js
// สรุปของสินค้าสำหรับหน้าจอข้อมูลสินค้า (user 2026-11-25 แบบ B): ยอดคงเหลือ/มูลค่าทุกคลัง, คลังที่ต่ำกว่าจุดสั่งซื้อ,
// เคลื่อนไหวล่าสุด, คงเหลือต่อคลัง และบัญชี GL ที่ใช้จริงพร้อมแหล่งที่มา (สินค้า → หมวดสินค้า → ประเภทเอกสาร → ค่าเริ่มต้นบริษัท)
// อ่านอย่างเดียว — ตารางที่ยังไม่ถูกสร้าง (ฐานข้อมูลใหม่) ถือว่าไม่มีข้อมูล ไม่สร้างตารางให้
'use strict';

const tableExists = async (client, name) =>
    !!(await client.query(`SELECT to_regclass($1) AS t`, [`public.${name}`])).rows[0].t;

// สต็อกต่อคลัง: คลังที่มียอดหรือมีการตั้งค่าต่อคลัง — จุดสั่งซื้อ/ขั้นต่ำ/สูงสุดใช้ของคลังถ้าตั้งไว้ ไม่งั้นว่าง
// (ค่าระดับสินค้าเทียบกับยอดรวมทุกคลังแทน ดู below_item_level)
const fetchWarehouseStock = async (client, itemId) => {
    const hasBal = await tableExists(client, 'im_stock_balance');
    const hasIw = await tableExists(client, 'im_item_warehouse');
    if (!hasBal && !hasIw) return [];
    const bal = hasBal
        ? `SELECT warehouse_id, SUM(qty_on_hand) AS qty, SUM(total_value) AS value
             FROM im_stock_balance WHERE item_id = $1 GROUP BY warehouse_id`
        : `SELECT NULL::int AS warehouse_id, 0::numeric AS qty, 0::numeric AS value WHERE false`;
    const iw = hasIw
        ? `SELECT warehouse_id, min_stock_qty, max_stock_qty, reorder_point, default_location_id
             FROM im_item_warehouse WHERE item_id = $1`
        : `SELECT NULL::int AS warehouse_id, NULL::numeric AS min_stock_qty, NULL::numeric AS max_stock_qty,
                  NULL::numeric AS reorder_point, NULL::int AS default_location_id WHERE false`;
    const r = await client.query(`
        WITH b AS (${bal}), s AS (${iw}),
             k AS (SELECT warehouse_id FROM b UNION SELECT warehouse_id FROM s)
        SELECT k.warehouse_id, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
               COALESCE(b.qty, 0) AS qty, COALESCE(b.value, 0) AS value,
               (s.warehouse_id IS NOT NULL) AS has_setting,
               s.min_stock_qty, s.max_stock_qty, s.reorder_point,
               l.location_code AS default_location_code
          FROM k
          JOIN im_warehouse w ON w.id = k.warehouse_id
          LEFT JOIN b ON b.warehouse_id = k.warehouse_id
          LEFT JOIN s ON s.warehouse_id = k.warehouse_id
          LEFT JOIN im_location l ON l.id = s.default_location_id
         ORDER BY w.warehouse_code`, [itemId]);
    return r.rows.map(x => {
        const qty = Number(x.qty), reorder = Number(x.reorder_point || 0);
        return {
            warehouse_id: x.warehouse_id, warehouse_code: x.warehouse_code,
            warehouse_name_th: x.warehouse_name_th, warehouse_name_en: x.warehouse_name_en,
            qty, value: Number(x.value), has_setting: x.has_setting,
            min_stock_qty: x.min_stock_qty == null ? null : Number(x.min_stock_qty),
            max_stock_qty: x.max_stock_qty == null ? null : Number(x.max_stock_qty),
            reorder_point: x.reorder_point == null ? null : reorder,
            default_location_code: x.default_location_code,
            below_reorder: reorder > 0 && qty < reorder,
        };
    });
};

const fetchLastMovement = async (client, itemId) => {
    if (!(await tableExists(client, 'im_transaction_detail'))) return null;
    const r = await client.query(`
        SELECT t.doc_date, t.doc_no, t.doc_code, d.qty, w.warehouse_code
          FROM im_transaction_detail d
          JOIN im_transaction t ON t.id = d.header_id
          LEFT JOIN im_warehouse w ON w.id = t.warehouse_id
         WHERE d.item_id = $1 AND t.status IN ('Posted', 'Received')
         ORDER BY t.doc_date DESC, t.id DESC
         LIMIT 1`, [itemId]);
    if (!r.rows[0]) return null;
    const x = r.rows[0];
    const dt = x.doc_date instanceof Date
        ? `${x.doc_date.getFullYear()}-${String(x.doc_date.getMonth() + 1).padStart(2, '0')}-${String(x.doc_date.getDate()).padStart(2, '0')}`
        : String(x.doc_date).slice(0, 10);
    return { doc_date: dt, doc_no: x.doc_no, doc_code: x.doc_code, qty: Number(x.qty || 0), warehouse_code: x.warehouse_code };
};

const accountInfo = async (client, ids) => {
    const list = [...new Set(ids.filter(n => Number(n) > 0).map(Number))];
    if (!list.length) return {};
    const r = await client.query(
        `SELECT id, account_code, account_name_thai, account_name_eng FROM gl_account WHERE id = ANY($1::int[])`, [list]);
    return Object.fromEntries(r.rows.map(a => [a.id, a]));
};

// บัญชีแต่ละชั้นต่อชนิด — ลำดับเดียวกับ imTransactionController (fetchItemAccountRow/resolve*):
// สต็อก/ต้นทุนขาย: สินค้า → หมวด → ค่าตั้งต้นประเภทเอกสาร IM → ค่าเริ่มต้นบริษัท
// รายได้: สินค้า → หมวด → ค่าตั้งต้นประเภทเอกสาร AR; ซื้อสินค้า (Periodic): สินค้า → หมวด → ค่าเริ่มต้นบริษัท
// ค่าใช้จ่าย: สินค้า → หมวด (ยังไม่ใช้ลงบัญชี); บัญชีสต็อก/ซื้อสินค้าที่ตั้งที่คลังจะใช้ก่อนเสมอ (warehouse_override)
// ส่งทุกชั้นแยกกัน ให้หน้าจอคำนวณ "มาจาก" ใหม่ได้ทันทีเมื่อผู้ใช้แก้บัญชี/เปลี่ยนหมวดก่อนบันทึก; itemId = 0 → เฉพาะค่าตั้งต้น
const fetchGlSources = async (client, itemId) => {
    const it = itemId ? (await client.query(`
        SELECT i.inventory_account_id AS i_inv, i.cogs_account_id AS i_cogs, i.revenue_account_id AS i_rev,
               i.expense_account_id AS i_exp, i.purchases_account_id AS i_pur,
               c.inventory_account_id AS c_inv, c.cogs_account_id AS c_cogs, c.revenue_account_id AS c_rev,
               c.expense_account_id AS c_exp, c.purchases_account_id AS c_pur
          FROM im_item i LEFT JOIN im_item_category c ON c.id = i.category_id
         WHERE i.id = $1`, [itemId])).rows[0] || {} : {};

    const company = (await tableExists(client, 'im_accounting_setting'))
        ? (await client.query(`SELECT inventory_account_id, cogs_account_id, purchases_account_id FROM im_accounting_setting ORDER BY id LIMIT 1`)).rows[0] || {}
        : {};
    const docTypeHas = async (table, col) => (await tableExists(client, table))
        ? (await client.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} IS NOT NULL`)).rows[0].n > 0
        : false;

    // คลังที่ตั้งบัญชีสต็อก/ซื้อสินค้าเอง (เฉพาะคลังที่สินค้านี้มียอดหรือมีการตั้งค่า)
    const whOverride = async (col) => {
        if (!itemId) return [];
        const parts = [];
        if (await tableExists(client, 'im_stock_balance')) parts.push(`SELECT warehouse_id FROM im_stock_balance WHERE item_id = $1`);
        if (await tableExists(client, 'im_item_warehouse')) parts.push(`SELECT warehouse_id FROM im_item_warehouse WHERE item_id = $1`);
        if (!parts.length) return [];
        const hasCol = (await client.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'im_warehouse' AND column_name = $1`, [col])).rows.length > 0;
        if (!hasCol) return [];
        const r = await client.query(`
            SELECT DISTINCT w.warehouse_code FROM im_warehouse w
             WHERE w.${col} IS NOT NULL AND w.id IN (${parts.join(' UNION ')})
             ORDER BY w.warehouse_code`, [itemId]);
        return r.rows.map(x => x.warehouse_code);
    };

    const rows = [
        { key: 'inventory', item: it.i_inv, category: it.c_inv, doc_type: await docTypeHas('im_gl_account_setup', 'inventory_account_id'), company: company.inventory_account_id, warehouse_override: await whOverride('inventory_account_id') },
        { key: 'cogs', item: it.i_cogs, category: it.c_cogs, doc_type: await docTypeHas('im_gl_account_setup', 'cogs_account_id'), company: company.cogs_account_id, warehouse_override: [] },
        { key: 'revenue', item: it.i_rev, category: it.c_rev, doc_type: await docTypeHas('ar_gl_account_setup', 'revenue_account_id'), company: null, warehouse_override: [] },
        { key: 'purchases', item: it.i_pur, category: it.c_pur, doc_type: false, company: company.purchases_account_id, warehouse_override: await whOverride('purchases_account_id') },
        { key: 'expense', item: it.i_exp, category: it.c_exp, doc_type: false, company: null, warehouse_override: [] },
    ];
    const acc = await accountInfo(client, rows.flatMap(r => [r.item, r.category, r.company]));
    const info = (id) => {
        const a = acc[Number(id)];
        return a ? { account_id: a.id, account_code: a.account_code, account_name_thai: a.account_name_thai, account_name_eng: a.account_name_eng } : null;
    };
    return rows.map(r => ({
        key: r.key,
        item_account: info(r.item),
        category_account: info(r.category),
        doc_type: r.doc_type,
        company_account: info(r.company),
        warehouse_override: r.warehouse_override,
    }));
};

// GET /im_item/:id/summary
const fetchSummary = async (req, res) => {
    const itemId = Number(req.params.id) || 0; // 0 = สินค้าใหม่ (ยังไม่บันทึก) — ส่งเฉพาะค่าตั้งต้นบัญชี
    const client = await req.dbPool.connect();
    try {
        if (!itemId) return res.status(200).json({ total_qty: 0, total_value: 0, avg_cost: 0, warehouse_count: 0, below_warehouses: [],
            below_item_level: false, item_reorder_point: 0, last_movement: null, warehouses: [], gl: await fetchGlSources(client, 0) });
        const item = (await client.query(`SELECT reorder_point FROM im_item WHERE id = $1`, [itemId])).rows[0];
        if (!item) return res.status(404).json({ message: 'ไม่พบสินค้า' });
        const warehouses = await fetchWarehouseStock(client, itemId);
        const totalQty = warehouses.reduce((s, w) => s + w.qty, 0);
        const totalValue = warehouses.reduce((s, w) => s + w.value, 0);
        const itemReorder = Number(item.reorder_point || 0);
        // จุดสั่งซื้อระดับสินค้าเทียบกับยอดรวมทุกคลัง (คลังที่ตั้งจุดสั่งซื้อเองเทียบรายคลัง)
        const belowItemLevel = itemReorder > 0 && totalQty < itemReorder;
        res.status(200).json({
            total_qty: totalQty,
            total_value: totalValue,
            avg_cost: totalQty !== 0 ? totalValue / totalQty : 0,
            warehouse_count: warehouses.filter(w => w.qty !== 0).length,
            below_warehouses: warehouses.filter(w => w.below_reorder).map(w => ({
                warehouse_code: w.warehouse_code, qty: w.qty, reorder_point: w.reorder_point })),
            below_item_level: belowItemLevel,
            item_reorder_point: itemReorder,
            last_movement: await fetchLastMovement(client, itemId),
            warehouses,
            gl: await fetchGlSources(client, itemId),
        });
    } catch (error) {
        console.error('Error fetching im_item summary:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchSummary, fetchGlSources };
