-- Add effective_date and end_date columns to cd_wht_type
ALTER TABLE cd_wht_type
  ADD COLUMN IF NOT EXISTS effective_date DATE,
  ADD COLUMN IF NOT EXISTS end_date       DATE;
