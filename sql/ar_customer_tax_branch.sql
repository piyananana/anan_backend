-- รหัสสาขาตามทะเบียนภาษีมูลค่าเพิ่มของลูกค้า (5 หลัก, 00000 = สำนักงานใหญ่, ว่าง = ไม่ระบุ)
-- นโยบาย: 1 สาขา = 1 รหัสลูกค้า — ฟอร์มพิมพ์ "สาขาที่ xxxxx" ต่อท้ายเลขประจำตัวผู้เสียภาษี
-- รันซ้ำได้ (apply per DB)

ALTER TABLE ar_customer ADD COLUMN IF NOT EXISTS tax_branch_code VARCHAR(5);

-- เติมรหัสสาขาให้รายการภาษีขายเดิมที่ยังว่าง (รันซ้ำหลังกรอกรหัสสาขาในข้อมูลลูกค้าแล้วได้)
UPDATE vt_transaction vt
   SET entity_branch_code = c.tax_branch_code
  FROM ar_customer c
 WHERE c.id = vt.customer_id
   AND vt.entity_branch_code IS NULL
   AND c.tax_branch_code IS NOT NULL;

-- เลขประจำตัวผู้เสียภาษีของรายการภาษีขาย AR ที่ว่าง (หน้าจอไม่ได้ส่ง customer_tax_id มา — ตอนนี้ backend ดึงจากลูกค้าเอง)
UPDATE vt_transaction vt
   SET entity_tax_id = c.tax_id
  FROM ar_customer c
 WHERE c.id = vt.customer_id
   AND vt.module_code = 'AR'
   AND vt.entity_tax_id IS NULL
   AND c.tax_id IS NOT NULL;
