// controllers/ar/arCollectorController.js

const COLLECTOR_SELECT = `
  SELECT ac.*,
         br.branch_name_thai,
         bu.bu_name_thai AS business_unit_name
    FROM ar_collector ac
    LEFT JOIN cd_branch       br ON ac.branch_id       = br.id
    LEFT JOIN cd_business_unit bu ON ac.business_unit_id = bu.id
`;

const fetchRowById = async (pool, id) => {
  const result = await pool.query(COLLECTOR_SELECT + ' WHERE ac.id = $1', [id]);
  return result.rows[0] ?? null;
};

// GET /ar_collector?search=xxx&active_only=true
const fetchRows = async (req, res) => {
  const { search, active_only } = req.query;
  try {
    let query = COLLECTOR_SELECT + ' WHERE 1=1';
    const params = [];
    if (active_only === 'true') {
      query += ' AND ac.is_active = TRUE';
    }
    if (search) {
      params.push(`%${search.toUpperCase()}%`);
      query += ` AND (UPPER(ac.collector_code) LIKE $${params.length} OR UPPER(ac.collector_name_thai) LIKE $${params.length})`;
    }
    query += ' ORDER BY ac.collector_code ASC';
    const result = await req.dbPool.query(query, params);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching ar_collector:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// GET /ar_collector/:id
const fetchRow = async (req, res) => {
  try {
    const data = await fetchRowById(req.dbPool, req.params.id);
    if (!data) return res.status(404).json({ message: 'Not found.' });
    res.status(200).json(data);
  } catch (err) {
    console.error('Error fetching ar_collector:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// POST /ar_collector
const addRow = async (req, res) => {
  const {
    collector_code, collector_name_thai, collector_name_eng,
    collector_type, tax_id, branch_id, business_unit_id,
    phone, email, address,
    effective_date_from, effective_date_to, is_active,
  } = req.body;
  const userName = req.headers.username;
  try {
    const result = await req.dbPool.query(
      `INSERT INTO ar_collector
         (collector_code, collector_name_thai, collector_name_eng,
          collector_type, tax_id, branch_id, business_unit_id,
          phone, email, address,
          effective_date_from, effective_date_to, is_active,
          created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       RETURNING id`,
      [
        collector_code?.trim().toUpperCase(), collector_name_thai,
        collector_name_eng || null,
        collector_type || 'EMPLOYEE',
        tax_id || null, branch_id || null, business_unit_id || null,
        phone || null, email || null, address || null,
        effective_date_from || null, effective_date_to || null,
        is_active !== undefined ? is_active : true,
        userName,
      ]
    );
    const full = await fetchRowById(req.dbPool, result.rows[0].id);
    res.status(201).json(full);
  } catch (err) {
    console.error('Error adding ar_collector:', err);
    if (err.code === '23505') {
      return res.status(409).json({ message: 'รหัสผู้วางบิล/รับชำระนี้มีอยู่แล้ว' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
};

// PUT /ar_collector/:id
const updateRow = async (req, res) => {
  const { id } = req.params;
  const {
    collector_code, collector_name_thai, collector_name_eng,
    collector_type, tax_id, branch_id, business_unit_id,
    phone, email, address,
    effective_date_from, effective_date_to, is_active,
  } = req.body;
  const userName = req.headers.username;
  try {
    const result = await req.dbPool.query(
      `UPDATE ar_collector SET
         collector_code       = $1,
         collector_name_thai  = $2,
         collector_name_eng   = $3,
         collector_type       = $4,
         tax_id               = $5,
         branch_id            = $6,
         business_unit_id     = $7,
         phone                = $8,
         email                = $9,
         address              = $10,
         effective_date_from  = $11,
         effective_date_to    = $12,
         is_active            = $13,
         updated_by           = $14,
         updated_at           = NOW()
       WHERE id = $15
       RETURNING id`,
      [
        collector_code?.trim().toUpperCase(), collector_name_thai,
        collector_name_eng || null,
        collector_type || 'EMPLOYEE',
        tax_id || null, branch_id || null, business_unit_id || null,
        phone || null, email || null, address || null,
        effective_date_from || null, effective_date_to || null,
        is_active, userName, id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    const full = await fetchRowById(req.dbPool, id);
    res.status(200).json(full);
  } catch (err) {
    console.error('Error updating ar_collector:', err);
    if (err.code === '23505') {
      return res.status(409).json({ message: 'รหัสผู้วางบิล/รับชำระนี้มีอยู่แล้ว' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
};

// DELETE /ar_collector/:id
const deleteRow = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      'DELETE FROM ar_collector WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting ar_collector:', err);
    if (err.code === '23503') {
      return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลอ้างอิง' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { fetchRows, fetchRow, addRow, updateRow, deleteRow };
