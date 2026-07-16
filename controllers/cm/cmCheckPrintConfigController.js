// controllers/cm/cmCheckPrintConfigController.js
//
// DDL:
// CREATE TABLE cm_check_print_config (
//     id              SERIAL PRIMARY KEY,
//     bank_account_id INT NOT NULL REFERENCES cm_bank_account(id),
//     config_name     VARCHAR(100) NOT NULL,
//     paper_width_mm  NUMERIC(8,2) NOT NULL DEFAULT 210,
//     paper_height_mm NUMERIC(8,2) NOT NULL DEFAULT 99,
//     date_x          NUMERIC(8,2) DEFAULT 150,
//     date_y          NUMERIC(8,2) DEFAULT 18,
//     date_format     VARCHAR(20) DEFAULT 'dd/MM/yyyy',
//     payee_x         NUMERIC(8,2) DEFAULT 35,
//     payee_y         NUMERIC(8,2) DEFAULT 38,
//     amount_num_x    NUMERIC(8,2) DEFAULT 155,
//     amount_num_y    NUMERIC(8,2) DEFAULT 38,
//     amount_text_x   NUMERIC(8,2) DEFAULT 20,
//     amount_text_y   NUMERIC(8,2) DEFAULT 55,
//     has_stub        BOOLEAN DEFAULT FALSE,
//     stub_width_mm   NUMERIC(8,2) DEFAULT 50,
//     is_default      BOOLEAN DEFAULT FALSE,
//     created_by      VARCHAR(100),
//     created_at      TIMESTAMPTZ DEFAULT NOW(),
//     updated_at      TIMESTAMPTZ DEFAULT NOW()
// );

const ensureTable = async (pool) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cm_check_print_config (
            id              SERIAL PRIMARY KEY,
            bank_account_id INT NOT NULL REFERENCES cm_bank_account(id),
            config_name     VARCHAR(100) NOT NULL,
            paper_width_mm  NUMERIC(8,2) NOT NULL DEFAULT 210,
            paper_height_mm NUMERIC(8,2) NOT NULL DEFAULT 99,
            date_x          NUMERIC(8,2) DEFAULT 150,
            date_y          NUMERIC(8,2) DEFAULT 18,
            date_format     VARCHAR(20) DEFAULT 'dd/MM/yyyy',
            payee_x         NUMERIC(8,2) DEFAULT 35,
            payee_y         NUMERIC(8,2) DEFAULT 38,
            amount_num_x    NUMERIC(8,2) DEFAULT 155,
            amount_num_y    NUMERIC(8,2) DEFAULT 38,
            amount_text_x   NUMERIC(8,2) DEFAULT 20,
            amount_text_y   NUMERIC(8,2) DEFAULT 55,
            has_stub        BOOLEAN DEFAULT FALSE,
            stub_width_mm   NUMERIC(8,2) DEFAULT 50,
            is_default      BOOLEAN DEFAULT FALSE,
            created_by      VARCHAR(100),
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `);
};

const BASE_SELECT = `
  SELECT
    cfg.*,
    ba.account_code AS bank_account_code,
    ba.account_name_th AS bank_account_name
  FROM cm_check_print_config cfg
  LEFT JOIN cm_bank_account ba ON ba.id = cfg.bank_account_id
`;

const fetchRows = async (req, res) => {
  try {
    await ensureTable(req.dbPool);
    const { bank_account_id } = req.query;
    let sql = `${BASE_SELECT}`;
    const params = [];
    if (bank_account_id) {
      params.push(bank_account_id);
      sql += ` WHERE cfg.bank_account_id = $1`;
    }
    sql += ` ORDER BY cfg.bank_account_id, cfg.is_default DESC, cfg.config_name`;
    const result = await req.dbPool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching cm_check_print_config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const fetchRow = async (req, res) => {
  const { id } = req.params;
  try {
    await ensureTable(req.dbPool);
    const result = await req.dbPool.query(`${BASE_SELECT} WHERE cfg.id = $1`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching cm_check_print_config row:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const createRow = async (req, res) => {
  const {
    bank_account_id, config_name,
    paper_width_mm, paper_height_mm,
    date_x, date_y, date_format,
    payee_x, payee_y,
    amount_num_x, amount_num_y,
    amount_text_x, amount_text_y,
    has_stub, stub_width_mm, is_default
  } = req.body;
  const createdBy = req.headers.username;
  const client = await req.dbPool.connect();
  try {
    await ensureTable(req.dbPool);
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO cm_check_print_config
         (bank_account_id, config_name,
          paper_width_mm, paper_height_mm,
          date_x, date_y, date_format,
          payee_x, payee_y,
          amount_num_x, amount_num_y,
          amount_text_x, amount_text_y,
          has_stub, stub_width_mm, is_default,
          created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        bank_account_id, config_name,
        paper_width_mm ?? 210, paper_height_mm ?? 99,
        date_x ?? 150, date_y ?? 18, date_format || 'dd/MM/yyyy',
        payee_x ?? 35, payee_y ?? 38,
        amount_num_x ?? 155, amount_num_y ?? 38,
        amount_text_x ?? 20, amount_text_y ?? 55,
        has_stub ?? false, stub_width_mm ?? 50, is_default ?? false,
        createdBy || null
      ]
    );
    const newId = result.rows[0].id;
    if (is_default) {
      await client.query(
        `UPDATE cm_check_print_config SET is_default = FALSE WHERE bank_account_id = $1 AND id != $2`,
        [bank_account_id, newId]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating cm_check_print_config:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

const updateRow = async (req, res) => {
  const { id } = req.params;
  const {
    bank_account_id, config_name,
    paper_width_mm, paper_height_mm,
    date_x, date_y, date_format,
    payee_x, payee_y,
    amount_num_x, amount_num_y,
    amount_text_x, amount_text_y,
    has_stub, stub_width_mm, is_default
  } = req.body;
  const client = await req.dbPool.connect();
  try {
    await ensureTable(req.dbPool);
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE cm_check_print_config SET
         bank_account_id = $1, config_name = $2,
         paper_width_mm = $3, paper_height_mm = $4,
         date_x = $5, date_y = $6, date_format = $7,
         payee_x = $8, payee_y = $9,
         amount_num_x = $10, amount_num_y = $11,
         amount_text_x = $12, amount_text_y = $13,
         has_stub = $14, stub_width_mm = $15, is_default = $16,
         updated_at = NOW()
       WHERE id = $17
       RETURNING *`,
      [
        bank_account_id, config_name,
        paper_width_mm ?? 210, paper_height_mm ?? 99,
        date_x ?? 150, date_y ?? 18, date_format || 'dd/MM/yyyy',
        payee_x ?? 35, payee_y ?? 38,
        amount_num_x ?? 155, amount_num_y ?? 38,
        amount_text_x ?? 20, amount_text_y ?? 55,
        has_stub ?? false, stub_width_mm ?? 50, is_default ?? false,
        id
      ]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found.' });
    }
    if (is_default) {
      await client.query(
        `UPDATE cm_check_print_config SET is_default = FALSE WHERE bank_account_id = $1 AND id != $2`,
        [bank_account_id, id]
      );
    }
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating cm_check_print_config:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

const deleteRow = async (req, res) => {
  const { id } = req.params;
  try {
    await ensureTable(req.dbPool);
    const result = await req.dbPool.query('DELETE FROM cm_check_print_config WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting cm_check_print_config:', err);
    if (err.code === '23503') return res.status(409).json({ error: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลที่เชื่อมโยงอยู่' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { fetchRows, fetchRow, createRow, updateRow, deleteRow };
