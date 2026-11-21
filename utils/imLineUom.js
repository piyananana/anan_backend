// utils/imLineUom.js — หน่วยนับหลายหน่วยในบรรทัดเอกสาร IM (ขั้นที่ 2, 2026-11-21)
//
// หน้าจอส่งบรรทัดตามหน่วยในเอกสาร: uom_id + uom_qty (จำนวนตามหน่วยนั้น) + ราคา/ต้นทุนต่อหน่วยนั้น
// ก่อนบันทึก normalizeImLines() แปลงบรรทัดเป็นหน่วยหลัก เพื่อให้ engine สต็อก/ต้นทุน/GL/AR/AP เดิมทำงานได้โดยไม่ต้องแก้:
//   - counted_qty = system_qty ± จำนวนหน่วยหลัก (ทิศทางตามที่หน้าจอคำนวณมา)
//   - unit_cost / unit_cost_fc / unit_price / net_unit_price = ราคาต่อหน่วยหลัก = ราคาที่กรอก ÷ อัตราแปลงจริงของบรรทัด
//     อัตราแปลงจริง = จำนวนหน่วยหลัก ÷ จำนวนในเอกสาร (หลังปัด) — ยอดเงิน (จำนวนหลัก × ราคาต่อหน่วยหลัก) จึงเท่ากับ
//     จำนวนในเอกสาร × ราคาที่กรอกเสมอ แม้จำนวนหน่วยหลักถูกปัด (คอลัมน์ราคา NUMERIC(24,10))
//   - ค่าที่กรอกจริงเก็บไว้ที่ uom_qty / conversion_factor (snapshot) / uom_unit_* สำหรับแสดงผล แก้ไข และพิมพ์
// บรรทัดหน่วยหลัก (หรือไม่ระบุหน่วย) ไม่เปลี่ยนค่าใด ๆ — เก็บ uom_qty = จำนวน, factor = 1
'use strict';

const { resolveFactor, toBaseQty, uomError } = require('./uom');

// งานของแต่ละประเภทเอกสาร IM (sys_doc_type) — ใช้ตรวจว่าหน่วยของสินค้าอนุญาตในงานนั้น
const PURCHASE_TYPES = ['10', '11', '12', '13', '14', '15', '20', '25'];
const SALES_TYPES = ['30', '31', '32', '33', '35', '40', '45'];
const PRODUCTION_TYPES = ['90', '95'];
const BASE_ONLY_TYPES = ['80']; // ปรับยอด — กรอกยอดนับได้ (ยอดคงเหลือเป้าหมาย) เป็นหน่วยหลักเท่านั้น

const purposeOf = (sysDocType) =>
    PURCHASE_TYPES.includes(sysDocType) ? 'PURCHASE'
        : SALES_TYPES.includes(sysDocType) ? 'SALES'
            : PRODUCTION_TYPES.includes(sysDocType) ? 'PRODUCTION'
                : 'GENERAL';

const PRICE_FIELDS = [
    ['unit_cost', 'uom_unit_cost'],
    ['unit_cost_fc', 'uom_unit_cost_fc'],
    ['unit_price', 'uom_unit_price'],
    ['net_unit_price', 'uom_net_unit_price'],
    ['billed_unit_cost', 'uom_billed_unit_cost'],
    ['billed_unit_cost_fc', 'uom_billed_unit_cost_fc'],
];
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const PRICE_DP = 10; // NUMERIC(24,10)
const roundP = (n) => { const p = 10 ** PRICE_DP; return Math.round(n * p) / p; };

/**
 * แปลงบรรทัดคำขอ (หน่วยในเอกสาร) เป็นหน่วยหลักในตัว — เรียกหลังตรวจราคา/ส่วนลด/วงเงิน (ซึ่งคิดตามหน่วยในเอกสาร)
 * และก่อน INSERT บรรทัด
 */
const normalizeImLines = async (client, sysDocType, lines) => {
    const purpose = purposeOf(sysDocType);
    for (const d of lines || []) {
        if (!d || !d.item_id) continue;
        const sys = Number(d.system_qty) || 0;
        const delta = (Number(d.counted_qty) || 0) - sys;
        const item = (await client.query(`SELECT item_code, base_uom_id FROM im_item WHERE id = $1`, [d.item_id])).rows[0];
        const baseUomId = item?.base_uom_id ? Number(item.base_uom_id) : null;
        const uomId = d.uom_id ? Number(d.uom_id) : baseUomId;
        const isBase = !uomId || uomId === baseUomId;

        if (isBase || BASE_ONLY_TYPES.includes(sysDocType)) {
            if (!isBase) throw uomError(`${item.item_code}: เอกสารปรับยอดใช้หน่วยหลักเท่านั้น`);
            d.uom_id = uomId || null;
            d.conversion_factor = 1;
            d.uom_qty = BASE_ONLY_TYPES.includes(sysDocType) ? null : Math.abs(delta);
            for (const [f, u] of PRICE_FIELDS) d[u] = num(d[f]);
            continue;
        }

        const r = await resolveFactor(client, d.item_id, uomId, { purpose: purpose === 'GENERAL' ? undefined : purpose });
        if (purpose === 'GENERAL') {
            // เบิก/โอน: หน่วยของสินค้าที่ปิดใช้งานแล้วใช้ในเอกสารใหม่ไม่ได้ (ไม่มีสิทธิ์ซื้อ/ขาย/ผลิตให้ตรวจ)
            const c = (await client.query(`SELECT is_active FROM im_uom_conversion WHERE item_id = $1 AND uom_id = $2`, [d.item_id, uomId])).rows[0];
            if (c && c.is_active === false) throw uomError(`หน่วย ${r.uomCode} ของสินค้า ${item.item_code} ปิดใช้งานแล้ว`);
        }
        const docQty = num(d.uom_qty) != null ? Math.abs(num(d.uom_qty)) : Math.abs(delta);
        const b = toBaseQty(docQty, r);
        const dir = delta < 0 ? -1 : 1;
        d.counted_qty = sys + dir * b.baseQty;
        d.uom_qty = b.qty;
        d.conversion_factor = b.factor;
        const eff = b.qty > 0 ? b.baseQty / b.qty : r.factor;
        for (const [f, u] of PRICE_FIELDS) {
            const v = num(d[f]);
            d[u] = v;
            if (v != null) d[f] = roundP(v / eff);
        }
    }
    return lines;
};

/** อัตราแปลงจริงของบรรทัดที่บันทึกแล้ว (จำนวนหน่วยหลัก ÷ จำนวนในเอกสาร) — 1 ถ้าเป็นหน่วยหลัก/ข้อมูลเก่า */
const lineEffFactor = (row) => {
    const f = num(row.conversion_factor);
    const uq = num(row.uom_qty);
    if (f == null || f === 1 || !uq) return 1;
    const base = num(row.qty) != null && Number(row.qty) !== 0
        ? Math.abs(Number(row.qty))
        : Math.abs((Number(row.counted_qty) || 0) - (Number(row.system_qty) || 0));
    return base > 0 ? base / uq : f;
};

/** ราคาต่อหน่วยในเอกสาร → ต่อหน่วยหลัก ของบรรทัดที่บันทึกแล้ว (ใช้กับ endpoint ที่แก้ราคาหลังบันทึก เช่น '12'/'32') */
const toBasePrice = (row, docPrice) => {
    const v = num(docPrice);
    if (v == null) return null;
    const eff = lineEffFactor(row);
    return eff === 1 ? v : roundP(v / eff);
};

// คอลัมน์ของบรรทัด IM — เรียกจาก ensureImTransactionTable
const ensureImLineUomColumns = async (client) => {
    // รหัสหน่วยของบรรทัดใบตั้งหนี้/ลดหนี้/เพิ่มหนี้ AP ที่สร้างจาก IM (AR มี unit_code อยู่แล้ว)
    await client.query(`ALTER TABLE ap_transaction_detail ADD COLUMN IF NOT EXISTS unit_code VARCHAR(10)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction_detail
        ADD COLUMN IF NOT EXISTS uom_qty                 NUMERIC(20,6),
        ADD COLUMN IF NOT EXISTS conversion_factor       NUMERIC(18,6) NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS uom_unit_cost           NUMERIC(24,10),
        ADD COLUMN IF NOT EXISTS uom_unit_cost_fc        NUMERIC(24,10),
        ADD COLUMN IF NOT EXISTS uom_unit_price          NUMERIC(24,10),
        ADD COLUMN IF NOT EXISTS uom_net_unit_price      NUMERIC(24,10),
        ADD COLUMN IF NOT EXISTS uom_billed_unit_cost    NUMERIC(24,10),
        ADD COLUMN IF NOT EXISTS uom_billed_unit_cost_fc NUMERIC(24,10)`);
    // ราคาต่อหน่วยหลักต้องละเอียดพอให้ จำนวนหลัก × ราคา = จำนวนในเอกสาร × ราคาที่กรอก (เดิม NUMERIC(18,4))
    await client.query(`
        DO $$
        DECLARE r RECORD;
        BEGIN
            FOR r IN SELECT column_name FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'im_transaction_detail'
                        AND column_name IN ('unit_cost','unit_cost_fc','unit_price','net_unit_price','billed_unit_cost','billed_unit_cost_fc')
                        AND numeric_scale < 10
            LOOP
                EXECUTE format('ALTER TABLE im_transaction_detail ALTER COLUMN %I TYPE NUMERIC(24,10)', r.column_name);
            END LOOP;
        END $$`);
};

/**
 * บรรทัด IM ในมุมของหน่วยในเอกสาร — ใช้ตอนสร้างใบแจ้งหนี้/ลดหนี้/เพิ่มหนี้ AR/AP อัตโนมัติ ให้บรรทัดแสดง
 * "5 แพ็ค @40" ตามที่กรอก แทน "30 ขวด @6.6667" (ยอดเงินเท่ากัน: จำนวนหลัก × ราคาหลัก = จำนวนเอกสาร × ราคาที่กรอก)
 * qty = ±uom_qty (เครื่องหมายเดิม), base_qty = จำนวนหน่วยหลักเดิม (มูลค่าสต็อก = base_qty × ต้นทุนหน่วยหลัก),
 * unit_code = รหัสหน่วย, ราคาใน fields = ราคาหน่วยหลักที่ผู้เรียกเตรียมไว้ × อัตราจริง ปัด 6 ตำแหน่ง — ได้ราคาที่กรอกกลับมา
 * ตรงตัว (ราคาหน่วยหลักเก็บ 10 ตำแหน่ง) และใช้ได้กับราคาที่ผู้เรียกสลับมาแล้ว เช่น ราคาตามใบกำกับของ '12'
 * fields = คอลัมน์ราคาที่จะแปลง — เฉพาะที่ใช้คิดยอดเงิน (ห้ามใส่ stock_unit_cost)
 * บรรทัดหน่วยหลัก/ข้อมูลเก่า: ค่าเดิม + unit_code + base_qty
 */
const toDocUnitLines = async (client, details, fields) => {
    const ids = [...new Set((details || []).map(d => Number(d.uom_id)).filter(Boolean))];
    const codes = {};
    if (ids.length) {
        const r = await client.query(`SELECT id, uom_code FROM im_uom WHERE id = ANY($1::int[])`, [ids]);
        for (const x of r.rows) codes[Number(x.id)] = x.uom_code;
    }
    const r6 = (n) => Math.round(n * 1e6) / 1e6;
    return (details || []).map(d => {
        const unit_code = d.uom_id ? (codes[Number(d.uom_id)] || null) : null;
        const uq = num(d.uom_qty), q = Math.abs(Number(d.qty) || 0);
        const base = { ...d, unit_code, base_qty: Number(d.qty) || 0 };
        if (!(uq > 0) || !(q > 0) || Number(d.conversion_factor ?? 1) === 1) return base;
        const eff = q / uq;
        const out = { ...base, qty: (Number(d.qty) < 0 ? -1 : 1) * uq };
        for (const f of fields) if (num(d[f]) != null) out[f] = r6(num(d[f]) * eff);
        return out;
    });
};

/**
 * หน่วยของบรรทัดเอกสารสั่ง (ใบเสนอราคา/ใบสั่งขาย/ใบสั่งซื้อ ...) — จำนวน/ราคาเก็บตามหน่วยของบรรทัดเลย (ไม่แปลงเป็นหน่วยหลัก
 * เพราะเอกสารเหล่านี้ไม่ตัดสต็อก) + อัตราแปลง snapshot ไว้ใช้คิดจำนวนหน่วยหลักตอนส่ง/รับสินค้า
 * ไม่ระบุหน่วย = หน่วยหลัก, หน่วยหลักไม่ตรวจทศนิยม (เหมือนบรรทัด IM — ฐานข้อมูลที่ยังไม่ได้ตั้งประเภทหน่วยใช้ต่อได้)
 * หน่วยอื่น: ต้องอนุญาตในงาน (purpose) และจำนวนต้องตรงทศนิยมของหน่วย (นับจำนวน = ลงตัว, อื่น ๆ ปัด)
 * @returns {{ uom_id, factor, qty, base_qty }}
 */
const resolveOrderLineUom = async (client, itemId, uomId, qty, purpose) => {
    const n = Number(qty) || 0;
    const item = (await client.query(`SELECT item_code, base_uom_id FROM im_item WHERE id = $1`, [itemId])).rows[0];
    const baseId = item?.base_uom_id ? Number(item.base_uom_id) : null;
    const id = uomId ? Number(uomId) : baseId;
    if (!id || id === baseId) return { uom_id: id, factor: 1, qty: n, base_qty: n };
    const r = await resolveFactor(client, itemId, id, { purpose });
    const b = toBaseQty(Math.abs(n), r);
    const sign = n < 0 ? -1 : 1;
    return { uom_id: id, factor: b.factor, qty: sign * b.qty, base_qty: sign * b.baseQty };
};

/**
 * จำนวนที่ส่งแล้วของบรรทัดใบสั่งขาย (alias sod) เป็นหน่วยของใบสั่งขาย — บรรทัด IM ที่ใช้หน่วยเดียวกับ SO นับ uom_qty
 * ตรงตัว (ไม่เพี้ยนจากการปัดหน่วยหลัก เช่น ปอนด์ → กก.) หน่วยอื่น/ข้อมูลเก่า = จำนวนหน่วยหลัก ÷ อัตราแปลงของบรรทัด SO
 * นับเฉพาะเอกสาร IM ที่ Posted/Delivered
 */
const soDeliveredSql = (sod = 'sod') => `COALESCE((
    SELECT SUM(CASE WHEN imd.uom_qty IS NOT NULL AND imd.uom_id IS NOT DISTINCT FROM ${sod}.uom_id THEN ABS(imd.uom_qty)
                    ELSE ABS(imd.qty) / NULLIF(${sod}.conversion_factor, 0) END)
    FROM im_transaction_detail imd JOIN im_transaction imt ON imt.id = imd.header_id
    WHERE imd.ref_so_detail_id = ${sod}.id AND imt.status IN ('Posted', 'Delivered')
), 0)`;

/** จำนวนที่รับแล้วของบรรทัดใบสั่งซื้อ (alias pod) เป็นหน่วยของใบสั่งซื้อ — สูตรเดียวกับ soDeliveredSql (Posted/Received) */
const poReceivedSql = (pod = 'pod') => `COALESCE((
    SELECT SUM(CASE WHEN imd.uom_qty IS NOT NULL AND imd.uom_id IS NOT DISTINCT FROM ${pod}.uom_id THEN ABS(imd.uom_qty)
                    ELSE ABS(imd.qty) / NULLIF(${pod}.conversion_factor, 0) END)
    FROM im_transaction_detail imd JOIN im_transaction imt ON imt.id = imd.header_id
    WHERE imd.ref_po_detail_id = ${pod}.id AND imt.status IN ('Posted', 'Received')
), 0)`;

/**
 * หน่วยของบรรทัดแผน (สูตรการผลิต/ใบสั่งผลิต) — ตรวจแค่ว่าหน่วยอนุญาตในงาน (purpose) แล้วคืนอัตราแปลง ไม่ตรวจทศนิยม
 * เพราะจำนวนที่วางแผน/สเกลจากสูตรเป็นเศษได้ (การเบิก/รับจริงในเอกสาร IM ตรวจทศนิยมของหน่วยอีกครั้ง)
 * ไม่ระบุหน่วย = หน่วยหลัก (factor 1)
 */
const resolvePlanLineUom = async (client, itemId, uomId, purpose) => {
    const item = (await client.query(`SELECT base_uom_id FROM im_item WHERE id = $1`, [itemId])).rows[0];
    const baseId = item?.base_uom_id ? Number(item.base_uom_id) : null;
    const id = uomId ? Number(uomId) : baseId;
    if (!id || id === baseId) return { uom_id: id, factor: 1 };
    const r = await resolveFactor(client, itemId, id, { purpose });
    return { uom_id: id, factor: r.factor };
};

/**
 * จำนวนที่เบิก/รับแล้วของบรรทัดใบสั่งผลิต (alias) เป็นหน่วยของบรรทัดนั้น — สูตรเดียวกับ soDeliveredSql
 * refCol = ref_mo_component_detail_id (เบิก '90') หรือ ref_mo_output_detail_id (รับ '95'), นับเฉพาะ Posted
 */
const moLineDoneSql = (alias, refCol) => `COALESCE((
    SELECT SUM(CASE WHEN imd.uom_qty IS NOT NULL AND imd.uom_id IS NOT DISTINCT FROM ${alias}.uom_id THEN ABS(imd.uom_qty)
                    ELSE ABS(imd.qty) / NULLIF(${alias}.conversion_factor, 0) END)
    FROM im_transaction_detail imd JOIN im_transaction imt ON imt.id = imd.header_id
    WHERE imd.${refCol} = ${alias}.id AND imt.status = 'Posted'
), 0)`;
const moIssuedSql = (c = 'c') => moLineDoneSql(c, 'ref_mo_component_detail_id');
const moReceivedSql = (o = 'o') => moLineDoneSql(o, 'ref_mo_output_detail_id');

/**
 * จำนวนที่ขอเบิก/รับในเอกสาร IM เป็นหน่วยของบรรทัดเอกสารต้นทาง — หน่วยเดียวกัน = uom_qty ตรงตัว
 * ไม่งั้น = จำนวนหน่วยหลัก ÷ อัตราแปลงของบรรทัดต้นทาง
 */
const qtyInLineUnit = ({ requestedQty, uomId, uomQty }, line) => {
    const same = uomQty != null && Number(uomId || 0) === Number(line.uom_id || 0);
    return same ? Math.abs(Number(uomQty)) : Math.abs(Number(requestedQty)) / (Number(line.conversion_factor) || 1);
};

module.exports = { purposeOf, normalizeImLines, lineEffFactor, toBasePrice, ensureImLineUomColumns, toDocUnitLines, resolveOrderLineUom, soDeliveredSql, poReceivedSql, PRICE_FIELDS,
    resolvePlanLineUom, moIssuedSql, moReceivedSql, qtyInLineUnit };
