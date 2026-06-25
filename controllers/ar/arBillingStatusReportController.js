// controllers/ar/arBillingStatusReportController.js
// รายงานสถานะใบวางบิล — ตรวจดูว่าได้ชำระแล้วหรือไม่

const getBillingStatusReport = async (req, res) => {
    const {
        date_from, date_to,
        branch_id, customer_group_id,
        customer_code_from, customer_code_to,
        status_filter,  // 'all' | 'pending' | 'paid' | 'void'
        sort_by,        // 'doc_type' | 'customer'
    } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        const params  = [dateFrom, dateTo];
        const filters = [
            "d.sys_doc_type = '70'",
            'bc.doc_date >= $1::date',
            'bc.doc_date <= $2::date',
        ];

        if (status_filter === 'pending') {
            filters.push("bc.status = 'Posted'");
            filters.push('bc.balance_amount_lc > 0');
        } else if (status_filter === 'paid') {
            filters.push("bc.status = 'Posted'");
            filters.push('bc.balance_amount_lc <= 0');
        } else if (status_filter === 'void') {
            filters.push("bc.status = 'Void'");
        }
        // 'all': no status filter

        if (branch_id) {
            params.push(parseInt(branch_id));
            filters.push(`bc.branch_id = $${params.length}`);
        }
        if (customer_group_id) {
            const groupIds = String(customer_group_id)
                .split(',')
                .map(s => parseInt(s.trim()))
                .filter(n => !isNaN(n));
            if (groupIds.length > 0) {
                params.push(groupIds);
                filters.push(`c.customer_group_id = ANY($${params.length})`);
            }
        }
        if (customer_code_from) {
            params.push(customer_code_from);
            filters.push(`bc.customer_code >= $${params.length}`);
        }
        if (customer_code_to) {
            params.push(customer_code_to);
            filters.push(`bc.customer_code <= $${params.length}`);
        }

        const whereClause = filters.join('\n  AND ');

        const orderClause = sort_by === 'customer'
            ? 'bc.customer_code ASC, bc.doc_date ASC, bc.doc_no ASC'
            : 'd.sys_doc_type ASC, bc.doc_no ASC';

        const bcResult = await client.query(`
            SELECT
                bc.id               AS bc_id,
                bc.doc_no           AS bc_doc_no,
                bc.doc_date         AS bc_doc_date,
                bc.customer_id,
                bc.customer_code,
                bc.customer_name_th,
                bc.total_amount_lc,
                bc.balance_amount_lc,
                bc.status,
                d.doc_code,
                d.doc_name_thai,
                d.sys_doc_type
            FROM ar_transaction bc
            JOIN sa_module_document d ON d.id = bc.doc_id
            LEFT JOIN ar_customer c   ON c.id = bc.customer_id
            WHERE ${whereClause}
            ORDER BY ${orderClause}
        `, params);

        if (bcResult.rows.length === 0) {
            return res.json([]);
        }

        // Fetch linked invoices for all BCs in one query
        const bcIds = bcResult.rows.map(r => r.bc_id);
        const detailResult = await client.query(`
            SELECT
                ta.transaction_id   AS bc_id,
                inv.id              AS inv_id,
                inv.doc_no          AS inv_doc_no,
                inv.doc_date        AS inv_doc_date,
                inv.ref_doc_no      AS inv_ref_doc_no,
                inv.balance_amount_lc AS inv_balance,
                ta.applied_amount_lc AS applied_amount,
                inv_d.doc_name_thai AS inv_doc_name,
                inv_d.sys_doc_type  AS inv_sys_doc_type
            FROM ar_transaction_apply ta
            JOIN ar_transaction inv       ON inv.id   = ta.applied_to_id
            JOIN sa_module_document inv_d ON inv_d.id = inv.doc_id
            WHERE ta.transaction_id = ANY($1::int[])
              AND ta.apply_type = 'bc_invoice'
            ORDER BY ta.transaction_id, inv.doc_date, inv.doc_no
        `, [bcIds]);

        const invMap = new Map();
        for (const row of detailResult.rows) {
            if (!invMap.has(row.bc_id)) invMap.set(row.bc_id, []);
            invMap.get(row.bc_id).push({
                inv_id:         row.inv_id,
                doc_no:         row.inv_doc_no,
                doc_date:       row.inv_doc_date,
                ref_doc_no:     row.inv_ref_doc_no || '',
                doc_name_thai:  row.inv_doc_name,
                sys_doc_type:   row.inv_sys_doc_type,
                applied_amount: Number(row.applied_amount || 0),
                inv_balance:    Number(row.inv_balance    || 0),
            });
        }

        const result = bcResult.rows.map(bc => ({
            bc_id:             bc.bc_id,
            bc_doc_no:         bc.bc_doc_no,
            bc_doc_date:       bc.bc_doc_date,
            customer_id:       bc.customer_id,
            customer_code:     bc.customer_code,
            customer_name_th:  bc.customer_name_th,
            total_amount_lc:   Number(bc.total_amount_lc   || 0),
            balance_amount_lc: Number(bc.balance_amount_lc || 0),
            status:            bc.status,
            doc_code:          bc.doc_code,
            doc_name_thai:     bc.doc_name_thai,
            sys_doc_type:      bc.sys_doc_type,
            invoices:          invMap.get(bc.bc_id) || [],
        }));

        res.json(result);
    } catch (err) {
        console.error('AR Billing Status Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getBillingStatusReport };
