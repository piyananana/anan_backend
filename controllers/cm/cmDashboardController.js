const { bankBalanceLc } = require('../../utils/cmBankBalance');
const { getBaseCurrency } = require('../../utils/baseCurrency');
// controllers/cm/cmDashboardController.js
'use strict';

const tableExists = async (client, name) => {
    const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
    return r.rows.length > 0;
};

const getDashboard = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const hasReceipt  = await tableExists(client, 'cm_receipt');
        const hasPayment  = await tableExists(client, 'cm_payment');
        const hasFxReval  = await tableExists(client, 'cm_bank_fx_revaluation');
        const hasCmTx     = await tableExists(client, 'cm_transaction');
        const hasStmt     = await tableExists(client, 'cm_bank_statement');

        // ── 1. Bank account balances ─────────────────────────────────────────
        const accsRes = await client.query(`
            SELECT ba.id, ba.account_code, ba.account_name_th, ba.currency_code,
                   cb.short_name AS bank_short_name
            FROM cm_bank_account ba
            LEFT JOIN cd_bank cb ON cb.id = ba.bank_id
            WHERE ba.cm_type='BANK' AND ba.is_active=TRUE
            ORDER BY ba.account_code`);

        const bankBalances = [];
        for (const acc of accsRes.rows) {
            const balance = await bankBalanceLc(client, acc.id, '9999-12-31');
            bankBalances.push({
                bank_account_id:   acc.id,
                bank_account_code: acc.account_code,
                bank_account_name: acc.account_name_th,
                bank_short_name:   acc.bank_short_name,
                currency_code:     acc.currency_code,
                balance:           Math.round(balance * 100) / 100,
            });
        }

        // ── 2. Petty cash balances ───────────────────────────────────────────
        const pcAccsRes = await client.query(`
            SELECT ba.id, ba.account_code, ba.account_name_th
            FROM cm_bank_account ba
            WHERE ba.cm_type='PETTY_CASH' AND ba.is_active=TRUE
            ORDER BY ba.account_code`);

        const pettyCashBalances = [];
        for (const acc of pcAccsRes.rows) {
            let usedAmount = 0;
            if (hasCmTx) {
                // ใบเบิกเงินสดย่อย (CM 40) ของกองนี้ที่ยังไม่ได้เติมเงิน
                const r = await client.query(`
                    SELECT COALESCE(SUM(t.balance_amount_lc),0) AS amt FROM cm_transaction t JOIN sa_module_document d ON d.id = t.doc_id
                 WHERE d.sys_doc_type = '40' AND t.status = 'Posted' AND t.balance_amount_lc > 0.005 AND t.bank_account_id = $1`, [acc.id]);
                usedAmount = parseFloat(r.rows[0].amt);
            }
            // cm_bank_account has no fund_amount column — no petty-cash fund-limit source exists yet
            const fundAmount  = 0;
            pettyCashBalances.push({
                bank_account_id:   acc.id,
                bank_account_code: acc.account_code,
                bank_account_name: acc.account_name_th,
                fund_amount:       fundAmount,
                used_amount:       Math.round(usedAmount * 100) / 100,
                available:         Math.round((fundAmount - usedAmount) * 100) / 100,
            });
        }

        // ── 3. Pending checks ────────────────────────────────────────────────
        let pendingChecksReceived = { count: 0, amount: 0 };
        let pendingChecksIssued   = { count: 0, amount: 0 };
        if (hasReceipt) {
            const r = await client.query(`
                SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_lc),0) AS amt FROM cm_receipt
                WHERE check_no IS NOT NULL AND check_no!='' AND status='Pending'`);
            pendingChecksReceived = { count: parseInt(r.rows[0].cnt), amount: parseFloat(r.rows[0].amt) };
        }
        if (hasPayment) {
            const r = await client.query(`
                SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_lc),0) AS amt FROM cm_payment
                WHERE check_no IS NOT NULL AND check_no!='' AND status='Pending'`);
            pendingChecksIssued = { count: parseInt(r.rows[0].cnt), amount: parseFloat(r.rows[0].amt) };
        }

        // ── 4. Alerts ────────────────────────────────────────────────────────
        const alerts = [];
        if (hasStmt) {
            const r = await client.query(`SELECT COUNT(*) AS cnt FROM cm_bank_statement WHERE status='Draft'`);
            if (parseInt(r.rows[0].cnt) > 0)
                alerts.push({ key: 'UNCONFIRMED_STMT', severity: 'WARNING',
                    title: 'Bank Statement ยังไม่ยืนยัน', count: parseInt(r.rows[0].cnt) });
        }
        if (hasFxReval) {
            const r = await client.query(`SELECT COUNT(*) AS cnt FROM cm_bank_fx_revaluation WHERE status='Draft'`);
            if (parseInt(r.rows[0].cnt) > 0)
                alerts.push({ key: 'DRAFT_FX_REVAL', severity: 'ERROR',
                    title: 'FX Revaluation Draft รอ Post', count: parseInt(r.rows[0].cnt) });
        }
        if (hasCmTx) {
            const r = await client.query(`SELECT COUNT(*) AS cnt FROM cm_transaction t JOIN sa_module_document d ON d.id = t.doc_id
                 WHERE d.sys_doc_type = '40' AND t.status = 'Posted' AND t.balance_amount_lc > 0.005 `);
            if (parseInt(r.rows[0].cnt) > 0)
                alerts.push({ key: 'PENDING_PCV', severity: 'INFO',
                    title: 'ใบสำคัญเงินสดย่อยรอเบิก', count: parseInt(r.rows[0].cnt) });
        }

        // ── 5. Recent transactions ────────────────────────────────────────────
        const txParts = [];
        if (hasReceipt)
            txParts.push(`(SELECT receipt_date AS tx_date, ar_doc_no AS doc_no, 'RECEIPT' AS tx_type,
                COALESCE(customer_name_th, drawer_bank, '') AS description, amount_lc FROM cm_receipt
                WHERE status!='Voided' ORDER BY receipt_date DESC, id DESC LIMIT 10)`);
        if (hasPayment)
            txParts.push(`(SELECT payment_date AS tx_date, ap_doc_no AS doc_no, 'PAYMENT' AS tx_type,
                COALESCE(payee_name_th, '') AS description, amount_lc FROM cm_payment
                WHERE status!='Voided' ORDER BY payment_date DESC, id DESC LIMIT 10)`);

        let recentTransactions = [];
        if (txParts.length > 0) {
            const r = await client.query(
                `SELECT * FROM (${txParts.join(' UNION ALL ')}) t ORDER BY tx_date DESC, doc_no DESC LIMIT 10`);
            recentTransactions = r.rows.map(t => ({
                tx_date:     t.tx_date,
                doc_no:      t.doc_no,
                tx_type:     t.tx_type,
                description: t.description,
                amount_lc:   Math.round(parseFloat(t.amount_lc) * 100) / 100,
            }));
        }

        // ── 6. Totals ─────────────────────────────────────────────────────────
        // ยอดรวมนับเฉพาะบัญชีสกุลเงินหลัก (ยอดสกุลเงินต่างประเทศรวมข้ามสกุลไม่ได้)
        const { code: baseCode } = await getBaseCurrency(req.dbPool);
        const totalBankBalance = bankBalances
            .filter(b => b.currency_code === baseCode)
            .reduce((s, b) => s + b.balance, 0);

        res.json({
            bank_balances:          bankBalances,
            petty_cash_balances:    pettyCashBalances,
            pending_checks_received: pendingChecksReceived,
            pending_checks_issued:   pendingChecksIssued,
            alerts,
            recent_transactions:    recentTransactions,
            total_bank_balance_lc:  Math.round(totalBankBalance * 100) / 100,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { getDashboard };
