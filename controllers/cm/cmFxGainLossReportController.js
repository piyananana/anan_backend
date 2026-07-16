// controllers/cm/cmFxGainLossReportController.js
'use strict';

const getReport = async (req, res) => {
    const { date_from, date_to, bank_account_id } = req.query;
    if (!date_from || !date_to) {
        return res.status(400).json({ error: 'ต้องระบุ date_from และ date_to' });
    }

    const client = await req.dbPool.connect();
    try {
        const params  = [date_from, date_to];
        const wheres  = [`rv.status='Posted'`, `rv.revaluation_date>=$1`, `rv.revaluation_date<=$2`];
        if (bank_account_id) {
            params.push(bank_account_id);
            wheres.push(`rl.bank_account_id=$${params.length}`);
        }

        const r = await client.query(`
            SELECT
                rv.id              AS revaluation_id,
                rv.revaluation_date,
                rv.gl_doc_no,
                rv.description,
                rl.id              AS line_id,
                rl.bank_account_id,
                ba.account_code    AS bank_account_code,
                ba.account_name_th AS bank_account_name,
                ba.currency_code,
                cb.short_name      AS bank_short_name,
                rl.balance_fc,
                rl.balance_lc_book,
                rl.new_rate,
                rl.balance_lc_new,
                rl.fx_gain_loss
            FROM cm_bank_fx_revaluation_line rl
            JOIN cm_bank_fx_revaluation rv ON rv.id = rl.revaluation_id
            LEFT JOIN cm_bank_account ba ON ba.id = rl.bank_account_id
            LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
            WHERE ${wheres.join(' AND ')}
            ORDER BY rv.revaluation_date, ba.account_code, rv.id`,
            params);

        const rows = r.rows;

        // Compute summary
        const totalGain = rows
            .filter(r => parseFloat(r.fx_gain_loss) > 0)
            .reduce((s, r) => s + parseFloat(r.fx_gain_loss), 0);
        const totalLoss = rows
            .filter(r => parseFloat(r.fx_gain_loss) < 0)
            .reduce((s, r) => s + parseFloat(r.fx_gain_loss), 0);
        const netGainLoss = totalGain + totalLoss;

        res.json({
            date_from,
            date_to,
            rows,
            total_gain:     Math.round(totalGain    * 100) / 100,
            total_loss:     Math.round(totalLoss    * 100) / 100,
            net_gain_loss:  Math.round(netGainLoss  * 100) / 100,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { getReport };
