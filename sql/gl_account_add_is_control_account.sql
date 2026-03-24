-- Add is_control_account column to gl_account
-- TRUE = บันทึกได้เฉพาะจากโมดูลอื่น (AR, AP, Inventory) ห้ามลงตรงในโมดูล GL
ALTER TABLE gl_account
  ADD COLUMN IF NOT EXISTS is_control_account BOOLEAN NOT NULL DEFAULT false;
