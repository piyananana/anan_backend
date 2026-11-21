// utils/uom.js — หน่วยนับหลายหน่วย: หาอัตราแปลงของหน่วยในเอกสาร -> หน่วยหลักของสินค้า และแปลงจำนวน
//
// หลักการ (แบบระบบ 2026-11-20):
//   - สต็อก/ต้นทุน/layer เก็บเป็นหน่วยหลักเสมอ; บรรทัดเอกสารเก็บ uom_id + qty + conversion_factor (snapshot) + base_qty
//   - ลำดับหาอัตราแปลง: หน่วยหลัก = 1 -> หน่วยของสินค้า (im_uom_conversion) -> อัตราแปลงมาตรฐาน (im_uom_standard_conversion)
//   - อัตราแปลง = จำนวนหน่วยหลักต่อ 1 หน่วยในเอกสาร (base_qty = qty × factor)
//   - ทศนิยม (2026-11-21): หน่วยตั้งได้ 0-6 ตำแหน่ง; หน่วยนับจำนวน (COUNT) ต้องลงตัวตามทศนิยม (ไม่ให้บันทึกถ้าเกิน)
//     หน่วยประเภทอื่น (น้ำหนัก/ความยาว/ปริมาตร/พื้นที่/เวลา) ปัดตามทศนิยมที่ตั้งไว้ เช่น 1 lb = 0.453592 -> 0.454 kg
'use strict';

const FACTOR_DP = 6;   // im_uom_conversion.conversion_factor NUMERIC(18,6)
const QTY_DP_MAX = 6;  // คอลัมน์จำนวนทั้งหมด NUMERIC(20,6) (sql/qty_scale_6.sql)
const EPS = 1e-9;

const PURPOSES = {
    PURCHASE:   { allow: 'allow_purchase',   def: 'is_purchase_default',   th: 'ซื้อ' },
    SALES:      { allow: 'allow_sales',      def: 'is_sales_default',      th: 'ขาย' },
    PRODUCTION: { allow: 'allow_production', def: 'is_production_default', th: 'ผลิต' },
    COUNT:      { allow: null,               def: 'is_count_default',      th: 'ตรวจนับ' },
    REPORT:     { allow: null,               def: 'is_report_default',     th: 'รายงาน' },
};

const uomError = (message) => Object.assign(new Error(message), { status: 400, code: 'UOM' });

const round = (n, dp) => { const p = 10 ** dp; return Math.round((Number(n) + Number.EPSILON) * p) / p; };

// จำนวนตำแหน่งทศนิยมจริงของตัวเลข (ตัดศูนย์ท้าย, ทนเศษ floating point)
const decimalsOf = (n) => {
    const s = round(Number(n), 10).toString();
    if (s.includes('e-')) return Number(s.split('e-')[1]);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
};

// ตรวจว่าจำนวนไม่เกินทศนิยมที่หน่วยกำหนด — คืนข้อความ error หรือ null
const checkDecimals = (qty, decimals, uomCode) => {
    const dp = Math.min(Number(decimals ?? 0), QTY_DP_MAX);
    if (Math.abs(round(qty, dp) - Number(qty)) > EPS) {
        return dp === 0
            ? `หน่วย ${uomCode} ต้องเป็นจำนวนเต็ม (ป้อน ${qty})`
            : `หน่วย ${uomCode} ป้อนทศนิยมได้ไม่เกิน ${dp} ตำแหน่ง (ป้อน ${qty})`;
    }
    return null;
};

const isCount = (dimension) => (dimension || 'COUNT') === 'COUNT';

/**
 * ทำจำนวนให้เข้ากับทศนิยมของหน่วย: หน่วยนับจำนวน = ต้องลงตัว (throw), หน่วยอื่น = ปัด
 * @returns {number} จำนวนหลังปัด
 */
const fitQty = (qty, decimals, dimension, uomCode) => {
    const dp = Math.min(Number(decimals ?? 0), QTY_DP_MAX);
    if (isCount(dimension)) {
        const e = checkDecimals(qty, dp, uomCode);
        if (e) throw uomError(e);
    }
    return round(qty, dp);
};

const loadItem = async (db, itemId) => {
    const r = await db.query(
        `SELECT i.id, i.item_code, i.base_uom_id, i.is_serial_tracked,
                u.uom_code AS base_uom_code, u.uom_dimension AS base_dimension, COALESCE(u.decimal_places, 0) AS base_decimals
           FROM im_item i LEFT JOIN im_uom u ON u.id = i.base_uom_id
          WHERE i.id = $1`, [itemId]);
    if (!r.rows.length) throw uomError(`ไม่พบสินค้า id ${itemId}`);
    return r.rows[0];
};

const tableExists = async (db, name) =>
    !!(await db.query(`SELECT to_regclass($1) AS reg`, [`public.${name}`])).rows[0].reg;

/**
 * หาอัตราแปลงของ [uomId] สำหรับสินค้า [itemId]
 * @param {object} opts.purpose  'PURCHASE' | 'SALES' | 'PRODUCTION' | 'COUNT' | 'REPORT' | undefined
 *                               — ระบุเมื่อสร้าง/แก้เอกสารใหม่ เพื่อตรวจว่าหน่วยของสินค้าใช้ในงานนี้ได้และยังเปิดใช้งาน
 *                               ไม่ระบุ = แค่หาอัตรา (เช่นอ่านเอกสารเก่า)
 * @returns {{ factor, source: 'BASE'|'ITEM'|'STANDARD', baseUomId, baseUomCode, baseDecimals, baseDimension, uomId, uomCode, uomDecimals, uomDimension }}
 */
const resolveFactor = async (db, itemId, uomId, { purpose } = {}) => {
    const item = await loadItem(db, itemId);
    if (!item.base_uom_id) throw uomError(`สินค้า ${item.item_code} ยังไม่ได้ตั้งหน่วยนับหลัก`);
    const target = uomId ? Number(uomId) : Number(item.base_uom_id);
    const base = {
        baseUomId: Number(item.base_uom_id), baseUomCode: item.base_uom_code, baseDecimals: Number(item.base_decimals),
        baseDimension: item.base_dimension || 'COUNT',
    };
    if (target === Number(item.base_uom_id)) {
        return { factor: 1, source: 'BASE', ...base, uomId: target, uomCode: item.base_uom_code, uomDecimals: Number(item.base_decimals), uomDimension: base.baseDimension };
    }

    const u = (await db.query(`SELECT id, uom_code, uom_dimension, COALESCE(decimal_places, 0) AS decimal_places FROM im_uom WHERE id = $1`, [target])).rows[0];
    if (!u) throw uomError(`ไม่พบหน่วยนับ id ${uomId}`);
    const uomInfo = { uomId: target, uomCode: u.uom_code, uomDecimals: Number(u.decimal_places), uomDimension: u.uom_dimension || 'COUNT' };

    // 1) หน่วยของสินค้า
    const conv = (await db.query(`SELECT * FROM im_uom_conversion WHERE item_id = $1 AND uom_id = $2`, [itemId, target])).rows[0];
    if (conv) {
        const p = purpose ? PURPOSES[purpose] : null;
        if (purpose && !p) throw uomError(`purpose ไม่ถูกต้อง: ${purpose}`);
        if (p && conv.is_active === false) throw uomError(`หน่วย ${u.uom_code} ของสินค้า ${item.item_code} ปิดใช้งานแล้ว`);
        if (p && p.allow && conv[p.allow] === false) throw uomError(`หน่วย ${u.uom_code} ของสินค้า ${item.item_code} ไม่ได้อนุญาตให้ใช้ในงาน${p.th}`);
        return { factor: Number(conv.conversion_factor), source: 'ITEM', ...base, ...uomInfo };
    }

    // 2) อัตราแปลงมาตรฐาน (เฉพาะหน่วยประเภทเดียวกับหน่วยหลัก)
    if (u.uom_dimension === item.base_dimension && await tableExists(db, 'im_uom_standard_conversion')) {
        const s = (await db.query(
            `SELECT from_uom_id, conversion_factor FROM im_uom_standard_conversion
              WHERE (from_uom_id = $1 AND to_uom_id = $2) OR (from_uom_id = $2 AND to_uom_id = $1) LIMIT 1`,
            [target, item.base_uom_id])).rows[0];
        if (s) {
            const f = Number(s.conversion_factor);
            // แถวเก็บ 1 [from] = f [to]; ต้องการ "หน่วยหลักต่อ 1 หน่วยเอกสาร"
            const factor = Number(s.from_uom_id) === target ? f : round(1 / f, 12);
            return { factor, source: 'STANDARD', ...base, ...uomInfo };
        }
    }
    throw uomError(`หน่วย ${u.uom_code} แปลงเป็นหน่วยหลัก ${item.base_uom_code} ของสินค้า ${item.item_code} ไม่ได้ — ตั้งหน่วยของสินค้าหรืออัตราแปลงมาตรฐานก่อน`);
};

/**
 * แปลงจำนวนในหน่วยเอกสารเป็นหน่วยหลัก
 *   - จำนวนในหน่วยเอกสาร และจำนวนหน่วยหลักที่ได้ ใช้กฎเดียวกัน: หน่วยนับจำนวน = ต้องลงตัว, หน่วยอื่น = ปัดตามทศนิยม
 *   - ถ้าปัดแล้วจำนวนหน่วยหลักเป็น 0 ทั้งที่ป้อนมากกว่า 0 = ไม่ให้บันทึก (หน่วยเล็กเกินทศนิยมของหน่วยหลัก)
 * @param {object} r ผลจาก resolveFactor
 * @returns {{ qty, factor, baseQty, rounded }}  rounded = มีการปัดจำนวนหน่วยหลัก
 */
const toBaseQty = (qty, r) => {
    const raw = Number(qty);
    if (!Number.isFinite(raw)) throw uomError(`จำนวนไม่ถูกต้อง: ${qty}`);
    const q = fitQty(raw, r.uomDecimals, r.uomDimension, r.uomCode);
    const exact = round(q * r.factor, QTY_DP_MAX + 4);
    let baseQty;
    try {
        baseQty = fitQty(exact, r.baseDecimals, r.baseDimension, r.baseUomCode);
    } catch (e) {
        throw uomError(`${q} ${r.uomCode} = ${round(exact, QTY_DP_MAX)} ${r.baseUomCode} — ${e.message}`);
    }
    if (q !== 0 && baseQty === 0) {
        throw uomError(`${q} ${r.uomCode} = ${round(exact, QTY_DP_MAX)} ${r.baseUomCode} — น้อยกว่าทศนิยมของหน่วย ${r.baseUomCode} (${r.baseDecimals} ตำแหน่ง)`);
    }
    return { qty: q, factor: round(r.factor, FACTOR_DP), baseQty, rounded: Math.abs(baseQty - exact) > EPS };
};

/**
 * รายการหน่วยที่เลือกได้ของสินค้า (สำหรับ dropdown ในบรรทัดเอกสาร)
 * หน่วยหลัก + หน่วยของสินค้าที่เปิดใช้งาน/อนุญาตในงานนั้น + หน่วยที่แปลงได้ด้วยอัตรามาตรฐาน
 * @returns {{ base_uom_id, default_uom_id, units: [{ uom_id, uom_code, uom_name_th, uom_name_en, factor, decimal_places, source, barcode }] }}
 */
const listItemUoms = async (db, itemId, { purpose } = {}) => {
    const item = await loadItem(db, itemId);
    const p = purpose ? PURPOSES[purpose] : null;
    if (purpose && !p) throw uomError(`purpose ไม่ถูกต้อง: ${purpose}`);
    const units = [];
    if (!item.base_uom_id) return { base_uom_id: null, default_uom_id: null, units };
    const bu = (await db.query(`SELECT * FROM im_uom WHERE id = $1`, [item.base_uom_id])).rows[0];
    units.push({ uom_id: bu.id, uom_code: bu.uom_code, uom_name_th: bu.uom_name_th, uom_name_en: bu.uom_name_en,
        factor: 1, decimal_places: Number(bu.decimal_places ?? 0), uom_dimension: bu.uom_dimension || 'COUNT', source: 'BASE', barcode: null });
    let defaultUomId = null;
    const convs = (await db.query(
        `SELECT c.*, u.uom_code, u.uom_name_th, u.uom_name_en, u.uom_dimension, COALESCE(u.decimal_places, 0) AS decimal_places
           FROM im_uom_conversion c JOIN im_uom u ON u.id = c.uom_id
          WHERE c.item_id = $1 ORDER BY c.conversion_factor, u.uom_code`, [itemId])).rows;
    for (const c of convs) {
        if (c.is_active === false) continue;
        if (p && p.allow && c[p.allow] === false) continue;
        units.push({ uom_id: c.uom_id, uom_code: c.uom_code, uom_name_th: c.uom_name_th, uom_name_en: c.uom_name_en,
            factor: Number(c.conversion_factor), decimal_places: Number(c.decimal_places), uom_dimension: c.uom_dimension || 'COUNT',
            source: 'ITEM', barcode: c.barcode });
        if (p && c[p.def] === true) defaultUomId = c.uom_id;
    }
    if (await tableExists(db, 'im_uom_standard_conversion')) {
        const std = (await db.query(
            `SELECT s.from_uom_id, s.to_uom_id, s.conversion_factor, u.id AS uom_id, u.uom_code, u.uom_name_th, u.uom_name_en, u.uom_dimension,
                    COALESCE(u.decimal_places, 0) AS decimal_places
               FROM im_uom_standard_conversion s
               JOIN im_uom u ON u.id = CASE WHEN s.from_uom_id = $1 THEN s.to_uom_id ELSE s.from_uom_id END
              WHERE (s.from_uom_id = $1 OR s.to_uom_id = $1) AND u.is_active = true AND u.uom_dimension = $2`,
            [item.base_uom_id, item.base_dimension])).rows;
        for (const s of std) {
            if (units.some(x => x.uom_id === s.uom_id)) continue; // หน่วยของสินค้าชนะอัตรามาตรฐาน
            const f = Number(s.conversion_factor);
            units.push({ uom_id: s.uom_id, uom_code: s.uom_code, uom_name_th: s.uom_name_th, uom_name_en: s.uom_name_en,
                factor: Number(s.from_uom_id) === s.uom_id ? f : round(1 / f, 12),
                decimal_places: Number(s.decimal_places), uom_dimension: s.uom_dimension || 'COUNT', source: 'STANDARD', barcode: null });
        }
    }
    return { base_uom_id: Number(item.base_uom_id), default_uom_id: defaultUomId || Number(item.base_uom_id), units };
};

/**
 * หาสินค้า + หน่วยจาก barcode (barcode หลักของสินค้า = หน่วยหลัก, barcode ของหน่วยสินค้า = หน่วยนั้น)
 * @returns {{ item_id, uom_id, factor } | null}
 */
const findByBarcode = async (db, barcode) => {
    const code = String(barcode || '').trim();
    if (!code) return null;
    const unit = (await db.query(
        `SELECT item_id, uom_id, conversion_factor FROM im_uom_conversion WHERE barcode = $1 AND is_active = true LIMIT 1`, [code])).rows[0];
    if (unit) return { item_id: unit.item_id, uom_id: unit.uom_id, factor: Number(unit.conversion_factor) };
    const it = (await db.query(`SELECT id, base_uom_id FROM im_item WHERE barcode = $1 LIMIT 1`, [code])).rows[0];
    if (it) return { item_id: it.id, uom_id: it.base_uom_id, factor: 1 };
    return null;
};

module.exports = { PURPOSES, QTY_DP_MAX, resolveFactor, toBaseQty, fitQty, isCount, listItemUoms, findByBarcode, checkDecimals, decimalsOf, uomError };
