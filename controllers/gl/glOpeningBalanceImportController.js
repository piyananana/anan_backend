// controllers/gl/glOpeningBalanceImportController.js
const XLSX = require('xlsx');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

const BF_DOC_ID = 42; // sa_module_document.id ของเอกสาร "ยอดยกมา" (BF)

// ---------------------------------------------------------------------------
// Template definition — 2 sheets: header / detail
// ---------------------------------------------------------------------------
const HEADER_COLUMNS = [
  { key: 'header_ref',    label: 'เลขอ้างอิง (ใช้เชื่อมกับ sheet "detail")',          required: true,  example: '1' },
  { key: 'doc_no',        label: 'เลขที่เอกสาร (ว่าง = ระบบกำหนดอัตโนมัติ)',          required: false, example: '' },
  { key: 'doc_date',      label: 'วันที่เอกสาร (YYYY-MM-DD, ต้องอยู่ในงวดที่เปิด GL)', required: true,  example: '2026-01-01' },
  { key: 'ref_no',        label: 'เลขที่อ้างอิง/หมายเหตุอ้างอิง',                     required: false, example: 'เปิดยอดระบบใหม่' },
  { key: 'description',   label: 'คำอธิบาย',                                          required: false, example: 'ยอดยกมา ณ 1 ม.ค. 2569' },
  { key: 'branch_code',   label: 'รหัสสาขา (ว่าง = ไม่ระบุ)',                          required: false, example: '00' },
  { key: 'currency_code', label: 'สกุลเงิน (ว่าง = THB)',                              required: false, example: 'THB' },
  { key: 'exchange_rate', label: 'อัตราแลกเปลี่ยน (ว่าง = base rate ของสกุลเงิน)',     required: false, example: '1' },
];

const DETAIL_BASE_COLUMNS = [
  { key: 'header_ref',    label: 'เลขอ้างอิง (ต้องตรงกับ sheet "header")',  required: true,  example: '1' },
  { key: 'account_code',  label: 'รหัสบัญชี (ต้องเป็นบัญชีปฏิบัติการที่ใช้งานอยู่)', required: true,  example: '111100' },
  { key: 'description',   label: 'คำอธิบายรายการ',                          required: false, example: 'เงินสดยกมา' },
  { key: 'debit',         label: 'เดบิต (ระบุอย่างใดอย่างหนึ่งกับเครดิต)',  required: false, example: '50000' },
  { key: 'credit',        label: 'เครดิต',                                  required: false, example: '' },
];

const SHEET_DEFS = {
  header: { key: 'header', name: 'header', columns: HEADER_COLUMNS },
  detail: { key: 'detail', name: 'detail', columns: DETAIL_BASE_COLUMNS },
};

// ---------------------------------------------------------------------------
// Helpers (self-contained)
// ---------------------------------------------------------------------------
class ImportTemplateError extends Error {}

// อ่าน sheet ตามชื่อ; ถ้าไม่พบจะลองตามตำแหน่ง (fallbackIndex)
const readSheetByName = (workbook, sheetName, columns, fallbackIndex) => {
  let sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    const altName = workbook.SheetNames[fallbackIndex];
    if (altName) sheet = workbook.Sheets[altName];
  }
  if (!sheet) return { present: false, colIdx: {}, rows: [] };

  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (aoa.length === 0) return { present: false, colIdx: {}, rows: [] };

  const headers = aoa[0].map(h => String(h || '').trim());
  const expectedKeys = columns.map(c => c.key);
  const missing = expectedKeys.filter(k => !headers.includes(k));
  if (missing.length > 0) {
    throw new ImportTemplateError(`Sheet "${sheetName}" ไม่ตรงตามเทมเพลต ขาดคอลัมน์: ${missing.join(', ')}`);
  }
  const colIdx = {};
  headers.forEach((h, i) => { colIdx[h] = i; });

  // Skip label/hint row — if the row immediately after the header row has
  // at least one cell that looks like a label "(…)", treat it as documentation
  // and skip it (this is the pattern used by downloadTemplate).
  let dataStart = 1;
  if (aoa.length > 1) {
    const nextRow = aoa[1] || [];
    const isLabelRow = nextRow.some(cell => {
      const s = String(cell ?? '').trim();
      return s.startsWith('(') && s.endsWith(')');
    });
    if (isLabelRow) dataStart = 2;
  }
  return { present: true, colIdx, rows: aoa.slice(dataStart) };
};

// truncate string to max length safely
const trunc = (val, max) => (val && val.length > max ? val.substring(0, max) : val) || null;

// parse number cell: strip commas, default 0
const parseAmount = (val) => {
  const s = String(val ?? '').trim().replace(/,/g, '');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// parse date cell -> 'YYYY-MM-DD' string หรือ null
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

// ---------------------------------------------------------------------------
// Local replicas of gl_entry helpers (glEntryController.js does not export them)
// ---------------------------------------------------------------------------
const validateDimRules = async (client, details) => {
  const typeRes = await client.query(
    `SELECT type_code, slot_no FROM gl_dimension_type WHERE is_active = true`
  );
  const slotByType = {};
  for (const r of typeRes.rows) slotByType[r.type_code] = r.slot_no;

  const errors = [];
  for (let i = 0; i < details.length; i++) {
    const row = details[i];
    if (!row.account_id) continue;
    const rulesRes = await client.query(
      `SELECT type_code FROM gl_account_dim_rule WHERE account_id = $1 AND is_required = true`,
      [row.account_id]
    );
    for (const rule of rulesRes.rows) {
      const slot = slotByType[rule.type_code];
      if (!slot) continue;
      const dimId = row[`dim${slot}_id`];
      if (!dimId) {
        errors.push(`บรรทัดที่ ${i + 1}: ต้องระบุ ${rule.type_code}`);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Dimension ไม่ครบ:\n${errors.join('\n')}`);
  }
};

const getOrCreateComboId = async (client, { branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id }) => {
  const res = await client.query(`
        INSERT INTO gl_dim_combination (branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (combo_key) DO UPDATE SET id = gl_dim_combination.id
        RETURNING id
    `, [branch_id || 0, dim1_id || 0, dim2_id || 0, dim3_id || 0, dim4_id || 0, dim5_id || 0]);
  return res.rows[0].id;
};

const updateBalanceAccum = async (client, headerId, isReverse = false) => {
  const detailsRes = await client.query(`SELECT * FROM gl_entry_detail WHERE header_id = $1`, [headerId]);
  const headerRes  = await client.query(`SELECT * FROM gl_entry_header WHERE id = $1`, [headerId]);
  const header  = headerRes.rows[0];
  const details = detailsRes.rows;
  const multiplier = isReverse ? -1 : 1;

  for (const row of details) {
    const comboId  = await getOrCreateComboId(client, {
      branch_id: header.branch_id,
      dim1_id: row.dim1_id, dim2_id: row.dim2_id,
      dim3_id: row.dim3_id, dim4_id: row.dim4_id, dim5_id: row.dim5_id,
    });
    const debit    = (Number(row.debit_lc)  || 0) * multiplier;
    const credit   = (Number(row.credit_lc) || 0) * multiplier;
    const netChange = debit - credit;

    await client.query(`
            INSERT INTO gl_balance_accum
                (period_id, account_id, combo_id, currency_id,
                 debit_amount, credit_amount, end_balance, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
            ON CONFLICT (period_id, account_id, combo_id, currency_id)
            DO UPDATE SET
                debit_amount  = gl_balance_accum.debit_amount  + EXCLUDED.debit_amount,
                credit_amount = gl_balance_accum.credit_amount + EXCLUDED.credit_amount,
                end_balance   = gl_balance_accum.end_balance   + (EXCLUDED.debit_amount - EXCLUDED.credit_amount),
                updated_at    = NOW()
        `, [header.period_id, row.account_id, comboId, header.currency_id || 1,
      debit, credit, netChange]);
  }
};

const generateDocNo = async (client, docId, date, branchId = null) => {
  let config = null;
  let useBranchCounter = false;
  let branchRowId = null;

  if (branchId) {
    const branchRes = await client.query(
      `SELECT * FROM sa_doc_number_branch WHERE doc_id = $1 AND branch_id = $2 FOR UPDATE`,
      [docId, branchId]
    );
    if (branchRes.rows.length > 0) {
      const globalRes = await client.query(
        `SELECT * FROM sa_module_document WHERE id = $1`, [docId]
      );
      const global = globalRes.rows[0];
      if (!global || !global.is_auto_numbering) return null;
      const bc = branchRes.rows[0];
      config = {
        format_prefix:       bc.format_prefix      ?? global.format_prefix      ?? '',
        format_separator:    bc.format_separator   ?? global.format_separator   ?? '',
        format_suffix_date:  bc.format_suffix_date ?? global.format_suffix_date ?? '',
        running_length:      bc.running_length     ?? global.running_length     ?? 4,
        next_running_number: bc.next_running_number,
      };
      useBranchCounter = true;
      branchRowId = bc.id;
    }
  }

  if (!useBranchCounter) {
    const globalRes = await client.query(
      `SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]
    );
    const global = globalRes.rows[0];
    if (!global || !global.is_auto_numbering) return null;
    config = {
      format_prefix:       global.format_prefix      || '',
      format_separator:    global.format_separator   || '',
      format_suffix_date:  global.format_suffix_date || '',
      running_length:      global.running_length     || 4,
      next_running_number: global.next_running_number,
    };
  }

  let docNo = config.format_prefix;
  if (config.format_suffix_date) {
    const d = new Date(date);
    const year  = d.getFullYear().toString();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day   = d.getDate().toString().padStart(2, '0');
    if      (config.format_suffix_date === 'YY')       docNo += year.substring(2);
    else if (config.format_suffix_date === 'YYYY')     docNo += year;
    else if (config.format_suffix_date === 'YYMM')     docNo += year.substring(2) + month;
    else if (config.format_suffix_date === 'YYYYMM')   docNo += year + month;
    else if (config.format_suffix_date === 'YYYYMMDD') docNo += year + month + day;
  }
  if (config.format_separator) docNo += config.format_separator;
  docNo += config.next_running_number.toString().padStart(config.running_length, '0');

  if (useBranchCounter) {
    await client.query(
      `UPDATE sa_doc_number_branch SET next_running_number = next_running_number + 1 WHERE id = $1`,
      [branchRowId]
    );
  } else {
    await client.query(
      `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
      [docId]
    );
  }
  return docNo;
};

// ---------------------------------------------------------------------------
// GET /gl_opening_balance/import/template
// ---------------------------------------------------------------------------
const getTemplate = async (req, res) => {
  try {
    const [dimTypesR, branchesR, currenciesR] = await Promise.all([
      req.dbPool.query(`SELECT type_code, name_thai, slot_no FROM gl_dimension_type WHERE is_active = true ORDER BY slot_no ASC`),
      req.dbPool.query(`SELECT branch_code, branch_name_thai FROM cd_branch WHERE is_active = true ORDER BY branch_code ASC`),
      req.dbPool.query(`SELECT currency_code, currency_name_th, base_rate, base_currency_flag FROM cd_currency WHERE is_active = true ORDER BY currency_code ASC`),
    ]);

    const dimensionTypes = [];
    for (const dt of dimTypesR.rows) {
      const valuesR = await req.dbPool.query(
        `SELECT value_code, value_name_thai FROM gl_dimension_value WHERE type_code = $1 AND is_active = true ORDER BY sort_order ASC`,
        [dt.type_code]
      );
      dimensionTypes.push({
        type_code: dt.type_code,
        label: dt.name_thai,
        slot_no: dt.slot_no,
        values: valuesR.rows.map(v => ({ code: v.value_code, label: v.value_name_thai })),
      });
    }

    const detailColumns = [...DETAIL_BASE_COLUMNS];
    for (const dt of dimensionTypes) {
      detailColumns.push({
        key: `dim_${dt.type_code}`,
        label: `${dt.label} (รหัสจาก gl_dimension_value, บังคับถ้าบัญชีกำหนดไว้)`,
        required: false,
        example: dt.values[0]?.code || '',
      });
    }

    res.json({
      sheets: {
        header: { key: SHEET_DEFS.header.key, name: SHEET_DEFS.header.name, columns: HEADER_COLUMNS },
        detail: { key: SHEET_DEFS.detail.key, name: SHEET_DEFS.detail.name, columns: detailColumns },
      },
      branches: branchesR.rows.map(b => ({ code: b.branch_code, label: b.branch_name_thai })),
      currencies: currenciesR.rows.map(c => ({ code: c.currency_code, label: c.currency_name_th, base_rate: c.base_rate, base_currency_flag: c.base_currency_flag })),
      dimensionTypes,
    });
  } catch (err) {
    console.error('Error getting import template:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
};

// ---------------------------------------------------------------------------
// GET /gl_opening_balance/import/template/download
// ---------------------------------------------------------------------------
const downloadTemplate = async (req, res) => {
  try {
    const dimTypesR = await req.dbPool.query(
      `SELECT type_code, name_thai FROM gl_dimension_type WHERE is_active = true ORDER BY slot_no ASC`
    );
    const detailColumns = [...DETAIL_BASE_COLUMNS];
    for (const dt of dimTypesR.rows) {
      detailColumns.push({ key: `dim_${dt.type_code}`, label: dt.name_thai, required: false, example: '' });
    }

    const wb = XLSX.utils.book_new();

    const headerHeaders = HEADER_COLUMNS.map(c => c.key);
    const headerLabels  = HEADER_COLUMNS.map(c => `(${c.label}${c.required ? ' *' : ''})`);
    const wsHeader = XLSX.utils.aoa_to_sheet([headerHeaders, headerLabels]);
    wsHeader['!cols'] = HEADER_COLUMNS.map(c => ({ wch: Math.max(c.key.length, 20) + 4 }));
    XLSX.utils.book_append_sheet(wb, wsHeader, 'header');

    const detailHeaders = detailColumns.map(c => c.key);
    const detailLabels  = detailColumns.map(c => `(${c.label}${c.required ? ' *' : ''})`);
    const wsDetail = XLSX.utils.aoa_to_sheet([detailHeaders, detailLabels]);
    wsDetail['!cols'] = detailColumns.map(c => ({ wch: Math.max(c.key.length, 20) + 4 }));
    XLSX.utils.book_append_sheet(wb, wsDetail, 'detail');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="gl_opening_balance_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('Error downloading import template:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาด: ' + err.message });
  }
};

// ---------------------------------------------------------------------------
// POST /gl_opening_balance/import/validate  (multipart file, 2 sheets)
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
      const dimTypesR = await req.dbPool.query(
        `SELECT type_code, slot_no FROM gl_dimension_type WHERE is_active = true ORDER BY slot_no ASC`
      );
      const activeDimTypes = dimTypesR.rows;
      const detailColumns = [...DETAIL_BASE_COLUMNS];
      for (const dt of activeDimTypes) {
        detailColumns.push({ key: `dim_${dt.type_code}`, label: dt.type_code, required: false });
      }

      const headerSheet = readSheetByName(workbook, 'header', HEADER_COLUMNS, 0);
      const detailSheet = readSheetByName(workbook, 'detail', detailColumns, 1);

      if (!headerSheet.present || headerSheet.rows.length === 0) {
        return res.status(400).json({
          message: 'ไม่พบข้อมูลใน sheet "header" (ต้องมีแถว header และข้อมูลอย่างน้อย 1 แถว)',
        });
      }
      if (!detailSheet.present) {
        return res.status(400).json({ message: 'ไม่พบ sheet "detail"' });
      }

      // ── Pre-fetch lookup tables ──────────────────────────────────────────
      const [periodsR, branchesR, currenciesR, accountsR, dimRulesR, dimValuesR, existingDocsR] = await Promise.all([
        req.dbPool.query(`SELECT id, period_start_date, period_end_date, gl_status FROM gl_posting_period`),
        req.dbPool.query(`SELECT id, branch_code FROM cd_branch WHERE is_active = true`),
        req.dbPool.query(`SELECT id, currency_code, base_rate, base_currency_flag FROM cd_currency WHERE is_active = true`),
        req.dbPool.query(`SELECT id, account_code, account_name_thai, account_name_eng, is_active, is_normal_account FROM gl_account`),
        req.dbPool.query(`SELECT account_id, type_code FROM gl_account_dim_rule WHERE is_required = true`),
        req.dbPool.query(`SELECT id, type_code, value_code FROM gl_dimension_value WHERE is_active = true`),
        req.dbPool.query(`SELECT doc_no FROM gl_entry_header`),
      ]);

      const fmtDate = (d) => {
        if (!d) return null;
        if (typeof d === 'string') return d.slice(0, 10);
        return d.toISOString().slice(0, 10);
      };
      const periods = periodsR.rows.map(p => ({
        id: p.id,
        start: fmtDate(p.period_start_date),
        end: fmtDate(p.period_end_date),
        status: p.gl_status,
      }));

      const branchMap = {};
      for (const b of branchesR.rows) branchMap[String(b.branch_code).toUpperCase()] = b.id;

      const currencyMap = {};
      for (const c of currenciesR.rows) currencyMap[String(c.currency_code).toUpperCase()] = c;

      const accountMap = {};
      for (const a of accountsR.rows) accountMap[String(a.account_code).toUpperCase()] = a;

      const dimRulesMap = {}; // account_id -> Set(type_code)
      for (const r of dimRulesR.rows) {
        if (!dimRulesMap[r.account_id]) dimRulesMap[r.account_id] = new Set();
        dimRulesMap[r.account_id].add(r.type_code);
      }

      const dimValueMap = {}; // `${type_code}|${VALUE_CODE}` -> id
      for (const v of dimValuesR.rows) {
        dimValueMap[`${v.type_code}|${String(v.value_code).toUpperCase()}`] = v.id;
      }

      const existingDocNoSet = new Set(existingDocsR.rows.map(r => String(r.doc_no).toUpperCase()));

      // ── Pass 1: header sheet ────────────────────────────────────────────
      const errors = [];
      const headerRows = [];
      const headerRefCount = {};
      for (let i = 0; i < headerSheet.rows.length; i++) {
        const row = headerSheet.rows[i];
        const ref = String(row[headerSheet.colIdx['header_ref']] ?? '').trim();
        if (ref) headerRefCount[ref] = (headerRefCount[ref] || 0) + 1;
      }

      const headerMap = {};
      for (let i = 0; i < headerSheet.rows.length; i++) {
        const row = headerSheet.rows[i];
        const rowNum = i + 2;
        const get = (key) => String(row[headerSheet.colIdx[key]] ?? '').trim();

        const ref = get('header_ref');
        const docDateRaw = row[headerSheet.colIdx['doc_date']];
        const docDateStr = parseDateCell(docDateRaw);
        const refNo = get('ref_no');
        const description = get('description');
        if (!ref && !docDateStr && !refNo && !description) continue; // skip blank row

        const rowErrors = [];

        // header_ref
        if (!ref) {
          rowErrors.push({ column: 'header_ref', message: 'จำเป็นต้องระบุเลขอ้างอิง (header_ref)' });
        } else if (headerRefCount[ref] > 1) {
          rowErrors.push({ column: 'header_ref', message: `เลขอ้างอิง "${ref}" ซ้ำกับแถวอื่นใน sheet header` });
        }

        // doc_no
        const docNoRaw = get('doc_no');
        const docNo = docNoRaw ? trunc(docNoRaw, 50) : null;
        if (docNo && existingDocNoSet.has(docNo.toUpperCase())) {
          rowErrors.push({ column: 'doc_no', message: `เลขที่เอกสาร "${docNo}" มีอยู่แล้วในระบบ` });
        }

        // doc_date -> period_id
        let periodId = null;
        if (!docDateStr) {
          rowErrors.push({ column: 'doc_date', message: 'วันที่เอกสารไม่ถูกต้องหรือไม่ได้ระบุ (รูปแบบ YYYY-MM-DD)' });
        } else {
          const period = periods.find(p => p.status === 'OPEN' && docDateStr >= p.start && docDateStr <= p.end);
          if (!period) {
            rowErrors.push({ column: 'doc_date', message: `ไม่พบงวดบัญชีที่เปิดใช้งานสำหรับวันที่ ${docDateStr}` });
          } else {
            periodId = period.id;
          }
        }

        // branch_code
        const branchCodeRaw = get('branch_code');
        let branchId = null;
        if (branchCodeRaw) {
          branchId = branchMap[branchCodeRaw.toUpperCase()];
          if (!branchId) {
            rowErrors.push({ column: 'branch_code', message: `ไม่พบรหัสสาขา "${branchCodeRaw}"` });
          }
        }

        // currency_code
        const currencyCodeRaw = get('currency_code');
        const currencyCode = (currencyCodeRaw || 'THB').toUpperCase();
        const currency = currencyMap[currencyCode];
        let currencyId = null;
        if (!currency) {
          rowErrors.push({ column: 'currency_code', message: `ไม่พบสกุลเงิน "${currencyCode}"` });
        } else {
          currencyId = currency.id;
        }

        // exchange_rate
        const exRateRaw = get('exchange_rate');
        let exchangeRate = 1;
        if (exRateRaw) {
          const parsed = parseAmount(exRateRaw);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            rowErrors.push({ column: 'exchange_rate', message: `อัตราแลกเปลี่ยน "${exRateRaw}" ไม่ถูกต้อง ต้องมากกว่า 0` });
          } else {
            exchangeRate = parsed;
          }
        } else if (currency) {
          exchangeRate = currency.base_currency_flag ? 1 : (Number(currency.base_rate) || 1);
        }

        const entry = {
          __rowNum: rowNum,
          __rowErrors: rowErrors,
          __hasDetailErrors: false,
          header_ref: ref,
          doc_no: docNo,
          doc_date: docDateStr,
          period_id: periodId,
          ref_no: trunc(refNo, 100),
          description: description || null,
          branch_id: branchId,
          branch_code: branchCodeRaw || null,
          currency_id: currencyId,
          currency_code: currencyCode,
          exchange_rate: exchangeRate,
          totalDebitFc: 0,
          totalCreditFc: 0,
          lineCount: 0,
          totalLineCount: 0,
          details: [],
        };
        headerRows.push(entry);
        if (ref && headerRefCount[ref] === 1) {
          headerMap[ref] = entry;
        }
      }

      // ── Pass 2: detail sheet ─────────────────────────────────────────────
      const detailRows = [];
      for (let i = 0; i < detailSheet.rows.length; i++) {
        const row = detailSheet.rows[i];
        const rowNum = i + 2;
        const get = (key) => String(row[detailSheet.colIdx[key]] ?? '').trim();

        const ref = get('header_ref');
        const accountCodeRaw = get('account_code');
        const debitRaw = get('debit');
        const creditRaw = get('credit');
        if (!ref && !accountCodeRaw && !debitRaw && !creditRaw) continue; // skip blank row

        const rowErrors = [];

        // header_ref
        const headerEntry = ref ? headerMap[ref] : null;
        if (!ref) {
          rowErrors.push({ column: 'header_ref', message: 'จำเป็นต้องระบุเลขอ้างอิง (header_ref)' });
        } else if (!headerEntry) {
          rowErrors.push({ column: 'header_ref', message: `ไม่พบ header_ref "${ref}" ใน sheet header` });
        }

        // account_code
        const accountCode = accountCodeRaw.toUpperCase();
        let account = null;
        if (!accountCode) {
          rowErrors.push({ column: 'account_code', message: 'จำเป็นต้องระบุรหัสบัญชี' });
        } else {
          account = accountMap[accountCode];
          if (!account) {
            rowErrors.push({ column: 'account_code', message: `ไม่พบรหัสบัญชี "${accountCode}"` });
          } else if (!account.is_active) {
            rowErrors.push({ column: 'account_code', message: `บัญชี "${accountCode}" ไม่ได้ใช้งาน (is_active=false)` });
          } else if (!account.is_normal_account) {
            rowErrors.push({ column: 'account_code', message: `บัญชี "${accountCode}" ต้องเป็นบัญชีปฏิบัติการ (หัวบัญชี)` });
          }
        }

        // debit / credit
        const debit = parseAmount(debitRaw);
        const credit = parseAmount(creditRaw);
        if (!Number.isFinite(debit) || !Number.isFinite(credit)) {
          rowErrors.push({ column: 'debit', message: 'จำนวนเงินไม่ถูกต้อง' });
        } else if (debit < 0 || credit < 0) {
          rowErrors.push({ column: 'debit', message: 'จำนวนเงินต้องไม่ติดลบ' });
        } else if (debit > 0 && credit > 0) {
          rowErrors.push({ column: 'debit', message: 'ระบุเดบิตหรือเครดิตอย่างใดอย่างหนึ่ง ไม่สามารถระบุทั้งสองค่าได้' });
        } else if (debit === 0 && credit === 0) {
          rowErrors.push({ column: 'debit', message: 'ระบุเดบิตหรือเครดิตอย่างใดอย่างหนึ่ง' });
        }

        // dimensions (dynamic, per active gl_dimension_type)
        const dims = {}; // slot_no -> dimension_value.id
        const dimLabels = {}; // type_code -> value_code (uppercased)
        for (const dt of activeDimTypes) {
          const cell = get(`dim_${dt.type_code}`);
          if (cell) {
            const dimId = dimValueMap[`${dt.type_code}|${cell.toUpperCase()}`];
            if (!dimId) {
              rowErrors.push({ column: `dim_${dt.type_code}`, message: `ไม่พบ ${dt.type_code} รหัส "${cell}"` });
            } else {
              dims[dt.slot_no] = dimId;
              dimLabels[dt.type_code] = cell.toUpperCase();
            }
          } else if (account && dimRulesMap[account.id]?.has(dt.type_code)) {
            rowErrors.push({ column: `dim_${dt.type_code}`, message: `บัญชี "${accountCode}" ต้องระบุ ${dt.type_code}` });
          }
        }

        const detailEntry = {
          __rowNum: rowNum,
          __rowErrors: rowErrors,
          header_ref: ref,
          account_id: account ? account.id : null,
          account_code: accountCode,
          account_name_thai: account ? account.account_name_thai : null,
          account_name_eng: account ? account.account_name_eng : null,
          description: trunc(get('description'), 255),
          debit_fc: debit,
          credit_fc: credit,
          dim1_id: dims[1] || null,
          dim2_id: dims[2] || null,
          dim3_id: dims[3] || null,
          dim4_id: dims[4] || null,
          dim5_id: dims[5] || null,
          dim_labels: dimLabels,
        };
        detailRows.push(detailEntry);

        if (headerEntry) {
          headerEntry.totalLineCount += 1;
          if (rowErrors.length === 0) {
            headerEntry.totalDebitFc = round2(headerEntry.totalDebitFc + debit);
            headerEntry.totalCreditFc = round2(headerEntry.totalCreditFc + credit);
            headerEntry.lineCount += 1;
            headerEntry.details.push(detailEntry);
          } else {
            headerEntry.__hasDetailErrors = true;
          }
        }
      }

      // ── Pass 3: cross-checks per header ─────────────────────────────────
      for (const ref of Object.keys(headerMap)) {
        const h = headerMap[ref];
        if (h.totalLineCount === 0) {
          h.__rowErrors.push({ column: 'header_ref', message: 'ไม่มีรายการรายละเอียด (detail)' });
        } else if (!h.__hasDetailErrors) {
          const diff = Math.abs(h.totalDebitFc - h.totalCreditFc);
          if (diff > 0.01) {
            h.__rowErrors.push({
              column: 'header_ref',
              message: `ยอดเดบิต/เครดิตไม่เท่ากัน (รวม Dr=${h.totalDebitFc.toFixed(2)} Cr=${h.totalCreditFc.toFixed(2)})`,
            });
          }
        }
      }

      // ── Build response ───────────────────────────────────────────────────
      for (const h of headerRows) {
        if (h.__rowErrors.length > 0) {
          errors.push({ sheet: 'header', row: h.__rowNum, ref: h.header_ref || '(ไม่ระบุ)', errors: h.__rowErrors });
        }
      }
      for (const d of detailRows) {
        if (d.__rowErrors.length > 0) {
          errors.push({ sheet: 'detail', row: d.__rowNum, ref: d.header_ref || '(ไม่ระบุ)', errors: d.__rowErrors });
        }
      }

      const validHeaderEntries = headerRows.filter(h => h.__rowErrors.length === 0 && !h.__hasDetailErrors && h.lineCount > 0);
      const errorHeaders = headerRows.filter(h => h.__rowErrors.length > 0 || h.__hasDetailErrors).length;

      const data = {
        headers: validHeaderEntries.map(h => ({
          header_ref: h.header_ref,
          doc_no: h.doc_no,
          doc_date: h.doc_date,
          period_id: h.period_id,
          ref_no: h.ref_no,
          description: h.description,
          branch_id: h.branch_id,
          branch_code: h.branch_code,
          currency_id: h.currency_id,
          currency_code: h.currency_code,
          exchange_rate: h.exchange_rate,
          total_debit_fc: h.totalDebitFc,
          total_credit_fc: h.totalCreditFc,
          line_count: h.lineCount,
        })),
        details: validHeaderEntries.flatMap(h => h.details.map(d => ({
          header_ref: d.header_ref,
          account_id: d.account_id,
          account_code: d.account_code,
          account_name_thai: d.account_name_thai,
          account_name_eng: d.account_name_eng,
          description: d.description,
          debit_fc: d.debit_fc,
          credit_fc: d.credit_fc,
          dim1_id: d.dim1_id,
          dim2_id: d.dim2_id,
          dim3_id: d.dim3_id,
          dim4_id: d.dim4_id,
          dim5_id: d.dim5_id,
          dim_labels: d.dim_labels,
        }))),
      };

      res.json({
        totalHeaders: headerRows.length,
        validHeaders: validHeaderEntries.length,
        errorHeaders,
        totalDetailRows: detailRows.length,
        validDetailRows: validHeaderEntries.reduce((sum, h) => sum + h.lineCount, 0),
        errors,
        data,
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
// POST /gl_opening_balance/import/confirm  (JSON body { headers: [...], details: [...] })
// ---------------------------------------------------------------------------
const confirmImport = async (req, res) => {
  const { headers, details } = req.body;
  if (!Array.isArray(headers) || headers.length === 0) {
    return res.status(400).json({ message: 'ไม่มีข้อมูลนำเข้า' });
  }
  const detailsList = Array.isArray(details) ? details : [];
  const createdBy = parseInt(req.headers.userid, 10) || null;

  const client = await req.dbPool.connect();
  let imported = 0, skipped = 0;
  const importErrors = [];
  try {
    await client.query('BEGIN');

    for (let idx = 0; idx < headers.length; idx++) {
      const h = headers[idx];
      const savepointName = `sp_h_${idx}`;
      await client.query(`SAVEPOINT ${savepointName}`);
      try {
        // Re-verify the posting period is still OPEN for this doc_date
        const periodRes = await client.query(
          `SELECT id FROM gl_posting_period
           WHERE $1::date BETWEEN period_start_date AND period_end_date
           AND gl_status = 'OPEN' LIMIT 1`,
          [h.doc_date]
        );
        if (periodRes.rows.length === 0) {
          throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${h.doc_date}`);
        }
        const periodId = periodRes.rows[0].id;

        // Resolve doc_no (auto-generate if not provided)
        let docNo = h.doc_no;
        if (!docNo) {
          docNo = await generateDocNo(client, BF_DOC_ID, h.doc_date, h.branch_id || null);
          if (!docNo) throw new Error('ไม่สามารถออกเลขที่เอกสารอัตโนมัติได้');
        }

        const myDetails = detailsList.filter(d => d.header_ref === h.header_ref);
        if (myDetails.length === 0) {
          throw new Error('ไม่มีรายการรายละเอียด (detail)');
        }

        const exchangeRate = Number(h.exchange_rate) || 1;
        let totalDebitFc = 0, totalCreditFc = 0;
        for (const d of myDetails) {
          totalDebitFc = round2(totalDebitFc + (Number(d.debit_fc) || 0));
          totalCreditFc = round2(totalCreditFc + (Number(d.credit_fc) || 0));
        }
        const totalDebitLc = round2(totalDebitFc * exchangeRate);
        const totalCreditLc = round2(totalCreditFc * exchangeRate);

        const headerRes = await client.query(
          `INSERT INTO gl_entry_header
             (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
              currency_id, exchange_rate, status,
              total_debit_fc, total_credit_fc, total_debit_lc, total_credit_lc,
              created_by, branch_id)
           VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,'Posted',$9,$10,$11,$12,$13,$14)
           RETURNING id`,
          [
            BF_DOC_ID, docNo, h.doc_date, periodId, h.ref_no || null, h.description || null,
            h.currency_id, exchangeRate,
            totalDebitFc, totalCreditFc, totalDebitLc, totalCreditLc,
            createdBy, h.branch_id || null,
          ]
        );
        const headerId = headerRes.rows[0].id;

        let lineNo = 1;
        const insertedDetails = [];
        for (const d of myDetails) {
          const debitFc = round2(Number(d.debit_fc) || 0);
          const creditFc = round2(Number(d.credit_fc) || 0);
          const debitLc = round2(debitFc * exchangeRate);
          const creditLc = round2(creditFc * exchangeRate);
          const detailRes = await client.query(
            `INSERT INTO gl_entry_detail
               (header_id, line_no, account_id, description,
                debit_fc, credit_fc, debit_lc, credit_lc,
                dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING *`,
            [
              headerId, lineNo++, d.account_id, d.description || null,
              debitFc, creditFc, debitLc, creditLc,
              d.dim1_id || null, d.dim2_id || null, d.dim3_id || null, d.dim4_id || null, d.dim5_id || null,
            ]
          );
          insertedDetails.push(detailRes.rows[0]);
        }

        await validateDimRules(client, insertedDetails);
        await updateBalanceAccum(client, headerId, false);

        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        imported++;
      } catch (rowErr) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        importErrors.push({ header_ref: h.header_ref, doc_no: h.doc_no, message: rowErr.message });
        skipped++;
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
