// controllers/ar/arYearEndSetupController.js
// ตั้งค่าบัญชีสำหรับปิดสิ้นปี AR + กฎ % สำรองหนี้สงสัยจะสูญ

// GET /api/ar/ar_year_end_setup
const fetchSetup = async (req, res) => {
    try {
        const result = await req.dbPool.query(`
            SELECT s.*,
                gfg.account_code  AS fx_gain_code,       gfg.account_name_thai  AS fx_gain_name,
                gfl.account_code  AS fx_loss_code,       gfl.account_name_thai  AS fx_loss_name,
                gug.account_code  AS ufx_gain_code,      gug.account_name_thai  AS ufx_gain_name,
                gul.account_code  AS ufx_loss_code,      gul.account_name_thai  AS ufx_loss_name,
                gae.account_code  AS allow_exp_code,     gae.account_name_thai  AS allow_exp_name,
                gac.account_code  AS allow_contra_code,  gac.account_name_thai  AS allow_contra_name,
                dfx.doc_name_thai AS fx_reval_doc_name,
                dal.doc_name_thai AS allowance_doc_name
            FROM ar_year_end_setup s
            LEFT JOIN gl_account gfg ON gfg.id = s.fx_gain_account_id
            LEFT JOIN gl_account gfl ON gfl.id = s.fx_loss_account_id
            LEFT JOIN gl_account gug ON gug.id = s.unrealized_fx_gain_account_id
            LEFT JOIN gl_account gul ON gul.id = s.unrealized_fx_loss_account_id
            LEFT JOIN gl_account gae ON gae.id = s.allowance_expense_account_id
            LEFT JOIN gl_account gac ON gac.id = s.allowance_contra_account_id
            LEFT JOIN sa_module_document dfx ON dfx.id = s.fx_reval_gl_doc_id
            LEFT JOIN sa_module_document dal ON dal.id = s.allowance_gl_doc_id
            LIMIT 1
        `);
        res.json(result.rows[0] || null);
    } catch (err) {
        console.error('fetchSetup error:', err);
        res.status(500).json({ error: err.message });
    }
};

// PUT /api/ar/ar_year_end_setup
const upsertSetup = async (req, res) => {
    const {
        fx_gain_account_id, fx_loss_account_id,
        unrealized_fx_gain_account_id, unrealized_fx_loss_account_id,
        allowance_expense_account_id, allowance_contra_account_id,
        fx_reval_gl_doc_id, allowance_gl_doc_id,
    } = req.body;
    const updatedBy = req.headers['username'] || null;
    try {
        const existing = await req.dbPool.query('SELECT id FROM ar_year_end_setup LIMIT 1');
        if (existing.rows.length === 0) {
            await req.dbPool.query(`
                INSERT INTO ar_year_end_setup
                (fx_gain_account_id, fx_loss_account_id,
                 unrealized_fx_gain_account_id, unrealized_fx_loss_account_id,
                 allowance_expense_account_id, allowance_contra_account_id,
                 fx_reval_gl_doc_id, allowance_gl_doc_id, updated_by, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
            `, [fx_gain_account_id||null, fx_loss_account_id||null,
                unrealized_fx_gain_account_id||null, unrealized_fx_loss_account_id||null,
                allowance_expense_account_id||null, allowance_contra_account_id||null,
                fx_reval_gl_doc_id||null, allowance_gl_doc_id||null, updatedBy]);
        } else {
            await req.dbPool.query(`
                UPDATE ar_year_end_setup SET
                fx_gain_account_id=$1, fx_loss_account_id=$2,
                unrealized_fx_gain_account_id=$3, unrealized_fx_loss_account_id=$4,
                allowance_expense_account_id=$5, allowance_contra_account_id=$6,
                fx_reval_gl_doc_id=$7, allowance_gl_doc_id=$8,
                updated_by=$9, updated_at=NOW()
                WHERE id=$10
            `, [fx_gain_account_id||null, fx_loss_account_id||null,
                unrealized_fx_gain_account_id||null, unrealized_fx_loss_account_id||null,
                allowance_expense_account_id||null, allowance_contra_account_id||null,
                fx_reval_gl_doc_id||null, allowance_gl_doc_id||null,
                updatedBy, existing.rows[0].id]);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('upsertSetup error:', err);
        res.status(500).json({ error: err.message });
    }
};

// GET /api/ar/ar_allowance_rule
const fetchAllowanceRules = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            `SELECT * FROM ar_allowance_rule ORDER BY sort_order, age_from_days`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// PUT /api/ar/ar_allowance_rule  (bulk replace)
const saveAllowanceRules = async (req, res) => {
    const rules = req.body; // array of { age_from_days, age_to_days, rate, sort_order, is_active }
    if (!Array.isArray(rules)) return res.status(400).json({ error: 'Expected array' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM ar_allowance_rule');
        for (const r of rules) {
            await client.query(`
                INSERT INTO ar_allowance_rule (age_from_days, age_to_days, rate, sort_order, is_active)
                VALUES ($1,$2,$3,$4,$5)
            `, [r.age_from_days, r.age_to_days ?? null,
                r.rate, r.sort_order ?? 0, r.is_active ?? true]);
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('saveAllowanceRules error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { fetchSetup, upsertSetup, fetchAllowanceRules, saveAllowanceRules };
