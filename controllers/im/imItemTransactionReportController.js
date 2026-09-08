// controllers/im/imItemTransactionReportController.js
// รายงานสินค้าในธุรกรรม — flat list ระดับ "บรรทัดสินค้า" (ไม่ใช่ระดับเอกสารเหมือน imTransactionReportController)
// ทุก sys_doc_type ของ IM รวมกันในรายงานเดียว จัดกลุ่ม+ยอดรวมย่อยตามฟีลด์ที่เลือกเรียง (Flutter ฝั่ง frontend
// เป็นคนจัดกลุ่ม/แสดงยอดรวมย่อยตอน render — backend แค่ query แถวดิบมาเรียงลำดับให้ถูกต้องพอ)
'use strict';

const getItemTransactionReport = async (req, res) => {
    const { date_from, date_to, sys_doc_types, category_ids, item_code_from, item_code_to, sort } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        const params = [dateFrom, dateTo];
        let filters = '';

        if (sys_doc_types) {
            const types = String(sys_doc_types).split(',').map(s => s.trim()).filter(Boolean);
            if (types.length > 0) {
                params.push(types);
                filters += ` AND d.sys_doc_type = ANY($${params.length}::text[])`;
            }
        }
        if (category_ids) {
            const ids = String(category_ids).split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
            if (ids.length > 0) {
                params.push(ids);
                filters += ` AND it.category_id = ANY($${params.length}::int[])`;
            }
        }
        if (item_code_from) {
            params.push(item_code_from);
            filters += ` AND COALESCE(dt.item_code, it.item_code) >= $${params.length}`;
        }
        if (item_code_to) {
            params.push(item_code_to);
            filters += ` AND COALESCE(dt.item_code, it.item_code) <= $${params.length}`;
        }

        // การจัดเรียง — ตัวเลือกจากหน้าจอ: doc_date (default) / doc_type / item_code / party_code
        let orderBy = 't.doc_date ASC, t.id ASC, dt.line_no ASC';
        switch (sort) {
            case 'doc_type':
                orderBy = 'd.sys_doc_type ASC, t.doc_date ASC, t.id ASC, dt.line_no ASC';
                break;
            case 'item_code':
                orderBy = 'item_code ASC, t.doc_date ASC, t.id ASC, dt.line_no ASC';
                break;
            case 'party_code':
                orderBy = 'party_code ASC, t.doc_date ASC, t.id ASC, dt.line_no ASC';
                break;
            default:
                orderBy = 't.doc_date ASC, t.id ASC, dt.line_no ASC';
        }

        // dt.item_code/item_name เป็น snapshot ที่บาง insert path ไม่ได้เซ็ต (ดู imTransactionReportController) —
        // COALESCE กับ im_item เสมอเหมือนกัน เพื่อความสอดคล้องกับรายงานธุรกรรมระดับเอกสาร
        const result = await client.query(`
            SELECT
                t.doc_no, t.doc_date,
                d.doc_code, d.doc_name_thai, d.doc_name_eng, d.sys_doc_type,
                COALESCE(t.vendor_code, t.customer_code)     AS party_code,
                COALESCE(t.vendor_name_th, t.customer_name_th) AS party_name,
                COALESCE(dt.item_code, it.item_code) AS item_code,
                it.item_name_th, it.item_name_en,
                dt.qty, u.uom_code, u.uom_name_th, u.uom_name_en,
                dt.total_value_lc
            FROM im_transaction_detail dt
            JOIN im_transaction t      ON t.id = dt.header_id
            JOIN sa_module_document d  ON d.id = t.doc_id
            LEFT JOIN im_item it       ON it.id = dt.item_id
            LEFT JOIN im_uom u         ON u.id  = dt.uom_id
            WHERE t.status IN ('Posted', 'Received', 'Delivered')
              AND t.doc_date >= $1::date
              AND t.doc_date <= $2::date
              ${filters}
            ORDER BY ${orderBy}
        `, params);

        res.json(result.rows);
    } catch (err) {
        console.error('IM Item Transaction Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getItemTransactionReport };
