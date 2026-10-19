// รหัสสาขาตามทะเบียนภาษีมูลค่าเพิ่ม (ลูกค้า ar_customer / ผู้ขาย ap_vendor) — 5 หลัก, '00000' = สำนักงานใหญ่,
// ว่าง = ไม่ระบุ (บุคคลธรรมดา / ไม่ได้จด VAT — ฟอร์มไม่พิมพ์ข้อความสาขา)
// นโยบาย: 1 สาขา = 1 รหัสลูกค้า/ผู้ขาย จึงเก็บที่ตัวลูกค้า/ผู้ขายโดยตรง ไม่ต้อง snapshot ลงเอกสาร
// (vt_transaction.entity_branch_code เก็บค่า ณ วันบันทึกภาษีอยู่แล้ว)

// คืน { value } (null หรือสตริงตัวเลข 5 หลัก) หรือ { error } — รับตัวเลขจาก Excel ที่ถูกตัดศูนย์นำหน้าด้วย (0 → '00000')
const normalizeTaxBranch = (v) => {
  if (v === undefined || v === null) return { value: null };
  const s = String(v).trim();
  if (s === '') return { value: null };
  if (!/^\d{1,5}$/.test(s)) return { error: 'รหัสสาขาต้องเป็นตัวเลข 5 หลัก (00000 = สำนักงานใหญ่)' };
  return { value: s.padStart(5, '0') };
};

// SQL ดึงรหัสสาขาของคู่ค้าจาก id — ใช้ to_jsonb เพื่อไม่ error ถ้าฐานข้อมูลยังไม่ได้เพิ่มคอลัมน์ (คืน NULL)
const branchCodeSql = (table, idParam) =>
  `(SELECT to_jsonb(x)->>'tax_branch_code' FROM ${table} x WHERE x.id = ${idParam})`;

module.exports = { normalizeTaxBranch, branchCodeSql };
