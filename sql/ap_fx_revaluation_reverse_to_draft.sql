-- AP FX revaluation: ถอยเป็นร่าง / ยกเลิกแบบมีเหตุผล / ลบแบบเก็บไว้ (status 'Deleted')
ALTER TABLE ap_fx_revaluation
    ADD COLUMN IF NOT EXISTS void_reason TEXT,
    ADD COLUMN IF NOT EXISTS voided_by VARCHAR(100),
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS void_gl_entry_id INT,
    ADD COLUMN IF NOT EXISTS void_reversal_gl_entry_id INT,
    -- เลขที่รายการบัญชีที่ใช้ไปแล้ว: ถอยเป็นร่างแล้วโพสต์ใหม่ใช้เลขเดิม
    ADD COLUMN IF NOT EXISTS kept_gl_doc_no VARCHAR(50),
    ADD COLUMN IF NOT EXISTS kept_reversal_doc_no VARCHAR(50);
-- อัตราปรับมูลค่าก่อนหน้าของใบตั้งหนี้ (คืนค่าตอนถอย/ยกเลิกแบบ realized)
ALTER TABLE ap_fx_revaluation_detail ADD COLUMN IF NOT EXISTS prev_revaluation_rate NUMERIC(20,6);
