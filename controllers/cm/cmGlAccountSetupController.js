// controllers/cm/cmGlAccountSetupController.js
'use strict';

const SETUP_KEYS = [
    { key: 'FX_GAIN_ACCOUNT',   label: 'GL Account: กำไรจากอัตราแลกเปลี่ยน (FX Gain)', type: 'GL_ACCOUNT' },
    { key: 'FX_LOSS_ACCOUNT',   label: 'GL Account: ขาดทุนจากอัตราแลกเปลี่ยน (FX Loss)', type: 'GL_ACCOUNT' },
    { key: 'FX_REVAL_DOC_TYPE', label: 'GL Doc Type: FX Revaluation', type: 'GL_DOC_TYPE' },
    { key: 'TRANSFER_DOC_TYPE', label: 'GL Doc Type: โอนเงินระหว่างบัญชี (Inter-bank Transfer)', type: 'GL_DOC_TYPE' },
];

const ensureTables = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_gl_account_setup (
            id            SERIAL PRIMARY KEY,
            setup_key     VARCHAR(50) UNIQUE NOT NULL,
            setup_label   VARCHAR(200),
            setup_type    VARCHAR(20),
            gl_account_id INTEGER,
            gl_doc_id     INTEGER,
            updated_at    TIMESTAMP DEFAULT NOW()
        )
    `);
    for (const s of SETUP_KEYS) {
        await client.query(
            `INSERT INTO cm_gl_account_setup (setup_key, setup_label, setup_type)
             VALUES ($1,$2,$3) ON CONFLICT (setup_key) DO NOTHING`,
            [s.key, s.label, s.type]);
    }
};

const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const r = await client.query(`
            SELECT s.*,
                ga.account_code      AS gl_account_code,
                ga.account_name_thai AS gl_account_name,
                md.doc_code          AS gl_doc_code,
                md.doc_name_thai     AS gl_doc_name
            FROM cm_gl_account_setup s
            LEFT JOIN gl_account         ga ON ga.id = s.gl_account_id
            LEFT JOIN sa_module_document md ON md.id = s.gl_doc_id
            ORDER BY s.id`);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const upsertRow = async (req, res) => {
    const { setup_key, gl_account_id, gl_doc_id } = req.body;
    if (!setup_key) return res.status(400).json({ error: 'ต้องระบุ setup_key' });
    const client = await req.dbPool.connect();
    try {
        await client.query(
            `UPDATE cm_gl_account_setup SET gl_account_id=$1, gl_doc_id=$2, updated_at=NOW() WHERE setup_key=$3`,
            [gl_account_id || null, gl_doc_id || null, setup_key]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { fetchRows, upsertRow };
