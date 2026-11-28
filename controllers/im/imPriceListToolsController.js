// controllers/im/imPriceListToolsController.js
// เครื่องมือของหน้าจอตารางราคา (user 2026-11-25):
//   - GET  /im_price_list/:id/missing_items?list_type=  สินค้าขาย/ซื้อที่ยังไม่มีราคาในตารางนี้ (id 0 = ตารางใหม่)
//   - GET  /im_price_list/import/template/download?lang= เทมเพลต Excel นำเข้าราคา
//   - POST /im_price_list/import/parse (file, list_type)  อ่านไฟล์ → บรรทัดราคาที่จับคู่สินค้า/หน่วยแล้ว + ข้อผิดพลาดรายแถว
//     ไม่บันทึกลงฐานข้อมูล — หน้าจอรวมบรรทัดเข้ากับตารางที่กำลังแก้ ผู้ใช้ตรวจแล้วกดบันทึกเอง (ตรวจช่วงวันทับซ้อนตอนบันทึก)
'use strict';

const XLSX = require('xlsx');
const multer = require('multer');
const { withEnSheet, isEnglishReq, labelRow, colWidths } = require('../../utils/importLabels');
const { listItemUoms } = require('../../utils/uom');
const { excelDate } = require('../../utils/dateUtil');

const upload = multer({ storage: multer.memoryStorage() });
const PRICE_TYPES = ['STANDARD', 'PROMOTION'];

const SHEET = {
    key: 'prices',
    name: 'ราคา',
    columns: [
        { key: 'item_code',      label: 'รหัสสินค้า (หรือรหัสสินค้าเก่า)', required: true, example: '11010006' },
        { key: 'uom_code',       label: 'รหัสหน่วยนับ (ว่าง = หน่วยหลักของสินค้า)', example: 'BOX' },
        { key: 'min_qty',        label: 'จำนวนขั้นต่ำ (ว่าง = 0)', example: '0' },
        { key: 'unit_price_fc',  label: 'ราคาต่อหน่วย (รวม VAT หรือไม่ ตามที่ตั้งไว้ในตารางราคา)', required: true, example: '32' },
        { key: 'price_type',     label: 'ชนิดราคา STANDARD / PROMOTION (ว่าง = STANDARD)', example: 'STANDARD' },
        { key: 'effective_from', label: 'มีผลตั้งแต่ (YYYY-MM-DD)', example: '2026-01-01' },
        { key: 'effective_to',   label: 'มีผลถึง (YYYY-MM-DD)', example: '' },
    ],
};

const tableExists = async (client, name) =>
    !!(await client.query(`SELECT to_regclass($1) AS t`, [`public.${name}`])).rows[0].t;

// GET /im_price_list/:id/missing_items?list_type=SALES|PURCHASE
const fetchMissingItems = async (req, res) => {
    const listId = Number(req.params.id) || 0;
    const listType = String(req.query.list_type || 'SALES').toUpperCase() === 'PURCHASE' ? 'PURCHASE' : 'SALES';
    const flag = listType === 'PURCHASE' ? 'is_purchase_item' : 'is_sales_item';
    const client = await req.dbPool.connect();
    try {
        const hasDetail = await tableExists(client, 'im_price_list_detail');
        const r = await client.query(`
            SELECT i.id, i.item_code, i.item_name_th, i.item_name_en, i.item_type, i.base_uom_id,
                   u.uom_code AS base_uom_code, u.uom_name_th AS base_uom_name_th, u.uom_name_en AS base_uom_name_en,
                   c.category_code, c.category_name_th
              FROM im_item i
              LEFT JOIN im_uom u ON u.id = i.base_uom_id
              LEFT JOIN im_item_category c ON c.id = i.category_id
             WHERE i.is_active = true AND i.${flag} = true
               ${hasDetail && listId ? 'AND NOT EXISTS (SELECT 1 FROM im_price_list_detail d WHERE d.price_list_id = $1 AND d.item_id = i.id)' : ''}
             ORDER BY i.item_code`, hasDetail && listId ? [listId] : []);
        res.status(200).json({ count: r.rows.length, items: r.rows });
    } catch (error) {
        console.error('Error fetching price list missing items:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET /im_price_list/import/template/download?lang=
const downloadTemplate = (req, res) => {
    const en = isEnglishReq(req);
    const sheet = withEnSheet('im_price_list', SHEET);
    const ws = XLSX.utils.aoa_to_sheet([
        sheet.columns.map(c => c.key),
        labelRow(sheet.columns, en),
    ]);
    ws['!cols'] = colWidths(sheet.columns, en);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, SHEET.name);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="im_price_list_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
};

// POST /im_price_list/import/parse  (multipart: file, list_type)
const parseFile = [
    upload.single('file'),
    async (req, res) => {
        if (!req.file) return res.status(400).json({ message: 'ไม่พบไฟล์' });
        let workbook;
        try {
            workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        } catch (err) {
            return res.status(400).json({ message: 'ไม่สามารถอ่านไฟล์ได้: ' + err.message });
        }
        const listType = String(req.body?.list_type || 'SALES').toUpperCase() === 'PURCHASE' ? 'PURCHASE' : 'SALES';
        const ws = workbook.Sheets[SHEET.name] || workbook.Sheets[workbook.SheetNames[0]];
        const aoa = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) : [];
        if (aoa.length === 0) return res.status(400).json({ message: 'ไม่พบข้อมูลในไฟล์' });
        const headers = aoa[0].map(h => String(h || '').trim());
        const missing = SHEET.columns.filter(c => c.required).map(c => c.key).filter(k => !headers.includes(k));
        if (missing.length) return res.status(400).json({ message: `ไฟล์ไม่ตรงตามเทมเพลต ขาดคอลัมน์: ${missing.join(', ')}` });
        const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
        const cell = (row, k) => (idx[k] === undefined ? '' : row[idx[k]]);

        const client = await req.dbPool.connect();
        try {
            const rows = aoa.slice(1)
                .map((row, i) => ({ row, num: i + 2 }))
                .filter(({ row }) => { const v = String(cell(row, 'item_code') ?? '').trim(); return v !== '' && !v.startsWith('('); });
            const codes = [...new Set(rows.map(r => String(cell(r.row, 'item_code')).trim().toUpperCase()))];
            const items = codes.length ? (await client.query(`
                SELECT id, UPPER(item_code) AS code, UPPER(COALESCE(old_item_code, '')) AS old_code, item_code, item_name_th, item_name_en, is_active
                  FROM im_item WHERE UPPER(item_code) = ANY($1::text[]) OR UPPER(old_item_code) = ANY($1::text[])`, [codes])).rows : [];
            const byCode = new Map();
            for (const it of items) { byCode.set(it.code, it); if (it.old_code && !byCode.has(it.old_code)) byCode.set(it.old_code, it); }
            const purpose = listType === 'PURCHASE' ? 'PURCHASE' : 'SALES';
            const uomCache = new Map();

            const lines = [];
            const errors = [];
            for (const { row, num } of rows) {
                const err = (column, message) => errors.push({ row: num, column, message });
                const code = String(cell(row, 'item_code')).trim().toUpperCase();
                const it = byCode.get(code);
                if (!it) { err('item_code', `ไม่พบสินค้า "${code}"`); continue; }
                if (!it.is_active) { err('item_code', `สินค้า "${it.item_code}" หยุดใช้งานแล้ว`); continue; }
                if (!uomCache.has(it.id)) uomCache.set(it.id, await listItemUoms(client, it.id, { purpose }).catch(() => ({ units: [] })));
                const uoms = uomCache.get(it.id);
                const uomCode = String(cell(row, 'uom_code') ?? '').trim().toUpperCase();
                const unit = uomCode
                    ? uoms.units.find(u => String(u.uom_code).toUpperCase() === uomCode)
                    : uoms.units.find(u => u.source === 'BASE');
                if (!unit) {
                    err('uom_code', uomCode
                        ? `หน่วย "${uomCode}" ไม่ใช่หน่วยที่ใช้${purpose === 'PURCHASE' ? 'ซื้อ' : 'ขาย'}ได้ของสินค้า ${it.item_code}`
                        : `สินค้า ${it.item_code} ยังไม่ได้กำหนดหน่วยหลัก`);
                    continue;
                }
                const priceRaw = String(cell(row, 'unit_price_fc') ?? '').replace(/,/g, '').trim();
                const price = Number(priceRaw);
                if (priceRaw === '' || !Number.isFinite(price) || price < 0) { err('unit_price_fc', 'ราคาต่อหน่วยต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป'); continue; }
                const minRaw = String(cell(row, 'min_qty') ?? '').replace(/,/g, '').trim();
                const minQty = minRaw === '' ? 0 : Number(minRaw);
                if (!Number.isFinite(minQty) || minQty < 0) { err('min_qty', 'จำนวนขั้นต่ำต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป'); continue; }
                const pt = String(cell(row, 'price_type') ?? '').trim().toUpperCase() || 'STANDARD';
                if (!PRICE_TYPES.includes(pt)) { err('price_type', 'ชนิดราคาต้องเป็น STANDARD หรือ PROMOTION'); continue; }
                const fromRaw = cell(row, 'effective_from'), toRaw = cell(row, 'effective_to');
                const from = fromRaw === '' ? null : excelDate(fromRaw);
                const to = toRaw === '' ? null : excelDate(toRaw);
                if (fromRaw !== '' && !from) { err('effective_from', 'วันที่ไม่ถูกต้อง (ใช้ YYYY-MM-DD)'); continue; }
                if (toRaw !== '' && !to) { err('effective_to', 'วันที่ไม่ถูกต้อง (ใช้ YYYY-MM-DD)'); continue; }
                if (from && to && to < from) { err('effective_to', 'วันที่มีผลถึงต้องไม่ก่อนวันที่มีผลตั้งแต่'); continue; }
                lines.push({
                    row: num, item_id: it.id, item_code: it.item_code, item_name_th: it.item_name_th, item_name_en: it.item_name_en,
                    uom_id: unit.uom_id, uom_code: unit.uom_code, uom_name_th: unit.uom_name_th, uom_name_en: unit.uom_name_en,
                    min_qty: minQty, unit_price_fc: price, price_type: pt, effective_from: from, effective_to: to,
                });
            }
            res.status(200).json({ total_rows: rows.length, lines, errors });
        } catch (error) {
            console.error('Error parsing price list import:', error);
            res.status(500).json({ message: 'Internal server error' });
        } finally { client.release(); }
    },
];

module.exports = { fetchMissingItems, downloadTemplate, parseFile };
