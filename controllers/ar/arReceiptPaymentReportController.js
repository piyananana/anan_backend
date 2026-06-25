// controllers/ar/arReceiptPaymentReportController.js
// รายงานการรับชำระ — ยอดสรุปตามประเภทการชำระเงิน

const getReceiptPaymentReport = async (req, res) => {
    const {
        date_from, date_to,
        customer_group_id, salesperson_id,
        customer_code_from, customer_code_to,
        sort_by, // 'customer' | 'amount_desc' | 'amount_asc'
    } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        // Ensure ar_transaction_payment table exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS ar_transaction_payment (
                id                   SERIAL PRIMARY KEY,
                header_id            INT NOT NULL REFERENCES ar_transaction(id) ON DELETE CASCADE,
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
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type = 'CASH'), 0)                                     AS cash_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type = 'CHECK'), 0)                                    AS check_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type IN ('CREDIT_CARD','DEBIT_CARD')), 0)              AS card_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type = 'TRANSFER'), 0)                                 AS transfer_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type IN ('MOBILE_BANKING','QR_CODE')), 0)              AS internet_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type = 'BILL_OF_EXCHANGE'), 0)                        AS boe_amount,
                COALESCE(SUM(p.amount_lc) FILTER (WHERE p.payment_method_type NOT IN
                    ('CASH','CHECK','CREDIT_CARD','DEBIT_CARD','TRANSFER','MOBILE_BANKING','QR_CODE','BILL_OF_EXCHANGE')), 0)    AS other_amount
            FROM ar_transaction t
            JOIN sa_module_document d  ON d.id = t.doc_id
            LEFT JOIN ar_customer   c  ON c.id = t.customer_id
            LEFT JOIN ar_transaction_payment p ON p.header_id = t.id
            WHERE t.status        = 'Posted'
              AND d.sys_doc_type  = '80'
              AND t.doc_date     >= $1::date
              AND t.doc_date     <= $2::date
              ${extraFilters}
            GROUP BY
                t.customer_id, t.customer_code, t.customer_name_th,
                t.id, t.doc_no, t.doc_date, t.ref_doc_no, t.total_amount_lc
            ORDER BY t.customer_code ASC, t.doc_date ASC, t.doc_no ASC
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
                    total_amount:     0,
                    cash_amount:      0,
                    check_amount:     0,
                    card_amount:      0,
                    transfer_amount:  0,
                    internet_amount:  0,
                    boe_amount:       0,
                    other_amount:     0,
                    receipts:         [],
                });
            }
            const cust = custMap.get(cid);
            const amt  = Number(row.total_amount_lc || 0);
            cust.total_amount    += amt;
            cust.cash_amount     += Number(row.cash_amount     || 0);
            cust.check_amount    += Number(row.check_amount    || 0);
            cust.card_amount     += Number(row.card_amount     || 0);
            cust.transfer_amount += Number(row.transfer_amount || 0);
            cust.internet_amount += Number(row.internet_amount || 0);
            cust.boe_amount      += Number(row.boe_amount      || 0);
            cust.other_amount    += Number(row.other_amount    || 0);

            cust.receipts.push({
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

        let customers = Array.from(custMap.values());

        // จัดเรียงตาม sort_by
        if (sort_by === 'amount_desc') {
            customers.sort((a, b) => b.total_amount - a.total_amount);
        } else if (sort_by === 'amount_asc') {
            customers.sort((a, b) => a.total_amount - b.total_amount);
        }
        // default 'customer': already sorted by customer_code from SQL

        res.json(customers);
    } catch (err) {
        console.error('AR Receipt Payment Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getReceiptPaymentReport };
