// controllers/ap/apPreCloseCheckController.js
// ตรวจสอบสถานะก่อนปิดปี AP

// GET /api/ap/year_end/pre_close_check?period_year=2025
const preCloseCheck = async (req, res) => {
    const { period_year } = req.query;
    if (!period_year) return res.status(400).json({ error: 'period_year is required' });
    const year = parseInt(period_year);

    const client = await req.dbPool.connect();
    try {
        // 1. Draft AP transactions ในปีที่จะปิด
        const draftRes = await client.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.vendor_name_th,
                   d.doc_name_thai, d.sys_doc_type
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE t.status = 'Draft'
              AND EXTRACT(YEAR FROM t.doc_date) = $1
            ORDER BY t.doc_date, t.doc_no
        `, [year]);

        // 2. เงินมัดจำจ่ายค้าง (balance > 0)
        const openAdvRes = await client.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.vendor_name_th,
                   t.balance_amount_lc, d.doc_name_thai
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE d.sys_doc_type = '60'
              AND t.status NOT IN ('Void')
              AND t.balance_amount_lc > 0.005
              AND EXTRACT(YEAR FROM t.doc_date) <= $1
            ORDER BY t.doc_date, t.doc_no
        `, [year]);

        // 3. Reconcile: AP Subledger vs GL AP Control Account
        //    AP subledger = SUM(balance_amount_lc) ของ invoice/CN ที่ยังค้างจ่าย
        const apBalRes = await client.query(`
            SELECT COALESCE(SUM(t.balance_amount_lc), 0) AS ap_module_balance
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE d.sys_doc_type IN ('10','50')
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0.005
        `);

        //    GL AP control = SUM(credit_lc - debit_lc) ของบัญชีที่ใช้เป็น AP control
        const glBalRes = await client.query(`
            SELECT COALESCE(
                SUM(ged.credit_lc - ged.debit_lc), 0
            ) AS gl_ap_balance
            FROM gl_entry_detail ged
            JOIN gl_entry_header geh ON geh.id = ged.header_id
            WHERE ged.account_id IN (
                SELECT DISTINCT ap_account_id
                FROM ap_transaction
                WHERE ap_account_id IS NOT NULL
            )
            AND geh.status = 'Posted'
        `);

        const apModuleBalance = Number(apBalRes.rows[0].ap_module_balance || 0);
        const glApBalance     = Number(glBalRes.rows[0].gl_ap_balance     || 0);
        const reconcileDiff   = Math.abs(apModuleBalance - glApBalance);
        const canProceed      = draftRes.rows.length === 0;

        res.json({
            period_year:        year,
            draft_count:        draftRes.rows.length,
            draft_docs:         draftRes.rows,
            open_advance_count: openAdvRes.rows.length,
            open_advance_docs:  openAdvRes.rows,
            ap_module_balance:  apModuleBalance,
            gl_ap_balance:      glApBalance,
            reconcile_diff:     reconcileDiff,
            can_proceed:        canProceed,
        });
    } catch (err) {
        console.error('ap preCloseCheck error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { preCloseCheck };
