// controllers/po/poPendingReceiptReportController.js — รายงานจัดซื้อสินค้าค้างรับ (บรรทัด PO ที่ยังรับสินค้าไม่ครบ)
// อ่านอย่างเดียว — จำนวนคงเหลือที่ยังไม่รับ (qty_outstanding) คำนวณจาก qty_ordered ลบยอดที่รับจริงจาก im_transaction
// ที่อ้างอิงกลับมา (ref_po_detail_id) สถานะ Posted/Received — มิเรอร์ refreshPoStatus/fetchReceivableLines ใน
// poTransactionController.js ทุกประการ เฉพาะบรรทัดที่มี qty_outstanding > 0 เท่านั้นที่ถือว่า "ค้างรับ"
'use strict';

const fetchReport = async (req, res) => {
    const { po_date_from, po_date_to, due_date_from, due_date_to, vendor_ids, item_ids, sort_due_date } = req.query;
    const vendorIdList = (vendor_ids || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const itemIdList = (item_ids || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const sortAsc = sort_due_date !== 'desc';

    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`
            SELECT
                po.id AS po_id, po.doc_no AS po_doc_no, po.doc_date AS po_doc_date, po.due_date,
                po.exchange_rate,
                pod.id AS po_detail_id, pod.item_id, pod.item_code, pod.item_name,
                pod.qty_ordered, pod.unit_price_fc,
                COALESCE((
                    SELECT SUM(ABS(imd.qty)) FROM im_transaction_detail imd
                    JOIN im_transaction imt ON imt.id = imd.header_id
                    WHERE imd.ref_po_detail_id = pod.id AND imt.status IN ('Posted','Received')
                ), 0) AS qty_received,
                v.vendor_code, v.vendor_name_th, v.vendor_name_en,
                w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en
            FROM po_transaction_detail pod
            JOIN po_transaction po ON po.id = pod.header_id
            LEFT JOIN ap_vendor v  ON v.id = po.vendor_id
            LEFT JOIN im_warehouse w ON w.id = po.warehouse_id
            WHERE po.status IN ('Approved','PartiallyReceived','FullyReceived')
              AND ($1::date IS NULL OR po.doc_date >= $1::date)
              AND ($2::date IS NULL OR po.doc_date <= $2::date)
              AND ($3::date IS NULL OR po.due_date >= $3::date)
              AND ($4::date IS NULL OR po.due_date <= $4::date)
              AND ($5::int[] IS NULL OR po.vendor_id = ANY($5::int[]))
              AND ($6::int[] IS NULL OR pod.item_id = ANY($6::int[]))
        `, [
            po_date_from || null, po_date_to || null, due_date_from || null, due_date_to || null,
            vendorIdList.length > 0 ? vendorIdList : null, itemIdList.length > 0 ? itemIdList : null,
        ]);

        const rows = result.rows
            .map(r => ({ ...r, qty_outstanding: (Number(r.qty_ordered) || 0) - (Number(r.qty_received) || 0) }))
            .filter(r => r.qty_outstanding > 0.0001);

        rows.sort((a, b) => {
            const da = a.due_date ? new Date(a.due_date).getTime() : Infinity;
            const db = b.due_date ? new Date(b.due_date).getTime() : Infinity;
            if (da !== db) return sortAsc ? da - db : db - da;
            return (a.po_doc_no || '').localeCompare(b.po_doc_no || '');
        });

        res.status(200).json(rows);
    } catch (error) {
        console.error('Error fetching PO pending receipt report:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchReport };
