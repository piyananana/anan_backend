// controllers/ap/apVendorImportController.js
const XLSX = require('xlsx');
const multer = require('multer');
const { generateNextCode } = require('./apVendorRunningController');
const { insertRelated } = require('./apVendorController');

const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
// Template sheet definitions — 1 sheet ต่อหัวข้อใน ap_vendor_detail_widget
// ทุก sheet (ยกเว้น "ข้อมูลพื้นฐาน") ใช้ old_vendor_code เป็นคอลัมน์แรกเพื่อเชื่อม
// ข้อมูลกับเจ้าหนี้ใน sheet "ข้อมูลพื้นฐาน"
// ---------------------------------------------------------------------------
const TEMPLATE_SHEETS = [
  {
    key: 'general',
    name: 'ข้อมูลพื้นฐาน',
    columns: [
      { key: 'old_vendor_code',    label: 'รหัสเก่าเจ้าหนี้ — ใช้เชื่อมข้อมูลกับ sheet อื่น',    required: true,  example: 'VA0001' },
      { key: 'vendor_name_th',     label: 'ชื่อเจ้าหนี้ (ไทย)',                                   required: true,  example: 'บริษัท XYZ จำกัด' },
      { key: 'vendor_code',        label: 'รหัสเจ้าหนี้ (ว่างได้ถ้าอัตโนมัติ)',                  required: false, example: 'V001' },
      { key: 'vendor_group_code',  label: 'รหัสกลุ่มเจ้าหนี้',                                   required: false, example: 'LOCAL' },
      { key: 'vendor_name_en',     label: 'ชื่อเจ้าหนี้ (อังกฤษ)',                                required: false, example: 'XYZ Co., Ltd.' },
      { key: 'tax_id',             label: 'เลขประจำตัวผู้เสียภาษี',                               required: false, example: '0105555012345' },
      { key: 'business_type_code', label: 'รหัสประเภทธุรกิจ',                                     required: false, example: 'TRADE' },
      { key: 'credit_term_months', label: 'เครดิต (เดือน)',                                        required: false, example: '0' },
      { key: 'credit_term_days',   label: 'เครดิต (วัน)',                                          required: false, example: '30' },
      { key: 'currency_code',      label: 'สกุลเงิน',                                             required: false, example: 'THB' },
      { key: 'is_active',          label: 'ใช้งาน (Y/N)',                                         required: false, example: 'Y' },
      { key: 'remark',             label: 'หมายเหตุ',                                              required: false, example: '' },
    ],
  },
  {
    key: 'addresses',
    name: 'ที่อยู่',
    columns: [
      { key: 'old_vendor_code',           label: 'รหัสเก่าเจ้าหนี้ — เชื่อมกับ sheet ข้อมูลพื้นฐาน', required: true,  example: 'VA0001' },
      { key: 'address_type',             label: 'ประเภทที่อยู่ (billing/shipping)',                      required: false, example: 'billing' },
      { key: 'address_no',               label: 'บ้านเลขที่',         required: false, example: '123' },
      { key: 'address_building_village', label: 'อาคาร/หมู่บ้าน',     required: false, example: '' },
      { key: 'address_alley',            label: 'ซอย',                required: false, example: '' },
      { key: 'address_road',             label: 'ถนน',                required: false, example: '' },
      { key: 'address_sub_district',     label: 'ตำบล/แขวง',          required: false, example: '' },
      { key: 'address_district',         label: 'อำเภอ/เขต',          required: false, example: '' },
      { key: 'address_province',         label: 'จังหวัด',             required: false, example: '' },
      { key: 'address_zip_code',         label: 'รหัสไปรษณีย์',        required: false, example: '' },
      { key: 'address_country',          label: 'ประเทศ',              required: false, example: 'Thailand' },
      { key: 'is_default',               label: 'ที่อยู่หลัก (Y/N)',  required: false, example: 'Y' },
    ],
  },
  {
    key: 'contacts',
    name: 'ผู้ติดต่อ',
    columns: [
      { key: 'old_vendor_code', label: 'รหัสเก่าเจ้าหนี้ — เชื่อมกับ sheet ข้อมูลพื้นฐาน', required: true,  example: 'VA0001' },
      { key: 'contact_name',   label: 'ชื่อผู้ติดต่อ',      required: true,  example: 'คุณสมชาย' },
      { key: 'position',       label: 'ตำแหน่ง',             required: false, example: '' },
      { key: 'phone',          label: 'โทรศัพท์',            required: false, example: '02-123-4567' },
      { key: 'mobile',         label: 'มือถือ',              required: false, example: '081-234-5678' },
      { key: 'email',          label: 'อีเมล',               required: false, example: '' },
      { key: 'is_default',     label: 'ผู้ติดต่อหลัก (Y/N)', required: false, example: 'Y' },
    ],
  },
  {
    key: 'bank_accounts',
    name: 'บัญชีธนาคาร',
    columns: [
      { key: 'old_vendor_code',  label: 'รหัสเก่าเจ้าหนี้ — เชื่อมกับ sheet ข้อมูลพื้นฐาน', required: true,  example: 'VA0001' },
      { key: 'bank_name',       label: 'ธนาคาร',                         required: false, example: 'กสิกรไทย' },
      { key: 'branch_name',     label: 'สาขา',                           required: false, example: '' },
      { key: 'account_number',  label: 'เลขที่บัญชี',                    required: false, example: '' },
      { key: 'account_name',    label: 'ชื่อบัญชี',                      required: false, example: '' },
      { key: 'account_type',    label: 'ประเภทบัญชี (current/savings)',  required: false, example: 'current' },
      { key: 'is_default',      label: 'บัญชีหลัก (Y/N)',                required: false, example: 'Y' },
    ],
  },
  {
    key: 'ap_account',
    name: 'บัญชีเจ้าหนี้ (GL)',
    columns: [
      { key: 'old_vendor_code',  label: 'รหัสเก่าเจ้าหนี้ — เชื่อมกับ sheet ข้อมูลพื้นฐาน', required: true,  example: 'VA0001' },
      { key: 'ap_account_code', label: 'รหัสบัญชีเจ้าหนี้ (บัญชีคุมยอด)',                     required: false, example: '2100' },
    ],
  },
];

const ADDRESS_TYPES = ['billing', 'shipping'];
const ACCOUNT_TYPES = ['current', 'savings'];
const YES_VALUES = ['y', 'yes', 'true', '1', 'ใช่'];

// GET /ap_vendor/import/template
const getTemplate = (req, res) => {
  res.json({ sheets: TEMPLATE_SHEETS });
};

// GET /ap_vendor/import/template/download
const downloadTemplate = (req, res) => {
  const wb = XLSX.utils.book_new();
  for (const sheet of TEMPLATE_SHEETS) {
    const headers = sheet.columns.map(c => c.key);
    const labels  = sheet.columns.map(c => `(${c.label}${c.required ? ' *' : ''})`);
    const ws = XLSX.utils.aoa_to_sheet([headers, labels]);
    ws['!cols'] = sheet.columns.map(c => ({ wch: Math.max(c.key.length, c.label.length) + 4 }));
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="ap_vendor_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class ImportTemplateError extends Error {}

const readSheet = (workbook, sheetDef, { required = false } = {}) => {
  let sheet = workbook.Sheets[sheetDef.name];
  if (!sheet && required) {
    sheet = workbook.Sheets[workbook.SheetNames[0]];
  }
  if (!sheet) return { present: false, colIdx: {}, rows: [] };

  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (aoa.length === 0) return { present: false, colIdx: {}, rows: [] };

  const headers = aoa[0].map(h => String(h || '').trim());
  const expectedKeys = sheetDef.columns.map(c => c.key);
  const missing = expectedKeys.filter(k => !headers.includes(k));
  if (missing.length > 0) {
    throw new ImportTemplateError(`Sheet "${sheetDef.name}" ไม่ตรงตามเทมเพลต ขาดคอลัมน์: ${missing.join(', ')}`);
  }
  const colIdx = {};
  headers.forEach((h, i) => { colIdx[h] = i; });
  return { present: true, colIdx, rows: aoa.slice(1) };
};

const parseBool = (val) => YES_VALUES.includes(String(val ?? '').trim().toLowerCase());
const trunc = (val, max) => (val && val.length > max ? val.substring(0, max) : val) || null;
const buildCodeMap = (rows, codeField) => {
  const map = {};
  for (const row of rows) map[String(row[codeField]).toUpperCase()] = row;
  return map;
};

// ---------------------------------------------------------------------------
// POST /ap_vendor/import/validate  (multipart file)
// ---------------------------------------------------------------------------
const validateFile = [
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'ไม่พบไฟล์' });

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (err) {
      return res.status(500).json({ message: 'ไม่สามารถอ่านไฟล์ได้: ' + err.message });
    }

    try {
      const [generalDef, addressDef, contactDef, bankDef, apAccountDef] = TEMPLATE_SHEETS;

      const general     = readSheet(workbook, generalDef, { required: true });
      if (!general.present || general.rows.length === 0) {
        return res.status(400).json({
          message: `ไม่พบข้อมูลใน sheet "${generalDef.name}" (ต้องมีแถว header และข้อมูลอย่างน้อย 1 แถว)`,
        });
      }
      const addresses    = readSheet(workbook, addressDef);
      const contacts     = readSheet(workbook, contactDef);
      const bankAccounts = readSheet(workbook, bankDef);
      const apAccount    = readSheet(workbook, apAccountDef);

      // Pre-fetch lookup tables
      const [groupsR, businessTypesR, accountsR, currenciesR, runningR] = await Promise.all([
        req.dbPool.query(`SELECT id, group_code FROM ap_vendor_group WHERE is_active = true`),
        req.dbPool.query(`SELECT id, business_type_code FROM cd_business_type WHERE is_active = true`),
        req.dbPool.query(`SELECT id, account_code FROM gl_account WHERE is_active = true AND is_control_account = true`),
        req.dbPool.query(`SELECT currency_code FROM cd_currency WHERE is_active = true`),
        req.dbPool.query(`SELECT is_auto_numbering FROM ap_vendor_running LIMIT 1`),
      ]);
      const groupMap         = buildCodeMap(groupsR.rows, 'group_code');
      const businessTypeMap  = buildCodeMap(businessTypesR.rows, 'business_type_code');
      const accountMap       = buildCodeMap(accountsR.rows, 'account_code');
      const currencySet      = new Set(currenciesR.rows.map(r => String(r.currency_code).toUpperCase()));
      const globalAutoNumber = runningR.rows.length > 0 && runningR.rows[0].is_auto_numbering;

      const errors  = [];
      const vendors = new Map();
      const order   = [];

      // ── Sheet 1: ข้อมูลพื้นฐาน ────────────────────────────────────────────
      for (let i = 0; i < general.rows.length; i++) {
        const row    = general.rows[i];
        const rowNum = i + 2;
        const get    = (key) => String(row[general.colIdx[key]] ?? '').trim();

        const oldCode     = get('old_vendor_code');
        const nameTh      = get('vendor_name_th');
        const vendorCode  = get('vendor_code');
        const groupCode   = get('vendor_group_code').toUpperCase();
        if (!oldCode && !nameTh && !vendorCode && !groupCode) continue;

        const rowErrors = [];

        if (!oldCode) {
          rowErrors.push({ column: 'old_vendor_code', message: 'จำเป็นต้องระบุรหัสเก่าเจ้าหนี้ (ใช้เป็นตัวเชื่อมข้อมูลกับ sheet อื่น)' });
          errors.push({ row: rowNum, vendorCode: vendorCode || '(อัตโนมัติ)', errors: rowErrors });
          continue;
        }
        if (vendors.has(oldCode)) {
          rowErrors.push({ column: 'old_vendor_code', message: `รหัสเก่าเจ้าหนี้ "${oldCode}" ซ้ำกับแถวก่อนหน้าใน sheet "${generalDef.name}"` });
          errors.push({ row: rowNum, vendorCode: vendorCode || '(อัตโนมัติ)', errors: rowErrors });
          continue;
        }
        if (!nameTh) {
          rowErrors.push({ column: 'vendor_name_th', message: 'จำเป็นต้องระบุชื่อเจ้าหนี้ (ไทย)' });
        }

        let resolvedGroup = null;
        if (groupCode) {
          resolvedGroup = groupMap[groupCode] || null;
          if (!resolvedGroup) rowErrors.push({ column: 'vendor_group_code', message: `ไม่พบกลุ่มเจ้าหนี้ "${groupCode}"` });
        }

        if (!vendorCode) {
          if (!globalAutoNumber) rowErrors.push({ column: 'vendor_code', message: 'จำเป็นต้องระบุรหัสเจ้าหนี้ (ระบบไม่ได้เปิดรหัสอัตโนมัติ)' });
        } else if (vendorCode.length > 20) {
          rowErrors.push({ column: 'vendor_code', message: 'รหัสเจ้าหนี้ต้องไม่เกิน 20 ตัวอักษร' });
        }

        const businessTypeCode = get('business_type_code').toUpperCase();
        let resolvedBusinessType = null;
        if (businessTypeCode) {
          resolvedBusinessType = businessTypeMap[businessTypeCode] || null;
          if (!resolvedBusinessType) rowErrors.push({ column: 'business_type_code', message: `ไม่พบประเภทธุรกิจ "${businessTypeCode}"` });
        }

        const currencyCodeRaw = get('currency_code').toUpperCase();
        const currencyCode = currencyCodeRaw || 'THB';
        if (currencyCodeRaw && currencySet.size > 0 && !currencySet.has(currencyCodeRaw)) {
          rowErrors.push({ column: 'currency_code', message: `ไม่พบสกุลเงิน "${currencyCodeRaw}"` });
        }

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

        const isActiveStr = get('is_active');

        const vendor = {
          __rowNum: rowNum,
          __rowErrors: rowErrors,
          vendor_code:          vendorCode ? vendorCode.toUpperCase() : null,
          vendor_group_code:    groupCode || null,
          vendor_group_id:      resolvedGroup?.id || null,
          old_vendor_code:      oldCode || null,
          vendor_name_th:       nameTh,
          vendor_name_en:       get('vendor_name_en') || null,
          tax_id:               get('tax_id') || null,
          business_type_code:   businessTypeCode || null,
          business_type_id:     resolvedBusinessType?.id || null,
          credit_term_months:   creditTermMonths,
          credit_term_days:     creditTermDays,
          currency_code:        currencyCode,
          is_active:            isActiveStr ? parseBool(isActiveStr) : true,
          remark:               get('remark') || null,
          ap_account_code:      null,
          ap_account_id:        null,
          addresses:            [],
          contacts:             [],
          bank_accounts:        [],
        };

        vendors.set(oldCode, vendor);
        order.push(oldCode);
      }

      // helper: หา vendor จากรหัสเก่า ถ้าไม่พบให้บันทึก standalone error
      const findVendor = (sheetDef, row, colIdx, rowNum) => {
        const oldVendorCode = String(row[colIdx['old_vendor_code']] ?? '').trim();
        if (!oldVendorCode) return null;
        const vendor = vendors.get(oldVendorCode);
        if (!vendor) {
          errors.push({
            row: rowNum,
            vendorCode: oldVendorCode,
            errors: [{ column: sheetDef.name, message: `ไม่พบรหัสเก่าเจ้าหนี้ "${oldVendorCode}" ใน sheet "${generalDef.name}"` }],
          });
          return null;
        }
        return { vendor, oldVendorCode };
      };

      // ── Sheet 2: ที่อยู่ ──────────────────────────────────────────────────
      for (let i = 0; i < addresses.rows.length; i++) {
        const row    = addresses.rows[i];
        const rowNum = i + 2;
        const found  = findVendor(addressDef, row, addresses.colIdx, rowNum);
        if (!found) continue;
        const { vendor } = found;
        const get = (key) => String(row[addresses.colIdx[key]] ?? '').trim();

        const addressTypeRaw = get('address_type').toLowerCase();
        const addressType = addressTypeRaw || 'billing';
        if (addressTypeRaw && !ADDRESS_TYPES.includes(addressTypeRaw)) {
          vendor.__rowErrors.push({ column: `${addressDef.name}: address_type`, message: `ประเภทที่อยู่ต้องเป็นหนึ่งใน ${ADDRESS_TYPES.join(', ')}` });
        }

        vendor.addresses.push({
          address_type:             addressType,
          address_no:               get('address_no') || null,
          address_building_village: get('address_building_village') || null,
          address_alley:            get('address_alley') || null,
          address_road:             get('address_road') || null,
          address_sub_district:     get('address_sub_district') || null,
          address_district:         get('address_district') || null,
          address_province:         get('address_province') || null,
          address_zip_code:         get('address_zip_code') || null,
          address_country:          get('address_country') || 'Thailand',
          is_default:               parseBool(get('is_default')),
        });
      }

      // ── Sheet 3: ผู้ติดต่อ ────────────────────────────────────────────────
      for (let i = 0; i < contacts.rows.length; i++) {
        const row    = contacts.rows[i];
        const rowNum = i + 2;
        const found  = findVendor(contactDef, row, contacts.colIdx, rowNum);
        if (!found) continue;
        const { vendor } = found;
        const get = (key) => String(row[contacts.colIdx[key]] ?? '').trim();

        const contactName = get('contact_name');
        if (!contactName) {
          vendor.__rowErrors.push({ column: `${contactDef.name}: contact_name`, message: 'จำเป็นต้องระบุชื่อผู้ติดต่อ' });
        }

        vendor.contacts.push({
          contact_name: contactName,
          position:     get('position') || null,
          phone:        get('phone') || null,
          mobile:       get('mobile') || null,
          email:        get('email') || null,
          is_default:   parseBool(get('is_default')),
        });
      }

      // ── Sheet 4: บัญชีธนาคาร ─────────────────────────────────────────────
      for (let i = 0; i < bankAccounts.rows.length; i++) {
        const row    = bankAccounts.rows[i];
        const rowNum = i + 2;
        const found  = findVendor(bankDef, row, bankAccounts.colIdx, rowNum);
        if (!found) continue;
        const { vendor } = found;
        const get = (key) => String(row[bankAccounts.colIdx[key]] ?? '').trim();

        const accountTypeRaw = get('account_type').toLowerCase();
        const accountType = accountTypeRaw || 'current';
        if (accountTypeRaw && !ACCOUNT_TYPES.includes(accountTypeRaw)) {
          vendor.__rowErrors.push({ column: `${bankDef.name}: account_type`, message: `ประเภทบัญชีต้องเป็นหนึ่งใน ${ACCOUNT_TYPES.join(', ')}` });
        }

        vendor.bank_accounts.push({
          bank_name:      get('bank_name') || null,
          branch_name:    get('branch_name') || null,
          account_number: get('account_number') || null,
          account_name:   get('account_name') || null,
          account_type:   accountType,
          is_default:     parseBool(get('is_default')),
        });
      }

      // ── Sheet 5: บัญชีเจ้าหนี้ (GL) ──────────────────────────────────────
      for (let i = 0; i < apAccount.rows.length; i++) {
        const row    = apAccount.rows[i];
        const rowNum = i + 2;
        const found  = findVendor(apAccountDef, row, apAccount.colIdx, rowNum);
        if (!found) continue;
        const { vendor } = found;
        const get = (key) => String(row[apAccount.colIdx[key]] ?? '').trim();

        const apAccountCode = get('ap_account_code').toUpperCase();
        if (apAccountCode) {
          const acc = accountMap[apAccountCode];
          if (!acc) vendor.__rowErrors.push({ column: `${apAccountDef.name}: ap_account_code`, message: `ไม่พบรหัสบัญชีเจ้าหนี้ "${apAccountCode}" (ต้องเป็นบัญชีคุมยอดที่ใช้งานอยู่)` });
          else { vendor.ap_account_code = apAccountCode; vendor.ap_account_id = acc.id; }
        }
      }

      // ── สรุปผล ────────────────────────────────────────────────────────────
      const validatedRows = [];
      for (const code of order) {
        const vendor = vendors.get(code);
        if (vendor.__rowErrors.length > 0) {
          errors.push({ row: vendor.__rowNum, vendorCode: vendor.old_vendor_code || vendor.vendor_code || '(อัตโนมัติ)', errors: vendor.__rowErrors });
        } else {
          delete vendor.__rowNum;
          delete vendor.__rowErrors;
          validatedRows.push(vendor);
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
      if (err instanceof ImportTemplateError) {
        return res.status(400).json({ message: err.message });
      }
      console.error('Import validate error:', err);
      res.status(500).json({ message: 'เกิดข้อผิดพลาด: ' + err.message });
    }
  },
];

// ---------------------------------------------------------------------------
// POST /ap_vendor/import/confirm  (JSON body { rows: [...] })
// ---------------------------------------------------------------------------
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
              vendor_group_id, business_type_id,
              credit_term_months, credit_term_days,
              currency_code, is_active, remark,
              ap_account_id,
              created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
           ON CONFLICT (vendor_code) DO NOTHING
           RETURNING id`,
          [
            trunc(finalCode, 20), trunc(r.old_vendor_code, 50),
            trunc(r.vendor_name_th, 200), trunc(r.vendor_name_en, 200),
            trunc(r.tax_id, 20),
            r.vendor_group_id   || null,
            r.business_type_id  || null,
            r.credit_term_months ?? 0, r.credit_term_days ?? 30,
            trunc(r.currency_code, 10) || 'THB',
            r.is_active !== undefined ? r.is_active : true,
            trunc(r.remark, 500),
            r.ap_account_id || null,
            userName,
          ]
        );

        if (result.rows.length === 0) {
          skipped++;
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
          continue;
        }

        const vid = result.rows[0].id;
        await insertRelated(client, vid, r.addresses, r.contacts, r.bank_accounts);

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

module.exports = { getTemplate, downloadTemplate, validateFile, confirmImport };
