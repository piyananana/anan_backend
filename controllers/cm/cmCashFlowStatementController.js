// controllers/cm/cmCashFlowStatementController.js
const { bankBalanceLc } = require('../../utils/cmBankBalance');
const { addDays, ymd } = require('../../utils/dateUtil');
'use strict';

const tableExists = async (client, name) => {
    const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
    return r.rows.length > 0;
};

// Calculate balance for a bank account as of a given date
// ยอดธนาคาร ณ วันที่ — utils/cmBankBalance.js
const calcBalance = (client, accId, asOfDate) => bankBalanceLc(client, accId, asOfDate);

const getStatement = async (req, res) => {
    const { date_from, date_to, account_code_from, account_code_to } = req.query;
    if (!date_from || !date_to) {
        return res.status(400).json({ error: 'ต้องระบุ date_from และ date_to' });
    }

    // date before period = opening balance date
    const openingDate = addDays(date_from, -1);

    const client = await req.dbPool.connect();
    try {
        const tables = {
            receipt:  await tableExists(client, 'cm_receipt'),
            payment:  await tableExists(client, 'cm_payment'),
            fxReval:  await tableExists(client, 'cm_bank_fx_revaluation'),
        };

        // Get all active BANK accounts (optionally within an account_code range)
        let accWhere = `WHERE ba.cm_type='BANK' AND ba.is_active=TRUE`;
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
            SELECT ba.id, ba.account_code, ba.account_name_th, ba.account_name_en, ba.currency_code,
                   cb.short_name AS bank_short_name
            FROM cm_bank_account ba
            LEFT JOIN cd_bank cb ON cb.id = ba.bank_id
            ${accWhere}
            ORDER BY ba.account_code`, accParams);

        const rows = [];
        for (const acc of accsRes.rows) {
            // Opening balance (as of day before date_from)
            const opening = await calcBalance(client, acc.id, openingDate, tables);

            // Period receipts / payments — เงินโอนระหว่างบัญชี (CM 50) แยกเป็นโอนเข้า/โอนออก
            let transferIn = 0, transferOut = 0;
            let receipts = 0;
            if (tables.receipt) {
                const r = await client.query(
                    `SELECT COALESCE(SUM(amount_lc) FILTER (WHERE COALESCE(source_type, '') <> 'CM50'),0) AS amt,
                            COALESCE(SUM(amount_lc) FILTER (WHERE source_type = 'CM50'),0) AS transfer
                       FROM cm_receipt
                     WHERE bank_account_id=$1 AND status!='Voided'
                       AND receipt_date>=$2 AND receipt_date<=$3`,
                    [acc.id, date_from, date_to]);
                receipts = parseFloat(r.rows[0].amt);
                transferIn = parseFloat(r.rows[0].transfer);
            }

            // Period payments
            let payments = 0;
            if (tables.payment) {
                const r = await client.query(
                    `SELECT COALESCE(SUM(amount_lc) FILTER (WHERE COALESCE(source_type, '') <> 'CM50'),0) AS amt,
                            COALESCE(SUM(amount_lc) FILTER (WHERE source_type = 'CM50'),0) AS transfer
                       FROM cm_payment
                     WHERE bank_account_id=$1 AND status!='Voided'
                       AND payment_date>=$2 AND payment_date<=$3`,
                    [acc.id, date_from, date_to]);
                payments = parseFloat(r.rows[0].amt);
                transferOut = parseFloat(r.rows[0].transfer);
            }

            // Period FX adjustments
            let fxAdj = 0;
            if (tables.fxReval) {
                const r = await client.query(
                    `SELECT COALESCE(SUM(rl.fx_gain_loss),0) AS adj
                     FROM cm_bank_fx_revaluation_line rl
                     JOIN cm_bank_fx_revaluation rv ON rv.id=rl.revaluation_id
                     WHERE rl.bank_account_id=$1 AND rv.status='Posted'
                       AND rv.revaluation_date>=$2 AND rv.revaluation_date<=$3`,
                    [acc.id, date_from, date_to]);
                fxAdj = parseFloat(r.rows[0].adj);
            }

            const closing = Math.round(
                (opening + receipts - payments + transferIn - transferOut + fxAdj) * 100) / 100;

            rows.push({
                bank_account_id:   acc.id,
                bank_account_code: acc.account_code,
                bank_account_name: acc.account_name_th,
                bank_account_name_en: acc.account_name_en,
                bank_short_name:   acc.bank_short_name,
                currency_code:     acc.currency_code,
                opening:  Math.round(opening      * 100) / 100,
                receipts: Math.round(receipts      * 100) / 100,
                payments: Math.round(payments      * 100) / 100,
                transfer_in:  Math.round(transferIn  * 100) / 100,
                transfer_out: Math.round(transferOut * 100) / 100,
                fx_adj:   Math.round(fxAdj         * 100) / 100,
                closing,
            });
        }

        const sumRow = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
        res.json({
            date_from,
            date_to,
            rows,
            totals: {
                opening:      Math.round(sumRow('opening')      * 100) / 100,
                receipts:     Math.round(sumRow('receipts')     * 100) / 100,
                payments:     Math.round(sumRow('payments')     * 100) / 100,
                transfer_in:  Math.round(sumRow('transfer_in')  * 100) / 100,
                transfer_out: Math.round(sumRow('transfer_out') * 100) / 100,
                fx_adj:       Math.round(sumRow('fx_adj')       * 100) / 100,
                closing:      Math.round(sumRow('closing')      * 100) / 100,
            },
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { getStatement };
