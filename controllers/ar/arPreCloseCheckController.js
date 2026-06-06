// controllers/ar/arPreCloseCheckController.js
// ตรวจสอบสถานะก่อนปิดปี AR

// GET /api/ar/year_end/pre_close_check?period_year=2025
const preCloseCheck = async (req, res) => {
    const { period_year } = req.query;
    if (!period_year) return res.status(400).json({ error: 'period_year is required' });
    const year = parseInt(period_year);

    const client = await req.dbPool.connect();
    try {
        // 1. Draft transactions ในปีที่จะปิด
        const draftRes = await client.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.customer_name_th,
                   d.doc_name_thai, d.sys_doc_type
            FROM ar_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE t.status = 'Draft'
              AND EXTRACT(YEAR FROM t.doc_date) = $1
            ORDER BY t.doc_date, t.doc_no
        `, [year]);

        // 2. Bill Collection ที่ยังไม่ชำระ (balance > 0)
        const openBcRes = await client.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.customer_name_th,
                   t.balance_amount_lc
            FROM ar_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE d.sys_doc_type = '70'
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0.005
              AND EXTRACT(YEAR FROM t.doc_date) <= $1
            ORDER BY t.doc_date, t.doc_no
        `, [year]);

        // 3. เงินมัดจำค้าง (balance > 0)
        const openAdvRes = await client.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.customer_name_th,
                   t.balance_amount_lc, d.doc_name_thai
            FROM ar_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE d.sys_doc_type IN ('60', '65')
              AND t.status NOT IN ('Void')
              AND t.balance_amount_lc > 0.005
              AND EXTRACT(YEAR FROM t.doc_date) <= $1
            ORDER BY t.doc_date, t.doc_no
        `, [year]);

        // 4. Reconcile: AR Subledger vs GL Control Account
        //    ยอด AR subledger = SUM(balance_amount_lc) ของ invoice/DN ที่ยังค้างชำระ
        const arBalRes = await client.query(`
            SELECT COALESCE(SUM(t.balance_amount_lc), 0) AS ar_module_balance
            FROM ar_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE d.sys_doc_type IN ('10','30','35')
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0.005
        `);

        //    ยอด GL Control Account = SUM(debit_lc - credit_lc) ของบัญชีที่เป็น AR control
        const glBalRes = await client.query(`
            SELECT COALESCE(
                SUM(
                    CASE WHEN ged.debit_lc > 0 THEN ged.debit_lc ELSE -ged.credit_lc END
                ), 0
            ) AS gl_ar_balance
            FROM gl_entry_detail ged
            JOIN gl_account ga ON ga.id = ged.account_id
            JOIN gl_entry_header geh ON geh.id = ged.header_id
            WHERE ga.is_control_account = true
              AND geh.status = 'Posted'
        `);

        const arModuleBalance = Number(arBalRes.rows[0].ar_module_balance || 0);
        const glArBalance     = Number(glBalRes.rows[0].gl_ar_balance     || 0);
        const reconcileDiff   = Math.abs(arModuleBalance - glArBalance);

        const canProceed = draftRes.rows.length === 0;

        res.json({
            period_year:        year,
            draft_count:        draftRes.rows.length,
            draft_docs:         draftRes.rows,
            open_bc_count:      openBcRes.rows.length,
            open_bc_docs:       openBcRes.rows,
            open_advance_count: openAdvRes.rows.length,
            open_advance_docs:  openAdvRes.rows,
            ar_module_balance:  arModuleBalance,
            gl_ar_balance:      glArBalance,
            reconcile_diff:     reconcileDiff,
            can_proceed:        canProceed,
        });
    } catch (err) {
        console.error('preCloseCheck error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { preCloseCheck };
