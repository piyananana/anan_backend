// controllers/cm/cmBankGlReconcileController.js
const { bankBalanceLc } = require('../../utils/cmBankBalance');
const { ymd } = require('../../utils/dateUtil');
'use strict';

const tableExists = async (client, name) => {
    const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
    return r.rows.length > 0;
};

// Returns CM-side balance for a bank account as of a date, using opening balance if available
// ยอดธนาคารฝั่ง CM — utils/cmBankBalance.js (ยอดยกมา + เงินเข้า − เงินออก + ผลปรับมูลค่า)
const getCmBalance = (client, bankAccountId, asOfDate) => bankBalanceLc(client, bankAccountId, asOfDate);

const getReport = async (req, res) => {
    const { as_of_date, account_code_from, account_code_to } = req.query;
    if (!as_of_date) return res.status(400).json({ error: 'ต้องระบุ as_of_date' });

    const client = await req.dbPool.connect();
    try {
        const flags = {
            hasReceipt:         await tableExists(client, 'cm_receipt'),
            hasPayment:         await tableExists(client, 'cm_payment'),
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
