// controllers/ap/apPaymentReportController.js
// รายงานการชำระเงินเจ้าหนี้ — ยอดสรุปตามประเภทการชำระเงิน

const getPaymentReport = async (req, res) => {
    const {
        date_from, date_to,
        vendor_group_id,
        vendor_code_from, vendor_code_to,
        sort_by, // 'vendor' | 'amount_desc' | 'amount_asc'
    } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        // Ensure ap_transaction_payment table exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS ap_transaction_payment (
                id                   SERIAL PRIMARY KEY,
                header_id            INT NOT NULL REFERENCES ap_transaction(id) ON DELETE CASCADE,
                line_no              INT NOT NULL DEFAULT 1,
                payment_method_id    INT REFERENCES cm_payment_method(id),
                payment_method_code  VARCHAR(50),
                payment_method_name  VARCHAR(200),
                payment_method_type  VARCHAR(30) NOT NULL DEFAULT 'CASH',
                cm_bank_account_id   INT REFERENCES cm_bank_account(id),
                gl_account_id        INT REFERENCES gl_account(id),
                amount_lc            NUMERIC(18,4) NOT NULL DEFAULT 0,
                amount_fc            NUMERIC(18,4) NOT NULL DEFAULT 0,
                ref_no               VARCHAR(100),
                payment_date         DATE,
                remark               TEXT,
                drawer_bank_name     VARCHAR(100),
                drawer_bank_branch   VARCHAR(100),
                drawer_account_no    VARCHAR(50),
                card_type            VARCHAR(20),
                card_last4           CHAR(4),
                approval_code        VARCHAR(20),
                terminal_id          VARCHAR(20),
                batch_no             VARCHAR(20),
                created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
                created_by           VARCHAR(100)
            )
        `);

        // Fixed params: $1=dateFrom, $2=dateTo
        const params  = [dateFrom, dateTo];
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
            filters.push(`t.vendor_code >= $${params.length}`);
        }
        if (vendor_code_to) {
            params.push(vendor_code_to);
            filters.push(`t.vendor_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

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
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type = 'CASH'), 0)                                     AS cash_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type = 'CHECK'), 0)                                    AS check_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type IN ('CREDIT_CARD','DEBIT_CARD')), 0)              AS card_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type = 'TRANSFER'), 0)                                 AS transfer_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type IN ('MOBILE_BANKING','QR_CODE')), 0)              AS internet_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type = 'BILL_OF_EXCHANGE'), 0)                        AS boe_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type NOT IN
                    ('CASH','CHECK','CREDIT_CARD','DEBIT_CARD','TRANSFER','MOBILE_BANKING','QR_CODE','BILL_OF_EXCHANGE')), 0)    AS other_amount
            FROM ap_transaction t
            JOIN sa_module_document d  ON d.id = t.doc_id
            LEFT JOIN ap_vendor v      ON v.id = t.vendor_id
            LEFT JOIN ap_transaction_payment p ON p.header_id = t.id
            WHERE t.status        = 'Posted'
              AND d.sys_doc_type  = '80'
              AND t.doc_date     >= $1::date
              AND t.doc_date     <= $2::date
              ${extraFilters}
            GROUP BY
                t.vendor_id, t.vendor_code, t.vendor_name_th, v.vendor_name_en,
                t.id, t.doc_no, t.doc_date, t.ref_doc_no, t.total_amount_lc
            ORDER BY t.vendor_code ASC, t.doc_date ASC, t.doc_no ASC
        `, params);

        // จัดกลุ่มตาม vendor
        const vendorMap = new Map();
        for (const row of result.rows) {
            const vid = row.vendor_id;
            if (!vendorMap.has(vid)) {
                vendorMap.set(vid, {
                    vendor_id:       vid,
                    vendor_code:     row.vendor_code,
                    vendor_name_th:  row.vendor_name_th,
                    vendor_name_en:  row.vendor_name_en,
                    total_amount:    0,
                    cash_amount:     0,
                    check_amount:    0,
                    card_amount:     0,
                    transfer_amount: 0,
                    internet_amount: 0,
                    boe_amount:      0,
                    other_amount:    0,
                    payments:        [],
                });
            }
            const vend = vendorMap.get(vid);
            const amt  = Number(row.total_amount_lc || 0);
            vend.total_amount    += amt;
            vend.cash_amount     += Number(row.cash_amount     || 0);
            vend.check_amount    += Number(row.check_amount    || 0);
            vend.card_amount     += Number(row.card_amount     || 0);
            vend.transfer_amount += Number(row.transfer_amount || 0);
            vend.internet_amount += Number(row.internet_amount || 0);
            vend.boe_amount      += Number(row.boe_amount      || 0);
            vend.other_amount    += Number(row.other_amount    || 0);

            vend.payments.push({
                txn_id:          row.txn_id,
                doc_no:          row.doc_no,
                doc_date:        row.doc_date,
                ref_doc_no:      row.ref_doc_no || '',
                total_amount_lc: amt,
                cash_amount:     Number(row.cash_amount     || 0),
                check_amount:    Number(row.check_amount    || 0),
                card_amount:     Number(row.card_amount     || 0),
                transfer_amount: Number(row.transfer_amount || 0),
                internet_amount: Number(row.internet_amount || 0),
                boe_amount:      Number(row.boe_amount      || 0),
                other_amount:    Number(row.other_amount    || 0),
            });
        }

        let vendors = Array.from(vendorMap.values());

        if (sort_by === 'amount_desc') {
            vendors.sort((a, b) => b.total_amount - a.total_amount);
        } else if (sort_by === 'amount_asc') {
            vendors.sort((a, b) => a.total_amount - b.total_amount);
        }

        res.json(vendors);
    } catch (err) {
        console.error('AP Payment Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getPaymentReport };
