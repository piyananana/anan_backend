-- Migration: รวม cm_bank เข้า cd_bank
-- Run ใน psql โดย superuser บน database ที่ต้องการ

-- Step 1: copy cm_bank rows ที่ยังไม่มีใน cd_bank (match by bank_code)
INSERT INTO cd_bank (bank_code, bank_name_thai, bank_name_eng, short_name, swift_code, is_active, created_by, updated_by)
SELECT cm.bank_code, cm.bank_name_th, cm.bank_name_en, cm.short_name, cm.swift_code, cm.is_active, cm.created_by, cm.updated_by
FROM cm_bank cm
WHERE NOT EXISTS (SELECT 1 FROM cd_bank cd WHERE cd.bank_code = cm.bank_code);

-- Step 2: drop FK constraints ก่อน UPDATE (FK เก่าชี้ cm_bank จะ block ค่าใหม่จาก cd_bank)
ALTER TABLE cm_bank_account DROP CONSTRAINT IF EXISTS cm_bank_account_bank_id_fkey;
ALTER TABLE cm_post_dated_check DROP CONSTRAINT IF EXISTS cm_post_dated_check_bank_id_fkey;

-- Step 3: update cm_bank_account.bank_id → cd_bank.id
UPDATE cm_bank_account ba
SET bank_id = cd.id
FROM cm_bank cm
JOIN cd_bank cd ON cd.bank_code = cm.bank_code
WHERE ba.bank_id = cm.id;

-- Step 4: update cm_post_dated_check.bank_id → cd_bank.id
UPDATE cm_post_dated_check pdc
SET bank_id = cd.id
FROM cm_bank cm
JOIN cd_bank cd ON cd.bank_code = cm.bank_code
WHERE pdc.bank_id = cm.id;

-- Step 5: add FK constraints ใหม่ชี้ไป cd_bank
ALTER TABLE cm_bank_account
  ADD CONSTRAINT cm_bank_account_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES cd_bank(id);
ALTER TABLE cm_post_dated_check
  ADD CONSTRAINT cm_post_dated_check_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES cd_bank(id);

-- Step 6: drop cm_bank table
DROP TABLE IF EXISTS cm_bank;
