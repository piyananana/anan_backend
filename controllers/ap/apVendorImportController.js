// controllers/ap/apVendorImportController.js
const XLSX = require('xlsx');
const multer = require('multer');
const { generateNextCode } = require('./apVendorRunningController');

const upload = multer({ storage: multer.memoryStorage() });

const TEMPLATE_COLUMNS = [
  { key: 'vendor_code',             label: 'รหัสเจ้าหนี้ (ว่างได้ถ้าอัตโนมัติ)', required: false },
  { key: 'vendor_group_code',       label: 'รหัสกลุ่มเจ้าหนี้',          required: false },
  { key: 'old_vendor_code',         label: 'รหัสเจ้าหนี้เก่า',           required: false },
  { key: 'vendor_name_th',          label: 'ชื่อเจ้าหนี้ (ไทย)',         required: true  },
  { key: 'vendor_name_en',          label: 'ชื่อเจ้าหนี้ (อังกฤษ)',      required: false },
  { key: 'tax_id',                  label: 'เลขประจำตัวผู้เสียภาษี',     required: false },
  { key: 'credit_term_months',      label: 'เครดิต (เดือน)',              required: false },
  { key: 'credit_term_days',        label: 'เครดิต (วัน)',                required: false },
  { key: 'currency_code',           label: 'สกุลเงิน',                    required: false },
  { key: 'remark',                  label: 'หมายเหตุ',                    required: false },
  { key: 'address_no',              label: 'บ้านเลขที่',                  required: false },
  { key: 'address_building_village',label: 'อาคาร/หมู่บ้าน',             required: false },
  { key: 'address_alley',           label: 'ซอย',                         required: false },
  { key: 'address_road',            label: 'ถนน',                         required: false },
  { key: 'address_sub_district',    label: 'ตำบล/แขวง',                  required: false },
  { key: 'address_district',        label: 'อำเภอ/เขต',                  required: false },
  { key: 'address_province',        label: 'จังหวัด',                     required: false },
  { key: 'address_zip_code',        label: 'รหัสไปรษณีย์',               required: false },
  { key: 'contact_name',            label: 'ชื่อผู้ติดต่อ',              required: false },
  { key: 'position',                label: 'ตำแหน่ง',                    required: false },
  { key: 'phone',                   label: 'โทรศัพท์',                    required: false },
  { key: 'mobile',                  label: 'มือถือ',                      required: false },
  { key: 'email',                   label: 'อีเมล',                       required: false },
  { key: 'bank_name',               label: 'ธนาคาร',                      required: false },
  { key: 'bank_branch_name',        label: 'สาขาธนาคาร',                 required: false },
  { key: 'account_number',          label: 'เลขบัญชีธนาคาร',             required: false },
  { key: 'account_name',            label: 'ชื่อบัญชีธนาคาร',            required: false },
];

// GET /ap_vendor/import/template/download
const downloadTemplate = (req, res) => {
  const wb = XLSX.utils.book_new();
  const headers = TEMPLATE_COLUMNS.map(c => c.key);
  const labels  = TEMPLATE_COLUMNS.map(c => `(${c.label}${c.required ? ' *' : ''})`);
  const ws = XLSX.utils.aoa_to_sheet([headers, labels]);
  ws['!cols'] = TEMPLATE_COLUMNS.map(c => ({
    wch: Math.max(c.key.length, c.label.length) + 4,
  }));
  XLSX.utils.book_append_sheet(wb, ws, 'ap_vendor');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="ap_vendor_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

// POST /ap_vendor/import/validate  (multipart file)
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

      const headers = jsonRows[0].map(h => String(h || '').trim());
      const expectedKeys = TEMPLATE_COLUMNS.map(c => c.key);
      const missingCols = expectedKeys.filter(k => !headers.includes(k));
      if (missingCols.length > 0) {
        return res.status(400).json({
          message: `ไฟล์ไม่ตรงตามเทมเพลต ขาดคอลัมน์: ${missingCols.join(', ')}`,
        });
      }

      // Pre-fetch: vendor groups + global auto-number config
      const [groupsResult, runningResult] = await Promise.all([
        req.dbPool.query(`SELECT id, group_code FROM ap_vendor_group WHERE is_active = true`),
        req.dbPool.query(`SELECT is_auto_numbering FROM ap_vendor_running LIMIT 1`),
      ]);
      const groupMap = {};
      for (const g of groupsResult.rows) {
        groupMap[g.group_code.toUpperCase()] = g;
      }
      const globalAutoNumber = runningResult.rows.length > 0 && runningResult.rows[0].is_auto_numbering;

      const colIdx = {};
      headers.forEach((h, i) => { colIdx[h] = i; });

      const errors = [];
      const validatedRows = [];

      for (let i = 1; i < jsonRows.length; i++) {
        const row = jsonRows[i];
        const rowNum = i + 1;
        const get = (key) => String(row[colIdx[key]] ?? '').trim();

        const vendorCode     = get('vendor_code');
        const vendorNameTh   = get('vendor_name_th');
        const vendorGroupCode = get('vendor_group_code').toUpperCase();

        // Skip completely blank rows
        if (!vendorCode && !vendorNameTh && !vendorGroupCode) continue;

        const rowErrors = [];

        // vendor_group_code: ต้องมีในระบบถ้าระบุมา
        let resolvedGroup = null;
        if (vendorGroupCode) {
          resolvedGroup = groupMap[vendorGroupCode] || null;
          if (!resolvedGroup)
            rowErrors.push({ column: 'vendor_group_code', message: `ไม่พบกลุ่มเจ้าหนี้ "${vendorGroupCode}"` });
        }

        // vendor_code: จำเป็นต้องระบุ เว้นแต่มีรหัสอัตโนมัติ
        if (!vendorCode) {
          if (!globalAutoNumber) {
            rowErrors.push({ column: 'vendor_code', message: 'จำเป็นต้องระบุรหัสเจ้าหนี้ (ระบบไม่ได้เปิดรหัสอัตโนมัติ)' });
          }
        } else if (vendorCode.length > 20) {
          rowErrors.push({ column: 'vendor_code', message: 'รหัสเจ้าหนี้ต้องไม่เกิน 20 ตัวอักษร' });
        }

        if (!vendorNameTh) rowErrors.push({ column: 'vendor_name_th', message: 'จำเป็นต้องระบุชื่อเจ้าหนี้ (ไทย)' });

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

        if (rowErrors.length > 0) {
          errors.push({ row: rowNum, vendorCode: vendorCode || '(อัตโนมัติ)', errors: rowErrors });
        } else {
          validatedRows.push({
            vendor_code:              vendorCode ? vendorCode.toUpperCase() : null,
            vendor_group_code:        vendorGroupCode || null,
            vendor_group_id:          resolvedGroup?.id || null,
            old_vendor_code:          get('old_vendor_code') || null,
            vendor_name_th:           vendorNameTh,
            vendor_name_en:           get('vendor_name_en') || null,
            tax_id:                   get('tax_id') || null,
            credit_term_months:       creditTermMonths,
            credit_term_days:         creditTermDays,
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
            position:                 get('position') || null,
            phone:                    get('phone') || null,
            mobile:                   get('mobile') || null,
            email:                    get('email') || null,
            bank_name:                get('bank_name') || null,
            bank_branch_name:         get('bank_branch_name') || null,
            account_number:           get('account_number') || null,
            account_name:             get('account_name') || null,
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

const trunc = (val, max) => (val && val.length > max ? val.substring(0, max) : val) || null;

// POST /ap_vendor/import/confirm  (JSON body { rows: [...] })
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
        let finalCode = r.vendor_code || null;
        if (!finalCode) {
          finalCode = await generateNextCode(client);
          if (!finalCode) {
            importErrors.push({ vendor_code: r.vendor_name_th, message: 'ไม่มีรหัสอัตโนมัติ — กรุณาระบุรหัสเจ้าหนี้' });
            await client.query(`RELEASE SAVEPOINT ${savepointName}`);
            continue;
          }
        }

        const result = await client.query(
          `INSERT INTO ap_vendor
             (vendor_code, old_vendor_code, vendor_name_th, vendor_name_en, tax_id,
              vendor_group_id, credit_term_months, credit_term_days,
              currency_code, is_active, remark, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$11)
           ON CONFLICT (vendor_code) DO NOTHING
           RETURNING id`,
          [
            trunc(finalCode, 20), trunc(r.old_vendor_code, 50),
            trunc(r.vendor_name_th, 200), trunc(r.vendor_name_en, 200),
            trunc(r.tax_id, 20),
            r.vendor_group_id || null,
            r.credit_term_months ?? 0, r.credit_term_days ?? 30,
            trunc(r.currency_code, 10) || 'THB',
            trunc(r.remark, 500),
            userName,
          ]
        );

        if (result.rows.length === 0) {
          skipped++;
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
          continue;
        }

        const vid = result.rows[0].id;

        const hasAddress = r.address_no || r.address_building_village || r.address_alley ||
          r.address_road || r.address_sub_district || r.address_district ||
          r.address_province || r.address_zip_code;
        if (hasAddress) {
          await client.query(
            `INSERT INTO ap_vendor_address
               (vendor_id, address_type, address_no, address_building_village,
                address_alley, address_road, address_sub_district, address_district,
                address_province, address_zip_code, is_default)
             VALUES ($1,'billing',$2,$3,$4,$5,$6,$7,$8,$9,true)`,
            [
              vid,
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
            `INSERT INTO ap_vendor_contact
               (vendor_id, contact_name, position, phone, mobile, email, is_default)
             VALUES ($1,$2,$3,$4,$5,$6,true)`,
            [
              vid,
              trunc(r.contact_name, 200) || '',
              trunc(r.position, 100),
              trunc(r.phone, 50),
              trunc(r.mobile, 50),
              trunc(r.email, 200),
            ]
          );
        }

        if (r.bank_name || r.account_number) {
          await client.query(
            `INSERT INTO ap_vendor_bank_account
               (vendor_id, bank_name, branch_name, account_number, account_name, account_type, is_default)
             VALUES ($1,$2,$3,$4,$5,'current',true)`,
            [
              vid,
              trunc(r.bank_name, 100),
              trunc(r.bank_branch_name, 100),
              trunc(r.account_number, 50),
              trunc(r.account_name, 200),
            ]
          );
        }

        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        imported++;
      } catch (rowErr) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        importErrors.push({ vendor_code: r.vendor_code || r.vendor_name_th, message: rowErr.message });
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

module.exports = { downloadTemplate, validateFile, confirmImport };
