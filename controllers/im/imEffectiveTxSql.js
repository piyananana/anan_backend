// เอกสาร IM ที่มีผลต่อสต็อก สำหรับรายงานที่คำนวณยอด ณ วันที่ (ใช้แทน "FROM im_transaction t")
// - Posted / Received / Delivered: มีผล ณ วันที่เอกสาร
// - Void ที่ยกเลิกแบบลงรายการกลับ (มี void_date): เอกสารเดิมยังมีผล ณ วันที่เอกสาร (งวดเดิมไม่เปลี่ยน)
//   และมีรายการกลับ (sign = -1) ณ วันที่ยกเลิก — ตรงกับรายการบัญชีที่ลงกลับในวันที่ยกเลิก
//   Void แบบเดิมที่ไม่มี void_date ไม่นับ (ตามพฤติกรรมเดิม)
// คอลัมน์เพิ่ม: eff_date (วันที่ที่มีผล), sign (1 / -1), is_reversal
const IM_EFFECTIVE_TX = `(
    SELECT t.*, t.doc_date AS eff_date, 1 AS sign, FALSE AS is_reversal FROM im_transaction t
     WHERE t.status IN ('Posted', 'Received', 'Delivered') OR (t.status = 'Void' AND t.void_date IS NOT NULL)
    UNION ALL
    SELECT t.*, t.void_date AS eff_date, -1 AS sign, TRUE AS is_reversal FROM im_transaction t
     WHERE t.status = 'Void' AND t.void_date IS NOT NULL)`;

// เลขที่เอกสารที่แสดงในรายงาน — รายการกลับต่อท้ายด้วย (VOID)
const IM_EFFECTIVE_DOC_NO = `CASE WHEN t.is_reversal THEN t.doc_no || ' (VOID)' ELSE t.doc_no END`;

// ตัวกรองสถานะของรายงาน (query ?statuses=Posted,Void,...) — ไม่ส่งมา = ค่าเริ่มต้นของรายงานนั้น
const IM_REPORT_STATUSES = ['Draft', 'Posted', 'Received', 'Delivered', 'Void', 'Deleted'];
const parseStatuses = (raw, defaults) => {
    if (raw === undefined || raw === null || raw === '') return defaults;
    const list = String(raw).split(',').map(s => s.trim()).filter(s => IM_REPORT_STATUSES.includes(s));
    return list.length > 0 ? list : defaults;
};

// จำนวน/มูลค่าต่อบรรทัด — เอกสารร่าง/ลบแล้วยังไม่ได้คำนวณ qty (คำนวณตอนโพสต์) จึงใช้ ยอดนับ - ยอดในระบบ แทน
const IM_LINE_QTY = `CASE WHEN t.status IN ('Draft', 'Deleted') THEN COALESCE(dt.counted_qty, 0) - COALESCE(dt.system_qty, 0) ELSE dt.qty END`;
const IM_LINE_VALUE = `CASE WHEN t.status IN ('Draft', 'Deleted') THEN (COALESCE(dt.counted_qty, 0) - COALESCE(dt.system_qty, 0)) * COALESCE(dt.unit_cost, 0) ELSE dt.total_value_lc END`;

module.exports = { IM_EFFECTIVE_TX, IM_EFFECTIVE_DOC_NO, IM_REPORT_STATUSES, parseStatuses, IM_LINE_QTY, IM_LINE_VALUE };
