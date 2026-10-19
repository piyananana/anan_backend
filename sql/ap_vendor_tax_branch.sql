-- รหัสสาขาตามทะเบียนภาษีมูลค่าเพิ่มของผู้ขาย (5 หลัก, 00000 = สำนักงานใหญ่, ว่าง = ไม่ระบุ)
-- นโยบาย: 1 สาขา = 1 รหัสผู้ขาย (มิเรอร์ ar_customer.tax_branch_code)
-- รันซ้ำได้ (apply per DB)

ALTER TABLE ap_vendor ADD COLUMN IF NOT EXISTS tax_branch_code VARCHAR(5);

-- เติมรหัสสาขาให้รายการภาษีซื้อเดิมที่ยังว่าง (รันซ้ำหลังกรอกรหัสสาขาในข้อมูลผู้ขายแล้วได้)
UPDATE vt_transaction vt
   SET entity_branch_code = v.tax_branch_code
  FROM ap_vendor v
 WHERE v.id = vt.vendor_id
   AND vt.entity_branch_code IS NULL
   AND v.tax_branch_code IS NOT NULL;

-- เลขประจำตัวผู้เสียภาษีของรายการภาษีซื้อ AP ที่ว่าง (หน้าจอไม่ได้ส่ง vendor_tax_id มา — ตอนนี้ backend ดึงจากผู้ขายเอง)
UPDATE vt_transaction vt
   SET entity_tax_id = v.tax_id
  FROM ap_vendor v
 WHERE v.id = vt.vendor_id
   AND vt.module_code = 'AP'
   AND vt.entity_tax_id IS NULL
   AND v.tax_id IS NOT NULL;
