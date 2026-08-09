// controllers/cm/cmPreCloseCheckController.js
'use strict';

const tableExists = async (client, name) => {
    const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
    return r.rows.length > 0;
};

// CM balance for a bank account as of a date (mirrors cmBankGlReconcileController's getCmBalance)
const getCmBalance = async (client, bankAccountId, asOfDate, flags) => {
    let balance = 0;
    let fromDate = null;

    if (flags.hasOpeningBalance) {
        const ob = await client.query(
            `SELECT opening_balance, as_of_date FROM cm_bank_opening_balance
             WHERE bank_account_id=$1 AND as_of_date<=$2
             ORDER BY as_of_date DESC LIMIT 1`,
            [bankAccountId, asOfDate]);
        if (ob.rows.length > 0) {
            balance  = parseFloat(ob.rows[0].opening_balance);
            fromDate = ob.rows[0].as_of_date.toISOString
                ? ob.rows[0].as_of_date.toISOString().substring(0, 10)
                : ob.rows[0].as_of_date.toString().substring(0, 10);
        }
    }

    if (flags.hasReceipt) {
        const dateSql = fromDate ? `AND receipt_date > $2 AND receipt_date <= $3` : `AND receipt_date <= $2`;
        const params = fromDate ? [bankAccountId, fromDate, asOfDate] : [bankAccountId, asOfDate];
        const r = await client.query(
            `SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_receipt
             WHERE bank_account_id=$1 AND status!='Voided' ${dateSql}`, params);
        balance += parseFloat(r.rows[0].amt);
    }
    if (flags.hasPayment) {
        const dateSql = fromDate ? `AND payment_date > $2 AND payment_date <= $3` : `AND payment_date <= $2`;
        const params = fromDate ? [bankAccountId, fromDate, asOfDate] : [bankAccountId, asOfDate];
        const r = await client.query(
            `SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_payment
             WHERE bank_account_id=$1 AND status!='Voided' ${dateSql}`, params);
        balance -= parseFloat(r.rows[0].amt);
    }
    if (flags.hasTransfer) {
        const dateSql = fromDate ? `AND transfer_date > $2 AND transfer_date <= $3` : `AND transfer_date <= $2`;
        const params = fromDate ? [bankAccountId, fromDate, asOfDate] : [bankAccountId, asOfDate];
        const rIn  = await client.query(
            `SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_inter_bank_transfer
             WHERE to_bank_account_id=$1 AND status='Posted' ${dateSql}`, params);
        const rOut = await client.query(
            `SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_inter_bank_transfer
             WHERE from_bank_account_id=$1 AND status='Posted' ${dateSql}`, params);
        balance += parseFloat(rIn.rows[0].amt) - parseFloat(rOut.rows[0].amt);
    }
    if (flags.hasFxReval) {
        const dateSql = fromDate ? `AND rv.revaluation_date > $2 AND rv.revaluation_date <= $3` : `AND rv.revaluation_date <= $2`;
        const params = fromDate ? [bankAccountId, fromDate, asOfDate] : [bankAccountId, asOfDate];
        const r = await client.query(`
            SELECT COALESCE(SUM(rl.fx_gain_loss),0) AS adj
            FROM cm_bank_fx_revaluation_line rl
            JOIN cm_bank_fx_revaluation rv ON rv.id = rl.revaluation_id
            WHERE rl.bank_account_id=$1 AND rv.status='Posted' ${dateSql}`, params);
        balance += parseFloat(r.rows[0].adj);
    }
    return Math.round(balance * 100) / 100;
};

const runChecks = async (req, res) => {
    const { period_date } = req.query;
    if (!period_date) return res.status(400).json({ error: 'ต้องระบุ period_date' });

    const client = await req.dbPool.connect();
    try {
        const checks = [];

        const hasStmt     = await tableExists(client, 'cm_bank_statement');
        const hasReceipt  = await tableExists(client, 'cm_receipt');
        const hasPayment  = await tableExists(client, 'cm_payment');
        const hasFxReval  = await tableExists(client, 'cm_bank_fx_revaluation');
        const hasPCV      = await tableExists(client, 'cm_petty_cash_voucher');
        const hasTransfer = await tableExists(client, 'cm_inter_bank_transfer');
        const hasBB             = await tableExists(client, 'gl_beginning_balance');
        const hasOpeningBalance = await tableExists(client, 'cm_bank_opening_balance');

        // 1. Unconfirmed bank statements
        if (hasStmt) {
            const cntRes = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_bank_statement WHERE status='Draft' AND statement_date_to<=$1`,
                [period_date]);
            const cnt = parseInt(cntRes.rows[0].cnt);
            let docs = [];
            if (cnt > 0) {
                const r = await client.query(`
                    SELECT ba.account_code, s.statement_date_to
                    FROM cm_bank_statement s
                    LEFT JOIN cm_bank_account ba ON ba.id = s.bank_account_id
                    WHERE s.status='Draft' AND s.statement_date_to<=$1
                    ORDER BY s.statement_date_to LIMIT 5`, [period_date]);
                docs = r.rows.map(x => ({ doc_no: `${x.account_code || ''} ${x.statement_date_to ? x.statement_date_to.toISOString().substring(0, 10) : ''}`.trim() }));
            }
            checks.push({ check_key: 'UNCONFIRMED_STATEMENTS', severity: 'WARNING', count: cnt, docs,
                title: 'Bank Statement ที่ยังไม่ยืนยัน', title_en: 'Unconfirmed bank statements' });

            // 2. Unreconciled lines in confirmed statements
            const cnt2Res = await client.query(`
                SELECT COUNT(*) AS cnt FROM cm_bank_statement_line l
                JOIN cm_bank_statement s ON s.id = l.statement_id
                WHERE s.status='Confirmed' AND l.is_reconciled=FALSE AND s.statement_date_to<=$1`,
                [period_date]);
            const cnt2 = parseInt(cnt2Res.rows[0].cnt);
            let docs2 = [];
            if (cnt2 > 0) {
                const r = await client.query(`
                    SELECT l.line_date, l.reference, l.description
                    FROM cm_bank_statement_line l
                    JOIN cm_bank_statement s ON s.id = l.statement_id
                    WHERE s.status='Confirmed' AND l.is_reconciled=FALSE AND s.statement_date_to<=$1
                    ORDER BY l.line_date LIMIT 5`, [period_date]);
                docs2 = r.rows.map(x => ({ doc_no: (x.reference && x.reference.trim()) ? x.reference : (x.line_date ? x.line_date.toISOString().substring(0, 10) : '') }));
            }
            checks.push({ check_key: 'UNRECONCILED_LINES', severity: 'WARNING', count: cnt2, docs: docs2,
                title: 'รายการที่ยังไม่ได้ Reconcile', title_en: 'Unreconciled statement lines' });
        }

        // 3. Pending received checks
        if (hasReceipt) {
            const cntRes = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_receipt WHERE check_no IS NOT NULL AND check_no!='' AND status='Pending' AND receipt_date<=$1`,
                [period_date]);
            const cnt = parseInt(cntRes.rows[0].cnt);
            let docs = [];
            if (cnt > 0) {
                const r = await client.query(
                    `SELECT check_no FROM cm_receipt WHERE check_no IS NOT NULL AND check_no!='' AND status='Pending' AND receipt_date<=$1
                     ORDER BY receipt_date LIMIT 5`, [period_date]);
                docs = r.rows.map(x => ({ doc_no: x.check_no }));
            }
            checks.push({ check_key: 'PENDING_CHECKS_RECEIVED', severity: 'WARNING', count: cnt, docs,
                title: 'เช็คที่รับยังไม่ผ่านเรียกเก็บ', title_en: 'Received checks still pending clearance' });
        }

        // 4. Pending issued checks
        if (hasPayment) {
            const cntRes = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_payment WHERE check_no IS NOT NULL AND check_no!='' AND status='Pending' AND payment_date<=$1`,
                [period_date]);
            const cnt = parseInt(cntRes.rows[0].cnt);
            let docs = [];
            if (cnt > 0) {
                const r = await client.query(
                    `SELECT check_no FROM cm_payment WHERE check_no IS NOT NULL AND check_no!='' AND status='Pending' AND payment_date<=$1
                     ORDER BY payment_date LIMIT 5`, [period_date]);
                docs = r.rows.map(x => ({ doc_no: x.check_no }));
            }
            checks.push({ check_key: 'PENDING_CHECKS_ISSUED', severity: 'WARNING', count: cnt, docs,
                title: 'เช็คที่จ่ายยังไม่ผ่าน', title_en: 'Issued checks still pending clearance' });
        }

        // 5. Draft FX revaluations
        if (hasFxReval) {
            const cntRes = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_bank_fx_revaluation WHERE status='Draft' AND revaluation_date<=$1`,
                [period_date]);
            const cnt = parseInt(cntRes.rows[0].cnt);
            let docs = [];
            if (cnt > 0) {
                const r = await client.query(
                    `SELECT gl_doc_no FROM cm_bank_fx_revaluation WHERE status='Draft' AND revaluation_date<=$1
                     ORDER BY revaluation_date LIMIT 5`, [period_date]);
                docs = r.rows.map(x => ({ doc_no: x.gl_doc_no || '' }));
            }
            checks.push({ check_key: 'DRAFT_FX_REVALUATIONS', severity: 'ERROR', count: cnt, docs,
                title: 'FX Revaluation ที่ยังไม่ได้ Post GL', title_en: 'FX Revaluations not yet posted to GL' });
        }

        // 6. Approved petty cash vouchers not replenished
        if (hasPCV) {
            const cntRes = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_petty_cash_voucher WHERE status='Approved' AND voucher_date<=$1`,
                [period_date]);
            const cnt = parseInt(cntRes.rows[0].cnt);
            let docs = [];
            if (cnt > 0) {
                const r = await client.query(
                    `SELECT voucher_no FROM cm_petty_cash_voucher WHERE status='Approved' AND voucher_date<=$1
                     ORDER BY voucher_date LIMIT 5`, [period_date]);
                docs = r.rows.map(x => ({ doc_no: x.voucher_no }));
            }
            checks.push({ check_key: 'PENDING_PETTY_CASH', severity: 'INFO', count: cnt, docs,
                title: 'ใบสำคัญเงินสดย่อยที่ยังไม่เบิก', title_en: 'Approved petty cash vouchers not yet replenished' });
        }

        // 7. Draft inter-bank transfers
        if (hasTransfer) {
            const cntRes = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_inter_bank_transfer WHERE status='Draft' AND transfer_date<=$1`,
                [period_date]);
            const cnt = parseInt(cntRes.rows[0].cnt);
            let docs = [];
            if (cnt > 0) {
                const r = await client.query(
                    `SELECT transfer_no FROM cm_inter_bank_transfer WHERE status='Draft' AND transfer_date<=$1
                     ORDER BY transfer_date LIMIT 5`, [period_date]);
                docs = r.rows.map(x => ({ doc_no: x.transfer_no }));
            }
            checks.push({ check_key: 'DRAFT_TRANSFERS', severity: 'ERROR', count: cnt, docs,
                title: 'Inter-bank Transfer ที่ยังไม่ได้ Post GL', title_en: 'Inter-bank Transfers not yet posted to GL' });
        }

        // 8. CM vs GL reconciliation (bank accounts with a GL account configured)
        {
            const flags = { hasReceipt, hasPayment, hasTransfer, hasFxReval, hasBB, hasOpeningBalance };
            const accsRes = await client.query(`
                SELECT ba.id, ba.account_code, ba.gl_account_id
                FROM cm_bank_account ba
                WHERE ba.cm_type='BANK' AND ba.is_active=TRUE AND ba.gl_account_id IS NOT NULL
                ORDER BY ba.account_code`);

            let mismatchCount = 0;
            const mismatchDocs = [];
            for (const acc of accsRes.rows) {
                const cmBalance = await getCmBalance(client, acc.id, period_date, flags);

                let glBalance = 0;
                if (hasBB) {
                    const bbRes = await client.query(
                        `SELECT COALESCE(SUM(balance),0) AS bb FROM gl_beginning_balance WHERE gl_account_id=$1`,
                        [acc.gl_account_id]);
                    glBalance += parseFloat(bbRes.rows[0].bb);
                }
                const glRes = await client.query(`
                    SELECT COALESCE(SUM(l.debit_lc - l.credit_lc),0) AS gl_bal
                    FROM gl_entry_detail l
                    JOIN gl_entry_header h ON h.id = l.header_id
                    WHERE l.account_id=$1 AND h.status='Posted' AND h.doc_date<=$2`,
                    [acc.gl_account_id, period_date]);
                glBalance += parseFloat(glRes.rows[0].gl_bal);

                const diff = Math.abs(Math.round((cmBalance - glBalance) * 100) / 100);
                if (diff >= 0.01) {
                    mismatchCount++;
                    if (mismatchDocs.length < 5) mismatchDocs.push({ doc_no: acc.account_code });
                }
            }
            checks.push({ check_key: 'GL_RECONCILE_MISMATCH', severity: 'ERROR', count: mismatchCount, docs: mismatchDocs,
                title: 'บัญชีธนาคารที่ยอด CM ไม่ตรงกับ GL', title_en: 'Bank accounts where CM balance does not match GL' });
        }

        const issues = checks.filter(c => c.count > 0);
        res.json({
            period_date,
            checks,
            issues,
            total_issues: issues.length,
            has_errors:   issues.some(i => i.severity === 'ERROR'),
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { runChecks };
