// controllers/ar/arAgingReportController.js
// รายงานลูกหนี้คงค้างตามอายุ (AR Aging Report)

const getAgingReport = async (req, res) => {
    const {
        as_of_date,
        branch_id,
        customer_group_id,
        salesperson_id,
        customer_code_from,
        customer_code_to,
    } = req.query;

    const asOf = as_of_date || new Date().toISOString().slice(0, 10);
    const client = await req.dbPool.connect();
    try {
        const params = [asOf];
        const filters = [];

        // สาขา
        if (branch_id) {
            params.push(parseInt(branch_id));
            filters.push(`t.branch_id = $${params.length}`);
        }

        // กลุ่มลูกค้า
        if (customer_group_id) {
            params.push(parseInt(customer_group_id));
            filters.push(`c.customer_group_id = $${params.length}`);
        }

        // พนักงานขาย
        if (salesperson_id) {
            params.push(parseInt(salesperson_id));
            filters.push(`c.salesperson_id = $${params.length}`);
        }

        // รหัสลูกค้า ตั้งแต่
        if (customer_code_from) {
            params.push(customer_code_from);
            filters.push(`t.customer_code >= $${params.length}`);
        }

        // รหัสลูกค้า ถึง
        if (customer_code_to) {
            params.push(customer_code_to);
            filters.push(`t.customer_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

        // ดึงธุรกรรม AR ที่ยังค้างชำระ: Invoice + DN เท่านั้น
        const result = await client.query(`
            SELECT
                -- ข้อมูลลูกค้า
                t.customer_id,
                t.customer_code,
                t.customer_name_th,
                c.customer_group_id,
                cg.group_code          AS customer_group_code,
                cg.group_name_thai     AS customer_group_name,
                c.salesperson_id,
                sp.salesperson_code,
                sp.salesperson_name_thai,
                -- ข้อมูลเอกสาร
                t.doc_no,
                d.doc_code,
                d.doc_name_thai,
                d.sys_doc_type,
                t.doc_date,
                t.billing_date,
                t.due_date,
                t.expected_payment_date,
                t.currency_code,
                t.balance_amount_lc,
                -- ข้อมูลสาขา
                t.branch_id,
                b.branch_code,
                b.branch_name_thai,
                -- จำนวนวันค้างชำระ (ลบถ้ายังไม่ถึงกำหนด)
                ($1::date - COALESCE(t.due_date, t.doc_date)::date) AS days_overdue
            FROM ar_transaction t
            JOIN sa_module_document d  ON t.doc_id = d.id
            LEFT JOIN cd_branch b      ON b.id = t.branch_id
            LEFT JOIN ar_customer c    ON c.id = t.customer_id
            LEFT JOIN ar_customer_group cg  ON cg.id = c.customer_group_id
            LEFT JOIN cd_salesperson sp     ON sp.id = c.salesperson_id
            WHERE t.status = 'Posted'
              AND t.balance_amount_lc > 0.005
              AND d.sys_module = '11'
              AND d.sys_doc_type IN ('10', '30', '35')
              AND t.doc_date <= $1::date
              ${extraFilters}
            ORDER BY t.customer_code ASC, COALESCE(t.due_date, t.doc_date) ASC
        `, params);

        // จัดกลุ่มตามลูกค้า
        const customerMap = new Map();
        for (const row of result.rows) {
            const cid = row.customer_id;
            if (!customerMap.has(cid)) {
                customerMap.set(cid, {
                    customer_id:           cid,
                    customer_code:         row.customer_code,
                    customer_name_th:      row.customer_name_th,
                    customer_group_id:     row.customer_group_id,
                    customer_group_code:   row.customer_group_code,
                    customer_group_name:   row.customer_group_name,
                    salesperson_id:        row.salesperson_id,
                    salesperson_code:      row.salesperson_code,
                    salesperson_name_thai: row.salesperson_name_thai,
                    invoices: [],
                });
            }
            customerMap.get(cid).invoices.push({
                doc_no:                 row.doc_no,
                doc_code:               row.doc_code,
                doc_name_thai:          row.doc_name_thai,
                sys_doc_type:           row.sys_doc_type,
                doc_date:               row.doc_date,
                billing_date:           row.billing_date,
                due_date:               row.due_date,
                expected_payment_date:  row.expected_payment_date,
                currency_code:          row.currency_code,
                balance_amount_lc:      Number(row.balance_amount_lc),
                days_overdue:           Number(row.days_overdue),
                branch_code:            row.branch_code,
                branch_name_thai:       row.branch_name_thai,
            });
        }

        res.json(Array.from(customerMap.values()));
    } catch (err) {
        console.error('AR Aging Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getAgingReport };
