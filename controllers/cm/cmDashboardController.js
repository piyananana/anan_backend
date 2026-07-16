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
        const hasTransfer = await tableExists(client, 'cm_inter_bank_transfer');
        const hasFxReval  = await tableExists(client, 'cm_bank_fx_revaluation');
        const hasPCV      = await tableExists(client, 'cm_petty_cash_voucher');
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
            let balance = 0;
            if (hasReceipt) {
                const r = await client.query(
                    `SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_receipt WHERE bank_account_id=$1 AND status!='Voided'`,
                    [acc.id]);
                balance += parseFloat(r.rows[0].amt);
            }
            if (hasPayment) {
                const r = await client.query(
                    `SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_payment WHERE bank_account_id=$1 AND status!='Voided'`,
                    [acc.id]);
                balance -= parseFloat(r.rows[0].amt);
            }
            if (hasTransfer) {
                const rIn  = await client.query(`SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_inter_bank_transfer WHERE to_bank_account_id=$1   AND status='Posted'`, [acc.id]);
                const rOut = await client.query(`SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_inter_bank_transfer WHERE from_bank_account_id=$1 AND status='Posted'`, [acc.id]);
                balance += parseFloat(rIn.rows[0].amt) - parseFloat(rOut.rows[0].amt);
            }
            if (hasFxReval) {
                const r = await client.query(`
                    SELECT COALESCE(SUM(rl.fx_gain_loss),0) AS adj
                    FROM cm_bank_fx_revaluation_line rl
                    JOIN cm_bank_fx_revaluation rv ON rv.id=rl.revaluation_id
                    WHERE rl.bank_account_id=$1 AND rv.status='Posted'`, [acc.id]);
                balance += parseFloat(r.rows[0].adj);
            }
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
            SELECT ba.id, ba.account_code, ba.account_name_th, ba.fund_amount
            FROM cm_bank_account ba
            WHERE ba.cm_type='PETTY_CASH' AND ba.is_active=TRUE
            ORDER BY ba.account_code`);

        const pettyCashBalances = [];
        for (const acc of pcAccsRes.rows) {
            let usedAmount = 0;
            if (hasPCV) {
                const r = await client.query(`
                    SELECT COALESCE(SUM(amount),0) AS amt FROM cm_petty_cash_voucher
                    WHERE petty_cash_account_id=$1 AND status='Approved'`, [acc.id]);
                usedAmount = parseFloat(r.rows[0].amt);
            }
            const fundAmount  = parseFloat(acc.fund_amount || 0);
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
        if (hasTransfer) {
            const r = await client.query(`SELECT COUNT(*) AS cnt FROM cm_inter_bank_transfer WHERE status='Draft'`);
            if (parseInt(r.rows[0].cnt) > 0)
                alerts.push({ key: 'DRAFT_TRANSFER', severity: 'ERROR',
                    title: 'Inter-bank Transfer Draft รอ Post', count: parseInt(r.rows[0].cnt) });
        }
        if (hasPCV) {
            const r = await client.query(`SELECT COUNT(*) AS cnt FROM cm_petty_cash_voucher WHERE status='Approved'`);
            if (parseInt(r.rows[0].cnt) > 0)
                alerts.push({ key: 'PENDING_PCV', severity: 'INFO',
                    title: 'ใบสำคัญเงินสดย่อยรอเบิก', count: parseInt(r.rows[0].cnt) });
        }

        // ── 5. Recent transactions ────────────────────────────────────────────
        const txParts = [];
        if (hasReceipt)
            txParts.push(`SELECT receipt_date AS tx_date, ar_doc_no AS doc_no, 'RECEIPT' AS tx_type,
                COALESCE(customer_name_th, drawer_bank, '') AS description, amount_lc FROM cm_receipt
                WHERE status!='Voided' ORDER BY receipt_date DESC, id DESC LIMIT 10`);
        if (hasPayment)
            txParts.push(`SELECT payment_date AS tx_date, ap_doc_no AS doc_no, 'PAYMENT' AS tx_type,
                COALESCE(payee_name_th, '') AS description, amount_lc FROM cm_payment
                WHERE status!='Voided' ORDER BY payment_date DESC, id DESC LIMIT 10`);
        if (hasTransfer)
            txParts.push(`SELECT transfer_date AS tx_date, transfer_no AS doc_no, 'TRANSFER' AS tx_type,
                COALESCE(description,'โอนเงินระหว่างบัญชี') AS description, amount_lc FROM cm_inter_bank_transfer
                WHERE status!='Voided' ORDER BY transfer_date DESC, id DESC LIMIT 10`);

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
        const totalBankBalance = bankBalances
            .filter(b => b.currency_code === 'THB')
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
