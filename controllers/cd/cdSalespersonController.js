// controllers/cd/cdSalespersonController.js

const fetchRowById = async (pool, id) => {
  const [main, territories] = await Promise.all([
    pool.query(
      `SELECT sp.*,
              u.user_name AS user_name_ref,
              bu.bu_name_thai AS business_unit_name,
              br.branch_name_thai AS branch_name_thai
         FROM cd_salesperson sp
         LEFT JOIN sa_user u ON sp.user_id = u.id
         LEFT JOIN cd_business_unit bu ON sp.business_unit_id = bu.id
         LEFT JOIN cd_branch br ON sp.branch_id = br.id
        WHERE sp.id = $1`, [id]
    ),
    pool.query(
      `SELECT st.*, t.territory_code, t.territory_name_thai
         FROM cd_salesperson_territory st
         JOIN cd_sales_territory t ON st.territory_id = t.id
        WHERE st.salesperson_id = $1
        ORDER BY st.is_primary DESC, t.territory_code ASC`, [id]
    ),
  ]);
  if (main.rows.length === 0) return null;
  return { ...main.rows[0], territories: territories.rows };
};

// GET /cd_salesperson
const fetchRows = async (req, res) => {
  const { search } = req.query;
  try {
    let query = `
      SELECT sp.*,
             u.user_name AS user_name_ref,
             bu.bu_name_thai AS business_unit_name,
             br.branch_name_thai AS branch_name_thai
        FROM cd_salesperson sp
        LEFT JOIN sa_user u ON sp.user_id = u.id
        LEFT JOIN cd_business_unit bu ON sp.business_unit_id = bu.id
        LEFT JOIN cd_branch br ON sp.branch_id = br.id
       WHERE 1=1`;
    const params = [];
    if (search) {
      params.push(`%${search.toUpperCase()}%`);
      query += ` AND (UPPER(sp.salesperson_code) LIKE $1 OR UPPER(sp.salesperson_name_thai) LIKE $1)`;
    }
    query += ` ORDER BY sp.salesperson_code ASC`;
    const result = await req.dbPool.query(query, params);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching cd_salesperson:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// GET /cd_salesperson/:id
const fetchRow = async (req, res) => {
  try {
    const data = await fetchRowById(req.dbPool, req.params.id);
    if (!data) return res.status(404).json({ message: 'Not found.' });
    res.status(200).json(data);
  } catch (err) {
    console.error('Error fetching cd_salesperson:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// POST /cd_salesperson
const addRow = async (req, res) => {
  const {
    salesperson_code, salesperson_name_thai, salesperson_name_eng,
    salesperson_type, user_id, tax_id, branch_id, business_unit_id,
    phone, email, address, commission_rate,
    effective_date_from, effective_date_to, is_active,
    territories,
  } = req.body;
  const userName = req.headers.username;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO cd_salesperson
         (salesperson_code, salesperson_name_thai, salesperson_name_eng,
          salesperson_type, user_id, tax_id, branch_id, business_unit_id,
          phone, email, address, commission_rate,
          effective_date_from, effective_date_to, is_active,
          created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
       RETURNING id`,
      [
        salesperson_code?.trim().toUpperCase(), salesperson_name_thai, salesperson_name_eng || null,
        salesperson_type || 'EMPLOYEE', user_id || null, tax_id || null, branch_id || null,
        business_unit_id || null,
        phone || null, email || null, address || null, commission_rate ?? 0,
        effective_date_from || null, effective_date_to || null,
        is_active !== undefined ? is_active : true,
        userName,
      ]
    );
    const spId = result.rows[0].id;
    await _insertTerritories(client, spId, territories);
    await client.query('COMMIT');
    const full = await fetchRowById(req.dbPool, spId);
    res.status(201).json(full);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error adding cd_salesperson:', err);
    if (err.code === '23505') return res.status(409).json({ message: 'รหัสพนักงานขายนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

// PUT /cd_salesperson/:id
const updateRow = async (req, res) => {
  const { id } = req.params;
  const {
    salesperson_code, salesperson_name_thai, salesperson_name_eng,
    salesperson_type, user_id, tax_id, branch_id, business_unit_id,
    phone, email, address, commission_rate,
    effective_date_from, effective_date_to, is_active,
    territories,
  } = req.body;
  const userName = req.headers.username;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE cd_salesperson SET
         salesperson_code      = $1,
         salesperson_name_thai = $2,
         salesperson_name_eng  = $3,
         salesperson_type      = $4,
         user_id               = $5,
         tax_id                = $6,
         branch_id             = $7,
         business_unit_id      = $8,
         phone                 = $9,
         email                 = $10,
         address               = $11,
         commission_rate       = $12,
         effective_date_from   = $13,
         effective_date_to     = $14,
         is_active             = $15,
         updated_by            = $16,
         updated_at            = NOW()
       WHERE id = $17
       RETURNING id`,
      [
        salesperson_code?.trim().toUpperCase(), salesperson_name_thai, salesperson_name_eng || null,
        salesperson_type || 'EMPLOYEE', user_id || null, tax_id || null, branch_id || null,
        business_unit_id || null,
        phone || null, email || null, address || null, commission_rate ?? 0,
        effective_date_from || null, effective_date_to || null,
        is_active, userName, id,
      ]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found.' });
    }
    await client.query(`DELETE FROM cd_salesperson_territory WHERE salesperson_id=$1`, [id]);
    await _insertTerritories(client, id, territories);
    await client.query('COMMIT');
    const full = await fetchRowById(req.dbPool, id);
    res.status(200).json(full);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating cd_salesperson:', err);
    if (err.code === '23505') return res.status(409).json({ message: 'รหัสพนักงานขายนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

// DELETE /cd_salesperson/:id
const deleteRow = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      `DELETE FROM cd_salesperson WHERE id=$1 RETURNING id`, [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting cd_salesperson:', err);
    if (err.code === '23503') return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลอ้างอิง' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

const _insertTerritories = async (client, spId, territories) => {
  for (const t of (territories || [])) {
    await client.query(
      `INSERT INTO cd_salesperson_territory
         (salesperson_id, territory_id, is_primary, effective_date_from, effective_date_to)
       VALUES ($1,$2,$3,$4,$5)`,
      [spId, t.territory_id, t.is_primary || false,
       t.effective_date_from || null, t.effective_date_to || null]
    );
  }
};

// GET /cd_salesperson/by_territory/:territoryId
const fetchByTerritory = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      `SELECT sp.id,
              sp.salesperson_code,
              sp.salesperson_name_thai,
              sp.salesperson_name_eng,
              sp.salesperson_type,
              sp.is_active,
              st.is_primary,
              st.effective_date_from,
              st.effective_date_to
         FROM cd_salesperson sp
         JOIN cd_salesperson_territory st ON st.salesperson_id = sp.id
        WHERE st.territory_id = $1
        ORDER BY st.is_primary DESC, sp.salesperson_code ASC`,
      [req.params.territoryId]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching salespersons by territory:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { fetchRows, fetchRow, addRow, updateRow, deleteRow, fetchByTerritory };
