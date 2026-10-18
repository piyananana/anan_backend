// controllers/im/imTransactionReportController.js
const { today } = require('../../utils/dateUtil');
const { parseStatuses, IM_LINE_QTY, IM_LINE_VALUE } = require('./imEffectiveTxSql');
// รายงานธุรกรรมสินค้าคงคลัง — มิเรอร์รูปแบบ arTransactionReportController.js แต่ปรับให้เป็นรายการเอกสารเรียงตาม
// วันที่ (ไม่จัดกลุ่มตาม entity เหมือน AR ที่จัดกลุ่มตามลูกค้า) เพราะ IM ไม่มีฟีลด์ที่ทุก sys_doc_type มีร่วมกัน
// แบบ customer_id ของ AR (AJS/ISS/TRF ไม่มีผู้ขาย/ลูกค้า) — ยืนยันรูปแบบนี้กับผู้ใช้แล้วก่อนสร้าง
'use strict';

const getTransactionReport = async (req, res) => {
    const { date_from, date_to, sys_doc_types, statuses, sort } = req.query;

    const dateFrom = date_from || today();
    const dateTo   = date_to   || today();
    const order    = sort === 'desc' ? 'DESC' : 'ASC';

    const client = await req.dbPool.connect();
    try {
        // ค่าเริ่มต้น: ธุรกรรมที่มีผลจริง — Posted รวมถึง Received/Delivered ('12'/'32' ที่ Post IM แล้วแต่ยังไม่
        // Post AP/AR-GL) เลือกสถานะอื่น (ร่าง / ยกเลิก / ลบแล้ว) เพิ่มได้จากหน้าจอ
        const statusList = parseStatuses(statuses, ['Posted', 'Received', 'Delivered']);
        const params = [dateFrom, dateTo, statusList];
        let sdtFilter = '';
        if (sys_doc_types) {
            const types = String(sys_doc_types).split(',').map(s => s.trim()).filter(Boolean);
            if (types.length > 0) {
                params.push(types);
                sdtFilter = `AND d.sys_doc_type = ANY($${params.length}::text[])`;
            }
        }

        const headerRes = await client.query(`
            SELECT
                t.id                AS txn_id,
                t.doc_no, t.doc_date, t.status, t.description,
                t.ref_no, t.ref_doc_no,
                t.vendor_code, t.vendor_name_th,
                t.customer_code, t.customer_name_th,
                t.total_qty, t.total_value_lc, t.void_date, t.void_reason,
                w.warehouse_code, w.warehouse_name_th,
                tw.warehouse_code  AS to_warehouse_code, tw.warehouse_name_th AS to_warehouse_name_th,
                d.doc_code, d.doc_name_thai, d.doc_name_eng, d.sys_doc_type
            FROM im_transaction t
            JOIN sa_module_document d  ON d.id = t.doc_id
            LEFT JOIN im_warehouse w   ON w.id = t.warehouse_id
            LEFT JOIN im_warehouse tw  ON tw.id = t.to_warehouse_id
            WHERE t.status = ANY($3::text[])
              AND t.doc_date >= $1::date
              AND t.doc_date <= $2::date
              ${sdtFilter}
            ORDER BY t.doc_date ${order}, t.id ${order}
        `, params);

        const txnIds = headerRes.rows.map(r => r.txn_id);
        const linesByHeader = new Map();
        if (txnIds.length > 0) {
            // dt.item_name/dt.item_code เป็น snapshot ที่ INSERT path บางเส้นทางไม่ได้เซ็ตค่า (พบเป็น NULL ในข้อมูลจริง
            // แม้ dt.item_id จะมีค่าเสมอ) — COALESCE กับข้อมูลปัจจุบันจาก im_item เป็น fallback เสมอ
            const detailRes = await client.query(`
                SELECT
                    dt.header_id, dt.line_no,
                    COALESCE(dt.item_code, it.item_code) AS item_code,
                    it.item_name_th, it.item_name_en,
                    ${IM_LINE_QTY} AS qty, dt.unit_cost, dt.unit_price, dt.billed_unit_cost, dt.is_free,
                    dt.vat_type, dt.vat_rate, dt.lot_no, dt.serial_no, ${IM_LINE_VALUE} AS total_value_lc,
                    u.uom_code, u.uom_name_th, u.uom_name_en, l.location_code, tl.location_code AS to_location_code
                FROM im_transaction_detail dt
                JOIN im_transaction t    ON t.id = dt.header_id
                LEFT JOIN im_item it     ON it.id = dt.item_id
                LEFT JOIN im_uom u       ON u.id  = dt.uom_id
                LEFT JOIN im_location l  ON l.id  = dt.location_id
                LEFT JOIN im_location tl ON tl.id = dt.to_location_id
                WHERE dt.header_id = ANY($1::int[])
                ORDER BY dt.header_id, dt.line_no
            `, [txnIds]);
            for (const row of detailRes.rows) {
                if (!linesByHeader.has(row.header_id)) linesByHeader.set(row.header_id, []);
                linesByHeader.get(row.header_id).push(row);
            }
        }

        // ร่าง/ลบแล้ว: ยอดรวมหัวเอกสารยังเป็น 0 (คำนวณตอนโพสต์) — รวมจากบรรทัดแทน
        const rows = headerRes.rows.map(h => {
            const lines = linesByHeader.get(h.txn_id) || [];
            if (h.status !== 'Draft' && h.status !== 'Deleted') return { ...h, lines };
            const sum = (k) => lines.reduce((a, l) => a + Number(l[k] || 0), 0);
            return { ...h, total_qty: sum('qty'), total_value_lc: sum('total_value_lc'), lines };
        });

        res.json(rows);
    } catch (err) {
        console.error('IM Transaction Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getTransactionReport };
