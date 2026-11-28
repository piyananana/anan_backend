// controllers/gl/glClosingConfigController.js

const getConfig = async (req, res) => {
  try {
    const result = await req.dbPool.query(`
      SELECT
        c.*,
        a1.account_code  AS income_summary_account_code,
        a1.account_name_thai AS income_summary_account_name,
        a2.account_code  AS retained_earnings_account_code,
        a2.account_name_thai AS retained_earnings_account_name
      FROM gl_closing_config c
      LEFT JOIN gl_account a1 ON a1.id = c.income_summary_account_id
      LEFT JOIN gl_account a2 ON a2.id = c.retained_earnings_account_id
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No closing config found' });
    }
    res.status(200).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const saveConfig = async (req, res) => {
  const {
    income_summary_account_id,
    retained_earnings_account_id,
    revenue_account_types,
    expense_account_types,
    closing_doc_id,
    carry_forward_doc_id,
  } = req.body;

  try {
    // Check if config exists
    const existing = await req.dbPool.query('SELECT id FROM gl_closing_config LIMIT 1');
    let result;
    if (existing.rows.length === 0) {
      result = await req.dbPool.query(`
        INSERT INTO gl_closing_config
          (income_summary_account_id, retained_earnings_account_id,
           revenue_account_types, expense_account_types,
           closing_doc_id, carry_forward_doc_id, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        RETURNING *
      `, [
        income_summary_account_id, retained_earnings_account_id,
        revenue_account_types, expense_account_types,
        closing_doc_id || null, carry_forward_doc_id || null,
      ]);
    } else {
      result = await req.dbPool.query(`
        UPDATE gl_closing_config SET
          income_summary_account_id  = $1,
          retained_earnings_account_id = $2,
          revenue_account_types      = $3,
          expense_account_types      = $4,
          closing_doc_id             = $5,
          carry_forward_doc_id       = $6,
          updated_at                 = NOW()
        WHERE id = $7
        RETURNING *
      `, [
        income_summary_account_id, retained_earnings_account_id,
        revenue_account_types, expense_account_types,
        closing_doc_id || null, carry_forward_doc_id || null,
        existing.rows[0].id,
      ]);
    }
    res.status(200).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /gl_closing_config/summary — หน้าจอตั้งค่าปิดบัญชีสิ้นปีแบบใหม่ (user 2026-11-28)
//   ปีล่าสุดที่ปิดบัญชีแล้ว, ปีถัดไปที่ต้องปิด (+ ความคืบหน้าขั้นตอน, งวด GL ที่ปิดแล้ว, Draft ค้าง),
//   กำไร(ขาดทุน)ปีปัจจุบันถึงวันนี้, ยอดบัญชีกำไรสะสมในปีปัจจุบัน, ประวัติการปิดบัญชี
const fetchSummary = async (req, res) => {
  const { resolveFiscalYear } = require('./glAccountToolsController');
  const client = await req.dbPool.connect();
  try {
    const cfg = (await client.query(`SELECT * FROM gl_closing_config LIMIT 1`)).rows[0] || null;
    const history = (await client.query(`
      SELECT c.id, c.fiscal_year_id, f.fy_code, c.status, c.updated_at,
             h3.doc_no AS closing_doc_no, h5.doc_no AS carry_doc_no,
             (SELECT COALESCE(SUM(d.credit_lc - d.debit_lc), 0)::float8 FROM gl_entry_detail d
               WHERE d.header_id = c.step4_entry_id AND d.account_id = $1) AS net_income
        FROM gl_year_end_closing c JOIN gl_fiscal_year f ON f.id = c.fiscal_year_id
        LEFT JOIN gl_entry_header h3 ON h3.id = c.step3_entry_id
        LEFT JOIN gl_entry_header h5 ON h5.id = c.step5_entry_id
       ORDER BY f.year_start_date DESC`, [cfg?.retained_earnings_account_id || 0])).rows;
    const done = history.filter(h => h.status === 'COMPLETED');
    // ปีถัดไปที่ต้องปิด = ปีแรก (ตามวันเริ่ม) ที่ยังปิดบัญชีสิ้นปีไม่เสร็จ
    const next = (await client.query(`
      SELECT f.id, f.fy_code,
             COUNT(p.id)::int AS total_periods,
             COUNT(p.id) FILTER (WHERE p.gl_status = 'CLOSED')::int AS closed_periods,
             (SELECT COUNT(*)::int FROM gl_entry_header h JOIN gl_posting_period pp ON pp.id = h.period_id
               WHERE pp.fiscal_year_id = f.id AND h.status = 'Draft') AS draft_entries
        FROM gl_fiscal_year f LEFT JOIN gl_posting_period p ON p.fiscal_year_id = f.id
       WHERE NOT EXISTS (SELECT 1 FROM gl_year_end_closing c WHERE c.fiscal_year_id = f.id AND c.status = 'COMPLETED')
       GROUP BY f.id ORDER BY f.year_start_date LIMIT 1`)).rows[0] || null;
    let nextSteps = null;
    if (next) {
      nextSteps = (await client.query(`
        SELECT step1_checklist_ok, step2_adjusting_ok, step3_closing_ok, step4_transfer_ok, step5_carry_forward_ok, step6_lock_ok, status
          FROM gl_year_end_closing WHERE fiscal_year_id = $1 ORDER BY id DESC LIMIT 1`, [next.id])).rows[0] || null;
    }
    const fy = await resolveFiscalYear(client, null);
    let netIncomeYtd = 0;
    let retained = 0;
    if (fy) {
      const revTypes = cfg?.revenue_account_types?.length ? cfg.revenue_account_types : ['REVENUE'];
      const expTypes = cfg?.expense_account_types?.length ? cfg.expense_account_types : ['EXPENSE'];
      netIncomeYtd = (await client.query(`
        SELECT COALESCE(SUM(b.credit_amount - b.debit_amount), 0)::float8 AS n
          FROM gl_balance_accum b JOIN gl_posting_period p ON p.id = b.period_id JOIN gl_account a ON a.id = b.account_id
         WHERE p.fiscal_year_id = $1 AND a.account_type = ANY($2::text[])`, [fy.id, [...revTypes, ...expTypes]])).rows[0].n;
      if (cfg?.retained_earnings_account_id) {
        retained = (await client.query(`
          SELECT COALESCE(SUM(b.credit_amount - b.debit_amount), 0)::float8 AS n
            FROM gl_balance_accum b JOIN gl_posting_period p ON p.id = b.period_id
           WHERE p.fiscal_year_id = $1 AND b.account_id = $2`, [fy.id, cfg.retained_earnings_account_id])).rows[0].n;
      }
    }
    res.json({
      current_fiscal_year: fy,
      last_closed: done[0] || null,
      next_year: next ? { ...next, steps: nextSteps } : null,
      net_income_ytd: netIncomeYtd,
      retained_earnings: retained,
      history,
    });
  } catch (err) {
    console.error('gl_closing_config summary:', err);
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

module.exports = { getConfig, saveConfig, fetchSummary };
