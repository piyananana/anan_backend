// controllers/ar/arCustomerRunningController.js

const formatCustomerCode = (config) => {
  let code = config.format_prefix || '';
  if (config.format_suffix_date) {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    switch (config.format_suffix_date) {
      case 'YY':     code += year.substring(2); break;
      case 'YYYY':   code += year; break;
      case 'YYMM':   code += year.substring(2) + month; break;
      case 'YYYYMM': code += year + month; break;
      case 'YYMMDD': code += year.substring(2) + month + day; break;
    }
  }
  if (config.format_separator) code += config.format_separator;
  code += config.next_running_number.toString().padStart(config.running_length, '0');
  return code;
};

// GET /ar_customer_running
const fetchConfig = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      `SELECT * FROM ar_customer_running ORDER BY id LIMIT 1`
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No config found' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching ar_customer_running:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /ar_customer_running/preview_code  (ไม่เพิ่มเลขรัน)
const previewCode = async (req, res) => {
  try {
    const result = await req.dbPool.query(
      `SELECT * FROM ar_customer_running ORDER BY id LIMIT 1`
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No config found' });
    }
    const config = result.rows[0];
    if (!config.is_auto_numbering) {
      return res.status(400).json({ message: 'Auto-numbering is not enabled' });
    }
    res.status(200).json({ customer_code: formatCustomerCode(config) });
  } catch (error) {
    console.error('Error previewing customer code:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /ar_customer_running  (upsert)
const saveConfig = async (req, res) => {
  const {
    is_auto_numbering, format_prefix, format_separator,
    format_suffix_date, running_length, next_running_number,
  } = req.body;
  const userName = req.headers['username'] || 'system';
  try {
    const existing = await req.dbPool.query(
      `SELECT id FROM ar_customer_running LIMIT 1`
    );
    let result;
    if (existing.rows.length === 0) {
      result = await req.dbPool.query(
        `INSERT INTO ar_customer_running
           (is_auto_numbering, format_prefix, format_separator,
            format_suffix_date, running_length, next_running_number,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         RETURNING *`,
        [is_auto_numbering, format_prefix, format_separator,
         format_suffix_date, running_length, next_running_number, userName]
      );
    } else {
      result = await req.dbPool.query(
        `UPDATE ar_customer_running SET
           is_auto_numbering  = $1,  format_prefix      = $2,
           format_separator   = $3,  format_suffix_date = $4,
           running_length     = $5,  next_running_number = $6,
           updated_by = $7, updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [is_auto_numbering, format_prefix, format_separator,
         format_suffix_date, running_length, next_running_number,
         userName, existing.rows[0].id]
      );
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error saving ar_customer_running:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ฟังก์ชัน export สำหรับใช้ใน arCustomerController (atomic increment ภายใน transaction)
const generateNextCode = async (client) => {
  const result = await client.query(
    `SELECT * FROM ar_customer_running ORDER BY id LIMIT 1 FOR UPDATE`
  );
  if (result.rows.length === 0 || !result.rows[0].is_auto_numbering) return null;
  const config = result.rows[0];
  const code = formatCustomerCode(config);
  await client.query(
    `UPDATE ar_customer_running SET next_running_number = next_running_number + 1 WHERE id = $1`,
    [config.id]
  );
  return code;
};

module.exports = { fetchConfig, saveConfig, previewCode, generateNextCode };
