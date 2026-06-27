// controllers/ap/apVendorController.js
const { generateNextCode } = require('./apVendorRunningController');

const fetchRowById = async (pool, id) => {
  // เพิ่ม vendor_type column แบบ idempotent
  await pool.query(`ALTER TABLE ap_vendor ADD COLUMN IF NOT EXISTS vendor_type VARCHAR(20)`).catch(() => {});
  const [mainResult, addresses, contacts, banks] = await Promise.all([
    pool.query(`
      SELECT
        v.*,
        vg.group_code      AS vendor_group_code,
        vg.group_name_thai AS vendor_group_name,
        cbt.business_type_code,
        cbt.business_type_name_thai,
        ga.account_code    AS ap_account_code,
        ga.account_name_thai AS ap_account_name_thai
      FROM ap_vendor v
      LEFT JOIN ap_vendor_group    vg  ON v.vendor_group_id  = vg.id
      LEFT JOIN cd_business_type cbt ON v.business_type_id = cbt.id
      LEFT JOIN gl_account       ga  ON v.ap_account_id    = ga.id
      WHERE v.id = $1`, [id]),
    pool.query(`SELECT * FROM ap_vendor_address      WHERE vendor_id=$1 ORDER BY id`, [id]),
    pool.query(`SELECT * FROM ap_vendor_contact      WHERE vendor_id=$1 ORDER BY id`, [id]),
    pool.query(`SELECT * FROM ap_vendor_bank_account WHERE vendor_id=$1 ORDER BY id`, [id]),
  ]);
  if (mainResult.rows.length === 0) return null;
  return {
    ...mainResult.rows[0],
    addresses:     addresses.rows,
    contacts:      contacts.rows,
    bank_accounts: banks.rows,
  };
};

// GET /ap_vendor?search=xxx
const fetchRows = async (req, res) => {
  const { search } = req.query;
  try {
    let query = `
      SELECT
        v.id, v.vendor_code, v.old_vendor_code, v.vendor_name_th, v.vendor_name_en,
        v.tax_id, v.credit_term_months, v.credit_term_days,
        v.currency_code, v.is_active, v.vendor_type,
        v.vendor_group_id,   vg.group_code AS vendor_group_code, vg.group_name_thai AS vendor_group_name,
        v.business_type_id,  cbt.business_type_code, cbt.business_type_name_thai,
        v.ap_account_id,     ga.account_code  AS ap_account_code,
                             ga.account_name_thai AS ap_account_name_thai
      FROM ap_vendor v
      LEFT JOIN ap_vendor_group    vg  ON v.vendor_group_id  = vg.id
      LEFT JOIN cd_business_type cbt ON v.business_type_id = cbt.id
      LEFT JOIN gl_account       ga  ON v.ap_account_id    = ga.id
      WHERE 1=1`;
    const params = [];
    if (search) {
      params.push(`%${search.toUpperCase()}%`);
      query += ` AND (UPPER(v.vendor_code) LIKE $1 OR UPPER(COALESCE(v.old_vendor_code,'')) LIKE $1
                      OR UPPER(v.vendor_name_th) LIKE $1 OR UPPER(COALESCE(v.vendor_name_en,'')) LIKE $1
                      OR UPPER(COALESCE(v.tax_id,'')) LIKE $1)`;
    }
    query += ` ORDER BY v.vendor_code ASC`;
    const result = await req.dbPool.query(query, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching ap vendors:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /ap_vendor/active
const fetchActiveRows = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      `SELECT id, vendor_code, vendor_name_th, vendor_name_en, tax_id,
              currency_code, credit_term_months, credit_term_days, ap_account_id
       FROM ap_vendor WHERE is_active=TRUE ORDER BY vendor_code ASC`
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching active ap vendors:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /ap_vendor/:id
const fetchRow = async (req, res) => {
  const { id } = req.params;
  try {
    const data = await fetchRowById(req.dbPool, id);
    if (!data) return res.status(404).json({ message: 'Not found.' });
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching ap vendor:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

const insertRelated = async (client, vid, addresses, contacts, bank_accounts) => {
  for (const addr of (addresses || [])) {
    await client.query(
      `INSERT INTO ap_vendor_address
         (vendor_id, address_type, address_no, address_building_village, address_alley,
          address_road, address_sub_district, address_district, address_province,
          address_country, address_zip_code, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [vid, addr.address_type || 'billing',
       addr.address_no || null, addr.address_building_village || null,
       addr.address_alley || null, addr.address_road || null,
       addr.address_sub_district || null, addr.address_district || null,
       addr.address_province || null, addr.address_country || 'Thailand',
       addr.address_zip_code || null, addr.is_default || false]
    );
  }
  for (const c of (contacts || [])) {
    await client.query(
      `INSERT INTO ap_vendor_contact
         (vendor_id, contact_name, position, phone, mobile, email, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [vid, c.contact_name, c.position || null, c.phone || null,
       c.mobile || null, c.email || null, c.is_default || false]
    );
  }
  for (const b of (bank_accounts || [])) {
    await client.query(
      `INSERT INTO ap_vendor_bank_account
         (vendor_id, bank_name, branch_name, account_number, account_name, account_type, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [vid, b.bank_name || null, b.branch_name || null, b.account_number || null,
       b.account_name || null, b.account_type || 'current', b.is_default || false]
    );
  }
};

// POST /ap_vendor
const addRow = async (req, res) => {
  const {
    vendor_code, old_vendor_code, vendor_name_th, vendor_name_en, tax_id,
    vendor_group_id,
    business_type_id,
    vendor_type,
    credit_term_months, credit_term_days,
    currency_code, is_active, remark,
    ap_account_id,
    addresses, contacts, bank_accounts,
  } = req.body;
  const userName = req.headers.username;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    let finalCode = vendor_code && vendor_code.trim() !== ''
      ? vendor_code.trim().toUpperCase()
      : null;
    if (!finalCode) {
      finalCode = await generateNextCode(client);
    }
    if (!finalCode) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'กรุณาระบุรหัสเจ้าหนี้ หรือเปิดใช้งานรหัสอัตโนมัติในการตั้งค่า' });
    }
    const result = await client.query(
      `INSERT INTO ap_vendor
         (vendor_code, old_vendor_code, vendor_name_th, vendor_name_en, tax_id,
          vendor_group_id,
          business_type_id,
          vendor_type,
          credit_term_months, credit_term_days,
          currency_code, is_active, remark,
          ap_account_id,
          created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       RETURNING id`,
      [
        finalCode, old_vendor_code || null,
        vendor_name_th, vendor_name_en || null,
        tax_id || null,
        vendor_group_id || null,
        business_type_id || null,
        vendor_type || null,
        credit_term_months ?? 0, credit_term_days ?? 30,
        currency_code || 'THB',
        is_active !== undefined ? is_active : true,
        remark || null,
        ap_account_id ?? null,
        userName,
      ]
    );
    const vid = result.rows[0].id;
    await insertRelated(client, vid, addresses, contacts, bank_accounts);
    await client.query('COMMIT');
    const full = await fetchRowById(req.dbPool, vid);
    res.status(201).json(full);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding ap vendor:', error);
    if (error.code === '23505') return res.status(409).json({ message: 'รหัสเจ้าหนี้นี้มีอยู่แล้ว' });
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
};

// PUT /ap_vendor/:id
const updateRow = async (req, res) => {
  const { id } = req.params;
  const {
    vendor_code, old_vendor_code, vendor_name_th, vendor_name_en, tax_id,
    vendor_group_id,
    business_type_id,
    vendor_type,
    credit_term_months, credit_term_days,
    currency_code, is_active, remark,
    ap_account_id,
    addresses, contacts, bank_accounts,
  } = req.body;
  const userName = req.headers.username;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE ap_vendor SET
         vendor_code         = $1,  old_vendor_code     = $2,
         vendor_name_th      = $3,  vendor_name_en      = $4,
         tax_id              = $5,
         vendor_group_id     = $6,
         business_type_id    = $7,
         vendor_type         = $8,
         credit_term_months  = $9,  credit_term_days    = $10,
         currency_code       = $11, is_active           = $12,
         remark              = $13,
         ap_account_id       = $14,
         updated_by          = $15, updated_at          = NOW()
       WHERE id = $16
       RETURNING id`,
      [
        vendor_code.toUpperCase(), old_vendor_code || null,
        vendor_name_th, vendor_name_en || null,
        tax_id || null,
        vendor_group_id || null,
        business_type_id || null,
        vendor_type || null,
        credit_term_months ?? 0, credit_term_days ?? 30,
        currency_code || 'THB', is_active,
        remark || null,
        ap_account_id ?? null,
        userName, id,
      ]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found.' });
    }
    await client.query(`DELETE FROM ap_vendor_address      WHERE vendor_id=$1`, [id]);
    await client.query(`DELETE FROM ap_vendor_contact      WHERE vendor_id=$1`, [id]);
    await client.query(`DELETE FROM ap_vendor_bank_account WHERE vendor_id=$1`, [id]);
    await insertRelated(client, id, addresses, contacts, bank_accounts);
    await client.query('COMMIT');
    const full = await fetchRowById(req.dbPool, id);
    res.status(200).json(full);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating ap vendor:', error);
    if (error.code === '23505') return res.status(409).json({ message: 'รหัสเจ้าหนี้นี้มีอยู่แล้ว' });
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
};

// DELETE /ap_vendor/:id
const deleteRow = async (req, res) => {
  const { id } = req.params;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`DELETE FROM ap_vendor WHERE id=$1 RETURNING id`, [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found.' });
    }
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting ap vendor:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

module.exports = { fetchRows, fetchActiveRows, fetchRow, addRow, updateRow, deleteRow, insertRelated };
