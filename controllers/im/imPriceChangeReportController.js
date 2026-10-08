// controllers/im/imPriceChangeReportController.js
// รายงานตรวจเช็คการเปลี่ยนแปลงราคา — อ่านอย่างเดียว ไม่มีการเขียนข้อมูลใดๆ ในไฟล์นี้
// แหล่งข้อมูลหลักคือ im_price_change_detail (บรรทัดที่ถูกเลือกไว้จริงของแต่ละธุรกรรม) join กับ header/price_list/
// price_group/item/category/uom — ราคาเก่า/ใหม่ใช้ค่าที่ snapshot ไว้ใน detail เองเสมอ (ไม่ต้องพึ่ง
// im_price_list_detail) ยกเว้น "สถานะ" (ใช้งาน/ไม่ใช้) ที่ต้อง join ไปดูแถวราคาจริงที่เกิดจากการอนุมัติ
// (source_price_change_id) ว่ายังมีผลอยู่หรือถูกแทนที่ไปแล้ว
'use strict';

const { ensureImPriceChangeTable } = require('./imPriceChangeController');

// GET /im_price_change_report/categories?price_list_ids=1,2,3
// หมวดหมู่ของสินค้าที่มีราคาอยู่ในตารางราคาที่เลือก (ไม่ระบุ price_list_ids = ทุกหมวดหมู่ที่มีการตั้งราคาไว้)
const fetchCategories = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceChangeTable(client);
        const { price_list_ids } = req.query;
        let priceListFilter = '';
        const params = [];
        if (price_list_ids) {
            const ids = String(price_list_ids).split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
            if (ids.length > 0) { params.push(ids); priceListFilter = ` AND d.price_list_id = ANY($${params.length}::int[])`; }
        }
        const result = await client.query(`
            SELECT DISTINCT c.id, c.category_code, c.category_name_th, c.category_name_en
            FROM im_price_list_detail d
            JOIN im_item i ON i.id = d.item_id
            JOIN im_item_category c ON c.id = i.category_id
            WHERE 1=1 ${priceListFilter}
            ORDER BY c.category_code
        `, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching price change report categories:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET /im_price_change_report/items?price_list_ids=1,2,3&search=คำค้น
// ค้นหาสินค้าที่มีราคาอยู่ในตารางราคาที่เลือก — ใช้กับ dialog เลือกรหัสสินค้าจาก-ถึง (ไม่ระบุ price_list_ids =
// ค้นหาทุกสินค้าที่เคยตั้งราคาไว้ในระบบ)
const searchItems = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceChangeTable(client);
        const { price_list_ids, search } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (price_list_ids) {
            const ids = String(price_list_ids).split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
            if (ids.length > 0) { params.push(ids); where += ` AND d.price_list_id = ANY($${params.length}::int[])`; }
        }
        if (search) {
            params.push(`%${search}%`);
            where += ` AND (i.item_code ILIKE $${params.length} OR i.item_name_th ILIKE $${params.length} OR i.item_name_en ILIKE $${params.length})`;
        }
        const result = await client.query(`
            SELECT DISTINCT i.id, i.item_code, i.item_name_th, i.item_name_en
            FROM im_price_list_detail d
            JOIN im_item i ON i.id = d.item_id
            ${where}
            ORDER BY i.item_code
            LIMIT 100
        `, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error searching price change report items:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET /im_price_change_report — รายงานหลัก
// query: price_group_ids, price_list_ids, category_ids, item_code_from, item_code_to, date_from, date_to,
//        change_statuses (Draft,Pending,Approved — คอมม่าคั่น), active_status (ACTIVE|INACTIVE|ALL)
const fetchReport = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceChangeTable(client);
        const {
            price_group_ids, price_list_ids, category_ids, item_code_from, item_code_to,
            date_from, date_to, change_statuses, active_status,
        } = req.query;

        let where = `WHERE h.status != 'Void' AND d.is_selected = true`;
        const params = [];

        if (price_group_ids) {
            const ids = String(price_group_ids).split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
            if (ids.length > 0) { params.push(ids); where += ` AND pg.id = ANY($${params.length}::int[])`; }
        }
        if (price_list_ids) {
            const ids = String(price_list_ids).split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
            if (ids.length > 0) { params.push(ids); where += ` AND pl.id = ANY($${params.length}::int[])`; }
        }
        if (category_ids) {
            const ids = String(category_ids).split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
            if (ids.length > 0) { params.push(ids); where += ` AND i.category_id = ANY($${params.length}::int[])`; }
        }
        if (item_code_from) { params.push(item_code_from); where += ` AND i.item_code >= $${params.length}`; }
        if (item_code_to) { params.push(item_code_to); where += ` AND i.item_code <= $${params.length}`; }
        if (date_from) { params.push(date_from); where += ` AND h.effective_from >= $${params.length}`; }
        if (date_to) { params.push(date_to); where += ` AND h.effective_from <= $${params.length}`; }
        if (change_statuses) {
            const statuses = String(change_statuses).split(',').map((s) => s.trim()).filter(Boolean);
            if (statuses.length > 0) { params.push(statuses); where += ` AND h.status = ANY($${params.length}::varchar[])`; }
        }
        // สถานะ (ใช้งาน/ไม่ใช้) ใช้ได้เฉพาะรายการที่ Approved แล้วเท่านั้น (มีแถวราคาจริงให้ตรวจสอบ) — รายการ
        // Draft/Pending ยังไม่มีแถวราคาจริงเกิดขึ้น จึงแสดงเสมอไม่ว่าจะกรองสถานะใดก็ตาม ไม่ถือว่า "ไม่ตรงเงื่อนไข"
        if (active_status === 'ACTIVE') {
            where += ` AND (h.status != 'Approved' OR lp.effective_to IS NULL OR lp.effective_to >= CURRENT_DATE)`;
        } else if (active_status === 'INACTIVE') {
            where += ` AND (h.status != 'Approved' OR (lp.effective_to IS NOT NULL AND lp.effective_to < CURRENT_DATE))`;
        }

        const result = await client.query(`
            SELECT
                h.id AS header_id, h.change_no, h.status AS change_status, h.change_type,
                h.effective_from, h.effective_to, h.approved_at, h.approved_by,
                d.id AS detail_id, d.item_id, d.min_qty, d.old_unit_price_fc, d.new_unit_price_fc,
                pl.id AS price_list_id, pl.price_list_code, pl.price_list_name,
                pg.id AS price_group_id, pg.price_group_code, pg.price_group_name_th, pg.price_group_name_en,
                i.item_code, i.item_name_th, i.item_name_en, i.category_id,
                c.category_code, c.category_name_th, c.category_name_en,
                u.uom_code, u.uom_name_th, u.uom_name_en,
                CASE
                    WHEN h.status != 'Approved' THEN NULL
                    WHEN lp.effective_to IS NULL OR lp.effective_to >= CURRENT_DATE THEN 'ACTIVE'
                    ELSE 'INACTIVE'
                END AS result_status
            FROM im_price_change_detail d
            JOIN im_price_change_header h ON h.id = d.header_id
            JOIN im_price_list pl ON pl.id = h.price_list_id
            LEFT JOIN im_price_group pg ON pg.id = pl.price_group_id
            JOIN im_item i ON i.id = d.item_id
            LEFT JOIN im_item_category c ON c.id = i.category_id
            LEFT JOIN im_uom u ON u.id = d.uom_id
            LEFT JOIN im_price_list_detail lp ON lp.source_price_change_id = h.id
                AND lp.item_id = d.item_id AND lp.min_qty = d.min_qty
                AND lp.uom_id IS NOT DISTINCT FROM d.uom_id
            ${where}
            ORDER BY pg.price_group_code NULLS LAST, pl.price_list_code, c.category_code NULLS LAST,
                     i.item_code, h.effective_from DESC
        `, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching price change report:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchCategories, searchItems, fetchReport };
