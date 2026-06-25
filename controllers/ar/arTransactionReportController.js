// controllers/ar/arTransactionReportController.js
// รายงานธุรกรรมลูกหนี้ — ยอดสรุปและรายละเอียดตามประเภทเอกสาร

const AR_TYPES = ['10', '30', '35', '50', '55', '60', '65', '80'];

const getTransactionReport = async (req, res) => {
    const {
        date_from, date_to,
        branch_id, customer_group_id, salesperson_id,
        customer_code_from, customer_code_to,
        sort_by,  // 'customer' | 'doc_type'
    } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        // Fixed params: $1=dateFrom, $2=dateTo, $3=AR_TYPES
        const params  = [dateFrom, dateTo, AR_TYPES];
        const filters = [];

        if (branch_id) {
            params.push(parseInt(branch_id));
            filters.push(`t.branch_id = $${params.length}`);
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
        if (salesperson_id) {
            params.push(parseInt(salesperson_id));
            filters.push(`c.salesperson_id = $${params.length}`);
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

        // จัดเรียงใน SQL: customer เป็น primary, ภายใน customer sort ตาม sort_by
        const innerOrder = sort_by === 'doc_type'
            ? 'd.sys_doc_type ASC, t.doc_date ASC, t.doc_no ASC'
            : 't.doc_date ASC, t.doc_no ASC';

        const result = await client.query(`
            SELECT
                t.customer_id,
                t.customer_code,
                t.customer_name_th,
                t.id           AS txn_id,
                t.doc_no,
                t.doc_date,
                t.ref_doc_no,
                t.total_amount_lc,
                d.doc_name_thai,
                d.sys_doc_type
            FROM ar_transaction t
            JOIN sa_module_document d  ON d.id = t.doc_id
            LEFT JOIN ar_customer   c  ON c.id = t.customer_id
            WHERE t.status        = 'Posted'
              AND d.sys_doc_type  = ANY($3::text[])
              AND t.doc_date     >= $1::date
              AND t.doc_date     <= $2::date
              ${extraFilters}
            ORDER BY
                t.customer_code ASC,
                ${innerOrder}
        `, params);

        // จัดกลุ่มตาม customer
        const custMap = new Map();
        for (const row of result.rows) {
            const cid = row.customer_id;
            if (!custMap.has(cid)) {
                custMap.set(cid, {
                    customer_id:      cid,
                    customer_code:    row.customer_code,
                    customer_name_th: row.customer_name_th,
                    inv_amount:  0,  // sys_doc_type = '10'
                    dn_amount:   0,  // '30','35'
                    cn_amount:   0,  // '50','55'
                    adv_amount:  0,  // '60'
                    ret_amount:  0,  // '65'
                    rec_amount:  0,  // '80'
                    transactions: [],
                });
            }
            const cust = custMap.get(cid);
            const amt  = Number(row.total_amount_lc || 0);
            const sdt  = row.sys_doc_type;

            if      (sdt === '10')               cust.inv_amount += amt;
            else if (sdt === '30' || sdt === '35') cust.dn_amount  += amt;
            else if (sdt === '50' || sdt === '55') cust.cn_amount  += amt;
            else if (sdt === '60')               cust.adv_amount += amt;
            else if (sdt === '65')               cust.ret_amount += amt;
            else if (sdt === '80')               cust.rec_amount += amt;

            cust.transactions.push({
                txn_id:        row.txn_id,
                doc_no:        row.doc_no,
                doc_date:      row.doc_date,
                ref_doc_no:    row.ref_doc_no || '',
                doc_name_thai: row.doc_name_thai,
                sys_doc_type:  sdt,
                total_amount_lc: amt,
            });
        }

        res.json(Array.from(custMap.values()));
    } catch (err) {
        console.error('AR Transaction Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getTransactionReport };
