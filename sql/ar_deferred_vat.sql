-- Migration: Deferred VAT (VAT ณ จ่าย)
-- วันที่: 2026-04-24

-- 1. เพิ่ม flag รายการ VAT ณ จ่าย ในตารางรายการ AR
ALTER TABLE ar_transaction_detail
    ADD COLUMN IF NOT EXISTS is_deferred_vat boolean DEFAULT false;

-- 2. เพิ่มบัญชีภาษีขายรอตัดบัญชีในตาราง ar_gl_account_setup
ALTER TABLE ar_gl_account_setup
    ADD COLUMN IF NOT EXISTS vat_pending_output_account_id integer REFERENCES gl_account(id);
