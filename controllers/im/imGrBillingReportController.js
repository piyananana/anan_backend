// controllers/im/imGrBillingReportController.js
// รายงานตรวจสอบ GR รอ/ผ่านการโพสต์ AP-GL (sys_doc_type='12') — ยอดสินค้าที่ยังไม่มี GL รองรับ (สถานะ Received)
// และส่วนต่างราคาระหว่างต้นทุนที่ตีมูลค่าสต็อก (unit_cost) กับต้นทุนที่โพสต์ AP/GL จริง (billed_unit_cost, สถานะ Posted)

const getGrBillingReport = async (req, res) => {
    const {
        as_of_date,
        warehouse_id,
        vendor_id,
        date_from,
        date_to,
        status, // 'Received' | 'Posted' | undefined(=both)
    } = req.query;

    const asOf = as_of_date || new Date().toISOString().slice(0, 10);
    const client = await req.dbPool.connect();
    try {
        const params = [asOf];
        const filters = [];

        if (warehouse_id) { params.push(parseInt(warehouse_id)); filters.push(`t.warehouse_id = $${params.length}`); }
        if (vendor_id)    { params.push(parseInt(vendor_id));    filters.push(`t.vendor_id = $${params.length}`); }
        if (date_from)    { params.push(date_from);              filters.push(`t.doc_date >= $${params.length}`); }
        if (date_to)      { params.push(date_to);                filters.push(`t.doc_date <= $${params.length}`); }
        if (status === 'Received' || status === 'Posted') {
            params.push(status);
            filters.push(`t.status = $${params.length}`);
        } else {
            filters.push(`t.status IN ('Received','Posted')`);
        }

        const extraFilters = filters.length > 0 ? 'AND ' + filters.join('\n              AND ') : '';

        const result = await client.query(`
            SELECT
                t.id, t.doc_no, t.doc_date, t.status,
                t.vendor_id, t.vendor_code, t.vendor_name_th,
                t.warehouse_id, w.warehouse_code, w.warehouse_name_th,
                t.ref_no, t.linked_ap_transaction_id,
                ($1::date - t.doc_date::date) AS days_outstanding,
                COALESCE(SUM(dt.qty * dt.unit_cost), 0) AS stock_value,
                COALESCE(SUM(dt.qty * (COALESCE(dt.billed_unit_cost, dt.unit_cost) - dt.unit_cost)), 0) AS variance_value,
                COALESCE(SUM(dt.qty * COALESCE(dt.billed_unit_cost, dt.unit_cost)), 0) AS billed_value
            FROM im_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            LEFT JOIN im_warehouse w ON w.id = t.warehouse_id
            LEFT JOIN im_transaction_detail dt ON dt.header_id = t.id
            WHERE d.sys_module = '31' AND d.sys_doc_type = '12'
              ${extraFilters}
            GROUP BY t.id, t.doc_no, t.doc_date, t.status, t.vendor_id, t.vendor_code, t.vendor_name_th,
                     t.warehouse_id, w.warehouse_code, w.warehouse_name_th, t.ref_no, t.linked_ap_transaction_id
            ORDER BY t.vendor_code ASC, t.doc_date ASC
        `, params);

        // จัดกลุ่มตามผู้ขาย เหมือนรายงาน AP Aging
        const vendorMap = new Map();
        for (const row of result.rows) {
            const vid = row.vendor_id;
            if (!vendorMap.has(vid)) {
                vendorMap.set(vid, {
                    vendor_id: vid,
                    vendor_code: row.vendor_code,
                    vendor_name_th: row.vendor_name_th,
                    documents: [],
                });
            }
            vendorMap.get(vid).documents.push({
                id: row.id,
                doc_no: row.doc_no,
                doc_date: row.doc_date,
                status: row.status,
                warehouse_code: row.warehouse_code,
                warehouse_name_th: row.warehouse_name_th,
                ref_no: row.ref_no,
                linked_ap_transaction_id: row.linked_ap_transaction_id,
                days_outstanding: row.status === 'Received' ? Number(row.days_outstanding) : null,
                stock_value: Number(row.stock_value),
                billed_value: row.status === 'Posted' ? Number(row.billed_value) : null,
                variance_value: row.status === 'Posted' ? Number(row.variance_value) : 0,
            });
        }

        res.json(Array.from(vendorMap.values()));
    } catch (err) {
        console.error('IM GR Billing Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getGrBillingReport };
