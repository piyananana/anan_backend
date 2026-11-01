// controllers/cm/cmReportController.js — CM Reporting
const { bankBalanceLc } = require('../../utils/cmBankBalance');
'use strict';

// ── Helpers ─────────────────────────────────────────────────────────────────

const tableExists = async (client, name) => {
    const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
    return r.rows.length > 0;
};

// Calculate opening LC balance for a bank account (all non-voided CM records before dateFrom)
// ยอดยกมา (ก่อน dateFrom) — utils/cmBankBalance.js
const getOpeningBalance = (client, bankAccountId, dateFrom) => bankBalanceLc(client, bankAccountId, dateFrom, { before: true });

// ── Cash Position Report ─────────────────────────────────────────────────────
// Returns per-bank-account summary: opening + period receipts - period payments = closing
const getCashPosition = async (req, res) => {
    const { bank_account_id, account_code_from, account_code_to, date_from, date_to } = req.query;
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
            accParams.push(bank_account_id);
            accWhere += ` AND ba.id = $${accParams.length}`;
        }
        if (account_code_from) {
            accParams.push(account_code_from);
            accWhere += ` AND ba.account_code >= $${accParams.length}`;
        }
        if (account_code_to) {
            accParams.push(account_code_to);
            accWhere += ` AND ba.account_code <= $${accParams.length}`;
        }
        const accRes = await client.query(`
            SELECT ba.id, ba.account_code, ba.account_name_th, ba.account_name_en, ba.currency_code,
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

            // ยอดยกมา/ยอดคงเหลือจากฟังก์ชันกลาง (รวมยอดยกมาที่ตั้งไว้และผลปรับมูลค่าอัตราแลกเปลี่ยน — fx_adj = ส่วนที่ไม่ใช่รับ/จ่าย)
            void openingReceipt; void openingPayment;
            const opening = await bankBalanceLc(client, acc.id, date_from, { before: true });
            const closing = await bankBalanceLc(client, acc.id, date_to);
            const fxAdj = closing - opening - periodReceipt + periodPayment;

            rows.push({
                bank_account_id:   acc.id,
                bank_account_code: acc.account_code,
                bank_account_name: acc.account_name_th,
                bank_account_name_en: acc.account_name_en,
                bank_short_name:   acc.bank_short_name,
                currency_code:     acc.currency_code,
                opening_balance:   Math.round(opening         * 100) / 100,
                period_receipts:   Math.round(periodReceipt   * 100) / 100,
                period_payments:   Math.round(periodPayment   * 100) / 100,
                closing_balance:   Math.round(closing         * 100) / 100,
                fx_adj:            Math.round(fxAdj           * 100) / 100,
            });
        }
        res.json({ date_from, date_to, rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// Build one account's transaction section (opening/transactions/totals/closing)
const buildAccountTxReport = async (client, bankAccountId, date_from, date_to, record_type) => {
    const hasReceipt = await tableExists(client, 'cm_receipt');
    const hasPayment = await tableExists(client, 'cm_payment');

    const opening = await getOpeningBalance(client, bankAccountId, date_from);

    const parts = [];
    if (hasReceipt && (!record_type || record_type === 'RECEIPT')) {
        parts.push(`
            SELECT r.receipt_date AS record_date,
                   r.ar_doc_no    AS doc_no,
                   'RECEIPT'      AS record_type,
                   COALESCE(r.customer_name_th, r.drawer_bank, '') AS description,
                   r.check_no,
                   sl.reference   AS reference_no,
                   0              AS debit_amount,
                   r.amount_lc    AS credit_amount,
                   r.id           AS source_id
            FROM cm_receipt r
            LEFT JOIN cm_bank_statement_line sl ON sl.id = r.statement_line_id
            WHERE r.bank_account_id = $1
              AND r.status != 'Voided'
              AND r.receipt_date >= $2::date AND r.receipt_date <= $3::date`);
    }
    if (hasPayment && (!record_type || record_type === 'PAYMENT')) {
        parts.push(`
            SELECT p.payment_date AS record_date,
                   p.ap_doc_no    AS doc_no,
                   'PAYMENT'      AS record_type,
                   COALESCE(p.payee_name_th, '') AS description,
                   p.check_no,
                   sl.reference   AS reference_no,
                   p.amount_lc    AS debit_amount,
                   0              AS credit_amount,
                   p.id           AS source_id
            FROM cm_payment p
            LEFT JOIN cm_bank_statement_line sl ON sl.id = p.statement_line_id
            WHERE p.bank_account_id = $1
              AND p.status != 'Voided'
              AND p.payment_date >= $2::date AND p.payment_date <= $3::date`);
    }

    let transactions = [];
    if (parts.length > 0) {
        const txRes = await client.query(`
            SELECT *,
                $4::numeric + SUM(credit_amount - debit_amount)
                    OVER (ORDER BY record_date, record_type DESC, source_id) AS running_balance
            FROM (${parts.join(' UNION ALL ')}) t
            ORDER BY record_date, record_type DESC, source_id`, [bankAccountId, date_from, date_to, opening]);
        transactions = txRes.rows.map(r => ({
            record_date:     r.record_date,
            doc_no:          r.doc_no,
            record_type:     r.record_type,
            description:     r.description,
            check_no:        r.check_no,
            reference_no:    r.reference_no,
            debit_amount:    Math.round(parseFloat(r.debit_amount)  * 100) / 100,
            credit_amount:   Math.round(parseFloat(r.credit_amount) * 100) / 100,
            running_balance: Math.round(parseFloat(r.running_balance) * 100) / 100,
        }));
    }

    const totalCredit    = transactions.reduce((s, t) => s + t.credit_amount, 0);
    const totalDebit     = transactions.reduce((s, t) => s + t.debit_amount,  0);
    const closingBalance = Math.round((opening + totalCredit - totalDebit) * 100) / 100;

    return {
        opening_balance: Math.round(opening * 100) / 100,
        total_credit: Math.round(totalCredit * 100) / 100,
        total_debit:  Math.round(totalDebit  * 100) / 100,
        closing_balance: closingBalance,
        transactions,
    };
};

// ── Bank Transaction Report ──────────────────────────────────────────────────
// Returns detailed transactions (with running balance) for either one bank_account_id,
// or a range of accounts filtered by account_code_from / account_code_to
const getBankTransactions = async (req, res) => {
    const { bank_account_id, account_code_from, account_code_to, date_from, date_to, record_type } = req.query;
    if (!date_from || !date_to)
        return res.status(400).json({ error: 'ต้องระบุ date_from และ date_to' });

    const client = await req.dbPool.connect();
    try {
        let accWhere = `WHERE ba.cm_type = 'BANK' AND ba.is_active = TRUE`;
        const accParams = [];
        if (bank_account_id) {
            accParams.push(bank_account_id);
            accWhere += ` AND ba.id = $${accParams.length}`;
        }
        if (account_code_from) {
            accParams.push(account_code_from);
            accWhere += ` AND ba.account_code >= $${accParams.length}`;
        }
        if (account_code_to) {
            accParams.push(account_code_to);
            accWhere += ` AND ba.account_code <= $${accParams.length}`;
        }
        const accRes = await client.query(`
            SELECT ba.id, ba.account_code, ba.account_name_th, ba.account_name_en, ba.currency_code,
                   cb.short_name AS bank_short_name
            FROM cm_bank_account ba
            LEFT JOIN cd_bank cb ON cb.id = ba.bank_id
            ${accWhere}
            ORDER BY ba.account_code`, accParams);

        const accounts = [];
        for (const acc of accRes.rows) {
            const section = await buildAccountTxReport(client, acc.id, date_from, date_to, record_type);
            accounts.push({
                bank_account_id:      acc.id,
                bank_account_code:    acc.account_code,
                bank_account_name:    acc.account_name_th,
                bank_account_name_en: acc.account_name_en,
                bank_short_name:      acc.bank_short_name,
                currency_code:        acc.currency_code,
                ...section,
            });
        }

        res.json({ date_from, date_to, accounts });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// ── Check Register ───────────────────────────────────────────────────────────
// Returns both issued (cm_payment with check_no) and received (cm_receipt with check_no) checks
const getCheckRegister = async (req, res) => {
    const { bank_account_id, account_code_from, account_code_to, date_from, date_to, check_type, status } = req.query;
    if (!date_from || !date_to)
        return res.status(400).json({ error: 'ต้องระบุ date_from และ date_to' });

    const client = await req.dbPool.connect();
    try {
        const hasReceipt = await tableExists(client, 'cm_receipt');
        const hasPayment = await tableExists(client, 'cm_payment');

        // $1/$2 = ช่วงวันที่ ตัวกรองอื่นต่อท้ายเป็นพารามิเตอร์ (ใช้ชุดเดียวกันทั้งสองส่วนของ UNION)
        const params = [date_from, date_to];
        const arg = (v) => { params.push(v); return `$${params.length}`; };
        let accFilter = bank_account_id ? `AND ba.id = ${arg(parseInt(bank_account_id))}` : '';
        if (account_code_from) accFilter += ` AND ba.account_code >= ${arg(account_code_from)}`;
        if (account_code_to)   accFilter += ` AND ba.account_code <= ${arg(account_code_to)}`;
        const statusArg = (status && status !== 'All') ? arg(status) : null;

        const parts = [];
        if (hasReceipt && (!check_type || check_type === 'RECEIVED')) {
            parts.push(`
                SELECT 'RECEIVED' AS check_type,
                       r.id, r.bank_account_id,
                       ba.account_code  AS bank_account_code,
                       ba.account_name_th AS bank_account_name,
                       ba.account_name_en AS bank_account_name_en,
                       cb.short_name    AS bank_short_name,
                       r.receipt_date   AS record_date,
                       r.check_no,
                       r.check_date,
                       sl.reference     AS reference_no,
                       COALESCE(r.customer_name_th, r.drawer_bank) AS party_name,
                       r.amount_lc,
                       r.currency_code,
                       r.status,
                       r.ar_doc_no      AS doc_no
                FROM cm_receipt r
                LEFT JOIN cm_bank_account ba ON ba.id = r.bank_account_id
                LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
                LEFT JOIN cm_bank_statement_line sl ON sl.id = r.statement_line_id
                WHERE r.check_no IS NOT NULL AND r.check_no != ''
                  AND r.receipt_date >= $1::date AND r.receipt_date <= $2::date
                  ${accFilter} ${statusArg ? `AND r.status = ${statusArg}` : ''}`);
        }
        if (hasPayment && (!check_type || check_type === 'ISSUED')) {
            parts.push(`
                SELECT 'ISSUED' AS check_type,
                       p.id, p.bank_account_id,
                       ba.account_code  AS bank_account_code,
                       ba.account_name_th AS bank_account_name,
                       ba.account_name_en AS bank_account_name_en,
                       cb.short_name    AS bank_short_name,
                       p.payment_date   AS record_date,
                       p.check_no,
                       p.check_date,
                       sl.reference     AS reference_no,
                       p.payee_name_th  AS party_name,
                       p.amount_lc,
                       p.currency_code,
                       p.status,
                       p.ap_doc_no      AS doc_no
                FROM cm_payment p
                LEFT JOIN cm_bank_account ba ON ba.id = p.bank_account_id
                LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
                LEFT JOIN cm_bank_statement_line sl ON sl.id = p.statement_line_id
                WHERE p.check_no IS NOT NULL AND p.check_no != ''
                  AND p.payment_date >= $1::date AND p.payment_date <= $2::date
                  ${accFilter} ${statusArg ? `AND p.status = ${statusArg}` : ''}`);
        }

        let checks = [];
        if (parts.length > 0) {
            const r = await client.query(
                `${parts.join(' UNION ALL ')} ORDER BY record_date, check_no`, params);
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
