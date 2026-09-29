// controllers/so/soPendingDeliveryReportController.js — รายงานการสั่งขายและสินค้าค้างส่ง (บรรทัด SO ที่ยังส่งสินค้า
// ไม่ครบ) อ่านอย่างเดียว — จำนวนคงเหลือที่ยังไม่ส่ง (qty_outstanding) คำนวณจาก qty_ordered ลบยอดที่ส่งจริงจาก
// im_transaction ที่อ้างอิงกลับมา (ref_so_detail_id) สถานะ Posted/Delivered — มิเรอร์
// poPendingReceiptReportController.js ทุกประการ (vendor->customer) เฉพาะบรรทัดที่มี qty_outstanding > 0 เท่านั้น
// ที่ถือว่า "ค้างส่ง"
'use strict';

const fetchReport = async (req, res) => {
    const { so_date_from, so_date_to, due_date_from, due_date_to, customer_ids, item_ids, sort_due_date } = req.query;
    const customerIdList = (customer_ids || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const itemIdList = (item_ids || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const sortAsc = sort_due_date !== 'desc';

    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`
            SELECT
                so.id AS so_id, so.doc_no AS so_doc_no, so.doc_date AS so_doc_date, so.due_date,
                so.exchange_rate,
                sod.id AS so_detail_id, sod.item_id, sod.item_code, sod.item_name,
                sod.qty_ordered, sod.unit_price_fc,
                COALESCE((
                    SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                    JOIN im_transaction imt ON imt.id = imd.header_id
                    WHERE imd.ref_so_detail_id = sod.id AND imt.status IN ('Posted','Delivered')
                ), 0) AS qty_delivered,
                c.customer_code, c.customer_name_th, c.customer_name_en,
                w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en
            FROM so_transaction_detail sod
            JOIN so_transaction so ON so.id = sod.header_id
            LEFT JOIN ar_customer c ON c.id = so.customer_id
            LEFT JOIN im_warehouse w ON w.id = so.warehouse_id
            WHERE so.status IN ('Approved','PartiallyDelivered','FullyDelivered')
              AND ($1::date IS NULL OR so.doc_date >= $1::date)
              AND ($2::date IS NULL OR so.doc_date <= $2::date)
              AND ($3::date IS NULL OR so.due_date >= $3::date)
              AND ($4::date IS NULL OR so.due_date <= $4::date)
              AND ($5::int[] IS NULL OR so.customer_id = ANY($5::int[]))
              AND ($6::int[] IS NULL OR sod.item_id = ANY($6::int[]))
        `, [
            so_date_from || null, so_date_to || null, due_date_from || null, due_date_to || null,
            customerIdList.length > 0 ? customerIdList : null, itemIdList.length > 0 ? itemIdList : null,
        ]);

        const rows = result.rows
            .map(r => ({ ...r, qty_outstanding: (Number(r.qty_ordered) || 0) - (Number(r.qty_delivered) || 0) }))
            .filter(r => r.qty_outstanding > 0.0001);

        rows.sort((a, b) => {
            const da = a.due_date ? new Date(a.due_date).getTime() : Infinity;
            const db = b.due_date ? new Date(b.due_date).getTime() : Infinity;
            if (da !== db) return sortAsc ? da - db : db - da;
            return (a.so_doc_no || '').localeCompare(b.so_doc_no || '');
        });

        res.status(200).json(rows);
    } catch (error) {
        console.error('Error fetching SO pending delivery report:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchReport };
