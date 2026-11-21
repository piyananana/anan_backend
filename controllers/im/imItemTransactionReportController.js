// controllers/im/imItemTransactionReportController.js
const { today } = require('../../utils/dateUtil');
const { IM_EFFECTIVE_DOC_NO, parseStatuses, IM_LINE_QTY, IM_LINE_VALUE } = require('./imEffectiveTxSql');
const { reportUom } = require('../../utils/reportUom');
// รายงานสินค้าในธุรกรรม — flat list ระดับ "บรรทัดสินค้า" (ไม่ใช่ระดับเอกสารเหมือน imTransactionReportController)
// ทุก sys_doc_type ของ IM รวมกันในรายงานเดียว จัดกลุ่ม+ยอดรวมย่อยตามฟีลด์ที่เลือกเรียง (Flutter ฝั่ง frontend
// เป็นคนจัดกลุ่ม/แสดงยอดรวมย่อยตอน render — backend แค่ query แถวดิบมาเรียงลำดับให้ถูกต้องพอ)
'use strict';

const getItemTransactionReport = async (req, res) => {
    const { date_from, date_to, sys_doc_types, category_ids, item_code_from, item_code_to, statuses, sort, uom_mode } = req.query;
    // หน่วยแสดงผล: base (ค่าเริ่มต้น) = หน่วยหลัก, report = หน่วยรายงานของสินค้า, doc = หน่วยที่กรอกในเอกสาร
    // (dt.qty เป็นหน่วยหลักเสมอหลังขั้นที่ 2 — เดิม join หน่วยจาก dt.uom_id ทำให้บรรทัดที่กรอกเป็นแพ็ค แสดงจำนวนขวดแต่ป้ายว่าแพ็ค)
    const ru = reportUom(uom_mode);
    const isDoc = uom_mode === 'doc';
    const baseQty = `(${IM_LINE_QTY}) * t.sign`;
    const qtySql = isDoc
        ? `CASE WHEN dt.uom_qty IS NOT NULL AND dt.uom_id IS NOT NULL THEN SIGN(${baseQty}) * dt.uom_qty ELSE ${baseQty} END`
        : ru.qty(baseQty);
    const uomSql = isDoc
        ? `COALESCE(du.uom_code, u.uom_code) AS uom_code,
           CASE WHEN du.id IS NULL THEN u.uom_name_th ELSE du.uom_name_th END AS uom_name_th,
           CASE WHEN du.id IS NULL THEN u.uom_name_en ELSE du.uom_name_en END AS uom_name_en`
        : ru.uomCols;

    const dateFrom = date_from || today();
    const dateTo   = date_to   || today();

    const client = await req.dbPool.connect();
    try {
        // ค่าเริ่มต้น: Posted / Received / Delivered / Void — เอกสารที่ยกเลิกแสดง ณ วันที่เดิม และรายการกลับ "(VOID)"
        // ณ วันที่ยกเลิก (ตรงกับรายงานความเคลื่อนไหวสต็อก) ไม่เลือก Void = ไม่แสดงเอกสารที่ยกเลิกทั้งสองแถว
        // Void แบบเดิม (ไม่มี void_date) แสดงรายการกลับในวันที่เอกสาร ยอดสุทธิเป็นศูนย์
        const statusList = parseStatuses(statuses, ['Posted', 'Received', 'Delivered', 'Void']);
        const params = [dateFrom, dateTo, statusList];
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
        let orderBy = 't.eff_date ASC, t.id ASC, dt.line_no ASC';
        switch (sort) {
            case 'doc_type':
                orderBy = 'd.sys_doc_type ASC, t.eff_date ASC, t.id ASC, dt.line_no ASC';
                break;
            case 'item_code':
                orderBy = 'item_code ASC, t.eff_date ASC, t.id ASC, dt.line_no ASC';
                break;
            case 'party_code':
                orderBy = 'party_code ASC, t.eff_date ASC, t.id ASC, dt.line_no ASC';
                break;
            default:
                orderBy = 't.eff_date ASC, t.id ASC, dt.line_no ASC';
        }

        // dt.item_code/item_name เป็น snapshot ที่บาง insert path ไม่ได้เซ็ต (ดู imTransactionReportController) —
        // COALESCE กับ im_item เสมอเหมือนกัน เพื่อความสอดคล้องกับรายงานธุรกรรมระดับเอกสาร
        const result = await client.query(`
            SELECT
                ${IM_EFFECTIVE_DOC_NO} AS doc_no, t.eff_date AS doc_date,
                d.doc_code, d.doc_name_thai, d.doc_name_eng, d.sys_doc_type,
                COALESCE(t.vendor_code, t.customer_code)     AS party_code,
                COALESCE(t.vendor_name_th, t.customer_name_th) AS party_name,
                COALESCE(dt.item_code, it.item_code) AS item_code,
                it.item_name_th, it.item_name_en,
                ${qtySql} AS qty, ${uomSql},
                (${IM_LINE_VALUE}) * t.sign AS total_value_lc, dt.is_free,
                t.status, t.is_reversal
            FROM im_transaction_detail dt
            JOIN (
                SELECT t.*, t.doc_date AS eff_date, 1 AS sign, FALSE AS is_reversal FROM im_transaction t
                 WHERE t.status = ANY($3::text[])
                UNION ALL
                SELECT t.*, COALESCE(t.void_date, t.doc_date) AS eff_date, -1 AS sign, TRUE AS is_reversal FROM im_transaction t
                 WHERE t.status = 'Void' AND 'Void' = ANY($3::text[])
            ) t ON t.id = dt.header_id
            JOIN sa_module_document d  ON d.id = t.doc_id
            LEFT JOIN im_item it       ON it.id = dt.item_id
            LEFT JOIN im_uom u         ON u.id  = COALESCE(it.base_uom_id, dt.uom_id)
            LEFT JOIN im_uom du        ON du.id = CASE WHEN dt.uom_qty IS NOT NULL THEN dt.uom_id END
            ${ru.join}
            WHERE t.eff_date >= $1::date
              AND t.eff_date <= $2::date
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
