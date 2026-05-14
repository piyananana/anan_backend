-- Step A: Add branch_id to ar_transaction header
ALTER TABLE ar_transaction
  ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES cd_branch(id);
