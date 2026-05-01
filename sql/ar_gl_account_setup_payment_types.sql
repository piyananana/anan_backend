-- ar_gl_account_setup_payment_types.sql
-- เพิ่มคอลัมน์บัญชีรับชำระตามวิธีชำระเงิน 7 ประเภท
-- รัน 1 ครั้งต่อ database

ALTER TABLE ar_gl_account_setup
    ADD COLUMN IF NOT EXISTS check_account_id            INT REFERENCES gl_account(id),
    ADD COLUMN IF NOT EXISTS transfer_account_id         INT REFERENCES gl_account(id),
    ADD COLUMN IF NOT EXISTS credit_card_account_id      INT REFERENCES gl_account(id),
    ADD COLUMN IF NOT EXISTS debit_card_account_id       INT REFERENCES gl_account(id),
    ADD COLUMN IF NOT EXISTS qr_code_account_id          INT REFERENCES gl_account(id),
    ADD COLUMN IF NOT EXISTS mobile_banking_account_id   INT REFERENCES gl_account(id),
    ADD COLUMN IF NOT EXISTS bill_of_exchange_account_id INT REFERENCES gl_account(id);
