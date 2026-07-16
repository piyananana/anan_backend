// controllers/ap/apVendorBalanceImportController.js
const XLSX = require('xlsx');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// AP doc types that increase a vendor's outstanding balance (bills/invoices)
const AP_BILL_DOC_TYPES = ['10', '50'];

const TEMPLATE_SHEET = {
  key: 'balance',
  name: 'ยอดเจ้าหนี้คงเหลือ',
  columns: [
    { key: 'vendor_code',    label: 'รหัสเจ้าหนี้',                               required: true,  example: 'V0001' },
    { key: 'doc_code',       label: 'รหัสประเภทเอกสารที่ใช้ตั้งยอด (ดูรายการที่ใช้ได้ด้านล่าง)', required: true,  example: 'PI' },
    { key: 'doc_no',         label: 'เลขที่เอกสาร (ไม่เกิน 30 ตัวอักษร)',         required: true,  example: 'PI-2025-001234' },
    { key: 'doc_date',       label: 'วันที่เอกสาร (YYYY-MM-DD)',                   required: true,  example: '2025-12-15' },
    { key: 'due_date',       label: 'วันครบกำหนด (ว่าง = คำนวณจากเครดิตของเจ้าหนี้)', required: false, example: '2026-01-14' },
    { key: 'currency_code',  label: 'สกุลเงิน (ว่าง = THB)',                      required: false, example: 'THB' },
    { key: 'exchange_rate',  label: 'อัตราแลกเปลี่ยน (ว่าง = 1)',                 required: false, example: '1' },
    { key: 'amount',         label: 'ยอดคงเหลือ',                                 required: true,  example: '50000' },
    { key: 'description',    label: 'คำอธิบาย/หมายเหตุ',                          required: false, example: 'ยอดยกมาจากระบบเดิม' },
  ],
};

// GET /ap_vendor_balance/import/template
const getTemplate = async (req, res) => {
  try {
    const docTypesR = await req.dbPool.query(
      `SELECT doc_code, doc_name_thai, sys_doc_type FROM sa_module_document
       WHERE sys_module = '21' AND sys_doc_type = ANY($1) AND is_active = true AND is_doc_type = true
       ORDER BY doc_code`,
      [AP_BILL_DOC_TYPES]
    );
    res.json({ sheet: TEMPLATE_SHEET, docTypes: docTypesR.rows });
  } catch (err) {
    console.error('getTemplate error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
};

// GET /ap_vendor_balance/import/template/download
const downloadTemplate = (req, res) => {
  const headers = TEMPLATE_SHEET.columns.map(c => c.key);
  const labels  = TEMPLATE_SHEET.columns.map(c => `(${c.label}${c.required ? ' *' : ''})`);
  const ws = XLSX.utils.aoa_to_sheet([headers, labels]);
  ws['!cols'] = TEMPLATE_SHEET.columns.map(c => ({ wch: Math.max(c.key.length, c.label.length) + 4 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, TEMPLATE_SHEET.name);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="ap_vendor_balance_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class ImportTemplateError extends Error {}

const trunc = (val, max) => (val && val.length > max ? val.substring(0, max) : val) || null;

const buildCodeMap = (rows, codeField) => {
  const map = {};
  for (const row of rows) map[String(row[codeField]).toUpperCase()] = row;
  return map;
};

const readSheet = (workbook) => {
  let sheet = workbook.Sheets[TEMPLATE_SHEET.name];
  if (!sheet) sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { present: false, colIdx: {}, rows: [] };

  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (aoa.length === 0) return { present: false, colIdx: {}, rows: [] };

  const headers = aoa[0].map(h => String(h || '').trim());
  const expectedKeys = TEMPLATE_SHEET.columns.map(c => c.key);
  const missing = expectedKeys.filter(k => !headers.includes(k));
  if (missing.length > 0) {
    throw new ImportTemplateError(`Sheet "${TEMPLATE_SHEET.name}" ไม่ตรงตามเทมเพลต ขาดคอลัมน์: ${missing.join(', ')}`);
  }
  const colIdx = {};
  headers.forEach((h, i) => { colIdx[h] = i; });
  return { present: true, colIdx, rows: aoa.slice(1) };
};

const parseDateCell = (val) => {
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
};

const addMonthsDays = (dateStr, months, days) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, (m - 1) + (months || 0), d + (days || 0));
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
};

// ---------------------------------------------------------------------------
// POST /ap_vendor_balance/import/validate
// ---------------------------------------------------------------------------
const validateFile = [
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'ไม่พบไฟล์' });

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    } catch (err) {
      return res.status(500).json({ message: 'ไม่สามารถอ่านไฟล์ได้: ' + err.message });
    }

    try {
      const sheet = readSheet(workbook);
      if (!sheet.present || sheet.rows.length === 0) {
        return res.status(400).json({
          message: `ไม่พบข้อมูลใน sheet "${TEMPLATE_SHEET.name}" (ต้องมีแถว header และข้อมูลอย่างน้อย 1 แถว)`,
        });
      }

      const [vendorsR, groupsR, currenciesR, docTypesR, periodR] = await Promise.all([
        req.dbPool.query(
          `SELECT id, vendor_code, vendor_name_th, ap_account_id, vendor_group_id, credit_term_months, credit_term_days
           FROM ap_vendor WHERE is_active = true`
        ),
        req.dbPool.query(`SELECT id, ap_account_id FROM ap_vendor_group`),
        req.dbPool.query(`SELECT id, currency_code FROM cd_currency WHERE is_active = true`),
        req.dbPool.query(
          `SELECT id, doc_code, sys_doc_type FROM sa_module_document
           WHERE sys_module = '21' AND sys_doc_type = ANY($1) AND is_active = true AND is_doc_type = true`,
          [AP_BILL_DOC_TYPES]
        ),
        req.dbPool.query(
          `SELECT id FROM gl_posting_period
           WHERE CURRENT_DATE BETWEEN period_start_date AND period_end_date AND gl_status = 'OPEN' LIMIT 1`
        ),
      ]);

      if (periodR.rows.length === 0) {
        return res.status(400).json({ message: 'ไม่พบงวดบัญชีที่เปิดใช้งานสำหรับวันที่ปัจจุบัน กรุณาเปิดงวดบัญชีก่อนทำการนำเข้า' });
      }

      const vendorMap   = buildCodeMap(vendorsR.rows, 'vendor_code');
      const groupMap    = {};
      for (const g of groupsR.rows) groupMap[g.id] = g;
      const currencyMap = buildCodeMap(currenciesR.rows, 'currency_code');
      const docTypeMap  = buildCodeMap(docTypesR.rows, 'doc_code');

      const errors = [];
      const validatedRows = [];

      for (let i = 0; i < sheet.rows.length; i++) {
        const row = sheet.rows[i];
        const rowNum = i + 2;
        const get    = (key) => { const v = row[sheet.colIdx[key]]; return v === undefined || v === null ? '' : v; };
        const getStr = (key) => String(get(key) ?? '').trim();

        const vendorCode = getStr('vendor_code');
        const docCode    = getStr('doc_code');
        const docNo      = getStr('doc_no');
        if (!vendorCode && !docCode && !docNo) continue;

        const rowErrors = [];

        let vendor = null;
        if (!vendorCode) {
          rowErrors.push({ column: 'vendor_code', message: 'จำเป็นต้องระบุรหัสเจ้าหนี้' });
        } else {
          vendor = vendorMap[vendorCode.toUpperCase()] || null;
          if (!vendor) rowErrors.push({ column: 'vendor_code', message: `ไม่พบรหัสเจ้าหนี้ "${vendorCode}"` });
        }

        let docType = null;
        if (!docCode) {
          rowErrors.push({ column: 'doc_code', message: 'จำเป็นต้องระบุรหัสประเภทเอกสาร' });
        } else {
          docType = docTypeMap[docCode.toUpperCase()] || null;
          if (!docType) rowErrors.push({ column: 'doc_code', message: `ไม่พบประเภทเอกสาร "${docCode}" หรือไม่ใช่ประเภทที่ใช้ตั้งยอดเจ้าหนี้ได้ (ต้องเป็น Purchase Invoice / Debit Note)` });
        }

        if (!docNo) {
          rowErrors.push({ column: 'doc_no', message: 'จำเป็นต้องระบุเลขที่เอกสาร' });
        } else if (docNo.length > 30) {
          rowErrors.push({ column: 'doc_no', message: 'เลขที่เอกสารต้องไม่เกิน 30 ตัวอักษร' });
        }

        const docDateStr = getStr('doc_date');
        const docDate    = parseDateCell(get('doc_date'));
        if (!docDateStr) {
          rowErrors.push({ column: 'doc_date', message: 'จำเป็นต้องระบุวันที่เอกสาร' });
        } else if (!docDate) {
          rowErrors.push({ column: 'doc_date', message: `วันที่เอกสาร "${docDateStr}" ไม่ถูกต้อง (รูปแบบ YYYY-MM-DD)` });
        }

        const dueDateStr = getStr('due_date');
        let dueDate = null;
        if (!dueDateStr) {
          if (docDate && vendor) {
            dueDate = addMonthsDays(docDate, vendor.credit_term_months ?? 0, vendor.credit_term_days ?? 30);
          }
        } else {
          dueDate = parseDateCell(get('due_date'));
          if (!dueDate) rowErrors.push({ column: 'due_date', message: `วันครบกำหนด "${dueDateStr}" ไม่ถูกต้อง (รูปแบบ YYYY-MM-DD)` });
        }

        const currencyCodeRaw = getStr('currency_code').toUpperCase();
        const currencyCode    = currencyCodeRaw || 'THB';
        let currencyId = null;
        const resolvedCurrency = currencyMap[currencyCode];
        if (resolvedCurrency) {
          currencyId = resolvedCurrency.id;
        } else if (currencyCodeRaw) {
          rowErrors.push({ column: 'currency_code', message: `ไม่พบสกุลเงิน "${currencyCodeRaw}"` });
        }

        let exchangeRate = 1;
        const exRateStr = getStr('exchange_rate');
        if (exRateStr) {
          exchangeRate = parseFloat(exRateStr.replace(/,/g, ''));
          if (isNaN(exchangeRate) || exchangeRate <= 0) {
            rowErrors.push({ column: 'exchange_rate', message: 'อัตราแลกเปลี่ยนต้องเป็นตัวเลขมากกว่า 0' });
            exchangeRate = 1;
          }
        }

        let amount = 0;
        const amountStr = getStr('amount');
        if (!amountStr) {
          rowErrors.push({ column: 'amount', message: 'จำเป็นต้องระบุยอดคงเหลือ' });
        } else {
          amount = parseFloat(amountStr.replace(/,/g, ''));
          if (isNaN(amount) || amount <= 0) {
            rowErrors.push({ column: 'amount', message: 'ยอดคงเหลือต้องเป็นตัวเลขมากกว่า 0' });
          }
        }

        let apAccountId = null;
        if (vendor) {
          apAccountId = vendor.ap_account_id || (groupMap[vendor.vendor_group_id]?.ap_account_id) || null;
          if (!apAccountId) {
            rowErrors.push({ column: 'vendor_code', message: `ไม่พบบัญชีเจ้าหนี้ (ap_account) สำหรับเจ้าหนี้ "${vendorCode}" — กรุณาตั้งค่าที่หน้าข้อมูลเจ้าหนี้หรือกลุ่มเจ้าหนี้` });
          }
        }

        const description = trunc(getStr('description'), 500);

        if (rowErrors.length > 0) {
          errors.push({ row: rowNum, vendorCode: vendorCode || '-', errors: rowErrors });
          continue;
        }

        validatedRows.push({
          __rowNum: rowNum,
          vendor_id:      vendor.id,
          vendor_code:    vendor.vendor_code,
          vendor_name_th: vendor.vendor_name_th,
          doc_id:         docType.id,
          doc_code:       docCode.toUpperCase(),
          doc_no:         docNo,
          doc_date:       docDate,
          due_date:       dueDate,
          currency_code:  currencyCode,
          currency_id:    currencyId,
          exchange_rate:  exchangeRate,
          amount,
          ap_account_id:  apAccountId,
          description,
        });
      }

      if (validatedRows.length > 0) {
        const vendorIds = [...new Set(validatedRows.map(r => r.vendor_id))];
        const existingR = await req.dbPool.query(
          `SELECT vendor_id, doc_no FROM ap_transaction WHERE status != 'Void' AND vendor_id = ANY($1::int[])`,
          [vendorIds]
        );
        const existingSet = new Set(existingR.rows.map(r => `${r.vendor_id}|${r.doc_no}`));

        const stillValid = [];
        for (const r of validatedRows) {
          const key = `${r.vendor_id}|${r.doc_no}`;
          if (existingSet.has(key)) {
            errors.push({
              row: r.__rowNum,
              vendorCode: r.vendor_code,
              errors: [{ column: 'doc_no', message: `เอกสารเลขที่ "${r.doc_no}" มีอยู่ในระบบแล้วสำหรับเจ้าหนี้นี้` }],
            });
          } else {
            delete r.__rowNum;
            stillValid.push(r);
          }
        }
        validatedRows.length = 0;
        validatedRows.push(...stillValid);
      }

      errors.sort((a, b) => a.row - b.row);

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
// POST /ap_vendor_balance/import/confirm
// ---------------------------------------------------------------------------
const confirmImport = async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ message: 'ไม่มีข้อมูลนำเข้า' });
  }
  const userName = req.headers.username;
  const client   = await req.dbPool.connect();
  let imported = 0, skipped = 0;
  const importErrors = [];
  try {
    await client.query('BEGIN');

    const periodR = await client.query(
      `SELECT id FROM gl_posting_period
       WHERE CURRENT_DATE BETWEEN period_start_date AND period_end_date AND gl_status = 'OPEN' LIMIT 1`
    );
    if (periodR.rows.length === 0) {
      throw new Error('ไม่พบงวดบัญชีที่เปิดใช้งานสำหรับวันที่ปัจจุบัน');
    }
    const periodId = periodR.rows[0].id;

    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx];
      const savepointName = `sp_row_${idx}`;
      await client.query(`SAVEPOINT ${savepointName}`);
      try {
        const existingR = await client.query(
          `SELECT id FROM ap_transaction WHERE vendor_id = $1 AND doc_no = $2 AND status != 'Void' LIMIT 1`,
          [r.vendor_id, r.doc_no]
        );
        if (existingR.rows.length > 0) {
          skipped++;
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
          continue;
        }

        const amount     = Number(r.amount) || 0;
        const exRate     = Number(r.exchange_rate) || 1;
        const amountLc   = Math.round(amount * exRate * 100) / 100;

        await client.query(
          `INSERT INTO ap_transaction
             (doc_id, doc_no, doc_date, due_date, period_id,
              vendor_id, vendor_code, vendor_name_th,
              ap_account_id, currency_id, currency_code, exchange_rate,
              subtotal_fc, discount_amount_fc, before_vat_fc, vat_amount_fc, total_amount_fc,
              subtotal_lc, discount_amount_lc, before_vat_lc, vat_amount_lc, total_amount_lc,
              paid_amount_lc, balance_amount_lc,
              description, status, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                   $13,0,$13,0,$13,
                   $14,0,$14,0,$14,
                   0,$14,
                   $15,'Posted',$16,$16)`,
          [
            r.doc_id, trunc(r.doc_no, 30), r.doc_date, r.due_date || null, periodId,
            r.vendor_id, trunc(r.vendor_code, 20), trunc(r.vendor_name_th, 200),
            r.ap_account_id || null, r.currency_id || null, trunc(r.currency_code, 10) || 'THB', exRate,
            amount,
            amountLc,
            trunc(r.description, 500),
            userName,
          ]
        );

        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        imported++;
      } catch (rowErr) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        importErrors.push({ vendor_code: r.vendor_code, doc_no: r.doc_no, message: rowErr.message });
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
