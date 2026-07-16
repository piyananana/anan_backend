// controllers/ap/apYearEndSetupController.js
// ตั้งค่าบัญชีสำหรับปิดสิ้นปี AP
// (AP ไม่มีค่าเผื่อหนี้สงสัยจะสูญ — มีเฉพาะ FX account + GL doc type)

const ensureTable = async (pool) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ap_year_end_setup (
            id                            SERIAL PRIMARY KEY,
            fx_gain_account_id            INTEGER,
            fx_loss_account_id            INTEGER,
            unrealized_fx_gain_account_id INTEGER,
            unrealized_fx_loss_account_id INTEGER,
            fx_reval_gl_doc_id            INTEGER,
            updated_by                    VARCHAR(100),
            updated_at                    TIMESTAMPTZ
        )
    `);
};

// GET /api/ap/ap_year_end_setup
const fetchSetup = async (req, res) => {
    try {
        await ensureTable(req.dbPool);
        const result = await req.dbPool.query(`
            SELECT s.*,
                gfg.account_code  AS fx_gain_code,  gfg.account_name_thai  AS fx_gain_name,
                gfl.account_code  AS fx_loss_code,  gfl.account_name_thai  AS fx_loss_name,
                gug.account_code  AS ufx_gain_code, gug.account_name_thai  AS ufx_gain_name,
                gul.account_code  AS ufx_loss_code, gul.account_name_thai  AS ufx_loss_name,
                dfx.doc_name_thai AS fx_reval_doc_name
            FROM ap_year_end_setup s
            LEFT JOIN gl_account gfg ON gfg.id = s.fx_gain_account_id
            LEFT JOIN gl_account gfl ON gfl.id = s.fx_loss_account_id
            LEFT JOIN gl_account gug ON gug.id = s.unrealized_fx_gain_account_id
            LEFT JOIN gl_account gul ON gul.id = s.unrealized_fx_loss_account_id
            LEFT JOIN sa_module_document dfx ON dfx.id = s.fx_reval_gl_doc_id
            LIMIT 1
        `);
        res.json(result.rows[0] || null);
    } catch (err) {
        console.error('ap fetchSetup error:', err);
        res.status(500).json({ error: err.message });
    }
};

// PUT /api/ap/ap_year_end_setup
const upsertSetup = async (req, res) => {
    const {
        fx_gain_account_id, fx_loss_account_id,
        unrealized_fx_gain_account_id, unrealized_fx_loss_account_id,
        fx_reval_gl_doc_id,
    } = req.body;
    const updatedBy = req.headers['username'] || null;
    try {
        await ensureTable(req.dbPool);
        const existing = await req.dbPool.query('SELECT id FROM ap_year_end_setup LIMIT 1');
        if (existing.rows.length === 0) {
            await req.dbPool.query(`
                INSERT INTO ap_year_end_setup
                (fx_gain_account_id, fx_loss_account_id,
                 unrealized_fx_gain_account_id, unrealized_fx_loss_account_id,
                 fx_reval_gl_doc_id, updated_by, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,NOW())
            `, [fx_gain_account_id||null, fx_loss_account_id||null,
                unrealized_fx_gain_account_id||null, unrealized_fx_loss_account_id||null,
                fx_reval_gl_doc_id||null, updatedBy]);
        } else {
            await req.dbPool.query(`
                UPDATE ap_year_end_setup SET
                fx_gain_account_id=$1, fx_loss_account_id=$2,
                unrealized_fx_gain_account_id=$3, unrealized_fx_loss_account_id=$4,
                fx_reval_gl_doc_id=$5, updated_by=$6, updated_at=NOW()
                WHERE id=$7
            `, [fx_gain_account_id||null, fx_loss_account_id||null,
                unrealized_fx_gain_account_id||null, unrealized_fx_loss_account_id||null,
                fx_reval_gl_doc_id||null, updatedBy, existing.rows[0].id]);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('ap upsertSetup error:', err);
        res.status(500).json({ error: err.message });
    }
};

module.exports = { fetchSetup, upsertSetup };
