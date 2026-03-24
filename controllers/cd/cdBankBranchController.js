// controllers/cd/cdBankBranchController.js

// GET all branches (with bank info), optional ?bank_id=x filter
const fetchRows = async (req, res) => {
  const { bank_id } = req.query;
  try {
    let query = `
      SELECT b.*, bk.bank_code, bk.bank_name_thai, bk.short_name
      FROM cd_bank_branch b
      JOIN cd_bank bk ON b.bank_id = bk.id
      WHERE 1=1`;
    const params = [];
    if (bank_id) {
      params.push(bank_id);
      query += ` AND b.bank_id = $${params.length}`;
    }
    query += ` ORDER BY bk.bank_code, b.branch_code NULLS LAST, b.branch_name`;
    const result = await req.dbPool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching bank branches:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const addRow = async (req, res) => {
  const { bank_id, branch_code, branch_name, branch_address, is_active } = req.body;
  const userId = req.headers.userid;
  try {
    const result = await req.dbPool.query(
      `INSERT INTO cd_bank_branch
         (bank_id, branch_code, branch_name, branch_address, is_active, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$6)
       RETURNING *`,
      [bank_id, branch_code || null, branch_name, branch_address || null, is_active, userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating bank branch:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateRow = async (req, res) => {
  const { id } = req.params;
  const { bank_id, branch_code, branch_name, branch_address, is_active } = req.body;
  const userId = req.headers.userid;
  try {
    const result = await req.dbPool.query(
      `UPDATE cd_bank_branch SET
         bank_id = $1, branch_code = $2, branch_name = $3,
         branch_address = $4, is_active = $5,
         updated_at = NOW(), updated_by = $6
       WHERE id = $7
       RETURNING *`,
      [bank_id, branch_code || null, branch_name, branch_address || null, is_active, userId, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating bank branch:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const deleteRow = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await req.dbPool.query(
      'DELETE FROM cd_bank_branch WHERE id = $1 RETURNING *', [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting bank branch:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { fetchRows, addRow, updateRow, deleteRow };
