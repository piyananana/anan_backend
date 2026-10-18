-- sql/cm_transaction_reverse_to_draft.sql
-- ถอยธุรกรรม CM กลับเป็นร่าง / ยกเลิกแบบลงรายการกลับ
-- gl_doc_no: เลขที่รายการบัญชี (GL) ที่จองไว้ ตอนถอยระบบลบรายการบัญชีแต่เก็บเลขที่ไว้ โพสต์ใหม่ใช้เลขเดิม
-- void_*: เหตุผล ผู้ยกเลิก เวลา และรายการบัญชีกลับรายการ
-- รันซ้ำได้

ALTER TABLE cm_transaction ADD COLUMN IF NOT EXISTS gl_doc_no        VARCHAR(50);
ALTER TABLE cm_transaction ADD COLUMN IF NOT EXISTS void_reason      VARCHAR(500);
ALTER TABLE cm_transaction ADD COLUMN IF NOT EXISTS voided_by        VARCHAR(100);
ALTER TABLE cm_transaction ADD COLUMN IF NOT EXISTS voided_at        TIMESTAMPTZ;
ALTER TABLE cm_transaction ADD COLUMN IF NOT EXISTS void_gl_entry_id INTEGER;

-- เติมจากรายการบัญชีที่ลงไว้แล้ว
UPDATE cm_transaction t
   SET gl_doc_no = g.doc_no
  FROM gl_entry_header g
 WHERE g.id = t.gl_entry_id
   AND t.gl_doc_no IS NULL;
