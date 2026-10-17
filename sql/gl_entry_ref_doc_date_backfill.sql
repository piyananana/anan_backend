-- sql/gl_entry_ref_doc_date_backfill.sql
-- เติมวันที่เอกสารอ้างอิง (ref_doc_date) ให้รายการบัญชีที่ลงอัตโนมัติจากโมดูลอื่นก่อนหน้านี้
-- (โค้ดเดิมใส่เฉพาะ ref_doc_id/ref_doc_no) และเติมเอกสารอ้างอิงของรายการจาก CM ซึ่งเดิมไม่ได้ใส่เลย
-- รันซ้ำได้: แก้เฉพาะแถวที่ยังว่าง  ไม่กระทบ gl_balance_accum (trigger ดูเฉพาะ status/period/currency/branch)

BEGIN;

-- 1. CM: เอกสารอ้างอิง = เอกสาร CM ที่สร้างรายการนี้
UPDATE gl_entry_header h
   SET ref_doc_id = c.doc_id, ref_doc_no = c.doc_no, ref_doc_date = c.doc_date
  FROM cm_transaction c
 WHERE c.gl_entry_id = h.id
   AND h.ref_doc_no IS NULL;

-- 2. รายการจาก AP / AR / IM / MO / CM: วันที่ของเอกสารต้นทางที่มีรหัสเอกสารและเลขที่ตรงกัน
UPDATE gl_entry_header h
   SET ref_doc_date = s.doc_date
  FROM (
        SELECT doc_id, doc_no, doc_date FROM ap_transaction
        UNION ALL SELECT doc_id, doc_no, doc_date FROM ar_transaction
        UNION ALL SELECT doc_id, doc_no, doc_date FROM im_transaction
        UNION ALL SELECT doc_id, doc_no, doc_date FROM cm_transaction
        UNION ALL SELECT doc_id, doc_no, doc_date FROM mo_header
       ) s
 WHERE h.ref_doc_date IS NULL
   AND h.ref_doc_id = s.doc_id
   AND h.ref_doc_no = s.doc_no;

-- 3. รายการกลับรายการ/ยกเลิกของ FX revaluation และค่าเผื่อหนี้สงสัยจะสูญ: อ้างอิงรายการบัญชีต้นฉบับ
UPDATE gl_entry_header h
   SET ref_doc_date = g.doc_date
  FROM gl_entry_header g
 WHERE h.ref_doc_date IS NULL
   AND h.ref_doc_no IS NOT NULL
   AND g.id = h.ref_doc_id
   AND g.doc_no = h.ref_doc_no;

-- 4. รายการกลับรายการจากการยกเลิกเอกสาร AR (ref_doc_no = เลขที่ AR, external_source_id = ar_transaction.id)
UPDATE gl_entry_header h
   SET ref_doc_date = t.doc_date
  FROM ar_transaction t
 WHERE h.ref_doc_date IS NULL
   AND h.external_source_id = t.id
   AND h.ref_doc_no = t.doc_no;

COMMIT;

-- ตรวจสอบ: รายการที่มีเลขที่อ้างอิงแต่ยังไม่มีวันที่อ้างอิง
-- SELECT h.id, h.doc_no, h.ref_doc_id, h.ref_doc_no FROM gl_entry_header h
--  WHERE h.ref_doc_no IS NOT NULL AND h.ref_doc_date IS NULL;
