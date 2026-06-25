// controllers/gl/glAccountImportController.js
const XLSX = require('xlsx');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
// Template definition — sheet เดียว "ผังบัญชี"
// ---------------------------------------------------------------------------
const TEMPLATE_COLUMNS = [
  { key: 'account_code',         label: 'รหัสบัญชี',                                                  required: true,  example: '111100' },
  { key: 'parent_account_code',  label: 'รหัสบัญชีแม่ (ว่าง = บัญชีระดับบนสุด)',                       required: false, example: '111' },
  { key: 'account_name_thai',    label: 'ชื่อบัญชี (ไทย)',                                             required: true,  example: 'เงินสดย่อย' },
  { key: 'account_name_eng',     label: 'ชื่อบัญชี (อังกฤษ)',                                          required: false, example: 'Petty Cash' },
  { key: 'account_type',         label: 'ประเภทบัญชี (ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE)',        required: true,  example: 'ASSET' },
  { key: 'normal_balance',       label: 'ยอดดุลปกติ (DR/CR)',                                          required: true,  example: 'DR' },
  { key: 'is_normal_account',    label: 'หัวบัญชี (Y/N, ว่าง=Y; N=บัญชีรวม/หัวข้อ ลงรายการไม่ได้)',     required: false, example: 'Y' },
  { key: 'is_control_account',   label: 'บัญชีคุมยอด (Y/N, ว่าง=N)',                                   required: false, example: 'N' },
  { key: 'currency_code',        label: 'สกุลเงิน (ว่าง=THB)',                                         required: false, example: 'THB' },
  { key: 'branch_required',      label: 'บังคับระบุสาขา (Y/N, ว่าง=N)',                                required: false, example: 'N' },
  { key: 'is_active',            label: 'ใช้งาน (Y/N, ว่าง=Y)',                                        required: false, example: 'Y' },
  { key: 'dim_required_types',   label: 'มิติที่บังคับกรอก คั่นด้วย , (รหัสจาก gl_dimension_type)',     required: false, example: 'BU,PROJECT' },
];

const SHEET_DEF = { key: 'coa', name: 'ผังบัญชี', columns: TEMPLATE_COLUMNS };

const ACCOUNT_TYPES = [
  { code: 'ASSET', label: 'สินทรัพย์' },
  { code: 'LIABILITY', label: 'หนี้สิน' },
  { code: 'EQUITY', label: 'ส่วนของเจ้าของ' },
  { code: 'REVENUE', label: 'รายได้' },
  { code: 'EXPENSE', label: 'ค่าใช้จ่าย' },
];


const YES_VALUES = ['y', 'yes', 'true', '1', 'ใช่'];

// GET /gl_account/import/template
const getTemplate = async (req, res) => {
  try {
    const dimTypesR = await req.dbPool.query(
      `SELECT type_code, name_thai FROM gl_dimension_type WHERE is_active = true ORDER BY sort_order ASC`
    );
    res.json({
      sheet: { key: SHEET_DEF.key, name: SHEET_DEF.name, columns: TEMPLATE_COLUMNS },
      accountTypes: ACCOUNT_TYPES,
      dimensionTypes: dimTypesR.rows,
    });
  } catch (err) {
    console.error('Error getting import template:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
};

// GET /gl_account/import/template/download — ส่งไฟล์ xlsx เทมเพลต
const downloadTemplate = (req, res) => {
  const headers = TEMPLATE_COLUMNS.map(c => c.key);
  const labels = TEMPLATE_COLUMNS.map(c => `(${c.label}${c.required ? ' *' : ''})`);
  const ws = XLSX.utils.aoa_to_sheet([headers, labels]);
  ws['!cols'] = TEMPLATE_COLUMNS.map(c => ({ wch: Math.max(c.key.length, c.label.length) + 4 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_DEF.name);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="gl_account_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class ImportTemplateError extends Error {}

// อ่าน sheet ตามชื่อใน sheetDef แล้วตรวจ header กับ columns ที่กำหนด
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
  return { present: true, colIdx, rows: aoa.slice(1) };
};

// คืนค่า defaultVal ถ้าเซลล์ว่าง มิฉะนั้นแปลงเป็น boolean ตาม YES_VALUES
const parseBoolDefault = (val, defaultVal) => {
  const s = String(val ?? '').trim();
  if (!s) return defaultVal;
  return YES_VALUES.includes(s.toLowerCase());
};

const buildCodeMap = (rows, codeField) => {
  const map = {};
  for (const row of rows) map[String(row[codeField]).toUpperCase()] = row;
  return map;
};

// helper: truncate string to max length safely
const trunc = (val, max) => (val && val.length > max ? val.substring(0, max) : val) || null;

const _saveDimRules = async (client, accountId, dimRules) => {
  await client.query('DELETE FROM gl_account_dim_rule WHERE account_id = $1', [accountId]);
  if (Array.isArray(dimRules)) {
    for (const rule of dimRules) {
      if (rule.type_code) {
        await client.query(
          'INSERT INTO gl_account_dim_rule (account_id, type_code, is_required) VALUES ($1, $2, $3)',
          [accountId, rule.type_code, rule.is_required ?? true]
        );
      }
    }
  }
};

// ---------------------------------------------------------------------------
// POST /gl_account/import/validate  (multipart file)
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
      const sheet = readSheet(workbook, SHEET_DEF, { required: true });
      if (!sheet.present || sheet.rows.length === 0) {
        return res.status(400).json({
          message: `ไม่พบข้อมูลใน sheet "${SHEET_DEF.name}" (ต้องมีแถว header และข้อมูลอย่างน้อย 1 แถว)`,
        });
      }

      // ── Pre-fetch lookup tables ────────────────────────────────────────
      const [accountsR, dimTypesR, currenciesR] = await Promise.all([
        req.dbPool.query(`SELECT id, account_code FROM gl_account`),
        req.dbPool.query(`SELECT type_code FROM gl_dimension_type WHERE is_active = true`),
        req.dbPool.query(`SELECT currency_code FROM cd_currency WHERE is_active = true`),
      ]);
      const existingCodeMap = buildCodeMap(accountsR.rows, 'account_code');
      const dimTypeSet = new Set(dimTypesR.rows.map(r => String(r.type_code).toUpperCase()));
      const currencySet = new Set(currenciesR.rows.map(r => String(r.currency_code).toUpperCase()));
      const accountTypeSet = new Set(ACCOUNT_TYPES.map(a => a.code));

      // ── First pass: นับจำนวนรหัสบัญชีในไฟล์ เพื่อตรวจรายการซ้ำ ─────────────
      const sheetCodeCount = {};
      for (let i = 0; i < sheet.rows.length; i++) {
        const row = sheet.rows[i];
        const code = String(row[sheet.colIdx['account_code']] ?? '').trim().toUpperCase();
        if (code) sheetCodeCount[code] = (sheetCodeCount[code] || 0) + 1;
      }
      const sheetCodes = new Set(Object.keys(sheetCodeCount));

      // ── Second pass: ตรวจสอบแต่ละแถว ───────────────────────────────────────
      const errors = [];
      const rowsData = [];

      for (let i = 0; i < sheet.rows.length; i++) {
        const row = sheet.rows[i];
        const rowNum = i + 2; // +1 header, +1 1-indexed
        const get = (key) => String(row[sheet.colIdx[key]] ?? '').trim();

        const accountCode = get('account_code').toUpperCase();
        const nameThai = get('account_name_thai');
        const accountTypeRaw = get('account_type').toUpperCase();
        const normalBalanceRaw = get('normal_balance').toUpperCase();
        if (!accountCode && !nameThai && !accountTypeRaw && !normalBalanceRaw) continue; // skip blank row

        const rowErrors = [];

        // account_code
        if (!accountCode) {
          rowErrors.push({ column: 'account_code', message: 'จำเป็นต้องระบุรหัสบัญชี' });
        } else if (accountCode.length > 50) {
          rowErrors.push({ column: 'account_code', message: 'รหัสบัญชีต้องไม่เกิน 50 ตัวอักษร' });
        } else if (sheetCodeCount[accountCode] > 1) {
          rowErrors.push({ column: 'account_code', message: `รหัสบัญชี "${accountCode}" ซ้ำกับแถวอื่นในไฟล์` });
        }

        // parent_account_code
        const parentAccountCode = get('parent_account_code').toUpperCase() || null;
        if (parentAccountCode) {
          if (parentAccountCode === accountCode) {
            rowErrors.push({ column: 'parent_account_code', message: `รหัสบัญชีแม่ต้องไม่เป็นรหัสเดียวกับตัวเอง "${parentAccountCode}"` });
          } else if (!existingCodeMap[parentAccountCode] && !sheetCodes.has(parentAccountCode)) {
            rowErrors.push({ column: 'parent_account_code', message: `ไม่พบรหัสบัญชีแม่ "${parentAccountCode}" ในระบบหรือในไฟล์นำเข้า` });
          }
        }

        // account_name_thai
        if (!nameThai) {
          rowErrors.push({ column: 'account_name_thai', message: 'จำเป็นต้องระบุชื่อบัญชี (ไทย)' });
        }

        // account_type
        if (!accountTypeSet.has(accountTypeRaw)) {
          rowErrors.push({ column: 'account_type', message: `ประเภทบัญชี "${accountTypeRaw}" ไม่ถูกต้อง ต้องเป็นหนึ่งใน ${[...accountTypeSet].join('/')}` });
        }

        // normal_balance
        if (!['DR', 'CR'].includes(normalBalanceRaw)) {
          rowErrors.push({ column: 'normal_balance', message: `ยอดดุลปกติ "${normalBalanceRaw}" ไม่ถูกต้อง ต้องเป็น DR หรือ CR` });
        }

        // currency_code
        const currencyCodeRaw = get('currency_code').toUpperCase();
        const currencyCode = currencyCodeRaw || 'THB';
        if (currencyCodeRaw && !currencySet.has(currencyCodeRaw)) {
          rowErrors.push({ column: 'currency_code', message: `ไม่พบสกุลเงิน "${currencyCodeRaw}"` });
        }

        // dim_required_types
        const dimTypesRaw = get('dim_required_types');
        const dimRules = [];
        if (dimTypesRaw) {
          const codes = dimTypesRaw.split(',').map(c => c.trim().toUpperCase()).filter(c => c !== '');
          const invalid = codes.filter(c => !dimTypeSet.has(c));
          if (invalid.length > 0) {
            rowErrors.push({ column: 'dim_required_types', message: `ไม่พบรหัสมิติ: ${invalid.join(', ')}` });
          } else {
            for (const c of codes) dimRules.push({ type_code: c, is_required: true });
          }
        }

        rowsData.push({
          __rowNum: rowNum,
          __rowErrors: rowErrors,
          account_code: accountCode,
          parent_account_code: parentAccountCode,
          account_name_thai: nameThai,
          account_name_eng: trunc(get('account_name_eng'), 200),
          account_type: accountTypeRaw,
          normal_balance: normalBalanceRaw,
          is_normal_account: parseBoolDefault(get('is_normal_account'), true),
          is_control_account: parseBoolDefault(get('is_control_account'), false),
          currency_code: currencyCode,
          branch_required: parseBoolDefault(get('branch_required'), false),
          is_active: parseBoolDefault(get('is_active'), true),
          dim_rules: dimRules,
        });
      }

      // ── ตรวจสอบการอ้างอิงรหัสบัญชีแม่แบบวงวน (circular reference) ──────────
      const resolved = new Set(Object.keys(existingCodeMap));
      const cycleCandidates = rowsData.filter(r => r.__rowErrors.length === 0);
      const remaining = new Set(cycleCandidates.map(r => r.account_code));
      let progress = true;
      while (progress) {
        progress = false;
        for (const r of cycleCandidates) {
          if (!remaining.has(r.account_code)) continue;
          if (!r.parent_account_code || resolved.has(r.parent_account_code)) {
            resolved.add(r.account_code);
            remaining.delete(r.account_code);
            progress = true;
          }
        }
      }
      for (const r of cycleCandidates) {
        if (remaining.has(r.account_code)) {
          r.__rowErrors.push({ column: 'parent_account_code', message: `การอ้างอิงรหัสบัญชีแม่เป็นวงวน (circular reference): ${r.account_code}` });
        }
      }

      // ── สรุปผล ────────────────────────────────────────────────────────────
      const validatedRows = [];
      for (const r of rowsData) {
        if (r.__rowErrors.length > 0) {
          errors.push({ row: r.__rowNum, accountCode: r.account_code || '(ไม่ระบุ)', errors: r.__rowErrors });
        } else {
          delete r.__rowNum;
          delete r.__rowErrors;
          validatedRows.push(r);
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
// POST /gl_account/import/confirm  (JSON body { rows: [...] })
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

    const existingR = await client.query('SELECT id, account_code FROM gl_account');
    const resolved = new Map();
    for (const row of existingR.rows) {
      resolved.set(String(row.account_code).toUpperCase(), row.id);
    }

    const processed = new Array(rows.length).fill(false);
    let progress = true;
    while (progress) {
      progress = false;
      for (let idx = 0; idx < rows.length; idx++) {
        if (processed[idx]) continue;
        const r = rows[idx];
        const parentCode = r.parent_account_code || null;
        if (parentCode && !resolved.has(parentCode)) continue;

        progress = true;
        processed[idx] = true;
        const savepointName = `sp_row_${idx}`;
        await client.query(`SAVEPOINT ${savepointName}`);
        try {
          const parentId = parentCode ? (resolved.get(parentCode) ?? null) : null;
          const result = await client.query(
            `INSERT INTO gl_account
               (account_code, account_name_thai, account_name_eng, parent_id, account_type,
                normal_balance, is_normal_account, is_control_account, currency_code,
                branch_required, is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
             ON CONFLICT (account_code) DO NOTHING
             RETURNING id`,
            [
              trunc(r.account_code, 50), trunc(r.account_name_thai, 255), trunc(r.account_name_eng, 255),
              parentId, r.account_type,
              r.normal_balance, r.is_normal_account ?? true, r.is_control_account ?? false,
              trunc(r.currency_code, 3) || 'THB',
              r.branch_required ?? false,
              r.is_active ?? true, userName,
            ]
          );

          if (result.rows.length > 0) {
            const newId = result.rows[0].id;
            await _saveDimRules(client, newId, r.dim_rules);
            resolved.set(r.account_code, newId);
            imported++;
          } else {
            const existing = await client.query('SELECT id FROM gl_account WHERE account_code = $1', [r.account_code]);
            resolved.set(r.account_code, existing.rows[0]?.id ?? null);
            skipped++;
          }
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        } catch (rowErr) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
          importErrors.push({ account_code: r.account_code, message: rowErr.message });
        }
      }
    }

    for (let idx = 0; idx < rows.length; idx++) {
      if (!processed[idx]) {
        importErrors.push({ account_code: rows[idx].account_code, message: `ไม่สามารถนำเข้าได้: ไม่พบรหัสบัญชีแม่ "${rows[idx].parent_account_code}"` });
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
