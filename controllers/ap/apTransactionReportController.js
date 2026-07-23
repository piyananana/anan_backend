// controllers/ap/apTransactionReportController.js
// รายงานธุรกรรมเจ้าหนี้ — ยอดสรุปและรายละเอียดตามประเภทเอกสาร

// AP doc types: PI(10) CN(30) DN(50) จ่ายมัดจำ(60) คืนมัดจำ(65) ชำระ(80)
const AP_TYPES = ['10', '30', '50', '60', '65', '80'];

const getTransactionReport = async (req, res) => {
    const {
        date_from, date_to,
        branch_id, vendor_group_id,
        vendor_code_from, vendor_code_to,
        sort_by,  // 'vendor' | 'doc_type'
    } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        // Fixed params: $1=dateFrom, $2=dateTo, $3=AP_TYPES
        const params  = [dateFrom, dateTo, AP_TYPES];
        const filters = [];

        if (branch_id) {
            params.push(parseInt(branch_id));
            filters.push(`t.branch_id = $${params.length}`);
        }
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
            filters.push(`t.vendor_code >= $${params.length}`);
        }
        if (vendor_code_to) {
            params.push(vendor_code_to);
            filters.push(`t.vendor_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

        const innerOrder = sort_by === 'doc_type'
            ? 'd.sys_doc_type ASC, t.doc_date ASC, t.doc_no ASC'
            : 't.doc_date ASC, t.doc_no ASC';

        const result = await client.query(`
            SELECT
                t.vendor_id,
                t.vendor_code,
                t.vendor_name_th,
                v.vendor_name_en,
                t.id           AS txn_id,
                t.doc_no,
                t.doc_date,
                t.ref_doc_no,
                t.total_amount_lc,
                d.doc_name_thai,
                d.sys_doc_type
            FROM ap_transaction t
            JOIN sa_module_document d  ON d.id = t.doc_id
            LEFT JOIN ap_vendor v      ON v.id = t.vendor_id
            WHERE t.status        = 'Posted'
              AND d.sys_doc_type  = ANY($3::text[])
              AND t.doc_date     >= $1::date
              AND t.doc_date     <= $2::date
              ${extraFilters}
            ORDER BY
                t.vendor_code ASC,
                ${innerOrder}
        `, params);

        // จัดกลุ่มตาม vendor
        const vendorMap = new Map();
        for (const row of result.rows) {
            const vid = row.vendor_id;
            if (!vendorMap.has(vid)) {
                vendorMap.set(vid, {
                    vendor_id:      vid,
                    vendor_code:    row.vendor_code,
                    vendor_name_th: row.vendor_name_th,
                    vendor_name_en: row.vendor_name_en,
                    pi_amount:   0,  // sys_doc_type = '10'
                    cn_amount:   0,  // '30'
                    dn_amount:   0,  // '50'
                    adv_amount:  0,  // '60'
                    ret_amount:  0,  // '65'
                    pay_amount:  0,  // '80'
                    transactions: [],
                });
            }
            const vend = vendorMap.get(vid);
            const amt  = Number(row.total_amount_lc || 0);
            const sdt  = row.sys_doc_type;

            if      (sdt === '10') vend.pi_amount  += amt;
            else if (sdt === '30') vend.cn_amount  += amt;
            else if (sdt === '50') vend.dn_amount  += amt;
            else if (sdt === '60') vend.adv_amount += amt;
            else if (sdt === '65') vend.ret_amount += amt;
            else if (sdt === '80') vend.pay_amount += amt;

            vend.transactions.push({
                txn_id:          row.txn_id,
                doc_no:          row.doc_no,
                doc_date:        row.doc_date,
                ref_doc_no:      row.ref_doc_no || '',
                doc_name_thai:   row.doc_name_thai,
                sys_doc_type:    sdt,
                total_amount_lc: amt,
            });
        }

        res.json(Array.from(vendorMap.values()));
    } catch (err) {
        console.error('AP Transaction Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getTransactionReport };
