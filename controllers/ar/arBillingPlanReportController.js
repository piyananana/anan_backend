// controllers/ar/arBillingPlanReportController.js
// รายงานวันวางบิล (Billing Plan Report)
// ใช้วางแผนมอบหมายงานให้ผู้วางบิลไปติดต่อลูกหนี้ตามกำหนด
// ดึงเฉพาะ Invoice/DN ที่ยังค้างชำระ (balance > 0) และมี billing_date กำหนดไว้

const DR_TYPES = ['10', '30', '35']; // Invoice, DN, DN-with-bill

const getBillingPlanReport = async (req, res) => {
    const {
        date_from,
        date_to,
        customer_group_id,
        billing_collector_id,
        customer_code_from,
        customer_code_to,
    } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        // Fixed params: $1=dateFrom, $2=dateTo, $3=DR_TYPES
        const params  = [dateFrom, dateTo, DR_TYPES];
        const filters = [];

        if (customer_group_id) {
            params.push(parseInt(customer_group_id));
            filters.push(`c.customer_group_id = $${params.length}`);
        }
        if (billing_collector_id) {
            params.push(parseInt(billing_collector_id));
            filters.push(`c.billing_collector_id = $${params.length}`);
        }
        if (customer_code_from) {
            params.push(customer_code_from);
            filters.push(`t.customer_code >= $${params.length}`);
        }
        if (customer_code_to) {
            params.push(customer_code_to);
            filters.push(`t.customer_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

        const result = await client.query(`
            SELECT
                c.billing_collector_id,
                coll.collector_code,
                coll.collector_name_thai,
                t.id                    AS txn_id,
                t.customer_id,
                t.billing_date,
                t.doc_no,
                t.doc_date,
                t.due_date,
                t.expected_payment_date,
                t.customer_code,
                t.customer_name_th,
                t.total_amount_lc,
                t.balance_amount_lc,
                t.ref_no,
                d.doc_name_thai,
                d.sys_doc_type,
                contact.customer_phone
            FROM ar_transaction t
            JOIN sa_module_document d    ON d.id  = t.doc_id
            LEFT JOIN ar_customer  c    ON c.id  = t.customer_id
            LEFT JOIN ar_collector coll ON coll.id = c.billing_collector_id
            -- เบอร์โทรติดต่อหลักของลูกค้า
            LEFT JOIN LATERAL (
                SELECT COALESCE(cc.phone, cc.mobile) AS customer_phone
                FROM ar_customer_contact cc
                WHERE cc.customer_id = t.customer_id
                  AND cc.is_default  = true
                LIMIT 1
            ) contact ON true
            WHERE t.status         = 'Posted'
              AND t.billing_date   IS NOT NULL
              AND t.billing_date   >= $1::date
              AND t.billing_date   <= $2::date
              AND t.balance_amount_lc > 0
              AND d.sys_doc_type   = ANY($3::text[])
              -- ไม่แสดงใบที่มีใบวางบิล (BC) ที่ยังไม่ได้รับชำระ
              AND NOT EXISTS (
                  SELECT 1
                  FROM ar_transaction_apply ta
                  JOIN ar_transaction        bc  ON bc.id  = ta.transaction_id
                  JOIN sa_module_document    bcd ON bcd.id = bc.doc_id
                  WHERE ta.applied_to_id      = t.id
                    AND ta.apply_type         = 'bc_invoice'
                    AND bc.status             = 'Posted'
                    AND bc.balance_amount_lc  > 0
                    AND bcd.sys_doc_type      = '70'
              )
              ${extraFilters}
            ORDER BY
                coll.collector_code    ASC NULLS LAST,
                t.billing_date         ASC,
                t.customer_code        ASC,
                t.doc_date             ASC,
                t.doc_no               ASC
        `, params);

        // จัดกลุ่มตาม billing_collector_id
        const collMap = new Map();
        for (const row of result.rows) {
            const key = row.billing_collector_id ?? '__none__';
            if (!collMap.has(key)) {
                collMap.set(key, {
                    collector_id:         row.billing_collector_id,
                    collector_code:       row.collector_code       || '',
                    collector_name_thai:  row.collector_name_thai  || '(ไม่ระบุผู้วางบิล)',
                    invoices:             [],
                });
            }
            const collector = collMap.get(key);

            if (row.txn_id != null) {
                collector.invoices.push({
                    txn_id:                row.txn_id,
                    customer_id:           row.customer_id,
                    billing_date:          row.billing_date,
                    doc_no:                row.doc_no,
                    doc_date:              row.doc_date,
                    due_date:              row.due_date,
                    expected_payment_date: row.expected_payment_date,
                    customer_code:         row.customer_code        || '',
                    customer_name_th:      row.customer_name_th     || '',
                    customer_phone:        row.customer_phone        || '',
                    total_amount_lc:       Number(row.total_amount_lc   || 0),
                    balance_amount_lc:     Number(row.balance_amount_lc || 0),
                    ref_no:                row.ref_no                || '',
                    doc_name_thai:         row.doc_name_thai         || '',
                    sys_doc_type:          row.sys_doc_type,
                });
            }
        }

        const collectors = Array.from(collMap.values())
            .filter(c => c.invoices.length > 0)
            .map(c => ({
                ...c,
                total_amount:  c.invoices.reduce((s, i) => s + i.total_amount_lc,   0),
                total_balance: c.invoices.reduce((s, i) => s + i.balance_amount_lc, 0),
            }));

        res.json(collectors);
    } catch (err) {
        console.error('Billing Plan Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getBillingPlanReport };
