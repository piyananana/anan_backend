-- CM bank FX revaluation: ถอยเป็นร่าง / ยกเลิกแบบมีเหตุผล / ลบแบบเก็บไว้ (status 'Deleted')
ALTER TABLE cm_bank_fx_revaluation
    ADD COLUMN IF NOT EXISTS void_reason TEXT,
    ADD COLUMN IF NOT EXISTS voided_by VARCHAR(100),
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP;
