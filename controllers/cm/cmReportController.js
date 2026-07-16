// controllers/cm/cmReportController.js — CM Reporting
'use strict';

// ── Helpers ─────────────────────────────────────────────────────────────────

const tableExists = async (client, name) => {
    const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
    return r.rows.length > 0;
};

// Calculate opening LC balance for a bank account (all non-voided CM records before dateFrom)
const getOpeningBalance = async (client, bankAccountId, dateFrom) => {
    const hasReceipt = await tableExists(client, 'cm_receipt');
    const hasPayment = await tableExists(client, 'cm_payment');
    if (!hasReceipt && !hasPayment) return 0;

    const parts = [];
    if (hasReceipt) parts.push(
        `SELECT amount_lc FROM cm_receipt WHERE bank_account_id=${bankAccountId} AND status!='Voided' AND receipt_date < '${dateFrom}'`);
    if (hasPayment) parts.push(
        `SELECT -amount_lc FROM cm_payment WHERE bank_account_id=${bankAccountId} AND status!='Voided' AND payment_date < '${dateFrom}'`);

    const r = await client.query(
        `SELECT COALESCE(SUM(amount_lc),0) AS opening FROM (${parts.join(' UNION ALL ')}) t`);
    return parseFloat(r.rows[0].opening) || 0;
};

// ── Cash Position Report ─────────────────────────────────────────────────────
// Returns per-bank-account summary: opening + period receipts - period payments = closing
const getCashPosition = async (req, res) => {
    const { bank_account_id, date_from, date_to } = req.query;
    if (!date_from || !date_to)
        return res.status(400).json({ error: 'ต้องระบุ date_from และ date_to' });

    const client = await req.dbPool.connect();
    try {
        const hasReceipt = await tableExists(client, 'cm_receipt');
        const hasPayment = await tableExists(client, 'cm_payment');

        // Get active BANK accounts
        let accWhere = `WHERE ba.cm_type = 'BANK' AND ba.is_active = TRUE`;
        const accParams = [];
        if (bank_account_id) {
            accWhere += ` AND ba.id = $1`;
            accParams.push(bank_account_id);
        }
        const accRes = await client.query(`
            SELECT ba.id, ba.account_code, ba.account_name_th, ba.currency_code,
                   cb.short_name AS bank_short_name
            FROM cm_bank_account ba
            LEFT JOIN cd_bank cb ON cb.id = ba.bank_id
            ${accWhere}
            ORDER BY ba.account_code`, accParams);

        const rows = [];
        for (const acc of accRes.rows) {
            let openingReceipt = 0, openingPayment = 0;
            let periodReceipt  = 0, periodPayment  = 0;

            if (hasReceipt) {
                const r = await client.query(`
                    SELECT
                        COALESCE(SUM(CASE WHEN receipt_date < $2 THEN amount_lc ELSE 0 END), 0) AS opening,
                        COALESCE(SUM(CASE WHEN receipt_date >= $2 AND receipt_date <= $3 THEN amount_lc ELSE 0 END), 0) AS period
                    FROM cm_receipt
                    WHERE bank_account_id = $1 AND status != 'Voided'`,
                    [acc.id, date_from, date_to]);
                openingReceipt = parseFloat(r.rows[0].opening) || 0;
                periodReceipt  = parseFloat(r.rows[0].period)  || 0;
            }
            if (hasPayment) {
                const r = await client.query(`
                    SELECT
                        COALESCE(SUM(CASE WHEN payment_date < $2 THEN amount_lc ELSE 0 END), 0) AS opening,
                        COALESCE(SUM(CASE WHEN payment_date >= $2 AND payment_date <= $3 THEN amount_lc ELSE 0 END), 0) AS period
                    FROM cm_payment
                    WHERE bank_account_id = $1 AND status != 'Voided'`,
                    [acc.id, date_from, date_to]);
                openingPayment = parseFloat(r.rows[0].opening) || 0;
                periodPayment  = parseFloat(r.rows[0].period)  || 0;
            }

            const opening = openingReceipt - openingPayment;
            const closing = opening + periodReceipt - periodPayment;

            rows.push({
                bank_account_id:   acc.id,
                bank_account_code: acc.account_code,
                bank_account_name: acc.account_name_th,
                bank_short_name:   acc.bank_short_name,
                currency_code:     acc.currency_code,
                opening_balance:   Math.round(opening         * 100) / 100,
                period_receipts:   Math.round(periodReceipt   * 100) / 100,
                period_payments:   Math.round(periodPayment   * 100) / 100,
                closing_balance:   Math.round(closing         * 100) / 100,
            });
        }
        res.json({ date_from, date_to, rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// ── Bank Transaction Report ──────────────────────────────────────────────────
// Returns detailed transactions for ONE bank account with running balance
const getBankTransactions = async (req, res) => {
    const { bank_account_id, date_from, date_to, record_type } = req.query;
    if (!bank_account_id || !date_from || !date_to)
        return res.status(400).json({ error: 'ต้องระบุ bank_account_id, date_from, date_to' });

    const client = await req.dbPool.connect();
    try {
        const hasReceipt = await tableExists(client, 'cm_receipt');
        const hasPayment = await tableExists(client, 'cm_payment');

        // Opening balance
        const opening = await getOpeningBalance(client, bank_account_id, date_from);

        const parts = [];
        if (hasReceipt && (!record_type || record_type === 'RECEIPT')) {
            parts.push(`
                SELECT receipt_date AS record_date,
                       ar_doc_no    AS doc_no,
                       'RECEIPT'    AS record_type,
                       COALESCE(customer_name_th, drawer_bank, '') AS description,
                       check_no,
                       0            AS debit_amount,
                       amount_lc    AS credit_amount,
                       id           AS source_id
                FROM cm_receipt
                WHERE bank_account_id = ${bank_account_id}
                  AND status != 'Voided'
                  AND receipt_date >= '${date_from}' AND receipt_date <= '${date_to}'`);
        }
        if (hasPayment && (!record_type || record_type === 'PAYMENT')) {
            parts.push(`
                SELECT payment_date AS record_date,
                       ap_doc_no    AS doc_no,
                       'PAYMENT'    AS record_type,
                       COALESCE(payee_name_th, '') AS description,
                       check_no,
                       amount_lc    AS debit_amount,
                       0            AS credit_amount,
                       id           AS source_id
                FROM cm_payment
                WHERE bank_account_id = ${bank_account_id}
                  AND status != 'Voided'
                  AND payment_date >= '${date_from}' AND payment_date <= '${date_to}'`);
        }

        let transactions = [];
        if (parts.length > 0) {
            const txRes = await client.query(`
                SELECT *,
                    ${opening} + SUM(credit_amount - debit_amount)
                        OVER (ORDER BY record_date, record_type DESC, source_id) AS running_balance
                FROM (${parts.join(' UNION ALL ')}) t
                ORDER BY record_date, record_type DESC, source_id`);
            transactions = txRes.rows.map(r => ({
                record_date:    r.record_date,
                doc_no:         r.doc_no,
                record_type:    r.record_type,
                description:    r.description,
                check_no:       r.check_no,
                debit_amount:   Math.round(parseFloat(r.debit_amount)  * 100) / 100,
                credit_amount:  Math.round(parseFloat(r.credit_amount) * 100) / 100,
                running_balance:Math.round(parseFloat(r.running_balance) * 100) / 100,
            }));
        }

        const totalCredit   = transactions.reduce((s, t) => s + t.credit_amount, 0);
        const totalDebit    = transactions.reduce((s, t) => s + t.debit_amount,  0);
        const closingBalance = Math.round((opening + totalCredit - totalDebit) * 100) / 100;

        res.json({
            bank_account_id, date_from, date_to,
            opening_balance: Math.round(opening * 100) / 100,
            total_credit: Math.round(totalCredit * 100) / 100,
            total_debit:  Math.round(totalDebit  * 100) / 100,
            closing_balance: closingBalance,
            transactions,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// ── Check Register ───────────────────────────────────────────────────────────
// Returns both issued (cm_payment with check_no) and received (cm_receipt with check_no) checks
const getCheckRegister = async (req, res) => {
    const { bank_account_id, date_from, date_to, check_type, status } = req.query;
    if (!date_from || !date_to)
        return res.status(400).json({ error: 'ต้องระบุ date_from และ date_to' });

    const client = await req.dbPool.connect();
    try {
        const hasReceipt = await tableExists(client, 'cm_receipt');
        const hasPayment = await tableExists(client, 'cm_payment');

        const accFilter = bank_account_id ? `AND bank_account_id = ${parseInt(bank_account_id)}` : '';
        const statusFilter = (status && status !== 'All') ? `AND status = '${status}'` : '';

        const parts = [];
        if (hasReceipt && (!check_type || check_type === 'RECEIVED')) {
            parts.push(`
                SELECT 'RECEIVED' AS check_type,
                       r.id, r.bank_account_id,
                       ba.account_code  AS bank_account_code,
                       ba.account_name_th AS bank_account_name,
                       cb.short_name    AS bank_short_name,
                       r.receipt_date   AS record_date,
                       r.check_no,
                       r.check_date,
                       COALESCE(r.customer_name_th, r.drawer_bank) AS party_name,
                       r.amount_lc,
                       r.currency_code,
                       r.status,
                       r.ar_doc_no      AS doc_no
                FROM cm_receipt r
                LEFT JOIN cm_bank_account ba ON ba.id = r.bank_account_id
                LEFT JOIN cm_bank         cb ON cb.id = ba.bank_id
                WHERE r.check_no IS NOT NULL AND r.check_no != ''
                  AND r.receipt_date >= '${date_from}' AND r.receipt_date <= '${date_to}'
                  ${accFilter} ${statusFilter}`);
        }
        if (hasPayment && (!check_type || check_type === 'ISSUED')) {
            parts.push(`
                SELECT 'ISSUED' AS check_type,
                       p.id, p.bank_account_id,
                       ba.account_code  AS bank_account_code,
                       ba.account_name_th AS bank_account_name,
                       cb.short_name    AS bank_short_name,
                       p.payment_date   AS record_date,
                       p.check_no,
                       p.check_date,
                       p.payee_name_th  AS party_name,
                       p.amount_lc,
                       p.currency_code,
                       p.status,
                       p.ap_doc_no      AS doc_no
                FROM cm_payment p
                LEFT JOIN cm_bank_account ba ON ba.id = p.bank_account_id
                LEFT JOIN cm_bank         cb ON cb.id = ba.bank_id
                WHERE p.check_no IS NOT NULL AND p.check_no != ''
                  AND p.payment_date >= '${date_from}' AND p.payment_date <= '${date_to}'
                  ${accFilter} ${statusFilter}`);
        }

        let checks = [];
        if (parts.length > 0) {
            const r = await client.query(
                `${parts.join(' UNION ALL ')} ORDER BY record_date, check_no`);
            checks = r.rows;
        }

        const totalIssued   = checks.filter(c => c.check_type === 'ISSUED')  .reduce((s, c) => s + parseFloat(c.amount_lc || 0), 0);
        const totalReceived = checks.filter(c => c.check_type === 'RECEIVED').reduce((s, c) => s + parseFloat(c.amount_lc || 0), 0);

        res.json({
            date_from, date_to, checks,
            total_issued:   Math.round(totalIssued   * 100) / 100,
            total_received: Math.round(totalReceived * 100) / 100,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { getCashPosition, getBankTransactions, getCheckRegister };
