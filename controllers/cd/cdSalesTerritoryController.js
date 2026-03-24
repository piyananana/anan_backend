// controllers/cd/cdSalesTerritoryController.js

// GET /cd_sales_territory
const fetchRows = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      `SELECT t.*,
              p.territory_name_thai AS parent_name_thai
         FROM cd_sales_territory t
         LEFT JOIN cd_sales_territory p ON t.parent_id = p.id
        ORDER BY t.sort_order ASC, t.territory_code ASC`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching cd_sales_territory:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// GET /cd_sales_territory/active
const fetchActiveRows = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      `SELECT t.*,
              p.territory_name_thai AS parent_name_thai
         FROM cd_sales_territory t
         LEFT JOIN cd_sales_territory p ON t.parent_id = p.id
        WHERE t.is_active = TRUE
        ORDER BY t.sort_order ASC, t.territory_code ASC`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching active cd_sales_territory:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// POST /cd_sales_territory
const addRow = async (req, res) => {
  const {
    territory_code, territory_name_thai, territory_name_eng,
    parent_id, sort_order, description,
    effective_date_from, effective_date_to, is_active,
  } = req.body;
  const userName = req.headers.username;
  try {
    const result = await req.dbPool.query(
      `INSERT INTO cd_sales_territory
         (territory_code, territory_name_thai, territory_name_eng,
          parent_id, sort_order, description,
          effective_date_from, effective_date_to, is_active,
          created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       RETURNING *`,
      [
        territory_code?.trim().toUpperCase(), territory_name_thai, territory_name_eng || null,
        parent_id || null, sort_order ?? 0, description || null,
        effective_date_from || null, effective_date_to || null,
        is_active !== undefined ? is_active : true,
        userName,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding cd_sales_territory:', err);
    if (err.code === '23505') return res.status(409).json({ message: 'รหัสเขตการขายนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// PUT /cd_sales_territory/:id
const updateRow = async (req, res) => {
  const { id } = req.params;
  const {
    territory_code, territory_name_thai, territory_name_eng,
    parent_id, sort_order, description,
    effective_date_from, effective_date_to, is_active,
  } = req.body;
  const userName = req.headers.username;
  try {
    const result = await req.dbPool.query(
      `UPDATE cd_sales_territory SET
         territory_code      = $1,
         territory_name_thai = $2,
         territory_name_eng  = $3,
         parent_id           = $4,
         sort_order          = $5,
         description         = $6,
         effective_date_from = $7,
         effective_date_to   = $8,
         is_active           = $9,
         updated_by          = $10,
         updated_at          = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        territory_code?.trim().toUpperCase(), territory_name_thai, territory_name_eng || null,
        parent_id || null, sort_order ?? 0, description || null,
        effective_date_from || null, effective_date_to || null,
        is_active,
        userName, id,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error updating cd_sales_territory:', err);
    if (err.code === '23505') return res.status(409).json({ message: 'รหัสเขตการขายนี้มีอยู่แล้ว' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// DELETE /cd_sales_territory/:id
const deleteRow = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await req.dbPool.query(
      `DELETE FROM cd_sales_territory WHERE id=$1 RETURNING id`, [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting cd_sales_territory:', err);
    if (err.code === '23503') return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลอ้างอิง' });
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { fetchRows, fetchActiveRows, addRow, updateRow, deleteRow };
