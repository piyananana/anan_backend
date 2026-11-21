// utils/reportUom.js — หน่วยแสดงผลของรายงานสต็อก (ขั้นที่ 6 หน่วยนับหลายหน่วย, 2026-11-21)
//
// รายงานคำนวณเป็นหน่วยหลักเสมอ แล้วแปลงตอน SELECT ตาม uom_mode ที่หน้าจอส่งมา:
//   base   (ค่าเริ่มต้น) = หน่วยหลักของสินค้า
//   report = หน่วยรายงานที่ตั้งไว้ที่สินค้า (im_uom_conversion.is_report_default, หน่วยที่เปิดใช้งาน)
//            จำนวน ÷ อัตราแปลง, ต้นทุนต่อหน่วย × อัตราแปลง, มูลค่าเท่าเดิม — สินค้าที่ไม่ได้ตั้งหน่วยรายงานแสดงหน่วยหลัก
// คอลัมน์ uom_code/uom_name_th/uom_name_en ที่คืนเป็นหน่วยที่ใช้แสดงจริง หน้าจอ/PDF/Excel เดิมจึงใช้ได้ทันที
'use strict';

/**
 * @param {string} mode       uom_mode จาก query ('report' = หน่วยรายงาน อื่น ๆ = หน่วยหลัก)
 * @param {string} item       alias ของ im_item ใน query
 * @param {string} baseUom    alias ของ im_uom ที่ join หน่วยหลักของสินค้า
 */
const reportUom = (mode, item = 'it', baseUom = 'u') => {
    const on = mode === 'report';
    const f = `COALESCE(NULLIF(rpt.factor, 0), 1)`;
    return {
        on,
        join: on ? `LEFT JOIN LATERAL (
                SELECT c.conversion_factor AS factor, ru.uom_code, ru.uom_name_th, ru.uom_name_en
                  FROM im_uom_conversion c JOIN im_uom ru ON ru.id = c.uom_id
                 WHERE c.item_id = ${item}.id AND c.is_report_default = true AND c.is_active IS NOT FALSE
                 ORDER BY c.id LIMIT 1
            ) rpt ON true` : '',
        /** จำนวน (หน่วยหลัก) → หน่วยแสดงผล */
        qty: (expr) => (on ? `ROUND((${expr}) / ${f}, 6)` : `(${expr})`),
        /** ต้นทุน/ราคาต่อหน่วยหลัก → ต่อหน่วยแสดงผล */
        cost: (expr) => (on ? `((${expr}) * ${f})` : `(${expr})`),
        /** คอลัมน์หน่วย (uom_code, uom_name_th, uom_name_en) + อัตราแปลงที่ใช้ (display_factor) */
        uomCols: on
            ? `COALESCE(rpt.uom_code, ${baseUom}.uom_code) AS uom_code,
               CASE WHEN rpt.uom_code IS NULL THEN ${baseUom}.uom_name_th ELSE rpt.uom_name_th END AS uom_name_th,
               CASE WHEN rpt.uom_code IS NULL THEN ${baseUom}.uom_name_en ELSE rpt.uom_name_en END AS uom_name_en,
               ${f} AS display_factor`
            : `${baseUom}.uom_code, ${baseUom}.uom_name_th, ${baseUom}.uom_name_en, 1 AS display_factor`,
    };
};

module.exports = { reportUom };
