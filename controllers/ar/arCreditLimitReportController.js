// controllers/ar/arCreditLimitReportController.js
// รายงานวงเงินคงเหลือลูกหนี้

const getCreditLimitReport = async (req, res) => {
    const {
        customer_group_id,
        salesperson_id,
        customer_code_from,
        customer_code_to,
        credit_status, // 'over' | 'remaining' | 'full' | '' (all)
        sort_by,       // 'customer' | 'remaining_asc' | 'remaining_desc'
    } = req.query;

    const client = await req.dbPool.connect();
    try {
        const params  = [];
        const filters = [];

        if (customer_group_id) {
            params.push(parseInt(customer_group_id));
            filters.push(`c.customer_group_id = $${params.length}`);
        }
        if (salesperson_id) {
            params.push(parseInt(salesperson_id));
            filters.push(`c.salesperson_id = $${params.length}`);
        }
        if (customer_code_from) {
            params.push(customer_code_from);
            filters.push(`c.customer_code >= $${params.length}`);
        }
        if (customer_code_to) {
            params.push(customer_code_to);
            filters.push(`c.customer_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

        // sort expression สำหรับ ORDER BY — ต้องใช้ aggregate expression เต็ม (alias ใช้ใน ORDER BY กับ GROUP BY ไม่ได้)
        const outstandingExpr = `COALESCE(SUM(t.balance_amount_lc) FILTER (
                    WHERE t.status = 'Posted'
                      AND d.sys_doc_type IN ('10','30','35')
                      AND t.balance_amount_lc > 0.005
                ), 0)`;
        let orderExpr;
        switch (sort_by) {
            case 'remaining_asc':
                orderExpr = `(COALESCE(c.credit_limit,0) - ${outstandingExpr}) ASC NULLS LAST, c.customer_code ASC`;
                break;
            case 'remaining_desc':
                orderExpr = `(COALESCE(c.credit_limit,0) - ${outstandingExpr}) DESC NULLS LAST, c.customer_code ASC`;
                break;
            default:
                orderExpr = 'c.customer_code ASC';
        }

        // credit_status filter (HAVING)
        let havingClause = '';
        if (credit_status === 'no_limit') {
            // ไม่ระบุวงเงิน: credit_limit = 0 หรือ NULL
            havingClause = `HAVING COALESCE(c.credit_limit,0) = 0`;
        } else if (credit_status === 'over') {
            // เกินวงเงิน: มีวงเงิน AND outstanding >= credit_limit
            havingClause = `HAVING COALESCE(c.credit_limit,0) > 0
                       AND COALESCE(SUM(t.balance_amount_lc) FILTER (
                               WHERE t.status='Posted'
                                 AND d.sys_doc_type IN ('10','30','35')
                                 AND t.balance_amount_lc > 0.005
                           ), 0) >= COALESCE(c.credit_limit,0)`;
        } else if (credit_status === 'remaining') {
            // ยังเหลือวงเงิน: มีวงเงิน AND 0 < outstanding < credit_limit
            havingClause = `HAVING COALESCE(c.credit_limit,0) > 0
                       AND COALESCE(SUM(t.balance_amount_lc) FILTER (
                               WHERE t.status='Posted'
                                 AND d.sys_doc_type IN ('10','30','35')
                                 AND t.balance_amount_lc > 0.005
                           ), 0) > 0
                       AND COALESCE(SUM(t.balance_amount_lc) FILTER (
                               WHERE t.status='Posted'
                                 AND d.sys_doc_type IN ('10','30','35')
                                 AND t.balance_amount_lc > 0.005
                           ), 0) < COALESCE(c.credit_limit,0)`;
        } else if (credit_status === 'full') {
            // เหลือเต็มวงเงิน: มีวงเงิน AND outstanding = 0
            havingClause = `HAVING COALESCE(c.credit_limit,0) > 0
                       AND COALESCE(SUM(t.balance_amount_lc) FILTER (
                               WHERE t.status='Posted'
                                 AND d.sys_doc_type IN ('10','30','35')
                                 AND t.balance_amount_lc > 0.005
                           ), 0) = 0`;
        }

        const result = await client.query(`
            SELECT
                c.id              AS customer_id,
                c.customer_code,
                c.customer_name_th,
                COALESCE(c.credit_limit, 0) AS credit_limit,
                COALESCE(SUM(t.balance_amount_lc) FILTER (
                    WHERE t.status = 'Posted'
                      AND d.sys_doc_type IN ('10','30','35')
                      AND t.balance_amount_lc > 0.005
                ), 0) AS outstanding
            FROM ar_customer c
            LEFT JOIN ar_transaction t     ON t.customer_id = c.id
            LEFT JOIN sa_module_document d ON d.id = t.doc_id
            WHERE c.is_active = true
              ${extraFilters}
            GROUP BY c.id, c.customer_code, c.customer_name_th, c.credit_limit
            ${havingClause}
            ORDER BY ${orderExpr}
        `, params);

        const rows = result.rows.map(r => {
            const creditLimit   = Number(r.credit_limit   || 0);
            const outstanding   = Number(r.outstanding    || 0);
            const remaining     = creditLimit - outstanding;

            let status;
            if (creditLimit <= 0) {
                status = 'no_limit';       // ไม่ระบุวงเงิน
            } else if (outstanding <= 0) {
                status = 'full';           // เหลือเต็มวงเงิน
            } else if (outstanding >= creditLimit) {
                status = 'over';           // เกินวงเงิน
            } else {
                status = 'remaining';      // ยังเหลือวงเงิน
            }

            return {
                customer_id:      r.customer_id,
                customer_code:    r.customer_code,
                customer_name_th: r.customer_name_th,
                credit_limit:     creditLimit,
                outstanding:      outstanding,
                remaining:        remaining,
                credit_status:    status,
            };
        });

        res.json(rows);
    } catch (err) {
        console.error('AR Credit Limit Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getCreditLimitReport };
