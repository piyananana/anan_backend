-- ใบเสนอราคา: ถอย (ส่งอนุมัติ/อนุมัติแล้ว -> ร่าง, ปิด -> เปิดใหม่) / ยกเลิกแบบมีเหตุผล / ลบแบบเก็บไว้ (status 'Deleted')
ALTER TABLE quote_transaction
    ADD COLUMN IF NOT EXISTS void_reason TEXT,
    ADD COLUMN IF NOT EXISTS voided_by   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
