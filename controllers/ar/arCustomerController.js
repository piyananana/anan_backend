// controllers/ar/arCustomerController.js
const { generateNextCode } = require('./arCustomerRunningController');
const { generateNextCodeForGroup } = require('./arCustomerGroupController');

const fetchRowById = async (pool, id) => {
  const [mainResult, addresses, contacts, banks, billingConds, paymentConds] =
    await Promise.all([
      pool.query(`
        SELECT
          c.*,
          cbt.business_type_code,
          cbt.business_type_name_thai,
          acg.group_code        AS customer_group_code,
          acg.group_name_thai   AS customer_group_name,
          t.territory_code      AS sales_territory_code,
          t.territory_name_thai AS sales_territory_name_thai,
          sp.salesperson_code,
          sp.salesperson_name_thai,
          bc.collector_code      AS billing_collector_code,
          bc.collector_name_thai AS billing_collector_name_thai,
          cc.collector_code      AS collection_collector_code,
          cc.collector_name_thai AS collection_collector_name_thai,
          ga.account_code        AS ar_account_code,
          ga.account_name_thai   AS ar_account_name_thai,
          acg.gl_account_id AS group_ar_account_id,
          gacg.account_code AS group_ar_account_code,
          gacg.account_name_thai AS group_ar_account_name_thai
        FROM ar_customer c
        LEFT JOIN cd_business_type    cbt ON c.business_type_id       = cbt.id
        LEFT JOIN ar_customer_group   acg ON c.customer_group_id      = acg.id
        LEFT JOIN cd_sales_territory  t   ON c.sales_territory_id     = t.id
        LEFT JOIN cd_salesperson      sp  ON c.salesperson_id          = sp.id
        LEFT JOIN ar_collector        bc  ON c.billing_collector_id    = bc.id
        LEFT JOIN ar_collector        cc  ON c.collection_collector_id = cc.id
        LEFT JOIN gl_account          ga  ON c.ar_account_id           = ga.id
        LEFT JOIN gl_account           gacg ON gacg.id = acg.gl_account_id
        WHERE c.id = $1`, [id]),
      pool.query(`SELECT * FROM ar_customer_address      WHERE customer_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT * FROM ar_customer_contact      WHERE customer_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT * FROM ar_customer_bank_account WHERE customer_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT * FROM ar_customer_billing_condition  WHERE customer_id=$1 ORDER BY sort_order, id`, [id]),
      pool.query(`SELECT * FROM ar_customer_payment_condition  WHERE customer_id=$1 ORDER BY sort_order, id`, [id]),
    ]);
  if (mainResult.rows.length === 0) return null;
  return {
    ...mainResult.rows[0],
    addresses:          addresses.rows,
    contacts:           contacts.rows,
    bank_accounts:      banks.rows,
    billing_conditions: billingConds.rows,
    payment_conditions: paymentConds.rows,
  };
};

// GET /ar_customer?search=xxx
const fetchRows = async (req, res) => {
  const { search } = req.query;
  try {
    let query = `
      SELECT
        c.id, c.customer_code, c.old_customer_code, c.customer_name_th, c.customer_name_en,
        c.tax_id, c.credit_term_months, c.credit_term_days, c.credit_limit, c.discount_percent,
        c.currency_code, c.is_active,
        c.business_type_id,  cbt.business_type_code, cbt.business_type_name_thai,
        c.customer_group_id, acg.group_code AS customer_group_code,
                             acg.group_name_thai AS customer_group_name,
        c.sales_territory_id, t.territory_code      AS sales_territory_code,
                              t.territory_name_thai AS sales_territory_name_thai,
        c.salesperson_id,     sp.salesperson_code,
                              sp.salesperson_name_thai,
        c.billing_collector_id,    bc.collector_code     AS billing_collector_code,
                                   bc.collector_name_thai AS billing_collector_name_thai,
        c.collection_collector_id, cc.collector_code     AS collection_collector_code,
                                   cc.collector_name_thai AS collection_collector_name_thai,
        c.ar_account_id,           ga.account_code        AS ar_account_code,
                                   ga.account_name_thai   AS ar_account_name_thai,
        acg.gl_account_id AS group_ar_account_id,
        gacg.account_code AS group_ar_account_code,
        gacg.account_name_thai AS group_ar_account_name_thai
      FROM ar_customer c
      LEFT JOIN cd_business_type   cbt ON c.business_type_id      = cbt.id
      LEFT JOIN ar_customer_group  acg ON c.customer_group_id     = acg.id
      LEFT JOIN cd_sales_territory t   ON c.sales_territory_id    = t.id
      LEFT JOIN cd_salesperson     sp  ON c.salesperson_id         = sp.id
      LEFT JOIN ar_collector        bc ON c.billing_collector_id   = bc.id
      LEFT JOIN ar_collector        cc ON c.collection_collector_id = cc.id
      LEFT JOIN gl_account          ga ON c.ar_account_id          = ga.id
      LEFT JOIN gl_account          gacg ON gacg.id = acg.gl_account_id
      WHERE 1=1`;
    const params = [];
    if (search) {
      params.push(`%${search.toUpperCase()}%`);
      query += ` AND (UPPER(c.customer_code) LIKE $1 OR UPPER(COALESCE(c.old_customer_code,'')) LIKE $1 OR UPPER(c.customer_name_th) LIKE $1 OR UPPER(COALESCE(c.customer_name_en,'')) LIKE $1)`;
    }
    query += ` ORDER BY c.customer_code ASC`;
    const result = await req.dbPool.query(query, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching ar customers:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /ar_customer/:id
const fetchRow = async (req, res) => {
  const { id } = req.params;
  try {
    const data = await fetchRowById(req.dbPool, id);
    if (!data) return res.status(404).json({ message: 'Not found.' });
    res.status(200).json(data);
  } catch (error) {
    console.error('Error fetching ar customer:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

const insertRelated = async (client, cid, addresses, contacts, bank_accounts, billing_conditions, payment_conditions) => {
  for (const addr of (addresses || [])) {
    await client.query(
      `INSERT INTO ar_customer_address
         (customer_id, address_type, address_no, address_building_village, address_alley,
          address_road, address_sub_district, address_district, address_province,
          address_country, address_zip_code, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [cid, addr.address_type || 'billing',
       addr.address_no || null, addr.address_building_village || null,
       addr.address_alley || null, addr.address_road || null,
       addr.address_sub_district || null, addr.address_district || null,
       addr.address_province || null, addr.address_country || 'Thailand',
       addr.address_zip_code || null, addr.is_default || false]
    );
  }
  for (const c of (contacts || [])) {
    await client.query(
      `INSERT INTO ar_customer_contact
         (customer_id, contact_name, position, phone, mobile, email, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [cid, c.contact_name, c.position || null, c.phone || null,
       c.mobile || null, c.email || null, c.is_default || false]
    );
  }
  for (const b of (bank_accounts || [])) {
    await client.query(
      `INSERT INTO ar_customer_bank_account
         (customer_id, bank_name, branch_name, account_number, account_name, account_type, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [cid, b.bank_name || null, b.branch_name || null, b.account_number || null,
       b.account_name || null, b.account_type || 'current', b.is_default || false]
    );
  }
  for (const bc of (billing_conditions || [])) {
    await client.query(
      `INSERT INTO ar_customer_billing_condition
         (customer_id, sort_order, bill_with_delivery,
          billing_day_of_month, billing_day_of_week, billing_week_of_month,
          billing_time_from, billing_time_to, due_from_billing_date, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [cid,
       bc.sort_order ?? 1,
       bc.bill_with_delivery ?? false,
       bc.billing_day_of_month?.length ? bc.billing_day_of_month : null,
       bc.billing_day_of_week?.length  ? bc.billing_day_of_week  : null,
       bc.billing_week_of_month?.length ? bc.billing_week_of_month : null,
       bc.billing_time_from || null,
       bc.billing_time_to   || null,
       bc.due_from_billing_date ?? false,
       bc.remark || null]
    );
  }
  for (const pc of (payment_conditions || [])) {
    await client.query(
      `INSERT INTO ar_customer_payment_condition
         (customer_id, sort_order,
          payment_day_of_month, payment_day_of_week, payment_week_of_month,
          payment_time_from, payment_time_to,
          within_months_from_billing, additional_days, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [cid,
       pc.sort_order ?? 1,
       pc.payment_day_of_month?.length ? pc.payment_day_of_month : null,
       pc.payment_day_of_week?.length  ? pc.payment_day_of_week  : null,
       pc.payment_week_of_month?.length ? pc.payment_week_of_month : null,
       pc.payment_time_from || null,
       pc.payment_time_to   || null,
       pc.within_months_from_billing ?? 0,
       pc.additional_days ?? 0,
       pc.remark || null]
    );
  }
};

// POST /ar_customer
const addRow = async (req, res) => {
  const {
    customer_code, old_customer_code, customer_name_th, customer_name_en, tax_id,
    business_type_id, customer_group_id,
    credit_term_months, credit_term_days, credit_limit, discount_percent,
    currency_code, is_active, remark,
    requires_billing,
    addresses, contacts, bank_accounts,
    billing_conditions, payment_conditions,
    ar_account_id,
    sales_territory_id, salesperson_id,
    billing_collector_id, collection_collector_id,
  } = req.body;
  const userName = req.headers.username;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    let finalCode = customer_code && customer_code.trim() !== ''
      ? customer_code.trim().toUpperCase()
      : null;
    if (!finalCode) {
      if (customer_group_id) {
        finalCode = await generateNextCodeForGroup(client, customer_group_id);
      }
      if (!finalCode) {
        finalCode = await generateNextCode(client);
      }
    }
    if (!finalCode) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'กรุณาระบุรหัสลูกหนี้ หรือเปิดใช้งานรหัสอัตโนมัติในการตั้งค่า' });
    }
    const result = await client.query(
      `INSERT INTO ar_customer
         (customer_code, old_customer_code, customer_name_th, customer_name_en, tax_id,
          business_type_id, customer_group_id,
          credit_term_months, credit_term_days, credit_limit, discount_percent,
          currency_code, is_active, remark, requires_billing,
          ar_account_id,
          sales_territory_id, salesperson_id,
          billing_collector_id, collection_collector_id,
          created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
       RETURNING id`,
      [
        finalCode, old_customer_code || null,
        customer_name_th, customer_name_en || null,
        tax_id || null,
        business_type_id || null, customer_group_id || null,
        credit_term_months ?? 0, credit_term_days ?? 30,
        credit_limit ?? 0, discount_percent ?? 0,
        currency_code || 'THB',
        is_active !== undefined ? is_active : true,
        remark || null,
        requires_billing ?? false,
        ar_account_id ?? null,
        sales_territory_id ?? null, salesperson_id ?? null,
        billing_collector_id ?? null, collection_collector_id ?? null,
        userName,
      ]
    );
    const cid = result.rows[0].id;
    await insertRelated(client, cid, addresses, contacts, bank_accounts, billing_conditions, payment_conditions);
    await client.query('COMMIT');
    const full = await fetchRowById(req.dbPool, cid);
    res.status(201).json(full);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding ar customer:', error);
    if (error.code === '23505') return res.status(409).json({ message: 'รหัสลูกหนี้นี้มีอยู่แล้ว' });
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
};

// PUT /ar_customer/:id
const updateRow = async (req, res) => {
  const { id } = req.params;
  const {
    customer_code, old_customer_code, customer_name_th, customer_name_en, tax_id,
    business_type_id, customer_group_id,
    credit_term_months, credit_term_days, credit_limit, discount_percent,
    currency_code, is_active, remark,
    requires_billing,
    addresses, contacts, bank_accounts,
    billing_conditions, payment_conditions,
    ar_account_id,
    sales_territory_id, salesperson_id,
    billing_collector_id, collection_collector_id,
  } = req.body;
  const userName = req.headers.username;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE ar_customer SET
         customer_code      = $1,  old_customer_code  = $2,
         customer_name_th   = $3,  customer_name_en   = $4,
         tax_id             = $5,
         business_type_id   = $6,  customer_group_id  = $7,
         credit_term_months = $8,  credit_term_days   = $9,
         credit_limit       = $10, discount_percent   = $11,
         currency_code      = $12, is_active          = $13,
         remark             = $14, requires_billing   = $15,
         ar_account_id      = $16,
         sales_territory_id = $17, salesperson_id     = $18,
         billing_collector_id    = $19, collection_collector_id = $20,
         updated_by         = $21, updated_at         = NOW()
       WHERE id = $22
       RETURNING id`,
      [
        customer_code.toUpperCase(), old_customer_code || null,
        customer_name_th, customer_name_en || null,
        tax_id || null,
        business_type_id || null, customer_group_id || null,
        credit_term_months ?? 0, credit_term_days ?? 30,
        credit_limit ?? 0, discount_percent ?? 0,
        currency_code || 'THB', is_active,
        remark || null,
        requires_billing ?? false,
        ar_account_id ?? null,
        sales_territory_id ?? null, salesperson_id ?? null,
        billing_collector_id ?? null, collection_collector_id ?? null,
        userName, id,
      ]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found.' });
    }
    await client.query(`DELETE FROM ar_customer_address           WHERE customer_id=$1`, [id]);
    await client.query(`DELETE FROM ar_customer_contact           WHERE customer_id=$1`, [id]);
    await client.query(`DELETE FROM ar_customer_bank_account      WHERE customer_id=$1`, [id]);
    await client.query(`DELETE FROM ar_customer_billing_condition WHERE customer_id=$1`, [id]);
    await client.query(`DELETE FROM ar_customer_payment_condition WHERE customer_id=$1`, [id]);
    await insertRelated(client, id, addresses, contacts, bank_accounts, billing_conditions, payment_conditions);
    await client.query('COMMIT');
    const full = await fetchRowById(req.dbPool, id);
    res.status(200).json(full);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating ar customer:', error);
    if (error.code === '23505') return res.status(409).json({ message: 'รหัสลูกหนี้นี้มีอยู่แล้ว' });
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
};

// DELETE /ar_customer/:id
const deleteRow = async (req, res) => {
  const { id } = req.params;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`DELETE FROM ar_customer WHERE id=$1 RETURNING id`, [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found.' });
    }
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting ar customer:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

module.exports = { fetchRows, fetchRow, addRow, updateRow, deleteRow };
