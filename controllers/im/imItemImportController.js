// controllers/im/imItemImportController.js
const XLSX = require('xlsx');
const multer = require('multer');
const { generateNextCode } = require('./imItemRunningController');
const { generateNextCodeForCategory } = require('./imItemCategoryController');
const imUomConversion = require('./imUomConversionController');
const imItemWarehouse = require('./imItemWarehouseController');

const upload = multer({ storage: multer.memoryStorage() });

const ITEM_TYPES = ['STOCK', 'SERVICE', 'NON_STOCK'];
const COSTING_METHODS = ['FIFO', 'AVG', 'STANDARD'];
const YES_VALUES = ['y', 'yes', 'true', '1', 'ใช่'];

// ---------------------------------------------------------------------------
// Template sheet definitions — 1 sheet ต่อหัวข้อใน im_item_detail_widget
// ทุก sheet (ยกเว้น "ข้อมูลพื้นฐาน") ใช้ old_item_code เป็นคอลัมน์แรกเพื่อเชื่อม
// ข้อมูลกับสินค้าใน sheet "ข้อมูลพื้นฐาน"
// ---------------------------------------------------------------------------
const TEMPLATE_SHEETS = [
  {
    key: 'general',
    name: 'ข้อมูลพื้นฐาน',
    columns: [
      { key: 'old_item_code',       label: 'รหัสสินค้าเก่า — ใช้เชื่อมข้อมูลกับ sheet อื่น', required: true,  example: 'IA0001' },
      { key: 'item_name_th',        label: 'ชื่อสินค้า (ไทย)',                              required: true,  example: 'สินค้าตัวอย่าง' },
      { key: 'item_code',           label: 'รหัสสินค้า (ว่างได้ถ้าอัตโนมัติ)',              required: false, example: 'I001' },
      { key: 'category_code',       label: 'รหัสหมวดหมู่สินค้า',                            required: false, example: 'CAT01' },
      { key: 'item_name_en',        label: 'ชื่อสินค้า (อังกฤษ)',                           required: false, example: 'Sample Item' },
      { key: 'barcode',             label: 'บาร์โค้ด',                                      required: false, example: '' },
      { key: 'description',         label: 'คำอธิบาย',                                      required: false, example: '' },
      { key: 'item_type',           label: `ประเภทสินค้า (${ITEM_TYPES.join('/')})`,        required: false, example: 'STOCK' },
      { key: 'base_uom_code',       label: 'รหัสหน่วยนับหลัก',                              required: false, example: 'PCS' },
      { key: 'costing_method',      label: `วิธีคำนวณต้นทุน (${COSTING_METHODS.join('/')})`, required: false, example: 'AVG' },
      { key: 'standard_cost',       label: 'ต้นทุนมาตรฐาน',                                 required: false, example: '0' },
      { key: 'is_purchase_item',    label: 'ซื้อได้ (Y/N)',                                 required: false, example: 'Y' },
      { key: 'is_sales_item',       label: 'ขายได้ (Y/N)',                                  required: false, example: 'Y' },
      { key: 'is_manufactured',     label: 'ผลิตได้ (Y/N)',                                 required: false, example: 'N' },
      { key: 'is_lot_tracked',      label: 'ติดตาม Lot (Y/N)',                              required: false, example: 'N' },
      { key: 'is_serial_tracked',   label: 'ติดตาม Serial (Y/N)',                           required: false, example: 'N' },
      { key: 'shelf_life_days',     label: 'อายุสินค้า (วัน)',                              required: false, example: '' },
      { key: 'default_warehouse_code', label: 'รหัสคลังสินค้าตั้งต้น',                       required: false, example: 'WH01' },
      { key: 'min_stock_qty',       label: 'สต็อกขั้นต่ำ',                                  required: false, example: '0' },
      { key: 'max_stock_qty',       label: 'สต็อกสูงสุด',                                   required: false, example: '0' },
      { key: 'reorder_point',       label: 'จุดสั่งซื้อ',                                    required: false, example: '0' },
      { key: 'default_vat_type',    label: 'ประเภทภาษี VAT ตั้งต้น',                        required: false, example: 'VAT7' },
      { key: 'is_active',           label: 'ใช้งาน (Y/N)',                                  required: false, example: 'Y' },
    ],
  },
  {
    key: 'uom_conversions',
    name: 'หน่วยนับทางเลือก',
    columns: [
      { key: 'old_item_code',        label: 'รหัสสินค้าเก่า — เชื่อมกับ sheet ข้อมูลพื้นฐาน', required: true,  example: 'IA0001' },
      { key: 'uom_code',              label: 'รหัสหน่วยนับ',                                   required: true,  example: 'BOX' },
      { key: 'conversion_factor',     label: 'อัตราแปลง (เทียบหน่วยหลัก)',                     required: false, example: '12' },
      { key: 'barcode',               label: 'บาร์โค้ดของหน่วยนี้',                            required: false, example: '' },
      { key: 'is_purchase_default',   label: 'หน่วยซื้อตั้งต้น (Y/N)',                        required: false, example: 'N' },
      { key: 'is_sales_default',      label: 'หน่วยขายตั้งต้น (Y/N)',                         required: false, example: 'N' },
    ],
  },
  {
    key: 'item_warehouses',
    name: 'คลังสินค้า',
    columns: [
      { key: 'old_item_code',   label: 'รหัสสินค้าเก่า — เชื่อมกับ sheet ข้อมูลพื้นฐาน', required: true,  example: 'IA0001' },
      { key: 'warehouse_code',  label: 'รหัสคลังสินค้า',                                  required: true,  example: 'WH01' },
      { key: 'min_stock_qty',   label: 'สต็อกขั้นต่ำ (เฉพาะคลังนี้)',                    required: false, example: '0' },
      { key: 'max_stock_qty',   label: 'สต็อกสูงสุด (เฉพาะคลังนี้)',                     required: false, example: '0' },
      { key: 'reorder_point',   label: 'จุดสั่งซื้อ (เฉพาะคลังนี้)',                      required: false, example: '0' },
      { key: 'location_code',   label: 'รหัสตำแหน่งจัดเก็บตั้งต้น (ในคลังนี้)',           required: false, example: '' },
    ],
  },
  {
    key: 'gl_accounts',
    name: 'บัญชี GL',
    columns: [
      { key: 'old_item_code',          label: 'รหัสสินค้าเก่า — เชื่อมกับ sheet ข้อมูลพื้นฐาน', required: true,  example: 'IA0001' },
      { key: 'inventory_account_code', label: 'รหัสบัญชีสินค้าคงเหลือ',                          required: false, example: '1510' },
      { key: 'cogs_account_code',      label: 'รหัสบัญชีต้นทุนขาย',                              required: false, example: '5010' },
      { key: 'revenue_account_code',   label: 'รหัสบัญชีรายได้',                                 required: false, example: '4010' },
      { key: 'expense_account_code',   label: 'รหัสบัญชีค่าใช้จ่าย',                             required: false, example: '5510' },
    ],
  },
];

// GET /im_item/import/template
const getTemplate = (req, res) => {
  res.json({ sheets: TEMPLATE_SHEETS });
};

// GET /im_item/import/template/download
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
  res.setHeader('Content-Disposition', 'attachment; filename="im_item_template.xlsx"');
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
const trunc = (val, max) => (val && val.length > max ? val.substring(0, max) : val) || null;
const buildCodeMap = (rows, codeField) => {
  const map = {};
  for (const row of rows) map[String(row[codeField]).toUpperCase()] = row;
  return map;
};

// ---------------------------------------------------------------------------
// POST /im_item/import/validate  (multipart file)
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
      const [generalDef, uomConvDef, itemWhDef, glAccountDef] = TEMPLATE_SHEETS;

      const general = readSheet(workbook, generalDef, { required: true });
      if (!general.present || general.rows.length === 0) {
        return res.status(400).json({
          message: `ไม่พบข้อมูลใน sheet "${generalDef.name}" (ต้องมีแถว header และข้อมูลอย่างน้อย 1 แถว)`,
        });
      }
      const uomConversions = readSheet(workbook, uomConvDef);
      const itemWarehouses = readSheet(workbook, itemWhDef);
      const glAccounts     = readSheet(workbook, glAccountDef);

      // Pre-fetch lookup tables
      const [categoriesR, uomsR, warehousesR, locationsR, accountsR, runningR] = await Promise.all([
        req.dbPool.query(`SELECT id, category_code, is_auto_number FROM im_item_category WHERE is_active = true AND category_type = 'CATEGORY'`),
        req.dbPool.query(`SELECT id, uom_code FROM im_uom WHERE is_active = true`),
        req.dbPool.query(`SELECT id, warehouse_code FROM im_warehouse WHERE is_active = true`),
        req.dbPool.query(`SELECT id, warehouse_id, location_code FROM im_location WHERE is_active = true`),
        req.dbPool.query(`SELECT id, account_code FROM gl_account WHERE is_active = true`),
        req.dbPool.query(`SELECT is_auto_numbering FROM im_item_running LIMIT 1`),
      ]);
      const categoryMap  = buildCodeMap(categoriesR.rows, 'category_code');
      const uomMap        = buildCodeMap(uomsR.rows, 'uom_code');
      const warehouseMap  = buildCodeMap(warehousesR.rows, 'warehouse_code');
      const accountMap    = buildCodeMap(accountsR.rows, 'account_code');
      const locationMap   = {};
      for (const l of locationsR.rows) {
        locationMap[`${l.warehouse_id}|${String(l.location_code).toUpperCase()}`] = l;
      }
      const globalAutoNumber = runningR.rows.length > 0 && runningR.rows[0].is_auto_numbering;

      const errors = [];
      const items  = new Map();
      const order  = [];

      // ── Sheet 1: ข้อมูลพื้นฐาน ────────────────────────────────────────────
      for (let i = 0; i < general.rows.length; i++) {
        const row    = general.rows[i];
        const rowNum = general.rowNums[i];
        const get    = (key) => String(row[general.colIdx[key]] ?? '').trim();

        const oldCode  = get('old_item_code');
        const nameTh   = get('item_name_th');
        const itemCode = get('item_code');
        const categoryCode = get('category_code').toUpperCase();
        if (!oldCode && !nameTh && !itemCode && !categoryCode) continue;

        const rowErrors = [];

        if (!oldCode) {
          rowErrors.push({ column: 'old_item_code', message: 'จำเป็นต้องระบุรหัสสินค้าเก่า (ใช้เป็นตัวเชื่อมข้อมูลกับ sheet อื่น)' });
          errors.push({ row: rowNum, itemCode: itemCode || '(อัตโนมัติ)', errors: rowErrors });
          continue;
        }
        if (items.has(oldCode)) {
          rowErrors.push({ column: 'old_item_code', message: `รหัสสินค้าเก่า "${oldCode}" ซ้ำกับแถวก่อนหน้าใน sheet "${generalDef.name}"` });
          errors.push({ row: rowNum, itemCode: itemCode || '(อัตโนมัติ)', errors: rowErrors });
          continue;
        }
        if (!nameTh) {
          rowErrors.push({ column: 'item_name_th', message: 'จำเป็นต้องระบุชื่อสินค้า (ไทย)' });
        }

        let resolvedCategory = null;
        if (categoryCode) {
          resolvedCategory = categoryMap[categoryCode] || null;
          if (!resolvedCategory) rowErrors.push({ column: 'category_code', message: `ไม่พบหมวดหมู่สินค้า "${categoryCode}"` });
        }

        if (!itemCode) {
          const categoryAuto = resolvedCategory?.is_auto_number ?? false;
          if (!categoryAuto && !globalAutoNumber) {
            rowErrors.push({ column: 'item_code', message: 'จำเป็นต้องระบุรหัสสินค้า (หมวดหมู่และระบบไม่ได้เปิดรหัสอัตโนมัติ)' });
          }
        } else if (itemCode.length > 30) {
          rowErrors.push({ column: 'item_code', message: 'รหัสสินค้าต้องไม่เกิน 30 ตัวอักษร' });
        }

        const itemTypeRaw = get('item_type').toUpperCase();
        const itemType = itemTypeRaw || 'STOCK';
        if (itemTypeRaw && !ITEM_TYPES.includes(itemTypeRaw)) {
          rowErrors.push({ column: 'item_type', message: `ประเภทสินค้าต้องเป็นหนึ่งใน ${ITEM_TYPES.join(', ')}` });
        }

        const costingMethodRaw = get('costing_method').toUpperCase();
        const costingMethod = costingMethodRaw || 'AVG';
        if (costingMethodRaw && !COSTING_METHODS.includes(costingMethodRaw)) {
          rowErrors.push({ column: 'costing_method', message: `วิธีคำนวณต้นทุนต้องเป็นหนึ่งใน ${COSTING_METHODS.join(', ')}` });
        }

        const baseUomCode = get('base_uom_code').toUpperCase();
        let resolvedBaseUom = null;
        if (baseUomCode) {
          resolvedBaseUom = uomMap[baseUomCode] || null;
          if (!resolvedBaseUom) rowErrors.push({ column: 'base_uom_code', message: `ไม่พบหน่วยนับ "${baseUomCode}"` });
        }

        const defaultWarehouseCode = get('default_warehouse_code').toUpperCase();
        let resolvedDefaultWarehouse = null;
        if (defaultWarehouseCode) {
          resolvedDefaultWarehouse = warehouseMap[defaultWarehouseCode] || null;
          if (!resolvedDefaultWarehouse) rowErrors.push({ column: 'default_warehouse_code', message: `ไม่พบคลังสินค้า "${defaultWarehouseCode}"` });
        }

        const numField = (key, label, defaultVal) => {
          const str = get(key);
          if (!str) return defaultVal;
          const n = Number(str);
          if (isNaN(n) || n < 0) {
            rowErrors.push({ column: key, message: `${label} ต้องเป็นตัวเลขไม่ติดลบ` });
            return defaultVal;
          }
          return n;
        };
        const standardCost  = numField('standard_cost', 'ต้นทุนมาตรฐาน', 0);
        const minStockQty   = numField('min_stock_qty', 'สต็อกขั้นต่ำ', 0);
        const maxStockQty   = numField('max_stock_qty', 'สต็อกสูงสุด', 0);
        const reorderPoint  = numField('reorder_point', 'จุดสั่งซื้อ', 0);
        const shelfLifeStr  = get('shelf_life_days');
        let shelfLifeDays = null;
        if (shelfLifeStr) {
          const n = parseInt(shelfLifeStr, 10);
          if (isNaN(n) || n < 0) rowErrors.push({ column: 'shelf_life_days', message: 'อายุสินค้าต้องเป็นตัวเลขไม่ติดลบ' });
          else shelfLifeDays = n;
        }

        const isActiveStr = get('is_active');

        const item = {
          __rowNum: rowNum,
          __rowErrors: rowErrors,
          item_code:              itemCode ? itemCode.toUpperCase() : null,
          category_code:          categoryCode || null,
          category_id:            resolvedCategory?.id || null,
          old_item_code:          oldCode || null,
          item_name_th:           nameTh,
          item_name_en:           get('item_name_en') || null,
          barcode:                get('barcode') || null,
          description:            get('description') || null,
          item_type:              itemType,
          base_uom_code:          baseUomCode || null,
          base_uom_id:            resolvedBaseUom?.id || null,
          costing_method:         costingMethod,
          standard_cost:          standardCost,
          shelf_life_days:        shelfLifeDays,
          default_warehouse_code: defaultWarehouseCode || null,
          default_warehouse_id:   resolvedDefaultWarehouse?.id || null,
          min_stock_qty:          minStockQty,
          max_stock_qty:          maxStockQty,
          reorder_point:          reorderPoint,
          default_vat_type:       get('default_vat_type') || 'VAT7',
          is_active:              isActiveStr ? parseBool(isActiveStr) : true,
          inventory_account_code: null, inventory_account_id: null,
          cogs_account_code:      null, cogs_account_id:      null,
          revenue_account_code:   null, revenue_account_id:   null,
          expense_account_code:   null, expense_account_id:   null,
          uom_conversions:        [],
          item_warehouses:        [],
        };
        item.is_purchase_item  = get('is_purchase_item')  ? parseBool(get('is_purchase_item'))  : true;
        item.is_sales_item     = get('is_sales_item')     ? parseBool(get('is_sales_item'))     : true;
        item.is_manufactured   = parseBool(get('is_manufactured'));
        item.is_lot_tracked    = parseBool(get('is_lot_tracked'));
        item.is_serial_tracked = parseBool(get('is_serial_tracked'));

        items.set(oldCode, item);
        order.push(oldCode);
      }

      // helper: หา item จากรหัสเก่า ถ้าไม่พบให้บันทึก standalone error
      const findItem = (sheetDef, row, colIdx, rowNum) => {
        const oldItemCode = String(row[colIdx['old_item_code']] ?? '').trim();
        if (!oldItemCode) return null;
        const item = items.get(oldItemCode);
        if (!item) {
          errors.push({
            row: rowNum,
            itemCode: oldItemCode,
            errors: [{ column: sheetDef.name, message: `ไม่พบรหัสสินค้าเก่า "${oldItemCode}" ใน sheet "${generalDef.name}"` }],
          });
          return null;
        }
        return { item, oldItemCode };
      };

      // ── Sheet 2: หน่วยนับทางเลือก ────────────────────────────────────────
      for (let i = 0; i < uomConversions.rows.length; i++) {
        const row    = uomConversions.rows[i];
        const rowNum = uomConversions.rowNums[i];
        const found  = findItem(uomConvDef, row, uomConversions.colIdx, rowNum);
        if (!found) continue;
        const { item } = found;
        const get = (key) => String(row[uomConversions.colIdx[key]] ?? '').trim();

        const uomCode = get('uom_code').toUpperCase();
        if (!uomCode) {
          item.__rowErrors.push({ column: `${uomConvDef.name}: uom_code`, message: 'จำเป็นต้องระบุรหัสหน่วยนับ' });
          continue;
        }
        const uom = uomMap[uomCode];
        if (!uom) {
          item.__rowErrors.push({ column: `${uomConvDef.name}: uom_code`, message: `ไม่พบหน่วยนับ "${uomCode}"` });
          continue;
        }

        let conversionFactor = 1;
        const factorStr = get('conversion_factor');
        if (factorStr) {
          const n = Number(factorStr);
          if (isNaN(n) || n <= 0) {
            item.__rowErrors.push({ column: `${uomConvDef.name}: conversion_factor`, message: 'อัตราแปลงต้องเป็นตัวเลขมากกว่า 0' });
          } else {
            conversionFactor = n;
          }
        }

        item.uom_conversions.push({
          uom_id:               uom.id,
          conversion_factor:    conversionFactor,
          barcode:               get('barcode') || null,
          is_purchase_default:   parseBool(get('is_purchase_default')),
          is_sales_default:      parseBool(get('is_sales_default')),
        });
      }

      // ── Sheet 3: คลังสินค้า ──────────────────────────────────────────────
      for (let i = 0; i < itemWarehouses.rows.length; i++) {
        const row    = itemWarehouses.rows[i];
        const rowNum = itemWarehouses.rowNums[i];
        const found  = findItem(itemWhDef, row, itemWarehouses.colIdx, rowNum);
        if (!found) continue;
        const { item } = found;
        const get = (key) => String(row[itemWarehouses.colIdx[key]] ?? '').trim();

        const warehouseCode = get('warehouse_code').toUpperCase();
        if (!warehouseCode) {
          item.__rowErrors.push({ column: `${itemWhDef.name}: warehouse_code`, message: 'จำเป็นต้องระบุรหัสคลังสินค้า' });
          continue;
        }
        const warehouse = warehouseMap[warehouseCode];
        if (!warehouse) {
          item.__rowErrors.push({ column: `${itemWhDef.name}: warehouse_code`, message: `ไม่พบคลังสินค้า "${warehouseCode}"` });
          continue;
        }

        const numField = (key, label) => {
          const str = get(key);
          if (!str) return 0;
          const n = Number(str);
          if (isNaN(n) || n < 0) {
            item.__rowErrors.push({ column: `${itemWhDef.name}: ${key}`, message: `${label} ต้องเป็นตัวเลขไม่ติดลบ` });
            return 0;
          }
          return n;
        };

        let defaultLocationId = null;
        const locationCode = get('location_code').toUpperCase();
        if (locationCode) {
          const loc = locationMap[`${warehouse.id}|${locationCode}`];
          if (!loc) {
            item.__rowErrors.push({ column: `${itemWhDef.name}: location_code`, message: `ไม่พบรหัสตำแหน่ง "${locationCode}" ในคลัง "${warehouseCode}"` });
          } else {
            defaultLocationId = loc.id;
          }
        }

        item.item_warehouses.push({
          warehouse_id:        warehouse.id,
          min_stock_qty:       numField('min_stock_qty', 'สต็อกขั้นต่ำ'),
          max_stock_qty:       numField('max_stock_qty', 'สต็อกสูงสุด'),
          reorder_point:       numField('reorder_point', 'จุดสั่งซื้อ'),
          default_location_id: defaultLocationId,
        });
      }

      // ── Sheet 4: บัญชี GL ────────────────────────────────────────────────
      for (let i = 0; i < glAccounts.rows.length; i++) {
        const row    = glAccounts.rows[i];
        const rowNum = glAccounts.rowNums[i];
        const found  = findItem(glAccountDef, row, glAccounts.colIdx, rowNum);
        if (!found) continue;
        const { item } = found;
        const get = (key) => String(row[glAccounts.colIdx[key]] ?? '').trim();

        const resolveAccount = (key, targetCodeField, targetIdField) => {
          const code = get(key).toUpperCase();
          if (!code) return;
          const acc = accountMap[code];
          if (!acc) {
            item.__rowErrors.push({ column: `${glAccountDef.name}: ${key}`, message: `ไม่พบรหัสบัญชี "${code}"` });
          } else {
            item[targetCodeField] = code;
            item[targetIdField]   = acc.id;
          }
        };
        resolveAccount('inventory_account_code', 'inventory_account_code', 'inventory_account_id');
        resolveAccount('cogs_account_code',      'cogs_account_code',      'cogs_account_id');
        resolveAccount('revenue_account_code',   'revenue_account_code',   'revenue_account_id');
        resolveAccount('expense_account_code',   'expense_account_code',   'expense_account_id');
      }

      // ── สรุปผล ────────────────────────────────────────────────────────────
      const validatedRows = [];
      for (const code of order) {
        const item = items.get(code);
        if (item.__rowErrors.length > 0) {
          errors.push({ row: item.__rowNum, itemCode: item.old_item_code || item.item_code || '(อัตโนมัติ)', errors: item.__rowErrors });
        } else {
          delete item.__rowNum;
          delete item.__rowErrors;
          validatedRows.push(item);
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
// POST /im_item/import/confirm  (JSON body { rows: [...] })
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
    await client.query(`ALTER TABLE im_item ADD COLUMN IF NOT EXISTS is_code_auto_generated BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx];
      const savepointName = `sp_row_${idx}`;
      await client.query(`SAVEPOINT ${savepointName}`);
      try {
        // resolve รหัสสินค้า: ถ้าว่าง → ลองหมวดหมู่ → ลอง global
        const codeWasProvided = !!r.item_code;
        let finalCode = codeWasProvided ? r.item_code : null;
        if (!finalCode) {
          if (r.category_id) {
            finalCode = await generateNextCodeForCategory(client, r.category_id);
          }
          if (!finalCode) {
            finalCode = await generateNextCode(client);
          }
          if (!finalCode) {
            importErrors.push({ item_code: r.item_name_th, message: 'ไม่มีรหัสอัตโนมัติ — กรุณาระบุรหัสสินค้า' });
            await client.query(`RELEASE SAVEPOINT ${savepointName}`);
            continue;
          }
        }
        const isCodeAutoGenerated = !codeWasProvided;

        const result = await client.query(
          `INSERT INTO im_item
             (item_code, old_item_code, barcode, item_name_th, item_name_en, description, category_id,
              item_type, base_uom_id, costing_method, standard_cost,
              is_purchase_item, is_sales_item, is_manufactured, is_lot_tracked, is_serial_tracked,
              shelf_life_days, default_warehouse_id,
              min_stock_qty, max_stock_qty, reorder_point, default_vat_type,
              inventory_account_id, cogs_account_id, revenue_account_id, expense_account_id,
              is_active, is_code_auto_generated, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$29)
           ON CONFLICT (item_code) DO NOTHING
           RETURNING id`,
          [
            trunc(finalCode, 30), trunc(r.old_item_code, 30),
            trunc(r.barcode, 50), trunc(r.item_name_th, 200), trunc(r.item_name_en, 200), r.description || null,
            r.category_id || null,
            r.item_type || 'STOCK', r.base_uom_id || null, r.costing_method || 'AVG', r.standard_cost ?? 0,
            r.is_purchase_item ?? true, r.is_sales_item ?? true, r.is_manufactured ?? false,
            r.is_lot_tracked ?? false, r.is_serial_tracked ?? false,
            r.shelf_life_days || null, r.default_warehouse_id || null,
            r.min_stock_qty ?? 0, r.max_stock_qty ?? 0, r.reorder_point ?? 0, trunc(r.default_vat_type, 10) || 'VAT7',
            r.inventory_account_id || null, r.cogs_account_id || null, r.revenue_account_id || null, r.expense_account_id || null,
            r.is_active !== undefined ? r.is_active : true,
            isCodeAutoGenerated,
            userName,
          ]
        );

        if (result.rows.length === 0) {
          skipped++;
          await client.query(`RELEASE SAVEPOINT ${savepointName}`);
          continue;
        }

        const newId = result.rows[0].id;
        await imUomConversion.replaceForItem(client, newId, r.uom_conversions);
        await imItemWarehouse.replaceForItem(client, newId, r.item_warehouses);

        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        imported++;
      } catch (rowErr) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await client.query(`RELEASE SAVEPOINT ${savepointName}`);
        importErrors.push({ item_code: r.item_code || r.item_name_th, message: rowErr.message });
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
