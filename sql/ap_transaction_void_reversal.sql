-- sql/ap_transaction_void_reversal.sql
-- ยกเลิกเอกสาร AP แบบลงรายการกลับ: เก็บเหตุผล ผู้ยกเลิก เวลา และรายการบัญชีกลับรายการ
-- รันซ้ำได้

ALTER TABLE ap_transaction ADD COLUMN IF NOT EXISTS void_reason      VARCHAR(500);
ALTER TABLE ap_transaction ADD COLUMN IF NOT EXISTS voided_by        VARCHAR(100);
ALTER TABLE ap_transaction ADD COLUMN IF NOT EXISTS voided_at        TIMESTAMPTZ;
ALTER TABLE ap_transaction ADD COLUMN IF NOT EXISTS void_gl_entry_id INTEGER;
