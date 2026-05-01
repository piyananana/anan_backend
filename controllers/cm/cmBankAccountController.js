// controllers/cm/cmBankAccountController.js
//
// DDL:
// CREATE TABLE cm_bank_account (
//   id               SERIAL PRIMARY KEY,
//   account_code     VARCHAR(50) UNIQUE NOT NULL,
//   account_name_th  VARCHAR(200) NOT NULL,
//   account_name_en  VARCHAR(200),
//   bank_id          INT REFERENCES cm_bank(id),
//   account_number   VARCHAR(100),
//   account_type     VARCHAR(20) NOT NULL DEFAULT 'SAVING',  -- SAVING / CURRENT / FIXED
//   gl_account_id    INT REFERENCES gl_account(id),
//   is_active        BOOLEAN NOT NULL DEFAULT TRUE,
//   remark           TEXT,
//   created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
//   updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
//   created_by       INT,
//   updated_by       INT
// );

const BASE_SELECT = `
  SELECT
    ba.*,
    b.bank_code,
    b.bank_name_th,
    b.bank_name_en,
    b.short_name    AS bank_short_name,
    ga.account_code      AS gl_account_code,
    ga.account_name_thai AS gl_account_name
  FROM cm_bank_account ba
  LEFT JOIN cm_bank    b  ON b.id  = ba.bank_id
  LEFT JOIN gl_account ga ON ga.id = ba.gl_account_id
`;

const fetchRows = async (req, res) => {
  try {
    const result = await req.dbPool.query(`${BASE_SELECT} ORDER BY ba.account_code ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching cm_bank_account:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const fetchRow = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await req.dbPool.query(`${BASE_SELECT} WHERE ba.id = $1`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching cm_bank_account row:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const createRow = async (req, res) => {
  const {
    account_code, account_name_th, account_name_en,
    bank_id, account_number, account_type,
    gl_account_id, is_active, remark
  } = req.body;
  const userId = req.headers.userid;
  try {
    const result = await req.dbPool.query(
      `INSERT INTO cm_bank_account
         (account_code, account_name_th, account_name_en, bank_id, account_number,
          account_type, gl_account_id, is_active, remark, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       RETURNING *`,
      [
        account_code, account_name_th, account_name_en || null,
        bank_id || null, account_number || null,
        account_type || 'SAVING',
        gl_account_id || null, is_active ?? true, remark || null, userId
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating cm_bank_account:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสบัญชีธนาคารนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateRow = async (req, res) => {
  const { id } = req.params;
  const {
    account_code, account_name_th, account_name_en,
    bank_id, account_number, account_type,
    gl_account_id, is_active, remark
  } = req.body;
  const userId = req.headers.userid;
  try {
    const result = await req.dbPool.query(
      `UPDATE cm_bank_account SET
         account_code = $1, account_name_th = $2, account_name_en = $3,
         bank_id = $4, account_number = $5, account_type = $6,
         gl_account_id = $7, is_active = $8, remark = $9,
         updated_at = NOW(), updated_by = $10
       WHERE id = $11
       RETURNING *`,
      [
        account_code, account_name_th, account_name_en || null,
        bank_id || null, account_number || null,
        account_type || 'SAVING',
        gl_account_id || null, is_active ?? true, remark || null, userId, id
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating cm_bank_account:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสบัญชีธนาคารนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const deleteRow = async (req, res) => {
  const { id } = req.params;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('DELETE FROM cm_bank_account WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found.' });
    }
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting cm_bank_account:', err);
    if (err.code === '23503') return res.status(409).json({ error: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลที่เชื่อมโยงอยู่' });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

module.exports = { fetchRows, fetchRow, createRow, updateRow, deleteRow };
