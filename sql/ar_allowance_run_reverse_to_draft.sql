-- AR allowance run: ถอยเป็นร่าง / ยกเลิกแบบมีเหตุผล / ลบแบบเก็บไว้ (status 'Deleted')
ALTER TABLE ar_allowance_run
    ADD COLUMN IF NOT EXISTS void_reason TEXT,
    ADD COLUMN IF NOT EXISTS voided_by VARCHAR(100),
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS void_gl_entry_id INT,
    -- เลขที่รายการบัญชีที่ใช้ไปแล้ว: ถอยเป็นร่างแล้วโพสต์ใหม่ใช้เลขเดิม
    ADD COLUMN IF NOT EXISTS kept_gl_doc_no VARCHAR(50);
ALTER TABLE ar_allowance_run DROP CONSTRAINT IF EXISTS ar_allowance_run_status_check;
ALTER TABLE ar_allowance_run ADD CONSTRAINT ar_allowance_run_status_check
    CHECK (status IN ('Draft', 'Posted', 'Void', 'Deleted'));
