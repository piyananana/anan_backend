// controllers/im/imDlnBillingReportController.js
// รายงานตรวจสอบ DLN รอ/ผ่านการโพสต์ AR-GL (sys_doc_type='32') — ต้นทุนขาย (COGS) Post ไปแล้วตั้งแต่ตอน Post IM
// (สถานะ Delivered) เสมอ ต่างจาก GRN '12' ที่ยังไม่มี GL ใดๆ เลย — ช่องว่างที่รายงานนี้เฝ้าดูคือรายได้/ลูกหนี้ที่ยังไม่
// รับรู้ (ต้นทุนตัดไปแล้วแต่รายได้ยังไม่ตั้ง ผิดหลัก matching ชั่วคราวจนกว่าจะ Post AR/GL) ไม่ใช่ variance ราคาแบบ GRN —
// unit_price เป็นคอลัมน์เดียว แก้ไขตรงๆ ก่อน Post (ดู project_im_dln_module) จึงไม่มีค่า "ก่อน/หลัง" ให้เทียบส่วนต่างหลัง Post

const getDlnBillingReport = async (req, res) => {
    const {
        as_of_date,
        warehouse_id,
        customer_id,
        date_from,
        date_to,
        status, // 'Delivered' | 'Posted' | undefined(=both)
    } = req.query;

    const asOf = as_of_date || new Date().toISOString().slice(0, 10);
    const client = await req.dbPool.connect();
    try {
        const params = [asOf];
        const filters = [];

        if (warehouse_id) { params.push(parseInt(warehouse_id)); filters.push(`t.warehouse_id = $${params.length}`); }
        if (customer_id)  { params.push(parseInt(customer_id));  filters.push(`t.customer_id = $${params.length}`); }
        if (date_from)    { params.push(date_from);              filters.push(`t.doc_date >= $${params.length}`); }
        if (date_to)      { params.push(date_to);                filters.push(`t.doc_date <= $${params.length}`); }
        if (status === 'Delivered' || status === 'Posted') {
            params.push(status);
            filters.push(`t.status = $${params.length}`);
        } else {
            filters.push(`t.status IN ('Delivered','Posted')`);
        }

        const extraFilters = filters.length > 0 ? 'AND ' + filters.join('\n              AND ') : '';

        const result = await client.query(`
            SELECT
                t.id, t.doc_no, t.doc_date, t.status,
                t.customer_id, t.customer_code, t.customer_name_th,
                t.warehouse_id, w.warehouse_code, w.warehouse_name_th,
                t.ref_no, t.linked_ar_transaction_id,
                ($1::date - t.doc_date::date) AS days_outstanding,
                COALESCE(SUM(ABS(dt.qty) * dt.unit_cost), 0) AS cogs_value,
                COALESCE(SUM(ABS(dt.qty) * COALESCE(dt.unit_price, 0)), 0) AS estimated_revenue,
                ar.subtotal_lc AS billed_revenue
            FROM im_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            LEFT JOIN im_warehouse w ON w.id = t.warehouse_id
            LEFT JOIN im_transaction_detail dt ON dt.header_id = t.id
            LEFT JOIN ar_transaction ar ON ar.id = t.linked_ar_transaction_id
            WHERE d.sys_module = '31' AND d.sys_doc_type = '32'
              ${extraFilters}
            GROUP BY t.id, t.doc_no, t.doc_date, t.status, t.customer_id, t.customer_code, t.customer_name_th,
                     t.warehouse_id, w.warehouse_code, w.warehouse_name_th, t.ref_no, t.linked_ar_transaction_id, ar.subtotal_lc
            ORDER BY t.customer_code ASC, t.doc_date ASC
        `, params);

        // จัดกลุ่มตามลูกค้า เหมือนรายงาน GR Billing (ฝั่งผู้ขาย)
        const customerMap = new Map();
        for (const row of result.rows) {
            const cid = row.customer_id;
            if (!customerMap.has(cid)) {
                customerMap.set(cid, {
                    customer_id: cid,
                    customer_code: row.customer_code,
                    customer_name_th: row.customer_name_th,
                    documents: [],
                });
            }
            customerMap.get(cid).documents.push({
                id: row.id,
                doc_no: row.doc_no,
                doc_date: row.doc_date,
                status: row.status,
                warehouse_code: row.warehouse_code,
                warehouse_name_th: row.warehouse_name_th,
                ref_no: row.ref_no,
                linked_ar_transaction_id: row.linked_ar_transaction_id,
                days_outstanding: row.status === 'Delivered' ? Number(row.days_outstanding) : null,
                cogs_value: Number(row.cogs_value),
                estimated_revenue: row.status === 'Delivered' ? Number(row.estimated_revenue) : null,
                billed_revenue: row.status === 'Posted' ? Number(row.billed_revenue) || 0 : null,
            });
        }

        res.json(Array.from(customerMap.values()));
    } catch (err) {
        console.error('IM DLN Billing Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getDlnBillingReport };
