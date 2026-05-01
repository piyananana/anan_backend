// controllers/ar/arGlAccountSetupController.js

// Helper: join setup + sa_module_document + gl_account names
const SETUP_SELECT = `
    SELECT
        d.doc_code,
        d.doc_name_thai,
        d.sys_doc_type,
        d.is_active     AS doc_is_active,
        s.id,
        s.ar_account_id,          ar_a.account_code  AS ar_account_code,          ar_a.account_name_thai  AS ar_account_name,
        s.revenue_account_id,     rev_a.account_code AS revenue_account_code,     rev_a.account_name_thai AS revenue_account_name,
        s.vat_output_account_id,  vat_a.account_code AS vat_output_account_code,  vat_a.account_name_thai AS vat_output_account_name,
        s.discount_account_id,    dis_a.account_code AS discount_account_code,    dis_a.account_name_thai AS discount_account_name,
        s.advance_account_id,     adv_a.account_code AS advance_account_code,     adv_a.account_name_thai AS advance_account_name,
        s.cash_account_id,        cas_a.account_code AS cash_account_code,        cas_a.account_name_thai AS cash_account_name,
        s.check_account_id,        chk_a.account_code AS check_account_code,        chk_a.account_name_thai AS check_account_name,
        s.transfer_account_id,     trn_a.account_code AS transfer_account_code,     trn_a.account_name_thai AS transfer_account_name,
        s.credit_card_account_id,  crd_a.account_code AS credit_card_account_code,  crd_a.account_name_thai AS credit_card_account_name,
        s.debit_card_account_id,   dbt_a.account_code AS debit_card_account_code,   dbt_a.account_name_thai AS debit_card_account_name,
        s.qr_code_account_id,      qrc_a.account_code AS qr_code_account_code,      qrc_a.account_name_thai AS qr_code_account_name,
        s.mobile_banking_account_id, mob_a.account_code AS mobile_banking_account_code, mob_a.account_name_thai AS mobile_banking_account_name,
        s.bill_of_exchange_account_id, boe_a.account_code AS bill_of_exchange_account_code, boe_a.account_name_thai AS bill_of_exchange_account_name,
        s.wht_account_id,         wht_a.account_code AS wht_account_code,         wht_a.account_name_thai AS wht_account_name,
        s.fx_gain_account_id,              gain_a.account_code  AS fx_gain_account_code,              gain_a.account_name_thai  AS fx_gain_account_name,
        s.fx_loss_account_id,              loss_a.account_code  AS fx_loss_account_code,              loss_a.account_name_thai  AS fx_loss_account_name,
        s.vat_pending_output_account_id,   pend_a.account_code  AS vat_pending_output_account_code,   pend_a.account_name_thai  AS vat_pending_output_account_name,
        s.gl_doc_id,              gl_d.doc_code AS gl_doc_code,                   gl_d.doc_name_thai AS gl_doc_name,
        s.created_at, s.updated_at, s.created_by, s.updated_by
    FROM sa_module_document d
    LEFT JOIN ar_gl_account_setup s        ON s.doc_code = d.doc_code
    LEFT JOIN gl_account ar_a              ON ar_a.id   = s.ar_account_id
    LEFT JOIN gl_account rev_a             ON rev_a.id  = s.revenue_account_id
    LEFT JOIN gl_account vat_a             ON vat_a.id  = s.vat_output_account_id
    LEFT JOIN gl_account dis_a             ON dis_a.id  = s.discount_account_id
    LEFT JOIN gl_account adv_a             ON adv_a.id  = s.advance_account_id
    LEFT JOIN gl_account cas_a             ON cas_a.id  = s.cash_account_id
    LEFT JOIN gl_account chk_a ON chk_a.id = s.check_account_id
    LEFT JOIN gl_account trn_a ON trn_a.id = s.transfer_account_id
    LEFT JOIN gl_account crd_a ON crd_a.id = s.credit_card_account_id
    LEFT JOIN gl_account dbt_a ON dbt_a.id = s.debit_card_account_id
    LEFT JOIN gl_account qrc_a ON qrc_a.id = s.qr_code_account_id
    LEFT JOIN gl_account mob_a ON mob_a.id = s.mobile_banking_account_id
    LEFT JOIN gl_account boe_a ON boe_a.id = s.bill_of_exchange_account_id
    LEFT JOIN gl_account wht_a             ON wht_a.id  = s.wht_account_id
    LEFT JOIN gl_account gain_a            ON gain_a.id = s.fx_gain_account_id
    LEFT JOIN gl_account loss_a            ON loss_a.id = s.fx_loss_account_id
    LEFT JOIN gl_account pend_a            ON pend_a.id = s.vat_pending_output_account_id
    LEFT JOIN sa_module_document gl_d      ON gl_d.id   = s.gl_doc_id
    WHERE d.sys_module = '11'
      AND d.is_doc_type = true
`;

// GET all AR doc_codes with setup data (LEFT JOIN — returns row even if setup missing)
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            SETUP_SELECT + ` ORDER BY d.sys_doc_type, d.sort_order, d.doc_code`
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching ar_gl_account_setup:', error);
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
        console.error('Error fetching ar_gl_account_setup row:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST upsert by doc_code
const upsertRow = async (req, res) => {
    const { doc_code } = req.params;
    const {
        ar_account_id, revenue_account_id, vat_output_account_id, discount_account_id,
        advance_account_id, cash_account_id, wht_account_id,
        fx_gain_account_id, fx_loss_account_id,
        vat_pending_output_account_id, gl_doc_id,
        check_account_id, transfer_account_id, credit_card_account_id,
        debit_card_account_id, qr_code_account_id, mobile_banking_account_id,
        bill_of_exchange_account_id,
    } = req.body;
    const userName = req.headers.username;

    // ตรวจสอบว่า doc_code มีอยู่ใน sa_module_document
    try {
        const docCheck = await req.dbPool.query(
            `SELECT doc_code FROM sa_module_document WHERE doc_code = $1 AND sys_module = '11' AND is_doc_type = true`,
            [doc_code]
        );
        if (docCheck.rows.length === 0) {
            return res.status(404).json({ message: `doc_code '${doc_code}' ไม่พบในระบบ AR` });
        }

        await req.dbPool.query(
            `INSERT INTO ar_gl_account_setup
                (doc_code, ar_account_id, revenue_account_id, vat_output_account_id, discount_account_id,
                 advance_account_id, cash_account_id, wht_account_id, fx_gain_account_id, fx_loss_account_id,
                 vat_pending_output_account_id, gl_doc_id,
                 check_account_id, transfer_account_id, credit_card_account_id,
                 debit_card_account_id, qr_code_account_id, mobile_banking_account_id,
                 bill_of_exchange_account_id,
                 created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20)
             ON CONFLICT (doc_code) DO UPDATE SET
                ar_account_id                  = EXCLUDED.ar_account_id,
                revenue_account_id             = EXCLUDED.revenue_account_id,
                vat_output_account_id          = EXCLUDED.vat_output_account_id,
                discount_account_id            = EXCLUDED.discount_account_id,
                advance_account_id             = EXCLUDED.advance_account_id,
                cash_account_id               = EXCLUDED.cash_account_id,
                wht_account_id                 = EXCLUDED.wht_account_id,
                fx_gain_account_id             = EXCLUDED.fx_gain_account_id,
                fx_loss_account_id             = EXCLUDED.fx_loss_account_id,
                vat_pending_output_account_id  = EXCLUDED.vat_pending_output_account_id,
                gl_doc_id                      = EXCLUDED.gl_doc_id,
                check_account_id               = EXCLUDED.check_account_id,
                transfer_account_id            = EXCLUDED.transfer_account_id,
                credit_card_account_id         = EXCLUDED.credit_card_account_id,
                debit_card_account_id          = EXCLUDED.debit_card_account_id,
                qr_code_account_id             = EXCLUDED.qr_code_account_id,
                mobile_banking_account_id      = EXCLUDED.mobile_banking_account_id,
                bill_of_exchange_account_id    = EXCLUDED.bill_of_exchange_account_id,
                updated_by                     = EXCLUDED.updated_by,
                updated_at                     = NOW()`,
            [
                doc_code,
                ar_account_id || null, revenue_account_id || null, vat_output_account_id || null, discount_account_id || null,
                advance_account_id || null, cash_account_id || null, wht_account_id || null,
                fx_gain_account_id || null, fx_loss_account_id || null,
                vat_pending_output_account_id || null, gl_doc_id || null,
                check_account_id || null, transfer_account_id || null, credit_card_account_id || null,
                debit_card_account_id || null, qr_code_account_id || null, mobile_banking_account_id || null,
                bill_of_exchange_account_id || null, userName,
            ]
        );

        // คืนค่าข้อมูลพร้อม JOIN
        const updated = await req.dbPool.query(SETUP_SELECT + ` AND d.doc_code = $1`, [doc_code]);
        res.status(200).json(updated.rows[0]);
    } catch (error) {
        console.error('Error upserting ar_gl_account_setup:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET: ดึง setup สำหรับ doc_code ที่กำหนด (ใช้ใน postGlEntry)
const fetchSetupByDocCode = async (pool, docCode) => {
    const result = await pool.query(
        `SELECT * FROM ar_gl_account_setup WHERE doc_code = $1`, [docCode]
    );
    return result.rows[0] || null;
};

module.exports = { fetchRows, fetchRow, upsertRow, fetchSetupByDocCode };
