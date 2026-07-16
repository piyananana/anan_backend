// controllers/cm/cmCheckbookController.js
//
// DDL:
// CREATE TABLE cm_checkbook (
//     id              SERIAL PRIMARY KEY,
//     bank_account_id INT NOT NULL REFERENCES cm_bank_account(id),
//     checkbook_code  VARCHAR(50) NOT NULL,
//     start_check_no  VARCHAR(20) NOT NULL,
//     end_check_no    VARCHAR(20) NOT NULL,
//     next_check_no   VARCHAR(20),
//     received_date   DATE,
//     status          VARCHAR(20) NOT NULL DEFAULT 'Active',
//     note            TEXT,
//     created_by      VARCHAR(100),
//     created_at      TIMESTAMPTZ DEFAULT NOW(),
//     updated_at      TIMESTAMPTZ DEFAULT NOW(),
//     UNIQUE(bank_account_id, checkbook_code)
// );

const ensureTable = async (pool) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cm_checkbook (
            id              SERIAL PRIMARY KEY,
            bank_account_id INT NOT NULL REFERENCES cm_bank_account(id),
            checkbook_code  VARCHAR(50) NOT NULL,
            start_check_no  VARCHAR(20) NOT NULL,
            end_check_no    VARCHAR(20) NOT NULL,
            next_check_no   VARCHAR(20),
            received_date   DATE,
            status          VARCHAR(20) NOT NULL DEFAULT 'Active',
            note            TEXT,
            created_by      VARCHAR(100),
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(bank_account_id, checkbook_code)
        )
    `);
};

const BASE_SELECT = `
  SELECT
    cb.*,
    ba.account_code AS bank_account_code,
    ba.account_name_th AS bank_account_name
  FROM cm_checkbook cb
  LEFT JOIN cm_bank_account ba ON ba.id = cb.bank_account_id
`;

const fetchRows = async (req, res) => {
  try {
    await ensureTable(req.dbPool);
    const { bank_account_id } = req.query;
    let sql = `${BASE_SELECT}`;
    const params = [];
    if (bank_account_id) {
      params.push(bank_account_id);
      sql += ` WHERE cb.bank_account_id = $1`;
    }
    sql += ` ORDER BY cb.bank_account_id, cb.checkbook_code`;
    const result = await req.dbPool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching cm_checkbook:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const fetchRow = async (req, res) => {
  const { id } = req.params;
  try {
    await ensureTable(req.dbPool);
    const result = await req.dbPool.query(`${BASE_SELECT} WHERE cb.id = $1`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching cm_checkbook row:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const createRow = async (req, res) => {
  const {
    bank_account_id, checkbook_code,
    start_check_no, end_check_no, next_check_no,
    received_date, note
  } = req.body;
  const createdBy = req.headers.username;
  try {
    await ensureTable(req.dbPool);
    const result = await req.dbPool.query(
      `INSERT INTO cm_checkbook
         (bank_account_id, checkbook_code, start_check_no, end_check_no,
          next_check_no, received_date, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        bank_account_id, checkbook_code,
        start_check_no, end_check_no,
        next_check_no || start_check_no,
        received_date || null,
        note || null,
        createdBy || null
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating cm_checkbook:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสสมุดเช็คนี้มีอยู่แล้วสำหรับบัญชีธนาคารนี้' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateRow = async (req, res) => {
  const { id } = req.params;
  const {
    bank_account_id, checkbook_code,
    start_check_no, end_check_no, next_check_no,
    received_date, status, note
  } = req.body;
  try {
    await ensureTable(req.dbPool);
    const result = await req.dbPool.query(
      `UPDATE cm_checkbook SET
         bank_account_id = $1, checkbook_code = $2,
         start_check_no = $3, end_check_no = $4,
         next_check_no = $5, received_date = $6,
         status = $7, note = $8,
         updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        bank_account_id, checkbook_code,
        start_check_no, end_check_no,
        next_check_no || null,
        received_date || null,
        status || 'Active',
        note || null,
        id
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating cm_checkbook:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'รหัสสมุดเช็คนี้มีอยู่แล้วสำหรับบัญชีธนาคารนี้' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const deleteRow = async (req, res) => {
  const { id } = req.params;
  try {
    await ensureTable(req.dbPool);
    const check = await req.dbPool.query('SELECT status FROM cm_checkbook WHERE id = $1', [id]);
    if (check.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    if (check.rows[0].status === 'Used') {
      return res.status(409).json({ error: 'ไม่สามารถลบสมุดเช็คที่มีการใช้งานแล้ว' });
    }
    await req.dbPool.query('DELETE FROM cm_checkbook WHERE id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting cm_checkbook:', err);
    if (err.code === '23503') return res.status(409).json({ error: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลที่เชื่อมโยงอยู่' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { fetchRows, fetchRow, createRow, updateRow, deleteRow };
