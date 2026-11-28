// controllers/ar/arCustomerRunningController.js

// รหัสลูกค้าที่ใช้แล้ว → ข้ามไปเลขถัดไป (user 2026-11-28) — ใช้ทั้งออกรหัสจริงและแสดงตัวอย่าง
// fmt(no) = รหัสของเลขที่ no; คืน { code, no } ของเลขแรกที่ยังไม่มีลูกค้าใช้ (ค้นได้สูงสุด 10,000 เลข)
const firstFreeCode = async (db, fmt, startNo) => {
  let no = Number(startNo) || 1;
  for (let i = 0; i < 10000; i++, no++) {
    const code = fmt(no);
    const r = await db.query('SELECT 1 FROM ar_customer WHERE customer_code = $1 LIMIT 1', [code]);
    if (!r.rows.length) return { code, no };
  }
  throw new Error('ไม่พบรหัสลูกค้าว่างภายใน 10,000 เลขถัดไป — ตรวจสอบการตั้งค่ารหัสอัตโนมัติ');
};

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
  code += Number(config.next_running_number).toString().padStart(config.running_length, '0');
  return code;
};
const fmtAt = (config) => (no) => formatCustomerCode({ ...config, next_running_number: no });

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
    // ตัวอย่าง 3 รหัสถัดไปที่จะออกจริง (ข้ามรหัสที่มีลูกค้าใช้แล้ว) + รหัสล่าสุดที่ระบบออก
    const next = [];
    let no = Number(config.next_running_number) || 1;
    for (let i = 0; i < 3; i++) {
      const f = await firstFreeCode(req.dbPool, fmtAt(config), no);
      next.push(f.code);
      no = f.no + 1;
    }
    const last = await req.dbPool.query(
      `SELECT c.customer_code FROM ar_customer c LEFT JOIN ar_customer_group g ON g.id = c.customer_group_id
        WHERE COALESCE(c.is_code_auto_generated, false) AND (g.id IS NULL OR NOT COALESCE(g.is_auto_number, false))
        ORDER BY c.created_at DESC NULLS LAST, c.id DESC LIMIT 1`).catch(() => ({ rows: [] }));
    res.status(200).json({ customer_code: next[0], next_codes: next, last_code: last.rows[0]?.customer_code || null });
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
  const { code, no } = await firstFreeCode(client, fmtAt(config), config.next_running_number);
  await client.query(
    `UPDATE ar_customer_running SET next_running_number = $2 WHERE id = $1`,
    [config.id, no + 1]
  );
  return code;
};

// GET /ar_customer_running/summary?prefix=&separator=&suffix_date=&length=&next=  (หน้าจอแบบ B, 2026-11-28)
// ตามรูปแบบที่กำลังแก้: 4 รหัสที่จะออกจริง (ข้ามรหัสที่มีลูกค้าใช้แล้ว), รหัสเลขถัดไปชนลูกค้าเดิมหรือไม่,
// รหัสล่าสุดที่ระบบออกตามรูปแบบนี้, กลุ่มลูกค้าที่ออกรหัสเอง (ใช้รูปแบบของกลุ่มแทนหน้านี้)
const DATE_LEN = { YY: 2, YYYY: 4, YYMM: 4, YYYYMM: 6, YYMMDD: 6 };
const escapeRe = (t) => String(t || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const getSummary = async (req, res) => {
  try {
    const saved = (await req.dbPool.query(`SELECT * FROM ar_customer_running ORDER BY id LIMIT 1`)).rows[0] || {};
    const q = req.query;
    const config = {
      format_prefix: q.prefix !== undefined ? String(q.prefix).toUpperCase() : (saved.format_prefix ?? 'CUST'),
      format_separator: q.separator !== undefined ? String(q.separator) : (saved.format_separator ?? '-'),
      format_suffix_date: q.suffix_date !== undefined ? String(q.suffix_date) : (saved.format_suffix_date ?? ''),
      running_length: Math.min(10, Math.max(1, Number(q.length ?? saved.running_length ?? 4) || 4)),
      next_running_number: Math.max(1, Number(q.next ?? saved.next_running_number ?? 1) || 1),
    };
    const next = config.next_running_number;
    const nextCode = formatCustomerCode(config);
    let collision = null;
    const hit = (await req.dbPool.query(
      `SELECT customer_code, customer_name_th, customer_name_en FROM ar_customer WHERE customer_code = $1 LIMIT 1`, [nextCode])).rows[0];
    if (hit) {
      const f = await firstFreeCode(req.dbPool, fmtAt(config), next);
      collision = { code: nextCode, ...hit, next_free: f.no };
    }
    const nextCodes = [];
    let n = collision ? collision.next_free : next;
    while (nextCodes.length < 4) {
      const f = await firstFreeCode(req.dbPool, fmtAt(config), n);
      nextCodes.push(f.code);
      n = f.no + 1;
    }
    const dl = DATE_LEN[config.format_suffix_date] || 0;
    const re = `^${escapeRe(config.format_prefix)}${dl ? `[0-9]{${dl}}` : ''}${escapeRe(config.format_separator)}[0-9]{${config.running_length},}$`;
    const last = (await req.dbPool.query(`
      SELECT customer_code, customer_name_th, customer_name_en, created_at FROM ar_customer
       WHERE COALESCE(is_code_auto_generated, false) AND UPPER(customer_code) ~ $1
       ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 1`, [re.toUpperCase()]).catch(() => ({ rows: [] }))).rows[0] || null;
    const groups = (await req.dbPool.query(`
      SELECT g.id, g.group_code, g.group_name_thai, g.group_name_eng,
             g.running_prefix, g.running_separator, g.running_suffix_date, g.running_length, g.running_next_number,
             (SELECT COUNT(*)::int FROM ar_customer c WHERE c.customer_group_id = g.id) AS customer_count
        FROM ar_customer_group g
       WHERE g.is_auto_number = true
       ORDER BY g.group_code`)).rows.map(g => ({
      ...g,
      sample_code: formatCustomerCode({ format_prefix: g.running_prefix, format_separator: g.running_separator,
        format_suffix_date: g.running_suffix_date, running_length: g.running_length, next_running_number: g.running_next_number }),
    }));
    res.status(200).json({ next_codes: nextCodes, collision, last_issued: last, groups });
  } catch (error) {
    console.error('Error fetching ar_customer_running summary:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { fetchConfig, saveConfig, previewCode, generateNextCode, firstFreeCode, getSummary };
