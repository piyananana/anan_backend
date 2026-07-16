// controllers/ar/arCustomerImportController.js
const XLSX = require('xlsx');
const multer = require('multer');
const { generateNextCode } = require('./arCustomerRunningController');
const { generateNextCodeForGroup } = require('./arCustomerGroupController');
const { insertRelated } = require('./arCustomerController');

const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
// Template sheet definitions — 1 sheet ต่อหัวข้อใน ar_customer_detail_widget
// ทุก sheet (ยกเว้น "ข้อมูลทั่วไป") ใช้ customer_name_th เป็นคอลัมน์แรกเพื่อเชื่อม
// ข้อมูลกับลูกค้าใน sheet "ข้อมูลทั่วไป"
// ---------------------------------------------------------------------------
const TEMPLATE_SHEETS = [
  {
    key: 'general',
    name: 'ข้อมูลทั่วไป',
    columns: [
      { key: 'old_customer_code',  label: 'รหัสเก่าลูกหนี้ — ใช้เชื่อมข้อมูลกับ sheet อื่น', required: true,  example: 'CA0001' },
      { key: 'customer_name_th',   label: 'ชื่อลูกหนี้ (ไทย)',                     required: true,  example: 'บริษัท เอบีซี จำกัด' },
      { key: 'customer_code',      label: 'รหัสลูกหนี้ (ว่างได้ถ้าอัตโนมัติ)',     required: false, example: 'C0001' },
      { key: 'customer_group_code',label: 'รหัสกลุ่มลูกค้า',                       required: false, example: 'RETAIL' },
      { key: 'customer_name_en',   label: 'ชื่อลูกหนี้ (อังกฤษ)',                  required: false, example: 'ABC Co., Ltd.' },
      { key: 'tax_id',              label: 'เลขประจำตัวผู้เสียภาษี',                required: false, example: '0105555012345' },
      { key: 'business_type_code', label: 'รหัสประเภทธุรกิจ',                      required: false, example: 'TRADE' },
      { key: 'credit_term_months', label: 'เครดิต (เดือน)',                         required: false, example: '0' },
      { key: 'credit_term_days',   label: 'เครดิต (วัน)',                           required: false, example: '30' },
      { key: 'credit_limit',       label: 'วงเงินเครดิต',                          required: false, example: '100000' },
      { key: 'discount_percent',   label: 'ส่วนลด %',                              required: false, example: '5' },
      { key: 'currency_code',      label: 'สกุลเงิน',                              required: false, example: 'THB' },
      { key: 'is_active',          label: 'ใช้งาน (Y/N)',                          required: false, example: 'Y' },
      { key: 'requires_billing',   label: 'ต้องวางบิลก่อนรับชำระ (Y/N)',           required: false, example: 'N' },
      { key: 'remark',             label: 'หมายเหตุ',                              required: false, example: '' },
    ],
  },
  {
    key: 'sales',
    name: 'เขตการขายและพนักงานขาย',
    columns: [
      { key: 'old_customer_code',           label: 'รหัสเก่าลูกหนี้ — เชื่อมกับ sheet ข้อมูลทั่วไป', required: true,  example: 'CA0001' },
      { key: 'sales_territory_code',       label: 'รหัสเขตการขาย',     required: false, example: 'BKK' },
      { key: 'salesperson_code',           label: 'รหัสพนักงานขาย',    required: false, example: 'SP001' },
      { key: 'billing_collector_code',     label: 'รหัสผู้วางบิล',     required: false, example: 'COL001' },
      { key: 'collection_collector_code',  label: 'รหัสผู้รับชำระ',    required: false, example: 'COL001' },
    ],
  },
  {
    key: 'billing_conditions',
    name: 'เงื่อนไขการวางบิล',
    columns: [
      { key: 'old_customer_code',         label: 'รหัสเก่าลูกหนี้ — เชื่อมกับ sheet ข้อมูลทั่วไป', required: true,  example: 'CA0001' },
      { key: 'sort_order',               label: 'ลำดับ',                                            required: false, example: '1' },
      { key: 'bill_with_delivery',       label: 'วางบิลพร้อมส่งของ (Y/N)',                          required: false, example: 'N' },
      { key: 'billing_day_of_month',     label: 'วันที่ในเดือน (1-31, 31=สิ้นเดือน คั่นด้วย ,)',     required: false, example: '1,15' },
      { key: 'billing_day_of_week',      label: 'วันในสัปดาห์ (0=อา,1=จ,2=อ,3=พ,4=พฤ,5=ศ,6=ส คั่นด้วย ,)', required: false, example: '' },
      { key: 'billing_week_of_month',    label: 'สัปดาห์ที่ (1-4, -1=สุดท้าย คั่นด้วย ,)',           required: false, example: '' },
      { key: 'billing_time_from',        label: 'เวลาเริ่มวางบิล (HH:mm)',                          required: false, example: '' },
      { key: 'billing_time_to',          label: 'เวลาสิ้นสุดวางบิล (HH:mm)',                        required: false, example: '' },
      { key: 'due_from_billing_date',    label: 'คำนวณวันครบกำหนดจากวันวางบิล (Y/N)',               required: false, example: 'N' },
      { key: 'remark',                   label: 'หมายเหตุ',                                         required: false, example: '' },
    ],
  },
  {
    key: 'payment_conditions',
    name: 'เงื่อนไขการรับชำระเงิน',
    columns: [
      { key: 'old_customer_code',           label: 'รหัสเก่าลูกหนี้ — เชื่อมกับ sheet ข้อมูลทั่วไป', required: true,  example: 'CA0001' },
      { key: 'sort_order',                 label: 'ลำดับ',                                            required: false, example: '1' },
      { key: 'payment_day_of_month',       label: 'วันที่ในเดือน (1-31, 31=สิ้นเดือน คั่นด้วย ,)',     required: false, example: '' },
      { key: 'payment_day_of_week',        label: 'วันในสัปดาห์ (0=อา,1=จ,2=อ,3=พ,4=พฤ,5=ศ,6=ส คั่นด้วย ,)', required: false, example: '' },
      { key: 'payment_week_of_month',      label: 'สัปดาห์ที่ (1-4, -1=สุดท้าย คั่นด้วย ,)',           required: false, example: '' },
      { key: 'payment_time_from',          label: 'เวลาเริ่มรับชำระ (HH:mm)',                         required: false, example: '' },
      { key: 'payment_time_to',            label: 'เวลาสิ้นสุดรับชำระ (HH:mm)',                       required: false, example: '' },
      { key: 'within_months_from_billing', label: 'ชำระภายในกี่เดือนจากเดือนวางบิล (0=ไม่จำกัด)',     required: false, example: '0' },
      { key: 'additional_days',            label: 'จำนวนวันเพิ่มเติม',                                required: false, example: '0' },
      { key: 'remark',                     label: 'หมายเหตุ',                                         required: false, example: '' },
    ],
  },
  {
    key: 'addresses',
    name: 'ที่อยู่',
    columns: [
      { key: 'old_customer_code',         label: 'รหัสเก่าลูกหนี้ — เชื่อมกับ sheet ข้อมูลทั่วไป', required: true,  example: 'CA0001' },
      { key: 'address_type',             label: 'ประเภทที่อยู่ (billing/shipping/billing note/payment)', required: false, example: 'billing' },
      { key: 'address_no',               label: 'บ้านเลขที่',         required: false, example: '123' },
      { key: 'address_building_village', label: 'อาคาร/หมู่บ้าน',     required: false, example: '' },
      { key: 'address_alley',            label: 'ซอย',                required: false, example: '' },
      { key: 'address_road',             label: 'ถนน',                required: false, example: '' },
      { key: 'address_sub_district',     label: 'ตำบล/แขวง',          required: false, example: '' },
      { key: 'address_district',         label: 'อำเภอ/เขต',          required: false, example: '' },
      { key: 'address_province',         label: 'จังหวัด',             required: false, example: '' },
      { key: 'address_zip_code',         label: 'รหัสไปรษณีย์',       required: false, example: '' },
      { key: 'address_country',          label: 'ประเทศ',              required: false, example: 'Thailand' },
      { key: 'is_default',               label: 'ที่อยู่หลัก (Y/N)',  required: false, example: 'Y' },
    ],
  },
  {
    key: 'contacts',
    name: 'ผู้ติดต่อ',
    columns: [
      { key: 'old_customer_code', label: 'รหัสเก่าลูกหนี้ — เชื่อมกับ sheet ข้อมูลทั่วไป', required: true,  example: 'CA0001' },
      { key: 'contact_name',     label: 'ชื่อผู้ติดต่อ',     required: true,  example: 'คุณสมศักดิ์' },
      { key: 'position',         label: 'ตำแหน่ง',           required: false, example: '' },
      { key: 'phone',            label: 'โทรศัพท์',          required: false, example: '02-123-4567' },
      { key: 'mobile',           label: 'มือถือ',            required: false, example: '081-234-5678' },
      { key: 'email',            label: 'อีเมล',             required: false, example: '' },
      { key: 'is_default',       label: 'ผู้ติดต่อหลัก (Y/N)', required: false, example: 'Y' },
    ],
  },
  {
    key: 'bank_accounts',
    name: 'บัญชีธนาคาร',
    columns: [
      { key: 'old_customer_code', label: 'รหัสเก่าลูกหนี้ — เชื่อมกับ sheet ข้อมูลทั่วไป', required: true,  example: 'CA0001' },
      { key: 'bank_name',        label: 'ธนาคาร',                          required: false, example: 'กรุงไทย' },
      { key: 'branch_name',      label: 'สาขา',                            required: false, example: '' },
      { key: 'account_number',   label: 'เลขที่บัญชี',                    required: false, example: '' },
      { key: 'account_name',     label: 'ชื่อบัญชี',                      required: false, example: '' },
      { key: 'account_type',     label: 'ประเภทบัญชี (current/savings)',  required: false, example: 'current' },
      { key: 'is_default',       label: 'บัญชีหลัก (Y/N)',                required: false, example: 'Y' },
    ],
  },
  {
    key: 'ar_account',
    name: 'รหัสบัญชีลูกหนี้',
    columns: [
      { key: 'old_customer_code', label: 'รหัสเก่าลูกหนี้ — เชื่อมกับ sheet ข้อมูลทั่วไป', required: true,  example: 'CA0001' },
      { key: 'ar_account_code',  label: 'รหัสบัญชีลูกหนี้ (บัญชีคุมยอด)',  required: false, example: '1130' },
    ],
  },
];

const ADDRESS_TYPES = ['billing', 'shipping', 'billing note', 'payment'];
const ACCOUNT_TYPES = ['current', 'savings'];
const YES_VALUES = ['y', 'yes', 'true', '1', 'ใช่'];

// GET /ar_customer/import/template
const getTemplate = (req, res) => {
  res.json({ sheets: TEMPLATE_SHEETS });
};

// GET /ar_customer/import/template/download — ส่งไฟล์ xlsx เทมเพลตหลาย sheet
const downloadTemplate = (req, res) => {
  const wb = XLSX.utils.book_new();
  for (const sheet of TEMPLATE_SHEETS) {
    const headers = sheet.columns.map(c => c.key);
    const labels = sheet.columns.map(c => `(${c.label}${c.required ? ' *' : ''})`);
    const ws = XLSX.utils.aoa_to_sheet([headers, labels]);
    ws['!cols'] = sheet.columns.map(c => ({ wch: Math.max(c.key.length, c.label.length) + 4 }));
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="ar_customer_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class ImportTemplateError extends Error {}

// อ่าน sheet ตามชื่อใน TEMPLATE_SHEETS แล้วตรวจ header กับ columns ที่กำหนด
// required=true: ถ้าไม่พบ sheet ตามชื่อ จะลองใช้ sheet แรกของไฟล์แทน
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
  // กรอง description/label rows (ขึ้นต้นด้วย '(') และ blank rows ออก
  // พร้อมเก็บ Excel row number จริงเพื่อแสดงใน error message
  const keyIdx = colIdx[sheetDef.columns[0].key] ?? 0;
  const rowsWithMeta = aoa.slice(1)
    .map((row, i) => ({ row, num: i + 2 }))
    .filter(({ row }) => {
      const val = String(row[keyIdx] ?? '').trim();
      return val !== '' && !val.startsWith('(');
    });
  return {
    present: true,
    colIdx,
    rows: rowsWithMeta.map(r => r.row),
    rowNums: rowsWithMeta.map(r => r.num),
  };
};

const parseBool = (val) => YES_VALUES.includes(String(val ?? '').trim().toLowerCase());

// แปลงค่าเซลล์ "1,15,31" -> { list: [1,15,31], error: null }
const parseIntListCell = (val) => {
  const s = String(val ?? '').trim();
  if (!s) return { list: [], error: null };
  const parts = s.split(',').map(p => p.trim()).filter(p => p !== '');
  const list = [];
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n)) return { list: [], error: `ค่า "${p}" ไม่ใช่ตัวเลข` };
    list.push(n);
  }
  return { list, error: null };
};

const buildCodeMap = (rows, codeField) => {
  const map = {};
  for (const row of rows) map[String(row[codeField]).toUpperCase()] = row;
  return map;
};

// helper: truncate string to max length safely
const trunc = (val, max) => (val && val.length > max ? val.substring(0, max) : val) || null;

// ---------------------------------------------------------------------------
// POST /ar_customer/import/validate  (multipart file)
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
      const [generalDef, salesDef, billingCondDef, paymentCondDef, addressDef, contactDef, bankDef, arAccountDef] = TEMPLATE_SHEETS;

      const general = readSheet(workbook, generalDef, { required: true });
      if (!general.present || general.rows.length === 0) {
        return res.status(400).json({
          message: `ไม่พบข้อมูลใน sheet "${generalDef.name}" (ต้องมีแถว header และข้อมูลอย่างน้อย 1 แถว)`,
        });
      }
      const sales = readSheet(workbook, salesDef);
      const billingConds = readSheet(workbook, billingCondDef);
      const paymentConds = readSheet(workbook, paymentCondDef);
      const addresses = readSheet(workbook, addressDef);
      const contacts = readSheet(workbook, contactDef);
      const bankAccounts = readSheet(workbook, bankDef);
      const arAccount = readSheet(workbook, arAccountDef);

      // ── Pre-fetch lookup tables ──────────────────────────────────────────
      const [groupsR, businessTypesR, territoriesR, salespersonsR, collectorsR, accountsR, currenciesR, runningR] = await Promise.all([
        req.dbPool.query(`SELECT id, group_code, is_auto_number FROM ar_customer_group WHERE is_active = true`),
        req.dbPool.query(`SELECT id, business_type_code FROM cd_business_type WHERE is_active = true`),
        req.dbPool.query(`SELECT id, territory_code FROM cd_sales_territory WHERE is_active = true`),
        req.dbPool.query(`SELECT id, salesperson_code FROM cd_salesperson WHERE is_active = true`),
        req.dbPool.query(`SELECT id, collector_code FROM ar_collector WHERE is_active = true`),
        req.dbPool.query(`SELECT id, account_code FROM gl_account WHERE is_active = true AND is_control_account = true`),
        req.dbPool.query(`SELECT currency_code FROM cd_currency WHERE is_active = true`),
        req.dbPool.query(`SELECT is_auto_numbering FROM ar_customer_running LIMIT 1`),
      ]);
      const groupMap = buildCodeMap(groupsR.rows, 'group_code');
      const businessTypeMap = buildCodeMap(businessTypesR.rows, 'business_type_code');
      const territoryMap = buildCodeMap(territoriesR.rows, 'territory_code');
      const salespersonMap = buildCodeMap(salespersonsR.rows, 'salesperson_code');
      const collectorMap = buildCodeMap(collectorsR.rows, 'collector_code');
      const accountMap = buildCodeMap(accountsR.rows, 'account_code');
      const currencySet = new Set(currenciesR.rows.map(r => String(r.currency_code).toUpperCase()));
      const globalAutoNumber = runningR.rows.length > 0 && runningR.rows[0].is_auto_numbering;

      const errors = [];          // standalone errors (no matching customer row)
      const customers = new Map(); // customer_name_th -> customer record
      const order = [];

      // ── Sheet 1: ข้อมูลทั่วไป ─────────────────────────────────────────────
      for (let i = 0; i < general.rows.length; i++) {
        const row = general.rows[i];
        const rowNum = general.rowNums[i];
        const get = (key) => String(row[general.colIdx[key]] ?? '').trim();

        const oldCode = get('old_customer_code');
        const nameTh = get('customer_name_th');
        const customerCode = get('customer_code');
        const groupCode = get('customer_group_code').toUpperCase();
        if (!oldCode && !nameTh && !customerCode && !groupCode) continue; // skip blank row

        const rowErrors = [];

        if (!oldCode) {
          rowErrors.push({ column: 'old_customer_code', message: 'จำเป็นต้องระบุรหัสเก่าลูกหนี้ (ใช้เชื่อมข้อมูลกับ sheet อื่น)' });
          errors.push({ row: rowNum, customerCode: customerCode || '(อัตโนมัติ)', errors: rowErrors });
          continue;
        }
        if (customers.has(oldCode)) {
          rowErrors.push({ column: 'old_customer_code', message: `รหัสเก่าลูกหนี้ "${oldCode}" ซ้ำกับแถวก่อนหน้าใน sheet "${generalDef.name}"` });
          errors.push({ row: rowNum, customerCode: customerCode || '(อัตโนมัติ)', errors: rowErrors });
          continue;
        }

        if (!nameTh) {
          rowErrors.push({ column: 'customer_name_th', message: 'จำเป็นต้องระบุชื่อลูกหนี้ (ไทย)' });
        }

        // customer_group_code
        let resolvedGroup = null;
        if (groupCode) {
          resolvedGroup = groupMap[groupCode] || null;
          if (!resolvedGroup) rowErrors.push({ column: 'customer_group_code', message: `ไม่พบกลุ่มลูกค้า "${groupCode}"` });
        }

        // customer_code: จำเป็นต้องระบุ เว้นแต่มีรหัสอัตโนมัติ
        if (!customerCode) {
          const groupAuto = resolvedGroup?.is_auto_number ?? false;
          if (!groupAuto && !globalAutoNumber) {
            rowErrors.push({ column: 'customer_code', message: 'จำเป็นต้องระบุรหัสลูกหนี้ (กลุ่มและระบบไม่ได้เปิดรหัสอัตโนมัติ)' });
          }
        } else if (customerCode.length > 20) {
          rowErrors.push({ column: 'customer_code', message: 'รหัสลูกหนี้ต้องไม่เกิน 20 ตัวอักษร' });
        }

        // business_type_code
        const businessTypeCode = get('business_type_code').toUpperCase();
        let resolvedBusinessType = null;
        if (businessTypeCode) {
          resolvedBusinessType = businessTypeMap[businessTypeCode] || null;
          if (!resolvedBusinessType) rowErrors.push({ column: 'business_type_code', message: `ไม่พบประเภทธุรกิจ "${businessTypeCode}"` });
        }

        // currency_code (ถ้าระบุ ต้องมีในระบบ)
        const currencyCodeRaw = get('currency_code').toUpperCase();
        const currencyCode = currencyCodeRaw || 'THB';
        if (currencyCodeRaw && currencySet.size > 0 && !currencySet.has(currencyCodeRaw)) {
          rowErrors.push({ column: 'currency_code', message: `ไม่พบสกุลเงิน "${currencyCodeRaw}"` });
        }

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

        const isActiveStr = get('is_active');

        const customer = {
          __rowNum: rowNum,
          __rowErrors: rowErrors,
          customer_code: customerCode ? customerCode.toUpperCase() : null,
          customer_group_code: groupCode || null,
          customer_group_id: resolvedGroup?.id || null,
          old_customer_code: get('old_customer_code') || null,
          customer_name_th: nameTh,
          customer_name_en: get('customer_name_en') || null,
          tax_id: get('tax_id') || null,
          business_type_code: businessTypeCode || null,
          business_type_id: resolvedBusinessType?.id || null,
          credit_term_months: creditTermMonths,
          credit_term_days: creditTermDays,
          credit_limit: creditLimit,
          discount_percent: discountPercent,
          currency_code: currencyCode,
          is_active: isActiveStr ? parseBool(isActiveStr) : true,
          requires_billing: parseBool(get('requires_billing')),
          remark: get('remark') || null,
          // เขตการขาย / พนักงานขาย / ผู้วางบิล / ผู้รับชำระ (จาก sheet "เขตการขายและพนักงานขาย")
          sales_territory_code: null, sales_territory_id: null,
          salesperson_code: null, salesperson_id: null,
          billing_collector_code: null, billing_collector_id: null,
          collection_collector_code: null, collection_collector_id: null,
          // รหัสบัญชีลูกหนี้ (จาก sheet "รหัสบัญชีลูกหนี้")
          ar_account_code: null, ar_account_id: null,
          // รายการย่อย
          addresses: [],
          contacts: [],
          bank_accounts: [],
          billing_conditions: [],
          payment_conditions: [],
        };

        customers.set(oldCode, customer);
        order.push(oldCode);
      }

      // ── helper: หา customer จากรหัสเก่า, ถ้าไม่พบให้บันทึก standalone error ──
      const findCustomer = (sheetDef, row, colIdx, rowNum) => {
        const oldCustomerCode = String(row[colIdx['old_customer_code']] ?? '').trim();
        if (!oldCustomerCode) return null; // blank row, skip
        const customer = customers.get(oldCustomerCode);
        if (!customer) {
          errors.push({
            row: rowNum,
            customerCode: oldCustomerCode,
            errors: [{ column: sheetDef.name, message: `ไม่พบรหัสเก่าลูกหนี้ "${oldCustomerCode}" ใน sheet "${generalDef.name}"` }],
          });
          return null;
        }
        return { customer, oldCustomerCode };
      };

      // ── Sheet 2: เขตการขายและพนักงานขาย ───────────────────────────────────
      for (let i = 0; i < sales.rows.length; i++) {
        const row = sales.rows[i];
        const rowNum = sales.rowNums[i];
        const found = findCustomer(salesDef, row, sales.colIdx, rowNum);
        if (!found) continue;
        const { customer } = found;
        const get = (key) => String(row[sales.colIdx[key]] ?? '').trim();

        const territoryCode = get('sales_territory_code').toUpperCase();
        if (territoryCode) {
          const t = territoryMap[territoryCode];
          if (!t) customer.__rowErrors.push({ column: `${salesDef.name}: sales_territory_code`, message: `ไม่พบเขตการขาย "${territoryCode}"` });
          else { customer.sales_territory_code = territoryCode; customer.sales_territory_id = t.id; }
        }
        const salespersonCode = get('salesperson_code').toUpperCase();
        if (salespersonCode) {
          const sp = salespersonMap[salespersonCode];
          if (!sp) customer.__rowErrors.push({ column: `${salesDef.name}: salesperson_code`, message: `ไม่พบพนักงานขาย "${salespersonCode}"` });
          else { customer.salesperson_code = salespersonCode; customer.salesperson_id = sp.id; }
        }
        const billingCollectorCode = get('billing_collector_code').toUpperCase();
        if (billingCollectorCode) {
          const c = collectorMap[billingCollectorCode];
          if (!c) customer.__rowErrors.push({ column: `${salesDef.name}: billing_collector_code`, message: `ไม่พบผู้วางบิล "${billingCollectorCode}"` });
          else { customer.billing_collector_code = billingCollectorCode; customer.billing_collector_id = c.id; }
        }
        const collectionCollectorCode = get('collection_collector_code').toUpperCase();
        if (collectionCollectorCode) {
          const c = collectorMap[collectionCollectorCode];
          if (!c) customer.__rowErrors.push({ column: `${salesDef.name}: collection_collector_code`, message: `ไม่พบผู้รับชำระ "${collectionCollectorCode}"` });
          else { customer.collection_collector_code = collectionCollectorCode; customer.collection_collector_id = c.id; }
        }
      }

      // ── Sheet 3: เงื่อนไขการวางบิล ─────────────────────────────────────────
      for (let i = 0; i < billingConds.rows.length; i++) {
        const row = billingConds.rows[i];
        const rowNum = billingConds.rowNums[i];
        const found = findCustomer(billingCondDef, row, billingConds.colIdx, rowNum);
        if (!found) continue;
        const { customer } = found;
        const get = (key) => String(row[billingConds.colIdx[key]] ?? '').trim();

        const dom = parseIntListCell(get('billing_day_of_month'));
        const dow = parseIntListCell(get('billing_day_of_week'));
        const wom = parseIntListCell(get('billing_week_of_month'));
        if (dom.error) customer.__rowErrors.push({ column: `${billingCondDef.name}: billing_day_of_month`, message: dom.error });
        if (dow.error) customer.__rowErrors.push({ column: `${billingCondDef.name}: billing_day_of_week`, message: dow.error });
        if (wom.error) customer.__rowErrors.push({ column: `${billingCondDef.name}: billing_week_of_month`, message: wom.error });

        let sortOrder = 1;
        const sortStr = get('sort_order');
        if (sortStr) {
          sortOrder = parseInt(sortStr, 10);
          if (isNaN(sortOrder)) {
            customer.__rowErrors.push({ column: `${billingCondDef.name}: sort_order`, message: `ลำดับ "${sortStr}" ไม่ใช่ตัวเลข` });
            sortOrder = 1;
          }
        }

        customer.billing_conditions.push({
          sort_order: sortOrder,
          bill_with_delivery: parseBool(get('bill_with_delivery')),
          billing_day_of_month: dom.list,
          billing_day_of_week: dow.list,
          billing_week_of_month: wom.list,
          billing_time_from: get('billing_time_from') || null,
          billing_time_to: get('billing_time_to') || null,
          due_from_billing_date: parseBool(get('due_from_billing_date')),
          remark: get('remark') || null,
        });
      }

      // ── Sheet 4: เงื่อนไขการรับชำระเงิน ────────────────────────────────────
      for (let i = 0; i < paymentConds.rows.length; i++) {
        const row = paymentConds.rows[i];
        const rowNum = paymentConds.rowNums[i];
        const found = findCustomer(paymentCondDef, row, paymentConds.colIdx, rowNum);
        if (!found) continue;
        const { customer } = found;
        const get = (key) => String(row[paymentConds.colIdx[key]] ?? '').trim();

        const dom = parseIntListCell(get('payment_day_of_month'));
        const dow = parseIntListCell(get('payment_day_of_week'));
        const wom = parseIntListCell(get('payment_week_of_month'));
        if (dom.error) customer.__rowErrors.push({ column: `${paymentCondDef.name}: payment_day_of_month`, message: dom.error });
        if (dow.error) customer.__rowErrors.push({ column: `${paymentCondDef.name}: payment_day_of_week`, message: dow.error });
        if (wom.error) customer.__rowErrors.push({ column: `${paymentCondDef.name}: payment_week_of_month`, message: wom.error });

        let sortOrder = 1;
        const sortStr = get('sort_order');
        if (sortStr) {
          sortOrder = parseInt(sortStr, 10);
          if (isNaN(sortOrder)) {
            customer.__rowErrors.push({ column: `${paymentCondDef.name}: sort_order`, message: `ลำดับ "${sortStr}" ไม่ใช่ตัวเลข` });
            sortOrder = 1;
          }
        }

        let withinMonths = 0;
        const withinStr = get('within_months_from_billing');
        if (withinStr) {
          withinMonths = parseInt(withinStr, 10);
          if (isNaN(withinMonths) || withinMonths < 0) {
            customer.__rowErrors.push({ column: `${paymentCondDef.name}: within_months_from_billing`, message: 'ต้องเป็นตัวเลขไม่ติดลบ' });
            withinMonths = 0;
          }
        }
        let additionalDays = 0;
        const addDaysStr = get('additional_days');
        if (addDaysStr) {
          additionalDays = parseInt(addDaysStr, 10);
          if (isNaN(additionalDays) || additionalDays < 0) {
            customer.__rowErrors.push({ column: `${paymentCondDef.name}: additional_days`, message: 'ต้องเป็นตัวเลขไม่ติดลบ' });
            additionalDays = 0;
          }
        }

        customer.payment_conditions.push({
          sort_order: sortOrder,
          payment_day_of_month: dom.list,
          payment_day_of_week: dow.list,
          payment_week_of_month: wom.list,
          payment_time_from: get('payment_time_from') || null,
          payment_time_to: get('payment_time_to') || null,
          within_months_from_billing: withinMonths,
          additional_days: additionalDays,
          remark: get('remark') || null,
        });
      }

      // ── Sheet 5: ที่อยู่ ───────────────────────────────────────────────────
      for (let i = 0; i < addresses.rows.length; i++) {
        const row = addresses.rows[i];
        const rowNum = addresses.rowNums[i];
        const found = findCustomer(addressDef, row, addresses.colIdx, rowNum);
        if (!found) continue;
        const { customer } = found;
        const get = (key) => String(row[addresses.colIdx[key]] ?? '').trim();

        const addressTypeRaw = get('address_type').toLowerCase();
        const addressType = addressTypeRaw || 'billing';
        if (addressTypeRaw && !ADDRESS_TYPES.includes(addressTypeRaw)) {
          customer.__rowErrors.push({ column: `${addressDef.name}: address_type`, message: `ประเภทที่อยู่ต้องเป็นหนึ่งใน ${ADDRESS_TYPES.join(', ')}` });
        }

        customer.addresses.push({
          address_type: addressType,
          address_no: get('address_no') || null,
          address_building_village: get('address_building_village') || null,
          address_alley: get('address_alley') || null,
          address_road: get('address_road') || null,
          address_sub_district: get('address_sub_district') || null,
          address_district: get('address_district') || null,
          address_province: get('address_province') || null,
          address_zip_code: get('address_zip_code') || null,
          address_country: get('address_country') || 'Thailand',
          is_default: parseBool(get('is_default')),
        });
      }

      // ── Sheet 6: ผู้ติดต่อ ─────────────────────────────────────────────────
      for (let i = 0; i < contacts.rows.length; i++) {
        const row = contacts.rows[i];
        const rowNum = contacts.rowNums[i];
        const found = findCustomer(contactDef, row, contacts.colIdx, rowNum);
        if (!found) continue;
        const { customer } = found;
        const get = (key) => String(row[contacts.colIdx[key]] ?? '').trim();

        const contactName = get('contact_name');
        if (!contactName) {
          customer.__rowErrors.push({ column: `${contactDef.name}: contact_name`, message: 'จำเป็นต้องระบุชื่อผู้ติดต่อ' });
        }

        customer.contacts.push({
          contact_name: contactName,
          position: get('position') || null,
          phone: get('phone') || null,
          mobile: get('mobile') || null,
          email: get('email') || null,
          is_default: parseBool(get('is_default')),
        });
      }

      // ── Sheet 7: บัญชีธนาคาร ───────────────────────────────────────────────
      for (let i = 0; i < bankAccounts.rows.length; i++) {
        const row = bankAccounts.rows[i];
        const rowNum = bankAccounts.rowNums[i];
        const found = findCustomer(bankDef, row, bankAccounts.colIdx, rowNum);
        if (!found) continue;
        const { customer } = found;
        const get = (key) => String(row[bankAccounts.colIdx[key]] ?? '').trim();

        const accountTypeRaw = get('account_type').toLowerCase();
        const accountType = accountTypeRaw || 'current';
        if (accountTypeRaw && !ACCOUNT_TYPES.includes(accountTypeRaw)) {
          customer.__rowErrors.push({ column: `${bankDef.name}: account_type`, message: `ประเภทบัญชีต้องเป็นหนึ่งใน ${ACCOUNT_TYPES.join(', ')}` });
        }

        customer.bank_accounts.push({
          bank_name: get('bank_name') || null,
          branch_name: get('branch_name') || null,
          account_number: get('account_number') || null,
          account_name: get('account_name') || null,
          account_type: accountType,
          is_default: parseBool(get('is_default')),
        });
      }

      // ── Sheet 8: รหัสบัญชีลูกหนี้ ──────────────────────────────────────────
      for (let i = 0; i < arAccount.rows.length; i++) {
        const row = arAccount.rows[i];
        const rowNum = arAccount.rowNums[i];
        const found = findCustomer(arAccountDef, row, arAccount.colIdx, rowNum);
        if (!found) continue;
        const { customer } = found;
        const get = (key) => String(row[arAccount.colIdx[key]] ?? '').trim();

        const arAccountCode = get('ar_account_code').toUpperCase();
        if (arAccountCode) {
          const acc = accountMap[arAccountCode];
          if (!acc) customer.__rowErrors.push({ column: `${arAccountDef.name}: ar_account_code`, message: `ไม่พบรหัสบัญชีลูกหนี้ "${arAccountCode}" (ต้องเป็นบัญชีคุมยอดที่ใช้งานอยู่)` });
          else { customer.ar_account_code = arAccountCode; customer.ar_account_id = acc.id; }
        }
      }

      // ── สรุปผล ────────────────────────────────────────────────────────────
      const validatedRows = [];
      for (const code of order) {
        const customer = customers.get(code);
        if (customer.__rowErrors.length > 0) {
          errors.push({ row: customer.__rowNum, customerCode: customer.old_customer_code || customer.customer_code || '(อัตโนมัติ)', errors: customer.__rowErrors });
        } else {
          delete customer.__rowNum;
          delete customer.__rowErrors;
          validatedRows.push(customer);
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
// POST /ar_customer/import/confirm  (JSON body { rows: [...] })
// บันทึกด้วยวิธีเดียวกับ ar_customer_detail_widget (full field set + insertRelated)
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
              business_type_id, customer_group_id,
              credit_term_months, credit_term_days, credit_limit, discount_percent,
              currency_code, is_active, remark, requires_billing,
              ar_account_id,
              sales_territory_id, salesperson_id,
              billing_collector_id, collection_collector_id,
              created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
           ON CONFLICT (customer_code) DO NOTHING
           RETURNING id`,
          [
            trunc(finalCode, 20), trunc(r.old_customer_code, 50),
            trunc(r.customer_name_th, 200), trunc(r.customer_name_en, 200), trunc(r.tax_id, 20),
            r.business_type_id || null, r.customer_group_id || null,
            r.credit_term_months ?? 0, r.credit_term_days ?? 30,
            r.credit_limit ?? 0, r.discount_percent ?? 0,
            trunc(r.currency_code, 10) || 'THB',
            r.is_active !== undefined ? r.is_active : true,
            trunc(r.remark, 500),
            r.requires_billing ?? false,
            r.ar_account_id || null,
            r.sales_territory_id || null, r.salesperson_id || null,
            r.billing_collector_id || null, r.collection_collector_id || null,
            userName,
          ]
        );

        if (result.rows.length === 0) {
          skipped++;
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
          continue;
        }

        const cid = result.rows[0].id;
        await insertRelated(client, cid, r.addresses, r.contacts, r.bank_accounts, r.billing_conditions, r.payment_conditions);

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
