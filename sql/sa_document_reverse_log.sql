-- sql/sa_document_reverse_log.sql
-- ประวัติการถอยเอกสารกลับเป็นร่าง และการลบเอกสาร (to_status = 'Deleted') ใช้ร่วมทุกโมดูล: GL, AP, AR, CM, IM, ...
-- เอกสารที่ถอยเป็นร่างแล้วบันทึกใหม่จะใช้เลขที่เดิม ตารางนี้จึงเป็นหลักฐานให้ตรวจย้อนหลังได้ว่า
-- ใครถอย เมื่อไร เพราะอะไร
-- รันซ้ำได้

CREATE TABLE IF NOT EXISTS sa_document_reverse_log (
    id          SERIAL PRIMARY KEY,
    sys_module  VARCHAR(2)   NOT NULL,          -- '01'=GL, '11'=AR, '21'=AP, ...
    table_name  VARCHAR(60)  NOT NULL,          -- ตารางหัวเอกสาร เช่น gl_entry_header
    record_id   INTEGER      NOT NULL,          -- id ของหัวเอกสาร
    doc_no      VARCHAR(50),
    from_status VARCHAR(30),
    to_status   VARCHAR(30)  NOT NULL DEFAULT 'Draft',
    reason      VARCHAR(500) NOT NULL,
    created_by  INTEGER,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sa_document_reverse_log_record
    ON sa_document_reverse_log (table_name, record_id);
