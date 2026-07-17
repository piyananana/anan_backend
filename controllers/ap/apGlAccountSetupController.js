// controllers/ap/apGlAccountSetupController.js

const SETUP_SELECT = `
    SELECT
        d.doc_code,
        d.doc_name_thai,
        d.doc_name_eng,
        d.sys_doc_type,
        d.is_active     AS doc_is_active,
        s.id,
        s.ap_account_id,           ap_a.account_code   AS ap_account_code,          ap_a.account_name_thai   AS ap_account_name,
        s.expense_account_id,      exp_a.account_code  AS expense_account_code,     exp_a.account_name_thai  AS expense_account_name,
        s.vat_input_account_id,    vat_a.account_code  AS vat_input_account_code,   vat_a.account_name_thai  AS vat_input_account_name,
        s.discount_account_id,     dis_a.account_code  AS discount_account_code,    dis_a.account_name_thai  AS discount_account_name,
        s.advance_account_id,      adv_a.account_code  AS advance_account_code,     adv_a.account_name_thai  AS advance_account_name,
        s.wht_payable_account_id,  wht_a.account_code  AS wht_payable_account_code, wht_a.account_name_thai  AS wht_payable_account_name,
        s.cash_account_id,         cas_a.account_code  AS cash_account_code,        cas_a.account_name_thai  AS cash_account_name,
        s.check_account_id,        chk_a.account_code  AS check_account_code,       chk_a.account_name_thai  AS check_account_name,
        s.transfer_account_id,     trn_a.account_code  AS transfer_account_code,    trn_a.account_name_thai  AS transfer_account_name,
        s.fx_gain_account_id,      gain_a.account_code AS fx_gain_account_code,     gain_a.account_name_thai AS fx_gain_account_name,
        s.fx_loss_account_id,      loss_a.account_code AS fx_loss_account_code,     loss_a.account_name_thai AS fx_loss_account_name,
        s.vat_pending_input_account_id, pend_a.account_code AS vat_pending_input_account_code, pend_a.account_name_thai AS vat_pending_input_account_name,
        s.gl_doc_id,               gl_d.doc_code AS gl_doc_code,                   gl_d.doc_name_thai AS gl_doc_name,
        s.created_at, s.updated_at, s.created_by, s.updated_by
    FROM sa_module_document d
    LEFT JOIN ap_gl_account_setup s      ON s.doc_code = d.doc_code
    LEFT JOIN gl_account ap_a            ON ap_a.id   = s.ap_account_id
    LEFT JOIN gl_account exp_a           ON exp_a.id  = s.expense_account_id
    LEFT JOIN gl_account vat_a           ON vat_a.id  = s.vat_input_account_id
    LEFT JOIN gl_account dis_a           ON dis_a.id  = s.discount_account_id
    LEFT JOIN gl_account adv_a           ON adv_a.id  = s.advance_account_id
    LEFT JOIN gl_account wht_a           ON wht_a.id  = s.wht_payable_account_id
    LEFT JOIN gl_account cas_a           ON cas_a.id  = s.cash_account_id
    LEFT JOIN gl_account chk_a           ON chk_a.id  = s.check_account_id
    LEFT JOIN gl_account trn_a           ON trn_a.id  = s.transfer_account_id
    LEFT JOIN gl_account gain_a          ON gain_a.id = s.fx_gain_account_id
    LEFT JOIN gl_account loss_a          ON loss_a.id = s.fx_loss_account_id
    LEFT JOIN gl_account pend_a          ON pend_a.id = s.vat_pending_input_account_id
    LEFT JOIN sa_module_document gl_d    ON gl_d.id   = s.gl_doc_id
    WHERE d.sys_module = '21'
      AND d.is_doc_type = true
`;

// GET all AP doc_codes with setup data
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            SETUP_SELECT + ` ORDER BY d.sys_doc_type, d.sort_order, d.doc_code`
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching ap_gl_account_setup:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET one doc_code
const fetchRow = async (req, res) => {
    const { doc_code } = req.params;
    try {
        const result = await req.dbPool.query(
            SETUP_SELECT + ` AND d.doc_code = $1`, [doc_code]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'doc_code not found in sa_module_document' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching ap_gl_account_setup row:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST upsert by doc_code
const upsertRow = async (req, res) => {
    const { doc_code } = req.params;
    const {
        ap_account_id, expense_account_id, vat_input_account_id, discount_account_id,
        advance_account_id, wht_payable_account_id, cash_account_id,
        check_account_id, transfer_account_id,
        fx_gain_account_id, fx_loss_account_id,
        vat_pending_input_account_id, gl_doc_id,
    } = req.body;
    const userName = req.headers.username;

    try {
        const docCheck = await req.dbPool.query(
            `SELECT doc_code FROM sa_module_document WHERE doc_code = $1 AND sys_module = '21' AND is_doc_type = true`,
            [doc_code]
        );
        if (docCheck.rows.length === 0) {
            return res.status(404).json({ message: `doc_code '${doc_code}' ไม่พบในระบบ AP` });
        }

        await req.dbPool.query(
            `INSERT INTO ap_gl_account_setup
                (doc_code, ap_account_id, expense_account_id, vat_input_account_id, discount_account_id,
                 advance_account_id, wht_payable_account_id, cash_account_id,
                 check_account_id, transfer_account_id,
                 fx_gain_account_id, fx_loss_account_id,
                 vat_pending_input_account_id, gl_doc_id,
                 created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
             ON CONFLICT (doc_code) DO UPDATE SET
                ap_account_id                = EXCLUDED.ap_account_id,
                expense_account_id           = EXCLUDED.expense_account_id,
                vat_input_account_id         = EXCLUDED.vat_input_account_id,
                discount_account_id          = EXCLUDED.discount_account_id,
                advance_account_id           = EXCLUDED.advance_account_id,
                wht_payable_account_id       = EXCLUDED.wht_payable_account_id,
                cash_account_id              = EXCLUDED.cash_account_id,
                check_account_id             = EXCLUDED.check_account_id,
                transfer_account_id          = EXCLUDED.transfer_account_id,
                fx_gain_account_id           = EXCLUDED.fx_gain_account_id,
                fx_loss_account_id           = EXCLUDED.fx_loss_account_id,
                vat_pending_input_account_id = EXCLUDED.vat_pending_input_account_id,
                gl_doc_id                    = EXCLUDED.gl_doc_id,
                updated_by                   = EXCLUDED.updated_by,
                updated_at                   = NOW()`,
            [
                doc_code,
                ap_account_id || null, expense_account_id || null, vat_input_account_id || null,
                discount_account_id || null, advance_account_id || null, wht_payable_account_id || null,
                cash_account_id || null, check_account_id || null, transfer_account_id || null,
                fx_gain_account_id || null, fx_loss_account_id || null,
                vat_pending_input_account_id || null, gl_doc_id || null, userName,
            ]
        );

        const updated = await req.dbPool.query(SETUP_SELECT + ` AND d.doc_code = $1`, [doc_code]);
        res.status(200).json(updated.rows[0]);
    } catch (error) {
        console.error('Error upserting ap_gl_account_setup:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// สำหรับใช้ภายใน apTransactionController
const fetchSetupByDocCode = async (pool, docCode) => {
    const result = await pool.query(
        `SELECT * FROM ap_gl_account_setup WHERE doc_code = $1`, [docCode]
    );
    return result.rows[0] || null;
};

module.exports = { fetchRows, fetchRow, upsertRow, fetchSetupByDocCode };
