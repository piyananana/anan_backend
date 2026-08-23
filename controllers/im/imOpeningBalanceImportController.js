// controllers/im/imOpeningBalanceImportController.js
// ตั้งยอดคงเหลือ+มูลค่าสินค้าเริ่มต้น (ตอน go-live) — เขียนตรงลง im_stock_balance/im_stock_layer
// เหมือน ar_customer_balance_import / ap_vendor_balance_import: ไม่ผ่าน GL, ไม่ผ่าน im_transaction/AJS,
// ไม่มี guard กันตั้งยอดซ้ำ (ผู้ใช้รับผิดชอบเอง เหมือนกัน AR/AP)
'use strict';

const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const { ensureImStockBalanceTable } = require('./imStockBalanceController');
const { ensureImStockLayerTable } = require('./imStockLayerController');
const { STOCK_BALANCE_KEY, upsertStockBalance, recomputeBalanceFromLayers } = require('./imTransactionController');

const ensureImOpeningBalanceBatchTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_opening_balance_batch (
            id          SERIAL PRIMARY KEY,
            import_date DATE NOT NULL,
            description TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by  VARCHAR(100)
        )
    `);
};

// ---------------------------------------------------------------------------
// Template — 1 sheet เดียว
// ---------------------------------------------------------------------------
const TEMPLATE_SHEETS = [
    {
        key: 'opening_balance',
        name: 'ยอดคงเหลือเริ่มต้น',
        columns: [
            { key: 'old_item_code',  label: 'รหัสสินค้าเก่า (รหัสจากระบบเดิม — ใช้ตอนตั้งยอดครั้งแรกเท่านั้น)', required: true,  example: 'OLD-ITEM001' },
            { key: 'warehouse_code', label: 'รหัสคลังสินค้า',                                     required: true,  example: 'WH01' },
            { key: 'location_code',  label: 'รหัสตำแหน่งจัดเก็บ (ไม่บังคับ)',                     required: false, example: 'A-01-01' },
            { key: 'lot_no',         label: 'เลขที่ล็อต (บังคับถ้าสินค้าติดตามล็อต)',              required: false, example: 'LOT202601' },
            { key: 'serial_no',      label: 'Serial No. (บังคับถ้า costing เป็น SPECIFIC)',        required: false, example: 'SN00001' },
            { key: 'qty',            label: 'จำนวน',                                              required: true,  example: '100' },
            { key: 'unit_cost',      label: 'ต้นทุนต่อหน่วย (บังคับ ยกเว้น costing=STANDARD)',     required: false, example: '25.50' },
        ],
    },
];

// GET /im_opening_balance/import/template
const getTemplate = (req, res) => {
    res.json({ sheets: TEMPLATE_SHEETS });
};

// GET /im_opening_balance/import/template/download
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
    res.setHeader('Content-Disposition', 'attachment; filename="im_opening_balance_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
};

// ---------------------------------------------------------------------------
// Helpers (duplicated per-controller — same convention as imLocationImportController.js)
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

const buildCodeMap = (rows, codeField) => {
    const map = {};
    for (const row of rows) map[String(row[codeField]).toUpperCase()] = row;
    return map;
};

// old_item_code ไม่ใช่ unique column (ไม่มี UNIQUE constraint บน im_item) — ต่างจาก item_code/warehouse_code
// ที่ unique จริง จึงต้อง group เป็น array แล้วให้ผู้เรียกตัดสินว่ากรณี "เจอมากกว่า 1" ควรทำอย่างไร
const buildGroupedCodeMap = (rows, codeField) => {
    const map = {};
    for (const row of rows) {
        const key = String(row[codeField]).toUpperCase();
        (map[key] ||= []).push(row);
    }
    return map;
};

// ---------------------------------------------------------------------------
// POST /im_opening_balance/import/validate  (multipart file) — dry run, ไม่เขียนข้อมูล
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

            const [itemsR, warehousesR, locationsR, openSerialsR] = await Promise.all([
                req.dbPool.query(`SELECT id, item_code, old_item_code, costing_method, is_lot_tracked, standard_cost, is_active FROM im_item WHERE old_item_code IS NOT NULL AND old_item_code != ''`),
                req.dbPool.query(`SELECT id, warehouse_code FROM im_warehouse WHERE is_active = true`),
                req.dbPool.query(`SELECT id, warehouse_id, location_code FROM im_location`),
                req.dbPool.query(`SELECT item_id, serial_no FROM im_stock_layer WHERE serial_no IS NOT NULL AND remaining_qty > 0`),
            ]);
            // old_item_code ไม่ unique — group เป็น array แล้วเช็คความกำกวมต่อแถวด้านล่าง
            const itemMap = buildGroupedCodeMap(itemsR.rows, 'old_item_code');
            const warehouseMap = buildCodeMap(warehousesR.rows, 'warehouse_code');
            const locationMap = {};
            for (const l of locationsR.rows) locationMap[`${l.warehouse_id}|${String(l.location_code).toUpperCase()}`] = l;
            const existingOpenSerials = new Set(openSerialsR.rows.map(r => `${r.item_id}|${r.serial_no}`));

            const errors = [];
            const validatedRows = [];
            const seenSerials = new Set();

            for (let i = 0; i < sheet.rows.length; i++) {
                const row = sheet.rows[i];
                const rowNum = sheet.rowNums[i];
                const get = (key) => String(row[sheet.colIdx[key]] ?? '').trim();

                const oldItemCode = get('old_item_code').toUpperCase();
                const warehouseCode = get('warehouse_code').toUpperCase();
                const locationCode = get('location_code').toUpperCase();
                const lotNo = get('lot_no');
                const serialNo = get('serial_no');
                const qtyStr = get('qty');
                const unitCostStr = get('unit_cost');

                if (!oldItemCode && !warehouseCode) continue;

                const rowErrors = [];

                const itemMatches = itemMap[oldItemCode] || [];
                let item = null;
                if (!oldItemCode) {
                    rowErrors.push({ column: 'old_item_code', message: 'จำเป็นต้องระบุรหัสสินค้าเก่า' });
                } else if (itemMatches.length === 0) {
                    rowErrors.push({ column: 'old_item_code', message: `ไม่พบสินค้าที่มีรหัสสินค้าเก่า "${oldItemCode}"` });
                } else if (itemMatches.length > 1) {
                    rowErrors.push({
                        column: 'old_item_code',
                        message: `รหัสสินค้าเก่า "${oldItemCode}" ซ้ำกัน ${itemMatches.length} รายการในระบบ (${itemMatches.map(m => m.item_code).join(', ')}) — กรุณาแก้ไขรหัสสินค้าเก่าให้ไม่ซ้ำกันก่อน`,
                    });
                } else {
                    item = itemMatches[0];
                    if (!item.is_active) rowErrors.push({ column: 'old_item_code', message: `สินค้า "${item.item_code}" (รหัสเก่า "${oldItemCode}") ถูกปิดใช้งาน` });
                }

                const warehouse = warehouseMap[warehouseCode];
                if (!warehouseCode) rowErrors.push({ column: 'warehouse_code', message: 'จำเป็นต้องระบุรหัสคลังสินค้า' });
                else if (!warehouse) rowErrors.push({ column: 'warehouse_code', message: `ไม่พบคลังสินค้า "${warehouseCode}"` });

                let location = null;
                if (locationCode && warehouse) {
                    location = locationMap[`${warehouse.id}|${locationCode}`];
                    if (!location) rowErrors.push({ column: 'location_code', message: `ไม่พบตำแหน่ง "${locationCode}" ในคลังนี้` });
                }

                const qty = Number(qtyStr);
                if (!qtyStr || Number.isNaN(qty) || qty <= 0) rowErrors.push({ column: 'qty', message: 'จำนวนต้องเป็นตัวเลขมากกว่า 0' });

                let unitCost = unitCostStr ? Number(unitCostStr) : null;
                if (item && item.costing_method === 'STANDARD') {
                    unitCost = Number(item.standard_cost) || 0;
                } else if (!unitCostStr || Number.isNaN(unitCost) || unitCost < 0) {
                    rowErrors.push({ column: 'unit_cost', message: 'ต้นทุนต่อหน่วยต้องเป็นตัวเลข (บังคับ ยกเว้นสินค้า costing แบบ STANDARD)' });
                }

                if (item && item.is_lot_tracked && !lotNo) {
                    rowErrors.push({ column: 'lot_no', message: 'สินค้านี้ติดตามล็อต ต้องระบุเลขที่ล็อต' });
                }
                if (item && item.costing_method === 'SPECIFIC') {
                    if (!serialNo) {
                        rowErrors.push({ column: 'serial_no', message: 'สินค้านี้ใช้ costing แบบ SPECIFIC ต้องระบุ Serial No.' });
                    } else {
                        const serialKey = `${item.id}|${serialNo}`;
                        if (seenSerials.has(serialKey)) {
                            rowErrors.push({ column: 'serial_no', message: `Serial "${serialNo}" ซ้ำกับแถวก่อนหน้าในไฟล์นี้` });
                        } else if (existingOpenSerials.has(serialKey)) {
                            rowErrors.push({ column: 'serial_no', message: `Serial "${serialNo}" มีอยู่ในสต็อกแล้ว` });
                        } else {
                            seenSerials.add(serialKey);
                        }
                    }
                }

                if (rowErrors.length > 0) {
                    errors.push({ row: rowNum, itemCode: oldItemCode || '-', errors: rowErrors });
                    continue;
                }

                validatedRows.push({
                    item_id: item.id, item_code: item.item_code, old_item_code: oldItemCode,
                    warehouse_id: warehouse.id, warehouse_code: warehouseCode,
                    location_id: location ? location.id : null, location_code: locationCode || null,
                    lot_no: lotNo || null, serial_no: serialNo || null,
                    qty, unit_cost: unitCost,
                });
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
// POST /im_opening_balance/import/confirm  (JSON body { import_date, description, rows })
// ไม่แตะ gl_posting_period / gl_entry_header / im_transaction เลย — ตรงตาม AR/AP balance import
// ---------------------------------------------------------------------------
const confirmImport = async (req, res) => {
    const { import_date, description, rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ message: 'ไม่มีข้อมูลนำเข้า' });
    if (!import_date) return res.status(400).json({ message: 'กรุณาระบุวันที่ตั้งยอด' });
    const userName = req.headers.username;
    const client = await req.dbPool.connect();
    let imported = 0;
    const skipped = 0;
    const importErrors = [];
    try {
        await client.query('BEGIN');
        await ensureImOpeningBalanceBatchTable(client);
        await ensureImStockBalanceTable(client);
        await ensureImStockLayerTable(client);

        const batchRes = await client.query(
            `INSERT INTO im_opening_balance_batch (import_date, description, created_by) VALUES ($1,$2,$3) RETURNING id`,
            [import_date, description || null, userName]
        );
        const batchId = batchRes.rows[0].id;
        const batchDocNo = `OPBAL-${batchId.toString().padStart(6, '0')}`;

        for (let idx = 0; idx < rows.length; idx++) {
            const r = rows[idx];
            const savepointName = `sp_row_${idx}`;
            await client.query(`SAVEPOINT ${savepointName}`);
            try {
                const itemRes = await client.query(`SELECT * FROM im_item WHERE id=$1`, [r.item_id]);
                if (itemRes.rows.length === 0) throw new Error(`ไม่พบสินค้า item_id=${r.item_id}`);
                const item = itemRes.rows[0];
                const costingMethod = item.costing_method;
                const qty = Number(r.qty);
                const unitCost = costingMethod === 'STANDARD' ? (Number(item.standard_cost) || 0) : Number(r.unit_cost);

                if (costingMethod === 'AVG' || costingMethod === 'STANDARD') {
                    const balRes = await client.query(
                        `SELECT qty_on_hand, avg_unit_cost FROM im_stock_balance WHERE ${STOCK_BALANCE_KEY} FOR UPDATE`,
                        [r.item_id, r.warehouse_id, r.location_id || null, r.lot_no || null]
                    );
                    const beforeQty = balRes.rows.length ? Number(balRes.rows[0].qty_on_hand) : 0;
                    const beforeAvg = balRes.rows.length ? Number(balRes.rows[0].avg_unit_cost) : 0;
                    const newQty = beforeQty + qty;
                    const newAvg = costingMethod === 'STANDARD'
                        ? unitCost
                        : (newQty === 0 ? 0 : (beforeQty * beforeAvg + qty * unitCost) / newQty);
                    await upsertStockBalance(client, {
                        itemId: r.item_id, warehouseId: r.warehouse_id, locationId: r.location_id, lotNo: r.lot_no,
                        qty: newQty, avgCost: newAvg, updatedBy: userName,
                    });
                } else if (costingMethod === 'FIFO') {
                    await client.query(`
                        INSERT INTO im_stock_layer
                        (item_id, warehouse_id, location_id, lot_no, layer_date, received_qty, remaining_qty, unit_cost,
                         source_doc_type, source_doc_id, source_doc_no, created_by)
                        VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'OPBAL',$8,$9,$10)
                    `, [r.item_id, r.warehouse_id, r.location_id || null, r.lot_no || null, import_date, qty, unitCost,
                        batchId, batchDocNo, userName]);
                    await recomputeBalanceFromLayers(client, {
                        itemId: r.item_id, warehouseId: r.warehouse_id, locationId: r.location_id, lotNo: r.lot_no, updatedBy: userName,
                    });
                } else if (costingMethod === 'SPECIFIC') {
                    if (!r.serial_no) throw new Error(`กรุณาระบุ Serial No. สำหรับ ${r.item_code}`);
                    const dupRes = await client.query(
                        `SELECT id FROM im_stock_layer WHERE item_id=$1 AND serial_no=$2 AND remaining_qty > 0`,
                        [r.item_id, r.serial_no]
                    );
                    if (dupRes.rows.length > 0) throw new Error(`Serial ${r.serial_no} มีอยู่ในสต็อกแล้ว`);
                    await client.query(`
                        INSERT INTO im_stock_layer
                        (item_id, warehouse_id, location_id, lot_no, serial_no, layer_date, received_qty, remaining_qty, unit_cost,
                         source_doc_type, source_doc_id, source_doc_no, created_by)
                        VALUES ($1,$2,$3,$4,$5,$6,1,1,$7,'OPBAL',$8,$9,$10)
                    `, [r.item_id, r.warehouse_id, r.location_id || null, r.lot_no || null, r.serial_no, import_date, unitCost,
                        batchId, batchDocNo, userName]);
                    await recomputeBalanceFromLayers(client, {
                        itemId: r.item_id, warehouseId: r.warehouse_id, locationId: r.location_id, lotNo: r.lot_no, updatedBy: userName,
                    });
                } else {
                    throw new Error(`ไม่รู้จัก costing_method '${costingMethod}'`);
                }

                await client.query(`RELEASE SAVEPOINT ${savepointName}`);
                imported++;
            } catch (rowErr) {
                await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
                await client.query(`RELEASE SAVEPOINT ${savepointName}`);
                importErrors.push({ item_code: r.item_code, message: rowErr.message });
            }
        }
        await client.query('COMMIT');
        res.json({ imported, skipped, errors: importErrors, batch_id: batchId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Import confirm error:', err);
        res.status(500).json({ message: 'เกิดข้อผิดพลาด: ' + err.message });
    } finally {
        client.release();
    }
};

module.exports = { getTemplate, downloadTemplate, validateFile, confirmImport };
