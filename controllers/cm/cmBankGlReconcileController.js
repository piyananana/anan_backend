// controllers/cm/cmBankGlReconcileController.js
'use strict';

const tableExists = async (client, name) => {
    const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
    return r.rows.length > 0;
};

// Returns CM-side balance for a bank account as of a date, using opening balance if available
const getCmBalance = async (client, bankAccountId, asOfDate, flags) => {
    let balance = 0;
    let fromDate = null; // null = from beginning

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

    // ใช้ parameterized query เสมอ — ห้าม interpolate ค่าจาก request (as_of_date) ลง SQL ตรงๆ (SQL injection)
    if (flags.hasReceipt) {
        const dateSql = fromDate ? `AND receipt_date > $2 AND receipt_date <= $3` : `AND receipt_date <= $2`;
        const params = fromDate ? [bankAccountId, fromDate, asOfDate] : [bankAccountId, asOfDate];
        const r = await client.query(
            `SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_receipt
             WHERE bank_account_id=$1 AND status!='Voided' ${dateSql}`,
            params);
        balance += parseFloat(r.rows[0].amt);
    }
    if (flags.hasPayment) {
        const dateSql = fromDate ? `AND payment_date > $2 AND payment_date <= $3` : `AND payment_date <= $2`;
        const params = fromDate ? [bankAccountId, fromDate, asOfDate] : [bankAccountId, asOfDate];
        const r = await client.query(
            `SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_payment
             WHERE bank_account_id=$1 AND status!='Voided' ${dateSql}`,
            params);
        balance -= parseFloat(r.rows[0].amt);
    }
    if (flags.hasTransfer) {
        const dateSql = fromDate ? `AND transfer_date > $2 AND transfer_date <= $3` : `AND transfer_date <= $2`;
        const params = fromDate ? [bankAccountId, fromDate, asOfDate] : [bankAccountId, asOfDate];
        const rIn = await client.query(
            `SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_inter_bank_transfer
             WHERE to_bank_account_id=$1 AND status='Posted' ${dateSql}`,
            params);
        const rOut = await client.query(
            `SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_inter_bank_transfer
             WHERE from_bank_account_id=$1 AND status='Posted' ${dateSql}`,
            params);
        balance += parseFloat(rIn.rows[0].amt) - parseFloat(rOut.rows[0].amt);
    }
    if (flags.hasFxReval) {
        const dateSql = fromDate ? `AND rv.revaluation_date > $2 AND rv.revaluation_date <= $3` : `AND rv.revaluation_date <= $2`;
        const params = fromDate ? [bankAccountId, fromDate, asOfDate] : [bankAccountId, asOfDate];
        const r = await client.query(`
            SELECT COALESCE(SUM(rl.fx_gain_loss),0) AS adj
            FROM cm_bank_fx_revaluation_line rl
            JOIN cm_bank_fx_revaluation rv ON rv.id = rl.revaluation_id
            WHERE rl.bank_account_id=$1 AND rv.status='Posted' ${dateSql}`,
            params);
        balance += parseFloat(r.rows[0].adj);
    }
    return Math.round(balance * 100) / 100;
};

const getReport = async (req, res) => {
    const { as_of_date, account_code_from, account_code_to } = req.query;
    if (!as_of_date) return res.status(400).json({ error: 'ต้องระบุ as_of_date' });

    const client = await req.dbPool.connect();
    try {
        const flags = {
            hasReceipt:         await tableExists(client, 'cm_receipt'),
            hasPayment:         await tableExists(client, 'cm_payment'),
            hasTransfer:        await tableExists(client, 'cm_inter_bank_transfer'),
            hasFxReval:         await tableExists(client, 'cm_bank_fx_revaluation'),
            hasBB:              await tableExists(client, 'gl_beginning_balance'),
            hasOpeningBalance:  await tableExists(client, 'cm_bank_opening_balance'),
        };

        // Active BANK accounts that have a GL account assigned
        let accWhere = `WHERE ba.cm_type='BANK' AND ba.is_active=TRUE AND ba.gl_account_id IS NOT NULL`;
        const accParams = [];
        if (account_code_from) {
            accParams.push(account_code_from);
            accWhere += ` AND ba.account_code >= $${accParams.length}`;
        }
        if (account_code_to) {
            accParams.push(account_code_to);
            accWhere += ` AND ba.account_code <= $${accParams.length}`;
        }
        const accsRes = await client.query(`
            SELECT ba.id, ba.account_code, ba.account_name_th, ba.account_name_en, ba.currency_code, ba.gl_account_id,
                   ga.account_code AS gl_account_code, ga.account_name_thai AS gl_account_name, ga.account_name_eng AS gl_account_name_en,
                   cb.short_name   AS bank_short_name
            FROM cm_bank_account ba
            LEFT JOIN gl_account  ga ON ga.id = ba.gl_account_id
            LEFT JOIN cd_bank     cb ON cb.id = ba.bank_id
            ${accWhere}
            ORDER BY ba.account_code`, accParams);

        const rows = [];
        for (const acc of accsRes.rows) {
            const cmBalance = await getCmBalance(client, acc.id, as_of_date, flags);

            // GL balance: beginning balance + gl_entry_detail postings (debit_lc - credit_lc)
            let glBalance = 0;
            if (flags.hasBB) {
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
                [acc.gl_account_id, as_of_date]);
            glBalance += parseFloat(glRes.rows[0].gl_bal);
            glBalance = Math.round(glBalance * 100) / 100;

            const difference = Math.round((cmBalance - glBalance) * 100) / 100;

            rows.push({
                bank_account_id:   acc.id,
                bank_account_code: acc.account_code,
                bank_account_name: acc.account_name_th,
                bank_account_name_en: acc.account_name_en,
                bank_short_name:   acc.bank_short_name,
                currency_code:     acc.currency_code,
                gl_account_code:   acc.gl_account_code,
                gl_account_name:   acc.gl_account_name,
                gl_account_name_en: acc.gl_account_name_en,
                cm_balance:        cmBalance,
                gl_balance:        glBalance,
                difference:        difference,
                is_matched:        Math.abs(difference) < 0.01,
            });
        }

        res.json({ as_of_date, rows,
            total_matched:   rows.filter(r => r.is_matched).length,
            total_unmatched: rows.filter(r => !r.is_matched).length,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { getReport };
