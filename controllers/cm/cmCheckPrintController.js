// controllers/cm/cmCheckPrintController.js
'use strict';

// Returns checks (cm_payment with check_no) ready for printing
const getChecks = async (req, res) => {
    const { bank_account_id, date_from, date_to, status } = req.query;
    if (!bank_account_id) return res.status(400).json({ error: 'ต้องระบุ bank_account_id' });

    const client = await req.dbPool.connect();
    try {
        const params  = [bank_account_id];
        const wheres  = [`p.bank_account_id=$1`, `p.check_no IS NOT NULL`, `p.check_no!=''`];

        if (date_from) { params.push(date_from); wheres.push(`p.payment_date>=$${params.length}`); }
        if (date_to)   { params.push(date_to);   wheres.push(`p.payment_date<=$${params.length}`); }
        if (status && status !== 'All') { params.push(status); wheres.push(`p.status=$${params.length}`); }

        const r = await client.query(`
            SELECT p.id, p.ap_doc_no, p.payment_date, p.payee_name_th, p.payee_name_en,
                   p.check_no, p.check_date, p.amount_lc, p.currency_code, p.status,
                   ba.account_code AS bank_account_code, ba.account_name_th AS bank_account_name,
                   cb.short_name   AS bank_short_name, cb.bank_name_thai AS bank_name
            FROM cm_payment p
            LEFT JOIN cm_bank_account ba ON ba.id = p.bank_account_id
            LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
            WHERE ${wheres.join(' AND ')}
            ORDER BY p.payment_date DESC, p.check_no`, params);

        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// Returns print config for a bank account (default config first)
const getPrintConfig = async (req, res) => {
    const { bank_account_id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const r = await client.query(`
            SELECT * FROM cm_check_print_config
            WHERE bank_account_id=$1
            ORDER BY is_default DESC, config_name`,
            [bank_account_id]);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { getChecks, getPrintConfig };
