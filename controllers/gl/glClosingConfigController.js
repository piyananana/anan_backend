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

module.exports = { getConfig, saveConfig };
