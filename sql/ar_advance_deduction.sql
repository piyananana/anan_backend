-- Migration: Advance Deduction in Receipt
-- วันที่: 2026-04-24

-- เพิ่ม apply_type เพื่อแยกระหว่าง "ชำระ Invoice" กับ "หักมัดจำ"
ALTER TABLE ar_transaction_apply
    ADD COLUMN IF NOT EXISTS apply_type VARCHAR(20) DEFAULT 'invoice';
-- 'invoice' = จับคู่ชำระ Invoice/DN/CN
-- 'advance' = หักมัดจำ (ตัด Advance Receipt)

-- index เพื่อ query เร็วขึ้น
CREATE INDEX IF NOT EXISTS idx_ar_apply_type ON ar_transaction_apply(apply_type);
