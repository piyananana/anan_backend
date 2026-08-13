// controllers/im/imLocationImportController.js
const XLSX = require('xlsx');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

const LOCATION_TYPES = ['GROUP', 'BIN'];
const YES_VALUES = ['y', 'yes', 'true', '1', 'ใช่'];

// ---------------------------------------------------------------------------
// Template — 1 sheet เดียว (ตำแหน่งจัดเก็บเป็น flat hierarchy ผ่าน parent_code)
// ---------------------------------------------------------------------------
const TEMPLATE_SHEETS = [
  {
    key: 'locations',
    name: 'ผังตำแหน่งจัดเก็บ',
    columns: [
      { key: 'warehouse_code', label: 'รหัสคลังสินค้า',                                          required: true,  example: 'WH01' },
      { key: 'location_code',  label: 'รหัสตำแหน่ง (ไม่ซ้ำในคลังเดียวกัน)',                       required: true,  example: 'A-01-01' },
      { key: 'parent_code',    label: 'รหัสตำแหน่งแม่ (ว่าง = ระดับบนสุด, ต้องเป็นชนิด GROUP)',    required: false, example: 'A' },
      { key: 'location_type',  label: `ชนิดตำแหน่ง (${LOCATION_TYPES.join('/')})`,                required: true,  example: 'BIN' },
      { key: 'location_name',  label: 'ชื่อตำแหน่ง',                                              required: false, example: 'ชั้น 1 แถว A ช่อง 01' },
      { key: 'category_code',  label: 'รหัสหมวดหมู่สินค้าที่ควรเก็บ (เฉพาะชนิด BIN)',             required: false, example: 'CAT01' },
      { key: 'is_active',      label: 'ใช้งาน (Y/N)',                                             required: false, example: 'Y' },
    ],
  },
];

// GET /im_location/import/template
const getTemplate = (req, res) => {
  res.json({ sheets: TEMPLATE_SHEETS });
};

// GET /im_location/import/template/download
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
  res.setHeader('Content-Disposition', 'attachment; filename="im_location_template.xlsx"');
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
const trunc = (val, max) => (val && val.length > max ? val.substring(0, max) : val) || null;
const buildCodeMap = (rows, codeField) => {
  const map = {};
  for (const row of rows) map[String(row[codeField]).toUpperCase()] = row;
  return map;
};

// ---------------------------------------------------------------------------
// POST /im_location/import/validate  (multipart file)
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
      const [sheetDef] = TEMPLATE_SHEETS;
      const sheet = readSheet(workbook, sheetDef, { required: true });
      if (!sheet.present || sheet.rows.length === 0) {
        return res.status(400).json({
          message: `ไม่พบข้อมูลใน sheet "${sheetDef.name}" (ต้องมีแถว header และข้อมูลอย่างน้อย 1 แถว)`,
        });
      }

      const [warehousesR, categoriesR, existingLocR] = await Promise.all([
        req.dbPool.query(`SELECT id, warehouse_code FROM im_warehouse WHERE is_active = true`),
        req.dbPool.query(`SELECT id, category_code FROM im_item_category WHERE is_active = true AND category_type = 'CATEGORY'`),
        req.dbPool.query(`SELECT id, warehouse_id, location_code, location_type, level FROM im_location`),
      ]);
      const warehouseMap = buildCodeMap(warehousesR.rows, 'warehouse_code');
      const categoryMap  = buildCodeMap(categoriesR.rows, 'category_code');
      const existingMap = {}; // `${warehouseId}|${CODE}` -> { id, type, level }
      for (const l of existingLocR.rows) {
        existingMap[`${l.warehouse_id}|${String(l.location_code).toUpperCase()}`] =
          { id: l.id, type: l.location_type, level: l.level };
      }

      const errors = [];
      const rowsData = [];
      const batchMap = {}; // `${WAREHOUSE_CODE}|${CODE}` -> rowData (only rows w/o basic errors)

      // ── Pass 1: per-row field validation ──────────────────────────────────
      for (let i = 0; i < sheet.rows.length; i++) {
        const row    = sheet.rows[i];
        const rowNum = sheet.rowNums[i];
        const get    = (key) => String(row[sheet.colIdx[key]] ?? '').trim();

        const warehouseCode   = get('warehouse_code').toUpperCase();
        const locationCode    = get('location_code').toUpperCase();
        const parentCode      = get('parent_code').toUpperCase();
        const locationTypeRaw = get('location_type').toUpperCase();
        const locationName    = get('location_name');
        const categoryCode    = get('category_code').toUpperCase();
        const isActiveStr     = get('is_active');

        if (!warehouseCode && !locationCode) continue;

        const rowErrors = [];
        let warehouse = null;
        if (!warehouseCode) {
          rowErrors.push({ column: 'warehouse_code', message: 'จำเป็นต้องระบุรหัสคลังสินค้า' });
        } else {
          warehouse = warehouseMap[warehouseCode];
          if (!warehouse) rowErrors.push({ column: 'warehouse_code', message: `ไม่พบคลังสินค้า "${warehouseCode}"` });
        }

        if (!locationCode) {
          rowErrors.push({ column: 'location_code', message: 'จำเป็นต้องระบุรหัสตำแหน่ง' });
        } else if (locationCode.length > 20) {
          rowErrors.push({ column: 'location_code', message: 'รหัสตำแหน่งต้องไม่เกิน 20 ตัวอักษร' });
        }

        const locationType = locationTypeRaw || 'BIN';
        if (locationTypeRaw && !LOCATION_TYPES.includes(locationTypeRaw)) {
          rowErrors.push({ column: 'location_type', message: `ชนิดตำแหน่งต้องเป็นหนึ่งใน ${LOCATION_TYPES.join(', ')}` });
        }

        let resolvedCategory = null;
        if (categoryCode) {
          if (locationType !== 'BIN') {
            rowErrors.push({ column: 'category_code', message: 'ระบุหมวดหมู่สินค้าได้เฉพาะตำแหน่งชนิด BIN เท่านั้น' });
          } else {
            resolvedCategory = categoryMap[categoryCode] || null;
            if (!resolvedCategory) rowErrors.push({ column: 'category_code', message: `ไม่พบหมวดหมู่สินค้า "${categoryCode}"` });
          }
        }

        const batchKey = (warehouseCode && locationCode) ? `${warehouseCode}|${locationCode}` : null;
        if (batchKey && batchMap[batchKey]) {
          rowErrors.push({ column: 'location_code', message: `รหัสตำแหน่ง "${locationCode}" ซ้ำกับแถวก่อนหน้าในคลังเดียวกัน` });
        } else if (warehouse && existingMap[`${warehouse.id}|${locationCode}`]) {
          rowErrors.push({ column: 'location_code', message: `รหัสตำแหน่ง "${locationCode}" มีอยู่แล้วในคลังนี้` });
        }

        if (rowErrors.length > 0) {
          errors.push({ row: rowNum, itemCode: locationCode || '-', errors: rowErrors });
          continue;
        }

        const rowData = {
          __rowNum: rowNum,
          warehouse_code: warehouseCode,
          warehouse_id: warehouse.id,
          location_code: locationCode,
          parent_code: parentCode || null,
          location_type: locationType,
          location_name: locationName || null,
          category_code: locationType === 'BIN' ? (categoryCode || null) : null,
          category_id: locationType === 'BIN' ? (resolvedCategory?.id || null) : null,
          is_active: isActiveStr ? parseBool(isActiveStr) : true,
          level: null, // null = unresolved, -1 = failed, >0 = resolved
        };
        rowsData.push(rowData);
        batchMap[batchKey] = rowData;
      }

      // ── Pass 2: resolve parent hierarchy (existing DB rows + rows within this batch) ──
      let progress = true;
      while (progress) {
        progress = false;
        for (const r of rowsData) {
          if (r.level !== null) continue;

          if (!r.parent_code) {
            r.level = 1;
            progress = true;
            continue;
          }

          const parentKey = `${r.warehouse_code}|${r.parent_code}`;
          const existingParent = existingMap[parentKey];
          if (existingParent) {
            if (existingParent.type !== 'GROUP') {
              r.__hierarchyError = `ตำแหน่งแม่ "${r.parent_code}" ไม่ใช่ชนิด GROUP`;
              r.level = -1;
            } else {
              r.level = existingParent.level + 1;
            }
            progress = true;
            continue;
          }

          const batchParent = batchMap[parentKey];
          if (batchParent && batchParent !== r && batchParent.level !== null) {
            if (batchParent.level === -1) {
              r.__hierarchyError = `ตำแหน่งแม่ "${r.parent_code}" ไม่ถูกต้อง`;
              r.level = -1;
            } else if (batchParent.location_type !== 'GROUP') {
              r.__hierarchyError = `ตำแหน่งแม่ "${r.parent_code}" ไม่ใช่ชนิด GROUP`;
              r.level = -1;
            } else {
              r.level = batchParent.level + 1;
            }
            progress = true;
          }
        }
      }

      for (const r of rowsData) {
        if (r.level === null) {
          errors.push({
            row: r.__rowNum, itemCode: r.location_code,
            errors: [{ column: 'parent_code', message: `ไม่พบตำแหน่งแม่ "${r.parent_code}" หรือมีการอ้างอิงวนซ้ำ (circular reference)` }],
          });
        } else if (r.level === -1) {
          errors.push({
            row: r.__rowNum, itemCode: r.location_code,
            errors: [{ column: 'parent_code', message: r.__hierarchyError }],
          });
        }
      }

      const validatedRows = rowsData
        .filter(r => r.level > 0)
        .map(({ __rowNum, __hierarchyError, ...rest }) => rest);

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
// POST /im_location/import/confirm  (JSON body { rows: [...] })
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

    // seed id map with existing locations in the referenced warehouses
    const warehouseIds = [...new Set(rows.map(r => r.warehouse_id).filter(Boolean))];
    const idMap = {}; // `${warehouse_id}|${CODE}` -> id
    if (warehouseIds.length > 0) {
      const existing = await client.query(
        `SELECT id, warehouse_id, location_code FROM im_location WHERE warehouse_id = ANY($1::int[])`,
        [warehouseIds]
      );
      for (const l of existing.rows) {
        idMap[`${l.warehouse_id}|${String(l.location_code).toUpperCase()}`] = l.id;
      }
    }

    // insert in level order so parents always exist before their children
    const sorted = [...rows].sort((a, b) => (a.level || 1) - (b.level || 1));

    for (let idx = 0; idx < sorted.length; idx++) {
      const r = sorted[idx];
      const savepointName = `sp_row_${idx}`;
      await client.query(`SAVEPOINT ${savepointName}`);
      try {
        const locationCode = String(r.location_code || '').toUpperCase();
        const key = `${r.warehouse_id}|${locationCode}`;

        if (idMap[key]) {
          skipped++;
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
          continue;
        }

        let parentId = null;
        if (r.parent_code) {
          parentId = idMap[`${r.warehouse_id}|${String(r.parent_code).toUpperCase()}`] ?? null;
          if (!parentId) {
            importErrors.push({ item_code: locationCode, message: `ไม่พบตำแหน่งแม่ "${r.parent_code}"` });
            await client.query(`RELEASE SAVEPOINT ${savepointName}`);
            continue;
          }
        }

        const result = await client.query(
          `INSERT INTO im_location
             (warehouse_id, location_code, location_name, parent_id, level, location_type, category_id, is_active,
              created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
           RETURNING id`,
          [
            r.warehouse_id, trunc(locationCode, 20), trunc(r.location_name, 200),
            parentId, r.level || 1, r.location_type || 'BIN', r.category_id || null,
            r.is_active !== undefined ? r.is_active : true,
            userName,
          ]
        );

        idMap[key] = result.rows[0].id;
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        imported++;
      } catch (rowErr) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        importErrors.push({ item_code: r.location_code, message: rowErr.message });
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
