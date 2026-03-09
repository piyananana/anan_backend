// ดึงข้อมูลรายการเคลื่อนไหวสำหรับบัญชีแยกประเภท (GL Report)
const getGeneralLedgerTransactions = async (req, res) => {
    const { period_id, fiscal_year_id, account_from, account_to } = req.query;
    const client = await req.dbPool.connect();

    try {
        // หา period ids ที่จะดึง: ถ้าระบุ period_id ใช้งวดเดียว, ถ้าไม่ระบุใช้ทุกงวดปกติของปี
        let periodIds;
        if (period_id) {
            periodIds = [parseInt(period_id)];
        } else if (fiscal_year_id) {
            const periodsRes = await client.query(
                `SELECT id FROM gl_posting_period WHERE fiscal_year_id = $1 ORDER BY period_number ASC`,
                [fiscal_year_id]
            );
            // ข้ามงวดแรก (งวดยกยอด)
            periodIds = periodsRes.rows.slice(1).map(p => p.id);
            if (periodIds.length === 0) return res.json([]);
        } else {
            return res.status(400).json({ error: 'period_id or fiscal_year_id is required' });
        }

        let sql = `
            SELECT
                d.account_id, a.account_code, a.account_name_thai, a.normal_balance,
                d.branch_id, d.business_unit_id, d.project_id,
                h.doc_date, doc.doc_code, h.doc_no, d.line_no,
                ref_doc.doc_code AS ref_doc_code, h.ref_doc_no, h.ref_doc_date,
                d.description, d.debit_lc, d.credit_lc
            FROM gl_entry_detail d
            JOIN gl_entry_header h ON d.header_id = h.id
            JOIN gl_account a ON d.account_id = a.id
            LEFT JOIN sa_module_document doc ON h.doc_id = doc.id
            LEFT JOIN sa_module_document ref_doc ON h.ref_doc_id = ref_doc.id
            WHERE h.period_id = ANY($1::int[])
              AND h.status = 'Posted'
        `;

        const params = [periodIds];

        // กรองช่วงรหัสบัญชี (From - To) โดยใช้ string comparison กับ account_code
        if (account_from) {
            params.push(account_from);
            sql += ` AND a.account_code >= $${params.length}`;
        }
        if (account_to) {
            params.push(account_to);
            sql += ` AND a.account_code <= $${params.length}`;
        }

        // เรียงลำดับตาม รหัสบัญชี -> สาขา -> หน่วยงาน -> โครงการ -> วันที่ -> เลขที่เอกสาร -> ลำดับ
        sql += ` ORDER BY a.account_code ASC, d.branch_id ASC, d.business_unit_id ASC, d.project_id ASC, h.doc_date ASC, h.doc_no ASC, d.line_no ASC`;

        const result = await client.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Error in getGeneralLedgerTransactions:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// GET /gl_report_beginning_balance?fiscal_year_id=X&period_id=Y
// ยอดยกมา = สะสม gl_balance_accum ของทุกงวดที่มี period_number < งวดที่เลือก
const getReportBeginningBalance = async (req, res) => {
  const { fiscal_year_id, period_id } = req.query;
  const pool = req.dbPool;
  try {
    const periodsRes = await pool.query(
      `SELECT id, period_number FROM gl_posting_period
       WHERE fiscal_year_id = $1 ORDER BY period_number ASC`,
      [fiscal_year_id]
    );
    if (periodsRes.rows.length === 0) return res.json([]);

    let periodIds;
    if (!period_id) {
      // ไม่ระบุงวด → สะสมทุกงวดในปี
      periodIds = periodsRes.rows.map(p => p.id);
    } else {
      const selected = periodsRes.rows.find(p => p.id == period_id);
      if (!selected) return res.json([]);
      // สะสมเฉพาะงวดที่มี period_number น้อยกว่างวดที่เลือก
      periodIds = periodsRes.rows
        .filter(p => p.period_number < selected.period_number)
        .map(p => p.id);
    }

    if (periodIds.length === 0) return res.json([]);

    const result = await pool.query(
      `SELECT account_id, business_unit_id, branch_id, project_id,
              SUM(debit_amount)  AS amount_dr,
              SUM(credit_amount) AS amount_cr
       FROM gl_balance_accum
       WHERE period_id = ANY($1::int[])
       GROUP BY account_id, business_unit_id, branch_id, project_id
       HAVING SUM(debit_amount) > 0.001 OR SUM(credit_amount) > 0.001`,
      [periodIds]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
    getGeneralLedgerTransactions,
    getReportBeginningBalance,
};