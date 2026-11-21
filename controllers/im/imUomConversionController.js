// controllers/im/imUomConversionController.js
// im_uom_conversion is entirely owned by im_item (alternate purchase/sales units per
// item, e.g. 1 BOX = 12 PCS) — no standalone list screen, saved as a nested array
// inside im_item's own addRow/updateRow, same convention as ap_vendor's
// addresses/contacts/bank_accounts.
'use strict';

const { ensureImUomTable } = require('./imUomController');

const ensureImUomConversionTable = async (client) => {
    await ensureImUomTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_uom_conversion (
            id                    SERIAL PRIMARY KEY,
            item_id               INTEGER NOT NULL,
            uom_id                INTEGER NOT NULL REFERENCES im_uom(id),
            conversion_factor     NUMERIC(18,6) NOT NULL DEFAULT 1,
            barcode               VARCHAR(50),
            is_purchase_default   BOOLEAN NOT NULL DEFAULT false,
            is_sales_default      BOOLEAN NOT NULL DEFAULT false
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_uom_conversion_item ON im_uom_conversion(item_id)`);
    // หน่วยนับหลายหน่วย ขั้นที่ 1: ใช้ด้านไหนได้ + หน่วยเริ่มต้นแยกตามงาน + ปิดใช้งาน
    for (const [col, def] of [
        ['allow_purchase', 'true'], ['allow_sales', 'true'], ['allow_production', 'true'],
        ['is_production_default', 'false'], ['is_count_default', 'false'], ['is_report_default', 'false'],
        ['is_active', 'true'],
    ]) {
        await client.query(`ALTER TABLE im_uom_conversion ADD COLUMN IF NOT EXISTS ${col} BOOLEAN NOT NULL DEFAULT ${def}`);
    }
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_im_uom_conversion_item_uom ON im_uom_conversion(item_id, uom_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_uom_conversion_barcode ON im_uom_conversion(barcode)`);
};

// หน่วยเริ่มต้นแต่ละงาน -> สิทธิ์ที่หน่วยนั้นต้องมี (null = ไม่ต้องตรวจ)
const DEFAULT_FLAGS = [
    { flag: 'is_purchase_default',   allow: 'allow_purchase',   th: 'หน่วยซื้อเริ่มต้น' },
    { flag: 'is_sales_default',      allow: 'allow_sales',      th: 'หน่วยขายเริ่มต้น' },
    { flag: 'is_production_default', allow: 'allow_production', th: 'หน่วยผลิตเริ่มต้น' },
    { flag: 'is_count_default',      allow: null,               th: 'หน่วยตรวจนับเริ่มต้น' },
    { flag: 'is_report_default',     allow: null,               th: 'หน่วยรายงานเริ่มต้น' },
];

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// ตรวจหน่วยของสินค้าก่อนบันทึก — throw Error {status:400} พร้อมข้อความภาษาไทย
const validateForItem = async (client, itemId, rows) => {
    const item = (await client.query(`SELECT id, base_uom_id, barcode FROM im_item WHERE id = $1`, [itemId])).rows[0];
    if (!item) throw badRequest('ไม่พบสินค้า');
    const uomIds = rows.map(c => Number(c.uom_id));
    const uoms = new Map((await client.query(`SELECT id, uom_code FROM im_uom WHERE id = ANY($1::int[])`, [uomIds])).rows.map(u => [u.id, u]));
    const code = (id) => uoms.get(Number(id))?.uom_code || String(id);
    const seen = new Set();
    for (const c of rows) {
        const uid = Number(c.uom_id);
        if (!uoms.has(uid)) throw badRequest(`ไม่พบหน่วยนับ id ${c.uom_id}`);
        if (item.base_uom_id && uid === Number(item.base_uom_id)) throw badRequest(`หน่วย ${code(uid)} เป็นหน่วยหลักของสินค้าอยู่แล้ว ไม่ต้องเพิ่มเป็นหน่วยแปลง`);
        if (seen.has(uid)) throw badRequest(`หน่วย ${code(uid)} ซ้ำในรายการหน่วยของสินค้า`);
        seen.add(uid);
        const f = Number(c.conversion_factor);
        if (!Number.isFinite(f) || f <= 0) throw badRequest(`อัตราแปลงของหน่วย ${code(uid)} ต้องมากกว่า 0`);
        if (f >= 1e12) throw badRequest(`อัตราแปลงของหน่วย ${code(uid)} มากเกินไป`);
    }
    for (const d of DEFAULT_FLAGS) {
        const marked = rows.filter(c => c[d.flag] === true);
        if (marked.length > 1) throw badRequest(`${d.th}ตั้งได้หน่วยเดียว (ตอนนี้ตั้งไว้ ${marked.map(c => code(c.uom_id)).join(', ')})`);
        for (const c of marked) {
            if (c.is_active === false) throw badRequest(`หน่วย ${code(c.uom_id)} ปิดใช้งานอยู่ ตั้งเป็น${d.th}ไม่ได้`);
            if (d.allow && c[d.allow] === false) throw badRequest(`หน่วย ${code(c.uom_id)} ไม่ได้อนุญาตให้ใช้ในงานนี้ ตั้งเป็น${d.th}ไม่ได้`);
        }
    }
    // barcode ห้ามซ้ำทั้งระบบ: ในรายการเดียวกัน, กับ barcode หลักของสินค้านี้, กับสินค้าอื่น และหน่วยของสินค้าอื่น
    const codes = rows.map(c => (c.barcode || '').trim()).filter(Boolean);
    const own = (item.barcode || '').trim();
    const dupInList = codes.find((b, i) => codes.indexOf(b) !== i);
    if (dupInList) throw badRequest(`barcode ${dupInList} ซ้ำกันในหน่วยของสินค้านี้`);
    if (own && codes.includes(own)) throw badRequest(`barcode ${own} ซ้ำกับ barcode หลักของสินค้านี้`);
    const all = own ? [...codes, own] : codes;
    if (all.length) {
        const clash = await client.query(
            `SELECT x.barcode, i.item_code FROM (
                 SELECT barcode, id AS item_id FROM im_item WHERE barcode = ANY($1::text[]) AND id <> $2
                 UNION ALL
                 SELECT barcode, item_id FROM im_uom_conversion WHERE barcode = ANY($1::text[]) AND item_id <> $2
             ) x JOIN im_item i ON i.id = x.item_id LIMIT 1`, [all, itemId]);
        if (clash.rows.length) throw badRequest(`barcode ${clash.rows[0].barcode} ซ้ำกับสินค้า ${clash.rows[0].item_code}`);
    }
};

const CONVERSION_SELECT = `
    SELECT c.*, u.uom_code, u.uom_name_th, u.uom_name_en
    FROM im_uom_conversion c
    LEFT JOIN im_uom u ON u.id = c.uom_id
    WHERE c.item_id = $1
    ORDER BY c.id
`;

const fetchByItem = async (client, itemId) => {
    const result = await client.query(CONVERSION_SELECT, [itemId]);
    return result.rows;
};

// Adds a FK item_id -> im_item(id) once im_item is guaranteed to exist
// (called from imItemController.ensureImItemTable, after im_item itself is created)
const attachItemFk = async (client) => {
    await client.query(`
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'im_uom_conversion_item_id_fkey'
            ) THEN
                ALTER TABLE im_uom_conversion ADD CONSTRAINT im_uom_conversion_item_id_fkey
                    FOREIGN KEY (item_id) REFERENCES im_item(id) ON DELETE CASCADE;
            END IF;
        END $$;
    `).catch(() => {});
};

const replaceForItem = async (client, itemId, conversions) => {
    const rows = (conversions || []).filter(c => c && c.uom_id);
    await validateForItem(client, itemId, rows);
    await client.query(`DELETE FROM im_uom_conversion WHERE item_id = $1`, [itemId]);
    for (const c of rows) {
        await client.query(
            `INSERT INTO im_uom_conversion (item_id, uom_id, conversion_factor, barcode,
                 is_purchase_default, is_sales_default, is_production_default, is_count_default, is_report_default,
                 allow_purchase, allow_sales, allow_production, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [itemId, c.uom_id, c.conversion_factor ?? 1, (c.barcode || '').trim() || null,
             c.is_purchase_default ?? false, c.is_sales_default ?? false, c.is_production_default ?? false,
             c.is_count_default ?? false, c.is_report_default ?? false,
             c.allow_purchase ?? true, c.allow_sales ?? true, c.allow_production ?? true, c.is_active ?? true]
        );
    }
};

module.exports = { ensureImUomConversionTable, attachItemFk, fetchByItem, replaceForItem, validateForItem };
