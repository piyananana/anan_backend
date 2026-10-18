-- im_transaction: ถอยเป็นร่าง / ยกเลิก (รายการกลับวันที่ยกเลิก)
-- รันต่อฐานข้อมูล (ensureImTransactionTable เพิ่มให้อัตโนมัติเช่นกัน)
ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS gl_doc_no        VARCHAR(50);   -- เลขที่รายการบัญชีเดิม ใช้ซ้ำตอนโพสต์ใหม่
ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS linked_ap_doc_no VARCHAR(50);   -- เลขที่ใบตั้งหนี้ AP เดิม
ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS linked_ar_doc_no VARCHAR(50);   -- เลขที่ใบแจ้งหนี้ AR เดิม
ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS void_reason      TEXT;
ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS voided_by        VARCHAR(100);
ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS voided_at        TIMESTAMP;
ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS void_date        DATE;
ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS void_gl_entry_id INTEGER;
