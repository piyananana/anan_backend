-- sql/ap_transaction_reverse_to_draft.sql
-- ถอยเอกสาร AP กลับเป็นร่าง: เก็บเลขที่รายการบัญชี (GL) ที่จองไว้บนเอกสาร AP
-- ตอนถอยระบบจะลบรายการบัญชีออก แต่เก็บเลขที่ไว้ เมื่อโพสต์ใหม่จะใช้เลขเดิม (ไม่เกิดเลขขาดช่วง/เอกสารยกเลิก)
-- รันซ้ำได้

ALTER TABLE ap_transaction ADD COLUMN IF NOT EXISTS gl_doc_no VARCHAR(50);

-- เติมจากรายการบัญชีที่ลงไว้แล้ว
UPDATE ap_transaction t
   SET gl_doc_no = g.doc_no
  FROM gl_entry_header g
 WHERE g.id = t.gl_entry_id
   AND t.gl_doc_no IS NULL;
