// controllers/ap/apCreditLimitReportController.js
// รายงานวงเงินคงเหลือผู้ขาย (เหมือน AR แต่ใช้ credit_limit จาก ap_vendor)

const getCreditLimitReport = async (req, res) => {
    const {
        vendor_group_id,
        vendor_code_from,
        vendor_code_to,
        credit_status, // 'over' | 'remaining' | 'full' | 'no_limit' | '' (all)
        sort_by,       // 'vendor' | 'remaining_asc' | 'remaining_desc'
    } = req.query;

    const client = await req.dbPool.connect();
    try {
        // idempotent migration
        await client.query(
            `ALTER TABLE ap_vendor ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(18,4) NOT NULL DEFAULT 0`
        ).catch(() => {});

        const params  = [];
        const filters = [];

        if (vendor_group_id) {
            const groupIds = String(vendor_group_id)
                .split(',')
                .map(s => parseInt(s.trim()))
                .filter(n => !isNaN(n));
            if (groupIds.length > 0) {
                params.push(groupIds);
                filters.push(`v.vendor_group_id = ANY($${params.length})`);
            }
        }
        if (vendor_code_from) {
            params.push(vendor_code_from);
            filters.push(`v.vendor_code >= $${params.length}`);
        }
        if (vendor_code_to) {
            params.push(vendor_code_to);
            filters.push(`v.vendor_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

        // ยอดหนี้คงค้าง = PI(10) + DN(50) ที่ยัง balance_amount_lc > 0
        const outstandingExpr = `COALESCE(SUM(t.balance_amount_lc) FILTER (
                    WHERE t.status = 'Posted'
                      AND d.sys_doc_type IN ('10', '50')
                      AND t.balance_amount_lc > 0.005
                ), 0)`;

        let orderExpr;
        switch (sort_by) {
            case 'remaining_asc':
                orderExpr = `(COALESCE(v.credit_limit,0) - ${outstandingExpr}) ASC NULLS LAST, v.vendor_code ASC`;
                break;
            case 'remaining_desc':
                orderExpr = `(COALESCE(v.credit_limit,0) - ${outstandingExpr}) DESC NULLS LAST, v.vendor_code ASC`;
                break;
            default:
                orderExpr = 'v.vendor_code ASC';
        }

        // HAVING สำหรับกรองตาม credit_status
        let havingClause = '';
        if (credit_status === 'no_limit') {
            havingClause = `HAVING COALESCE(v.credit_limit,0) = 0`;
        } else if (credit_status === 'over') {
            havingClause = `HAVING COALESCE(v.credit_limit,0) > 0
                       AND ${outstandingExpr} >= COALESCE(v.credit_limit,0)`;
        } else if (credit_status === 'remaining') {
            havingClause = `HAVING COALESCE(v.credit_limit,0) > 0
                       AND ${outstandingExpr} > 0
                       AND ${outstandingExpr} < COALESCE(v.credit_limit,0)`;
        } else if (credit_status === 'full') {
            havingClause = `HAVING COALESCE(v.credit_limit,0) > 0
                       AND ${outstandingExpr} = 0`;
        }

        const result = await client.query(`
            SELECT
                v.id              AS vendor_id,
                v.vendor_code,
                v.vendor_name_th,
                v.vendor_name_en,
                COALESCE(v.credit_limit, 0) AS credit_limit,
                ${outstandingExpr}            AS outstanding
            FROM ap_vendor v
            LEFT JOIN ap_transaction t     ON t.vendor_id = v.id
            LEFT JOIN sa_module_document d ON d.id = t.doc_id
            WHERE v.is_active = true
              ${extraFilters}
            GROUP BY v.id, v.vendor_code, v.vendor_name_th, v.vendor_name_en, v.credit_limit
            ${havingClause}
            ORDER BY ${orderExpr}
        `, params);

        const rows = result.rows.map(r => {
            const creditLimit   = Number(r.credit_limit   || 0);
            const outstanding   = Number(r.outstanding    || 0);
            const remaining     = creditLimit - outstanding;

            let status;
            if (creditLimit <= 0) {
                status = 'no_limit';
            } else if (outstanding <= 0) {
                status = 'full';
            } else if (outstanding >= creditLimit) {
                status = 'over';
            } else {
                status = 'remaining';
            }

            return {
                vendor_id:      r.vendor_id,
                vendor_code:    r.vendor_code,
                vendor_name_th: r.vendor_name_th,
                vendor_name_en: r.vendor_name_en,
                credit_limit:   creditLimit,
                outstanding,
                remaining,
                credit_status:  status,
            };
        });

        res.json(rows);
    } catch (err) {
        console.error('AP Credit Limit Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getCreditLimitReport };
