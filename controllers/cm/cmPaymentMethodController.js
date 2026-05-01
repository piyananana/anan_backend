// controllers/cm/cmPaymentMethodController.js
//
// DDL:
// CREATE TABLE cm_payment_method (
//   id                  SERIAL PRIMARY KEY,
//   method_code         VARCHAR(50) UNIQUE NOT NULL,
//   method_name_th      VARCHAR(200) NOT NULL,
//   method_name_en      VARCHAR(200),
//   method_type         VARCHAR(30) NOT NULL DEFAULT 'CASH',
//                       -- CASH / CHECK / TRANSFER / BILL_OF_EXCHANGE
//   gl_account_id       INT REFERENCES gl_account(id),
//   cm_bank_account_id  INT REFERENCES cm_bank_account(id),
//   is_active           BOOLEAN NOT NULL DEFAULT TRUE,
//   remark              TEXT,
//   created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
//   updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
//   created_by          INT,
//   updated_by          INT
// );

const BASE_SELECT = `
  SELECT
    pm.*,
    ga.account_code      AS gl_account_code,
    ga.account_name_thai AS gl_account_name,
    ba.account_code  AS bank_account_code,
    ba.account_name_th AS bank_account_name_th,
    ba.account_number  AS bank_account_number,
    b.bank_name_th   AS bank_name_th,
    b.short_name     AS bank_short_name
  FROM cm_payment_method pm
  LEFT JOIN gl_account       ga ON ga.id = pm.gl_account_id
  LEFT JOIN cm_bank_account  ba ON ba.id = pm.cm_bank_account_id
  LEFT JOIN cm_bank          b  ON b.id  = ba.bank_id
`;

const fetchRows = async (req, res) => {
  try {
    const result = await req.dbPool.query(`${BASE_SELECT} ORDER BY pm.method_code ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching cm_payment_method:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const fetchRow = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await req.dbPool.query(`${BASE_SELECT} WHERE pm.id = $1`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching cm_payment_method row:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const createRow = async (req, res) => {
  const {
    method_code, method_name_th, method_name_en,
    method_type, gl_account_id, cm_bank_account_id,
    is_active, remark
  } = req.body;
  const userId = req.headers.userid;
  try {
    const result = await req.dbPool.query(
      `INSERT INTO cm_payment_method
         (method_code, method_name_th, method_name_en, method_type,
          gl_account_id, cm_bank_account_id, is_active, remark, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       RETURNING *`,
      [
        method_code, method_name_th, method_name_en || null,
        method_type || 'CASH',
        gl_account_id || null, cm_bank_account_id || null,
        is_active ?? true, remark || null, userId
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating cm_payment_method:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสประเภทการชำระนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateRow = async (req, res) => {
  const { id } = req.params;
  const {
    method_code, method_name_th, method_name_en,
    method_type, gl_account_id, cm_bank_account_id,
    is_active, remark
  } = req.body;
  const userId = req.headers.userid;
  try {
    const result = await req.dbPool.query(
      `UPDATE cm_payment_method SET
         method_code = $1, method_name_th = $2, method_name_en = $3,
         method_type = $4, gl_account_id = $5, cm_bank_account_id = $6,
         is_active = $7, remark = $8,
         updated_at = NOW(), updated_by = $9
       WHERE id = $10
       RETURNING *`,
      [
        method_code, method_name_th, method_name_en || null,
        method_type || 'CASH',
        gl_account_id || null, cm_bank_account_id || null,
        is_active ?? true, remark || null, userId, id
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating cm_payment_method:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสประเภทการชำระนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const deleteRow = async (req, res) => {
  const { id } = req.params;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('DELETE FROM cm_payment_method WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found.' });
    }
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting cm_payment_method:', err);
    if (err.code === '23503') return res.status(409).json({ error: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลที่เชื่อมโยงอยู่' });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

module.exports = { fetchRows, fetchRow, createRow, updateRow, deleteRow };
