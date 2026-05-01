// controllers/cm/cmBankController.js
//
// DDL:
// CREATE TABLE cm_bank (
//   id            SERIAL PRIMARY KEY,
//   bank_code     VARCHAR(20) UNIQUE NOT NULL,
//   bank_name_th  VARCHAR(200) NOT NULL,
//   bank_name_en  VARCHAR(200),
//   short_name    VARCHAR(50),
//   swift_code    VARCHAR(20),
//   is_active     BOOLEAN NOT NULL DEFAULT TRUE,
//   remark        TEXT,
//   created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
//   updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
//   created_by    INT,
//   updated_by    INT
// );

const fetchRows = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      `SELECT * FROM cm_bank ORDER BY bank_code ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching cm_bank:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const fetchRow = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await req.dbPool.query(
      `SELECT * FROM cm_bank WHERE id = $1`, [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching cm_bank row:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const createRow = async (req, res) => {
  const { bank_code, bank_name_th, bank_name_en, short_name, swift_code, is_active, remark } = req.body;
  const userId = req.headers.userid;
  try {
    const result = await req.dbPool.query(
      `INSERT INTO cm_bank
         (bank_code, bank_name_th, bank_name_en, short_name, swift_code, is_active, remark, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       RETURNING *`,
      [bank_code, bank_name_th, bank_name_en || null, short_name || null, swift_code || null,
       is_active ?? true, remark || null, userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating cm_bank:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสธนาคารนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateRow = async (req, res) => {
  const { id } = req.params;
  const { bank_code, bank_name_th, bank_name_en, short_name, swift_code, is_active, remark } = req.body;
  const userId = req.headers.userid;
  try {
    const result = await req.dbPool.query(
      `UPDATE cm_bank SET
         bank_code = $1, bank_name_th = $2, bank_name_en = $3,
         short_name = $4, swift_code = $5, is_active = $6,
         remark = $7, updated_at = NOW(), updated_by = $8
       WHERE id = $9
       RETURNING *`,
      [bank_code, bank_name_th, bank_name_en || null, short_name || null, swift_code || null,
       is_active ?? true, remark || null, userId, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating cm_bank:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสธนาคารนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const deleteRow = async (req, res) => {
  const { id } = req.params;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('DELETE FROM cm_bank WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found.' });
    }
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting cm_bank:', err);
    if (err.code === '23503') return res.status(409).json({ error: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลที่เชื่อมโยงอยู่' });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

module.exports = { fetchRows, fetchRow, createRow, updateRow, deleteRow };
