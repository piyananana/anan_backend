// controllers/gl/glAdjustingTemplateController.js

const fetchRows = async (req, res) => {
  try {
    const result = await req.dbPool.query(`
      SELECT
        t.*,
        a1.account_code       AS debit_account_code,
        a1.account_name_thai  AS debit_account_name,
        a2.account_code       AS credit_account_code,
        a2.account_name_thai  AS credit_account_name
      FROM gl_adjusting_template t
      LEFT JOIN gl_account a1 ON a1.id = t.debit_account_id
      LEFT JOIN gl_account a2 ON a2.id = t.credit_account_id
      WHERE t.is_active = TRUE
      ORDER BY t.sort_order, t.id
    `);
    res.status(200).json(result.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const addRow = async (req, res) => {
  const { template_name, description, debit_account_id, credit_account_id, default_amount, is_active, sort_order } = req.body;
  try {
    const result = await req.dbPool.query(`
      INSERT INTO gl_adjusting_template
        (template_name, description, debit_account_id, credit_account_id, default_amount, is_active, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [template_name, description || '', debit_account_id || null, credit_account_id || null,
        default_amount || 0, is_active !== false, sort_order || 0]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const updateRow = async (req, res) => {
  const { id } = req.params;
  const { template_name, description, debit_account_id, credit_account_id, default_amount, is_active, sort_order } = req.body;
  try {
    const result = await req.dbPool.query(`
      UPDATE gl_adjusting_template SET
        template_name     = $1,
        description       = $2,
        debit_account_id  = $3,
        credit_account_id = $4,
        default_amount    = $5,
        is_active         = $6,
        sort_order        = $7,
        updated_at        = NOW()
      WHERE id = $8
      RETURNING *
    `, [template_name, description || '', debit_account_id || null, credit_account_id || null,
        default_amount || 0, is_active !== false, sort_order || 0, id]);
    res.status(200).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const deleteRow = async (req, res) => {
  const { id } = req.params;
  try {
    await req.dbPool.query(
      `UPDATE gl_adjusting_template SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
      [id]
    );
    res.status(200).json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { fetchRows, addRow, updateRow, deleteRow };
