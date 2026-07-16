// controllers/cm/cmResetController.js
'use strict';

const tableExists = async (client, name) => {
    const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
    return r.rows.length > 0;
};

const resetData = async (req, res) => {
    const { confirm_text } = req.body;
    if (confirm_text !== 'RESET CM')
        return res.status(400).json({ error: 'กรุณาพิมพ์ "RESET CM" เพื่อยืนยัน' });

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // Order matters for FK constraints — dependent tables first
        const tables = [
            'cm_inter_bank_transfer',
            'cm_bank_fx_revaluation_line',
            'cm_bank_fx_revaluation',
            'cm_bank_statement_line',
            'cm_bank_statement',
            'cm_petty_cash_voucher',
            'cm_petty_cash_replenishment',
            'cm_receipt',
            'cm_payment',
        ];

        const result = [];
        for (const tbl of tables) {
            if (await tableExists(client, tbl)) {
                const r = await client.query(`DELETE FROM ${tbl}`);
                result.push({ table: tbl, deleted: r.rowCount });
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, result });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

module.exports = { resetData };
