-- Add gl_account_id column to cd_vat_rate
ALTER TABLE cd_vat_rate
  ADD COLUMN IF NOT EXISTS gl_account_id INT REFERENCES gl_account(id);
