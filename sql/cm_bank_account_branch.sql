-- ============================================================
-- สาขาของบัญชีธนาคาร (user-approved 2026-11-18)
-- ตีราคา FX ธนาคาร (cm_bank_fx_revaluation) ลงบรรทัดรายการบัญชีที่สาขาของบัญชีธนาคาร
-- (วิธี 1: สาขาที่บรรทัด gl_entry_detail.branch_id — ดู sql/gl_balance_accum_trigger.sql)
-- รันซ้ำได้
-- ============================================================
ALTER TABLE cm_bank_account ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES cd_branch(id);
