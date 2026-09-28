// controllers/po/poBulkCloseController.js — รายการใบสั่งซื้อที่ปิดได้ (Approved/PartiallyReceived/FullyReceived)
// สำหรับหน้าจอปิดใบสั่งซื้อทีละหลายใบ — อ่านอย่างเดียว การปิดจริงยังใช้ PUT /po_transaction/:id/close เดิม
// (closeTransaction ใน poTransactionController.js) เรียกทีละใบจากฝั่ง frontend ไม่มี endpoint เขียนใหม่ที่นี่
// qty_received คำนวณด้วยสูตรเดียวกับ poPendingReceiptReportController.js/refreshPoStatus ทุกประการ
'use strict';

const CLOSABLE_STATUSES = ['Approved', 'PartiallyReceived', 'FullyReceived'];

const fetchClosableList = async (req, res) => {
    const { po_date_from, po_date_to, due_date_from, due_date_to, vendor_ids, statuses } = req.query;
    const vendorIdList = (vendor_ids || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const statusList = (statuses || '').split(',').map(s => s.trim()).filter(s => CLOSABLE_STATUSES.includes(s));

    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`
            SELECT
                po.id AS po_id, po.doc_no AS po_doc_no, po.doc_date AS po_doc_date, po.due_date, po.status,
                po.vendor_id, po.vendor_code, po.vendor_name_th,
                v.vendor_name_en,
                po.warehouse_id, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                po.total_value_lc,
                COALESCE(SUM(pod.qty_ordered), 0) AS qty_ordered,
                COALESCE(SUM((
                    SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                    JOIN im_transaction imt ON imt.id = imd.header_id
                    WHERE imd.ref_po_detail_id = pod.id AND imt.status IN ('Posted','Received')
                )), 0) AS qty_received
            FROM po_transaction po
            JOIN po_transaction_detail pod ON pod.header_id = po.id
            LEFT JOIN ap_vendor v ON v.id = po.vendor_id
            LEFT JOIN im_warehouse w ON w.id = po.warehouse_id
            WHERE po.status = ANY($1::text[])
              AND ($2::date IS NULL OR po.doc_date >= $2::date)
              AND ($3::date IS NULL OR po.doc_date <= $3::date)
              AND ($4::date IS NULL OR po.due_date >= $4::date)
              AND ($5::date IS NULL OR po.due_date <= $5::date)
              AND ($6::int[] IS NULL OR po.vendor_id = ANY($6::int[]))
            GROUP BY po.id, v.vendor_name_en, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en
            ORDER BY po.doc_date, po.id
        `, [
            statusList.length > 0 ? statusList : CLOSABLE_STATUSES,
            po_date_from || null, po_date_to || null, due_date_from || null, due_date_to || null,
            vendorIdList.length > 0 ? vendorIdList : null,
        ]);

        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching closable PO list:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchClosableList };
