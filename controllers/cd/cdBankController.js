// controllers/cd/cdBankController.js

const fetchRows = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      `SELECT * FROM cd_bank ORDER BY bank_code ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching banks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const fetchActiveRows = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      `SELECT * FROM cd_bank WHERE is_active = TRUE ORDER BY bank_code ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching active banks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const addRow = async (req, res) => {
  const { bank_code, bank_name_thai, bank_name_eng, short_name, swift_code, is_active } = req.body;
  const userId = req.headers.userid;
  try {
    const result = await req.dbPool.query(
      `INSERT INTO cd_bank
         (bank_code, bank_name_thai, bank_name_eng, short_name, swift_code, is_active, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       RETURNING *`,
      [bank_code, bank_name_thai, bank_name_eng || null, short_name || null, swift_code || null, is_active, userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating bank:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสธนาคารนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateRow = async (req, res) => {
  const { id } = req.params;
  const { bank_code, bank_name_thai, bank_name_eng, short_name, swift_code, is_active } = req.body;
  const userId = req.headers.userid;
  try {
    const result = await req.dbPool.query(
      `UPDATE cd_bank SET
         bank_code = $1, bank_name_thai = $2, bank_name_eng = $3,
         short_name = $4, swift_code = $5, is_active = $6,
         updated_at = NOW(), updated_by = $7
       WHERE id = $8
       RETURNING *`,
      [bank_code, bank_name_thai, bank_name_eng || null, short_name || null, swift_code || null, is_active, userId, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating bank:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสธนาคารนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const deleteRow = async (req, res) => {
  const { id } = req.params;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('DELETE FROM cd_bank WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found.' });
    }
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting bank:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

module.exports = { fetchRows, fetchActiveRows, addRow, updateRow, deleteRow };
