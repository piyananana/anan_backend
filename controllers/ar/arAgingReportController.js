// controllers/ar/arAgingReportController.js
// รายงานลูกหนี้คงค้างตามอายุ (AR Aging Report)

const getAgingReport = async (req, res) => {
    const { as_of_date, branch_id } = req.query;
    const asOf = as_of_date || new Date().toISOString().slice(0, 10);
    const client = await req.dbPool.connect();
    try {
        const params = [asOf];
        let branchFilter = '';
        if (branch_id) {
            params.push(parseInt(branch_id));
            branchFilter = `AND t.branch_id = $${params.length}`;
        }

        // ดึงธุรกรรม AR ที่ยังค้างชำระ: Invoice + DN เท่านั้น
        const result = await client.query(`
            SELECT
                t.customer_id,
                t.customer_code,
                t.customer_name_th,
                t.doc_no,
                d.doc_code,
                d.doc_name_thai,
                d.sys_doc_type,
                t.doc_date,
                t.due_date,
                t.currency_code,
                t.balance_amount_lc,
                t.branch_id,
                b.branch_code,
                b.branch_name_thai,
                ($1::date - COALESCE(t.due_date, t.doc_date)::date) AS days_overdue
            FROM ar_transaction t
            JOIN sa_module_document d ON t.doc_id = d.id
            LEFT JOIN cd_branch b ON b.id = t.branch_id
            WHERE t.status = 'Posted'
              AND t.balance_amount_lc > 0.005
              AND d.sys_module = '11'
              AND d.sys_doc_type IN ('10', '30', '35')
              AND t.doc_date <= $1::date
              ${branchFilter}
            ORDER BY t.customer_code ASC, COALESCE(t.due_date, t.doc_date) ASC
        `, params);

        // จัดกลุ่มตามลูกค้า
        const customerMap = new Map();
        for (const row of result.rows) {
            const cid = row.customer_id;
            if (!customerMap.has(cid)) {
                customerMap.set(cid, {
                    customer_id: cid,
                    customer_code: row.customer_code,
                    customer_name_th: row.customer_name_th,
                    invoices: [],
                });
            }
            customerMap.get(cid).invoices.push({
                doc_no:           row.doc_no,
                doc_code:         row.doc_code,
                doc_name_thai:    row.doc_name_thai,
                sys_doc_type:     row.sys_doc_type,
                doc_date:         row.doc_date,
                due_date:         row.due_date,
                currency_code:    row.currency_code,
                balance_amount_lc: Number(row.balance_amount_lc),
                days_overdue:     Number(row.days_overdue),
                branch_code:      row.branch_code,
                branch_name_thai: row.branch_name_thai,
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
