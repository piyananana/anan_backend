// controllers/cm/cmTransactionGlSetupController.js
// ตั้งค่าบัญชี GL ต่อประเภทเอกสารของ cm_transaction — โครงสร้างเดียวกับ apGlAccountSetupController.js
// (คีย์ด้วย doc_code ผูกกับ sa_module_document, sys_module='81')

const ensureTable = async (pool) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cm_transaction_gl_setup (
            id                            SERIAL PRIMARY KEY,
            doc_code                      VARCHAR(20) NOT NULL UNIQUE,
            gl_doc_id                     INTEGER REFERENCES sa_module_document(id),
            revenue_account_id            INTEGER REFERENCES gl_account(id),
            expense_account_id            INTEGER REFERENCES gl_account(id),
            petty_cash_payable_account_id INTEGER REFERENCES gl_account(id),
            fx_gain_account_id            INTEGER REFERENCES gl_account(id),
            fx_loss_account_id            INTEGER REFERENCES gl_account(id),
            created_at                    TIMESTAMPTZ DEFAULT NOW(),
            updated_at                    TIMESTAMPTZ DEFAULT NOW(),
            created_by                    VARCHAR(100),
            updated_by                    VARCHAR(100)
        )
    `);
    // VAT / ภาษีหัก ณ ที่จ่ายของธุรกรรม CM (user-approved 2026-11-01, ดู project_cm_recheck_2026_11)
    //   ภาษีซื้อ: 20/40/70, ภาษีขาย: 10, ภาษีหัก ณ ที่จ่ายค้างจ่าย: 20, ภาษีถูกหัก ณ ที่จ่าย: 10/90
    await pool.query(`ALTER TABLE cm_transaction_gl_setup ADD COLUMN IF NOT EXISTS vat_input_account_id INTEGER REFERENCES gl_account(id)`);
    await pool.query(`ALTER TABLE cm_transaction_gl_setup ADD COLUMN IF NOT EXISTS vat_output_account_id INTEGER REFERENCES gl_account(id)`);
    await pool.query(`ALTER TABLE cm_transaction_gl_setup ADD COLUMN IF NOT EXISTS wht_payable_account_id INTEGER REFERENCES gl_account(id)`);
    await pool.query(`ALTER TABLE cm_transaction_gl_setup ADD COLUMN IF NOT EXISTS wht_prepaid_account_id INTEGER REFERENCES gl_account(id)`);
};

const SETUP_SELECT = `
    SELECT
        d.doc_code,
        d.doc_name_thai,
        d.doc_name_eng,
        d.sys_doc_type,
        d.is_active AS doc_is_active,
        s.id,
        s.revenue_account_id,            rev_a.account_code  AS revenue_account_code,            rev_a.account_name_thai  AS revenue_account_name,
        s.expense_account_id,            exp_a.account_code  AS expense_account_code,            exp_a.account_name_thai  AS expense_account_name,
        s.petty_cash_payable_account_id, pcp_a.account_code  AS petty_cash_payable_account_code,  pcp_a.account_name_thai  AS petty_cash_payable_account_name,
        s.fx_gain_account_id,            gain_a.account_code AS fx_gain_account_code,             gain_a.account_name_thai AS fx_gain_account_name,
        s.fx_loss_account_id,            loss_a.account_code AS fx_loss_account_code,             loss_a.account_name_thai AS fx_loss_account_name,
        s.vat_input_account_id, x0.account_code AS vat_input_account_code, x0.account_name_thai AS vat_input_account_name,
        s.vat_output_account_id, x1.account_code AS vat_output_account_code, x1.account_name_thai AS vat_output_account_name,
        s.wht_payable_account_id, x2.account_code AS wht_payable_account_code, x2.account_name_thai AS wht_payable_account_name,
        s.wht_prepaid_account_id, x3.account_code AS wht_prepaid_account_code, x3.account_name_thai AS wht_prepaid_account_name,
        s.gl_doc_id,                     gl_d.doc_code AS gl_doc_code,                            gl_d.doc_name_thai AS gl_doc_name,
        s.created_at, s.updated_at, s.created_by, s.updated_by
    FROM sa_module_document d
    LEFT JOIN cm_transaction_gl_setup s ON s.doc_code = d.doc_code
    LEFT JOIN gl_account rev_a  ON rev_a.id  = s.revenue_account_id
    LEFT JOIN gl_account exp_a  ON exp_a.id  = s.expense_account_id
    LEFT JOIN gl_account pcp_a  ON pcp_a.id  = s.petty_cash_payable_account_id
    LEFT JOIN gl_account gain_a ON gain_a.id = s.fx_gain_account_id
    LEFT JOIN gl_account loss_a ON loss_a.id = s.fx_loss_account_id
    LEFT JOIN gl_account x0 ON x0.id = s.vat_input_account_id
    LEFT JOIN gl_account x1 ON x1.id = s.vat_output_account_id
    LEFT JOIN gl_account x2 ON x2.id = s.wht_payable_account_id
    LEFT JOIN gl_account x3 ON x3.id = s.wht_prepaid_account_id
    LEFT JOIN sa_module_document gl_d ON gl_d.id = s.gl_doc_id
    WHERE d.sys_module = '81'
      AND d.is_doc_type = true
      AND d.sys_doc_type NOT IN ('15','25')
`;

// GET all CM doc_codes with setup data (excludes 15/25 — read-only mirrors, never post)
const fetchRows = async (req, res) => {
    try {
        await ensureTable(req.dbPool);
        const result = await req.dbPool.query(
            SETUP_SELECT + ` ORDER BY d.sys_doc_type, d.sort_order, d.doc_code`
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching cm_transaction_gl_setup:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET one doc_code
const fetchRow = async (req, res) => {
    const { doc_code } = req.params;
    try {
        await ensureTable(req.dbPool);
        const result = await req.dbPool.query(
            SETUP_SELECT + ` AND d.doc_code = $1`, [doc_code]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'doc_code not found in sa_module_document' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching cm_transaction_gl_setup row:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST upsert by doc_code
const upsertRow = async (req, res) => {
    const { doc_code } = req.params;
    const {
        revenue_account_id, expense_account_id, petty_cash_payable_account_id,
        fx_gain_account_id, fx_loss_account_id, gl_doc_id,
        vat_input_account_id, vat_output_account_id, wht_payable_account_id, wht_prepaid_account_id,
    } = req.body;
    const userName = req.headers.username;

    try {
        await ensureTable(req.dbPool);
        const docCheck = await req.dbPool.query(
            `SELECT doc_code FROM sa_module_document WHERE doc_code = $1 AND sys_module = '81' AND is_doc_type = true`,
            [doc_code]
        );
        if (docCheck.rows.length === 0) {
            return res.status(404).json({ message: `doc_code '${doc_code}' ไม่พบในระบบ CM` });
        }

        await req.dbPool.query(
            `INSERT INTO cm_transaction_gl_setup
                (doc_code, revenue_account_id, expense_account_id, petty_cash_payable_account_id,
                 fx_gain_account_id, fx_loss_account_id, gl_doc_id,
                 vat_input_account_id, vat_output_account_id, wht_payable_account_id, wht_prepaid_account_id,
                 created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$9,$10,$11,$12,$8,$8)
             ON CONFLICT (doc_code) DO UPDATE SET
                revenue_account_id            = EXCLUDED.revenue_account_id,
                expense_account_id            = EXCLUDED.expense_account_id,
                petty_cash_payable_account_id = EXCLUDED.petty_cash_payable_account_id,
                fx_gain_account_id            = EXCLUDED.fx_gain_account_id,
                fx_loss_account_id            = EXCLUDED.fx_loss_account_id,
                gl_doc_id                     = EXCLUDED.gl_doc_id,
                vat_input_account_id = EXCLUDED.vat_input_account_id,
                vat_output_account_id = EXCLUDED.vat_output_account_id,
                wht_payable_account_id = EXCLUDED.wht_payable_account_id,
                wht_prepaid_account_id = EXCLUDED.wht_prepaid_account_id,
                updated_by                    = EXCLUDED.updated_by,
                updated_at                    = NOW()`,
            [
                doc_code,
                revenue_account_id || null, expense_account_id || null, petty_cash_payable_account_id || null,
                fx_gain_account_id || null, fx_loss_account_id || null, gl_doc_id || null, userName,
                vat_input_account_id || null, vat_output_account_id || null, wht_payable_account_id || null, wht_prepaid_account_id || null,
            ]
        );

        const updated = await req.dbPool.query(SETUP_SELECT + ` AND d.doc_code = $1`, [doc_code]);
        res.status(200).json(updated.rows[0]);
    } catch (error) {
        console.error('Error upserting cm_transaction_gl_setup:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = { fetchRows, fetchRow, upsertRow, ensureTable };
