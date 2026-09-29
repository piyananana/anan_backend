// controllers/so/soBulkCloseController.js — รายการใบสั่งขายที่ปิดได้ (Approved/PartiallyDelivered/FullyDelivered)
// สำหรับหน้าจอปิดใบสั่งขายทีละหลายใบ — อ่านอย่างเดียว การปิดจริงยังใช้ PUT /so_transaction/:id/close เดิม
// (closeTransaction ใน soTransactionController.js) เรียกทีละใบจากฝั่ง frontend ไม่มี endpoint เขียนใหม่ที่นี่
// qty_delivered คำนวณด้วยสูตรเดียวกับ soPendingDeliveryReportController.js/refreshSoStatus ทุกประการ — มิเรอร์
// poBulkCloseController.js ทุกประการ (vendor->customer)
'use strict';

const CLOSABLE_STATUSES = ['Approved', 'PartiallyDelivered', 'FullyDelivered'];

const fetchClosableList = async (req, res) => {
    const { so_date_from, so_date_to, due_date_from, due_date_to, customer_ids, statuses } = req.query;
    const customerIdList = (customer_ids || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const statusList = (statuses || '').split(',').map(s => s.trim()).filter(s => CLOSABLE_STATUSES.includes(s));

    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`
            SELECT
                so.id AS so_id, so.doc_no AS so_doc_no, so.doc_date AS so_doc_date, so.due_date, so.status,
                so.customer_id, so.customer_code, so.customer_name_th,
                c.customer_name_en,
                so.warehouse_id, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                so.total_value_lc,
                COALESCE(SUM(sod.qty_ordered), 0) AS qty_ordered,
                COALESCE(SUM((
                    SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                    JOIN im_transaction imt ON imt.id = imd.header_id
                    WHERE imd.ref_so_detail_id = sod.id AND imt.status IN ('Posted','Delivered')
                )), 0) AS qty_delivered
            FROM so_transaction so
            JOIN so_transaction_detail sod ON sod.header_id = so.id
            LEFT JOIN ar_customer c ON c.id = so.customer_id
            LEFT JOIN im_warehouse w ON w.id = so.warehouse_id
            WHERE so.status = ANY($1::text[])
              AND ($2::date IS NULL OR so.doc_date >= $2::date)
              AND ($3::date IS NULL OR so.doc_date <= $3::date)
              AND ($4::date IS NULL OR so.due_date >= $4::date)
              AND ($5::date IS NULL OR so.due_date <= $5::date)
              AND ($6::int[] IS NULL OR so.customer_id = ANY($6::int[]))
            GROUP BY so.id, c.customer_name_en, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en
            ORDER BY so.doc_date, so.id
        `, [
            statusList.length > 0 ? statusList : CLOSABLE_STATUSES,
            so_date_from || null, so_date_to || null, due_date_from || null, due_date_to || null,
            customerIdList.length > 0 ? customerIdList : null,
        ]);

        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching closable SO list:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchClosableList };
