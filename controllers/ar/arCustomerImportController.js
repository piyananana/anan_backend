// controllers/ar/arCustomerImportController.js
const XLSX = require('xlsx');
const multer = require('multer');
const { generateNextCode } = require('./arCustomerRunningController');
const { generateNextCodeForGroup } = require('./arCustomerGroupController');

const upload = multer({ storage: multer.memoryStorage() });

const TEMPLATE_COLUMNS = [
  { key: 'customer_code',            label: 'รหัสลูกหนี้ (ว่างได้ถ้าอัตโนมัติ)', required: false },
  { key: 'customer_group_code',      label: 'รหัสกลุ่มลูกค้า',          required: false },
  { key: 'old_customer_code',        label: 'รหัสลูกหนี้เก่า',          required: false },
  { key: 'customer_name_th',         label: 'ชื่อลูกหนี้ (ไทย)',        required: true },
  { key: 'customer_name_en',         label: 'ชื่อลูกหนี้ (อังกฤษ)',     required: false },
  { key: 'tax_id',                   label: 'เลขประจำตัวผู้เสียภาษี',   required: false },
  { key: 'credit_term_months',       label: 'เครดิต (เดือน)',            required: false },
  { key: 'credit_term_days',         label: 'เครดิต (วัน)',              required: false },
  { key: 'credit_limit',             label: 'วงเงินเครดิต',              required: false },
  { key: 'discount_percent',         label: 'ส่วนลด %',                  required: false },
  { key: 'currency_code',            label: 'สกุลเงิน',                  required: false },
  { key: 'remark',                   label: 'หมายเหตุ',                  required: false },
  { key: 'address_no',               label: 'บ้านเลขที่',                required: false },
  { key: 'address_building_village', label: 'อาคาร/หมู่บ้าน',           required: false },
  { key: 'address_alley',            label: 'ซอย',                       required: false },
  { key: 'address_road',             label: 'ถนน',                       required: false },
  { key: 'address_sub_district',     label: 'ตำบล/แขวง',                required: false },
  { key: 'address_district',         label: 'อำเภอ/เขต',                required: false },
  { key: 'address_province',         label: 'จังหวัด',                   required: false },
  { key: 'address_zip_code',         label: 'รหัสไปรษณีย์',              required: false },
  { key: 'contact_name',             label: 'ชื่อผู้ติดต่อ',             required: false },
  { key: 'phone',                    label: 'โทรศัพท์',                  required: false },
  { key: 'mobile',                   label: 'มือถือ',                    required: false },
  { key: 'email',                    label: 'อีเมล',                     required: false },
];

// GET /ar_customer/import/template
const getTemplate = (req, res) => {
  res.json({ columns: TEMPLATE_COLUMNS });
};

// GET /ar_customer/import/template/download  — ส่งไฟล์ xlsx เทมเพลต
const downloadTemplate = (req, res) => {
  const wb = XLSX.utils.book_new();

  // Row 1: header keys (ใช้เป็น column name สำหรับ import)
  const headers = TEMPLATE_COLUMNS.map(c => c.key);
  // Row 2: ป้ายชื่อภาษาไทย (คำอธิบาย)
  const labels  = TEMPLATE_COLUMNS.map(c => `(${c.label}${c.required ? ' *' : ''})`);

  const ws = XLSX.utils.aoa_to_sheet([headers, labels]);

  // กำหนดความกว้างคอลัมน์
  ws['!cols'] = TEMPLATE_COLUMNS.map(c => ({
    wch: Math.max(c.key.length, c.label.length) + 4,
  }));

  XLSX.utils.book_append_sheet(wb, ws, 'ar_customer');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="ar_customer_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

// POST /ar_customer/import/validate  (multipart file)
const validateFile = [
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'ไม่พบไฟล์' });
    try {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      if (jsonRows.length < 2) {
        return res.status(400).json({ message: 'ไม่พบข้อมูลในไฟล์ (ต้องมีแถว header และข้อมูลอย่างน้อย 1 แถว)' });
      }

      // Validate header row
      const headers = jsonRows[0].map(h => String(h || '').trim());
      const expectedKeys = TEMPLATE_COLUMNS.map(c => c.key);
      const missingCols = expectedKeys.filter(k => !headers.includes(k));
      if (missingCols.length > 0) {
        return res.status(400).json({
          message: `ไฟล์ไม่ตรงตามเทมเพลต ขาดคอลัมน์: ${missingCols.join(', ')}`,
        });
      }

      // Pre-fetch: customer groups + global auto-number config
      const [groupsResult, runningResult] = await Promise.all([
        req.dbPool.query(`SELECT id, group_code, is_auto_number FROM ar_customer_group WHERE is_active = true`),
        req.dbPool.query(`SELECT is_auto_numbering FROM ar_customer_running LIMIT 1`),
      ]);
      // map: group_code (uppercase) → { id, is_auto_number }
      const groupMap = {};
      for (const g of groupsResult.rows) {
        groupMap[g.group_code.toUpperCase()] = g;
      }
      const globalAutoNumber = runningResult.rows.length > 0 && runningResult.rows[0].is_auto_numbering;

      // Build column index map
      const colIdx = {};
      headers.forEach((h, i) => { colIdx[h] = i; });

      const errors = [];
      const validatedRows = [];

      for (let i = 1; i < jsonRows.length; i++) {
        const row = jsonRows[i];
        const rowNum = i + 1; // Excel row number
        const get = (key) => String(row[colIdx[key]] ?? '').trim();

        const customerCode    = get('customer_code');
        const customerNameTh  = get('customer_name_th');
        const customerGroupCode = get('customer_group_code').toUpperCase();

        // Skip completely blank rows
        if (!customerCode && !customerNameTh && !customerGroupCode) continue;

        const rowErrors = [];

        // customer_group_code: ต้องมีในระบบถ้าระบุมา
        let resolvedGroup = null;
        if (customerGroupCode) {
          resolvedGroup = groupMap[customerGroupCode] || null;
          if (!resolvedGroup)
            rowErrors.push({ column: 'customer_group_code', message: `ไม่พบกลุ่มลูกค้า "${customerGroupCode}"` });
        }

        // customer_code: จำเป็นต้องระบุ เว้นแต่มีรหัสอัตโนมัติ
        if (!customerCode) {
          const groupAutoNumber = resolvedGroup?.is_auto_number ?? false;
          if (!groupAutoNumber && !globalAutoNumber) {
            rowErrors.push({ column: 'customer_code', message: 'จำเป็นต้องระบุรหัสลูกหนี้ (กลุ่มและระบบไม่ได้เปิดรหัสอัตโนมัติ)' });
          }
        } else if (customerCode.length > 20) {
          rowErrors.push({ column: 'customer_code', message: 'รหัสลูกหนี้ต้องไม่เกิน 20 ตัวอักษร' });
        }

        if (!customerNameTh) rowErrors.push({ column: 'customer_name_th', message: 'จำเป็นต้องระบุชื่อลูกหนี้ (ไทย)' });

        // credit_term_months / credit_term_days
        let creditTermMonths = 0;
        const creditMonthsStr = get('credit_term_months');
        if (creditMonthsStr) {
          creditTermMonths = parseInt(creditMonthsStr, 10);
          if (isNaN(creditTermMonths) || creditTermMonths < 0)
            rowErrors.push({ column: 'credit_term_months', message: 'เครดิต (เดือน) ต้องเป็นตัวเลขไม่ติดลบ' });
        }
        let creditTermDays = 30;
        const creditDaysStr = get('credit_term_days');
        if (creditDaysStr) {
          creditTermDays = parseInt(creditDaysStr, 10);
          if (isNaN(creditTermDays) || creditTermDays < 0)
            rowErrors.push({ column: 'credit_term_days', message: 'เครดิต (วัน) ต้องเป็นตัวเลขไม่ติดลบ' });
        }

        // credit_limit
        let creditLimit = 0;
        const creditLimitStr = get('credit_limit');
        if (creditLimitStr) {
          creditLimit = parseFloat(creditLimitStr.replace(/,/g, ''));
          if (isNaN(creditLimit) || creditLimit < 0)
            rowErrors.push({ column: 'credit_limit', message: 'วงเงินเครดิตต้องเป็นตัวเลขไม่ติดลบ' });
        }

        // discount_percent
        let discountPercent = 0;
        const discountStr = get('discount_percent');
        if (discountStr) {
          discountPercent = parseFloat(discountStr);
          if (isNaN(discountPercent) || discountPercent < 0 || discountPercent > 100)
            rowErrors.push({ column: 'discount_percent', message: 'ส่วนลดต้องอยู่ระหว่าง 0-100' });
        }

        if (rowErrors.length > 0) {
          errors.push({ row: rowNum, customerCode: customerCode || '(อัตโนมัติ)', errors: rowErrors });
        } else {
          validatedRows.push({
            customer_code:            customerCode ? customerCode.toUpperCase() : null,
            customer_group_code:      customerGroupCode || null,
            customer_group_id:        resolvedGroup?.id || null,
            old_customer_code:        get('old_customer_code') || null,
            customer_name_th:         customerNameTh,
            customer_name_en:         get('customer_name_en') || null,
            tax_id:                   get('tax_id') || null,
            credit_term_months:       creditTermMonths,
            credit_term_days:         creditTermDays,
            credit_limit:             creditLimit,
            discount_percent:         discountPercent,
            currency_code:            get('currency_code') || 'THB',
            remark:                   get('remark') || null,
            address_no:               get('address_no') || null,
            address_building_village: get('address_building_village') || null,
            address_alley:            get('address_alley') || null,
            address_road:             get('address_road') || null,
            address_sub_district:     get('address_sub_district') || null,
            address_district:         get('address_district') || null,
            address_province:         get('address_province') || null,
            address_zip_code:         get('address_zip_code') || null,
            contact_name:             get('contact_name') || null,
            phone:                    get('phone') || null,
            mobile:                   get('mobile') || null,
            email:                    get('email') || null,
          });
        }
      }

      res.json({
        totalRows: validatedRows.length + errors.length,
        validRows: validatedRows.length,
        errorRows: errors.length,
        errors,
        data: validatedRows,
      });
    } catch (err) {
      console.error('Import validate error:', err);
      res.status(500).json({ message: 'ไม่สามารถอ่านไฟล์ได้: ' + err.message });
    }
  },
];

// helper: truncate string to max length safely
const trunc = (val, max) => (val && val.length > max ? val.substring(0, max) : val) || null;

// POST /ar_customer/import/confirm  (JSON body { rows: [...] })
const confirmImport = async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ message: 'ไม่มีข้อมูลนำเข้า' });
  }
  const userName = req.headers.username;
  const client = await req.dbPool.connect();
  let imported = 0, skipped = 0;
  const importErrors = [];
  try {
    await client.query('BEGIN');
    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx];
      const savepointName = `sp_row_${idx}`;
      await client.query(`SAVEPOINT ${savepointName}`);
      try {
        // resolve รหัสลูกหนี้: ถ้าว่าง → ลองกลุ่ม → ลอง global
        let finalCode = r.customer_code || null;
        if (!finalCode) {
          if (r.customer_group_id) {
            finalCode = await generateNextCodeForGroup(client, r.customer_group_id);
          }
          if (!finalCode) {
            finalCode = await generateNextCode(client);
          }
          if (!finalCode) {
            importErrors.push({ customer_code: r.customer_name_th, message: 'ไม่มีรหัสอัตโนมัติ — กรุณาระบุรหัสลูกหนี้' });
            await client.query(`RELEASE SAVEPOINT ${savepointName}`);
            continue;
          }
        }

        const result = await client.query(
          `INSERT INTO ar_customer
             (customer_code, old_customer_code, customer_name_th, customer_name_en, tax_id,
              customer_group_id,
              credit_term_months, credit_term_days, credit_limit, discount_percent,
              currency_code, is_active, remark, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,$13)
           ON CONFLICT (customer_code) DO NOTHING
           RETURNING id`,
          [
            trunc(finalCode, 20), trunc(r.old_customer_code, 50),
            trunc(r.customer_name_th, 200), trunc(r.customer_name_en, 200), trunc(r.tax_id, 20),
            r.customer_group_id || null,
            r.credit_term_months ?? 0, r.credit_term_days ?? 30,
            r.credit_limit ?? 0, r.discount_percent ?? 0,
            trunc(r.currency_code, 10) || 'THB', trunc(r.remark, 500),
            userName,
          ]
        );

        if (result.rows.length === 0) {
          skipped++;
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
          continue;
        }

        const cid = result.rows[0].id;

        const hasAddress = r.address_no || r.address_building_village || r.address_alley ||
          r.address_road || r.address_sub_district || r.address_district ||
          r.address_province || r.address_zip_code;
        if (hasAddress) {
          await client.query(
            `INSERT INTO ar_customer_address
               (customer_id, address_type, address_no, address_building_village,
                address_alley, address_road, address_sub_district, address_district,
                address_province, address_zip_code, is_default)
             VALUES ($1,'billing',$2,$3,$4,$5,$6,$7,$8,$9,true)`,
            [
              cid,
              trunc(r.address_no, 100),
              trunc(r.address_building_village, 100),
              trunc(r.address_alley, 100),
              trunc(r.address_road, 100),
              trunc(r.address_sub_district, 100),
              trunc(r.address_district, 100),
              trunc(r.address_province, 100),
              trunc(r.address_zip_code, 10),
            ]
          );
        }

        if (r.contact_name || r.phone || r.mobile || r.email) {
          await client.query(
            `INSERT INTO ar_customer_contact
               (customer_id, contact_name, phone, mobile, email, is_default)
             VALUES ($1,$2,$3,$4,$5,true)`,
            [cid, trunc(r.contact_name, 200) || '', trunc(r.phone, 50), trunc(r.mobile, 50), trunc(r.email, 200)]
          );
        }

        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        imported++;
      } catch (rowErr) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        importErrors.push({ customer_code: r.customer_code || r.customer_name_th, message: rowErr.message });
      }
    }
    await client.query('COMMIT');
    res.json({ imported, skipped, errors: importErrors });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import confirm error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาด: ' + err.message });
  } finally {
    client.release();
  }
};

module.exports = { getTemplate, downloadTemplate, validateFile, confirmImport };
