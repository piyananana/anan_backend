// controllers/im/imUomSummaryController.js
// สรุปการใช้หน่วยนับ สำหรับหน้าจอหน่วยนับ (user 2026-11-25): จำนวนสินค้าที่ใช้เป็นหน่วยหลัก/หน่วยรอง,
// อัตราแปลงมาตรฐาน, เอกสารล่าสุดที่ใช้หน่วยนี้ และรายชื่อสินค้าที่ใช้ — อ่านอย่างเดียว ตารางที่ยังไม่มี = ไม่มีข้อมูล
'use strict';

const tableExists = async (client, name) =>
    !!(await client.query(`SELECT to_regclass($1) AS t`, [`public.${name}`])).rows[0].t;

// จำนวนสินค้าต่อหน่วย (หน่วยหลัก + หน่วยรองที่ไม่ใช่หน่วยหลักของสินค้านั้น) — ใช้ทั้งการ์ดรายการและหน้ารายละเอียด
const usageCounts = async (client, uomId = null) => {
    const hasItem = await tableExists(client, 'im_item');
    if (!hasItem) return {};
    const hasConv = await tableExists(client, 'im_uom_conversion');
    const params = uomId ? [uomId] : [];
    const r = await client.query(`
        SELECT uom_id, SUM(base_n)::int AS base_count, SUM(alt_n)::int AS alt_count FROM (
            SELECT base_uom_id AS uom_id, COUNT(*) AS base_n, 0 AS alt_n FROM im_item
             WHERE base_uom_id IS NOT NULL ${uomId ? 'AND base_uom_id = $1' : ''} GROUP BY base_uom_id
            ${hasConv ? `UNION ALL
            SELECT c.uom_id, 0, COUNT(DISTINCT c.item_id) FROM im_uom_conversion c
              JOIN im_item i ON i.id = c.item_id AND COALESCE(i.base_uom_id, 0) <> c.uom_id
             ${uomId ? 'WHERE c.uom_id = $1' : ''} GROUP BY c.uom_id` : ''}
        ) x GROUP BY uom_id`, params);
    return Object.fromEntries(r.rows.map(x => [x.uom_id, { base_count: x.base_count, alt_count: x.alt_count }]));
};

const ymd = (d) => d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);

// GET /im_uom/:id/summary
const fetchSummary = async (req, res) => {
    const uomId = Number(req.params.id);
    if (!uomId) return res.status(400).json({ message: 'uom id ไม่ถูกต้อง' });
    const client = await req.dbPool.connect();
    try {
        const uom = (await client.query(`SELECT id FROM im_uom WHERE id = $1`, [uomId])).rows[0];
        if (!uom) return res.status(404).json({ message: 'ไม่พบหน่วยนับ' });
        const counts = (await usageCounts(client, uomId))[uomId] || { base_count: 0, alt_count: 0 };

        let stdConversions = [];
        if (await tableExists(client, 'im_uom_standard_conversion')) {
            stdConversions = (await client.query(`
                SELECT CASE WHEN s.from_uom_id = $1 THEN t.uom_code ELSE f.uom_code END AS uom_code
                  FROM im_uom_standard_conversion s
                  JOIN im_uom f ON f.id = s.from_uom_id
                  JOIN im_uom t ON t.id = s.to_uom_id
                 WHERE s.from_uom_id = $1 OR s.to_uom_id = $1
                 ORDER BY 1`, [uomId])).rows.map(x => x.uom_code);
        }

        let lastDoc = null;
        if (await tableExists(client, 'im_transaction_detail')) {
            const r = await client.query(`
                SELECT t.doc_date, t.doc_no, t.doc_code
                  FROM im_transaction_detail d JOIN im_transaction t ON t.id = d.header_id
                 WHERE d.uom_id = $1 AND t.status IN ('Posted', 'Received')
                 ORDER BY t.doc_date DESC, t.id DESC LIMIT 1`, [uomId]);
            if (r.rows[0]) lastDoc = { doc_date: ymd(r.rows[0].doc_date), doc_no: r.rows[0].doc_no, doc_code: r.rows[0].doc_code };
        }

        // สินค้าที่ใช้หน่วยนี้ (สูงสุด 100 รายการแรกตามรหัส) — หน่วยหลักก่อน แล้วหน่วยรองพร้อมอัตรา
        let items = [];
        if (await tableExists(client, 'im_item')) {
            const hasConv = await tableExists(client, 'im_uom_conversion');
            items = (await client.query(`
                SELECT * FROM (
                    SELECT i.id AS item_id, i.item_code, i.item_name_th, i.item_name_en, 'BASE' AS role, 1::numeric AS factor,
                           NULL::text AS base_uom_code
                      FROM im_item i WHERE i.base_uom_id = $1
                    ${hasConv ? `UNION ALL
                    SELECT i.id, i.item_code, i.item_name_th, i.item_name_en, 'ALT', c.conversion_factor, bu.uom_code
                      FROM im_uom_conversion c JOIN im_item i ON i.id = c.item_id
                      LEFT JOIN im_uom bu ON bu.id = i.base_uom_id
                     WHERE c.uom_id = $1 AND COALESCE(i.base_uom_id, 0) <> $1` : ''}
                ) x ORDER BY item_code LIMIT 100`, [uomId])).rows.map(x => ({ ...x, factor: Number(x.factor) }));
        }

        res.status(200).json({
            base_count: counts.base_count,
            alt_count: counts.alt_count,
            std_conversions: stdConversions,
            last_doc: lastDoc,
            items,
        });
    } catch (error) {
        console.error('Error fetching im_uom summary:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchSummary, usageCounts };
