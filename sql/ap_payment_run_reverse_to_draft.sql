-- ใบอนุมัติจ่าย (payment run): ถอย / ยกเลิกแบบมีเหตุผล / ลบแบบเก็บไว้ (status 'Deleted')
ALTER TABLE ap_payment_run
    ADD COLUMN IF NOT EXISTS void_reason TEXT,
    ADD COLUMN IF NOT EXISTS voided_by   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
