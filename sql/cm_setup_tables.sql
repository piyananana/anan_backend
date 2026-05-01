-- cm_setup_tables.sql
-- Cash Management setup tables: cm_bank, cm_bank_account, cm_payment_method

-- ──────────────��────────────────────────────────��─────────────────────────────
-- 1. cm_bank  — ธนาคาร
-- ─────────────────────────────────────────────────��───────────────────────────
CREATE TABLE IF NOT EXISTS cm_bank (
  id            SERIAL PRIMARY KEY,
  bank_code     VARCHAR(20)  UNIQUE NOT NULL,
  bank_name_th  VARCHAR(200) NOT NULL,
  bank_name_en  VARCHAR(200),
  short_name    VARCHAR(50),
  swift_code    VARCHAR(20),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  remark        TEXT,
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  created_by    INT,
  updated_by    INT
);

-- ─────────────────────────────────────────���───────────────────────────────────
-- 2. cm_bank_account  — บัญชีธนาคาร
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cm_bank_account (
  id               SERIAL PRIMARY KEY,
  account_code     VARCHAR(50)  UNIQUE NOT NULL,
  account_name_th  VARCHAR(200) NOT NULL,
  account_name_en  VARCHAR(200),
  bank_id          INT REFERENCES cm_bank(id),
  account_number   VARCHAR(100),
  account_type     VARCHAR(20)  NOT NULL DEFAULT 'SAVING',
                   -- SAVING (ออมทรัพย์) / CURRENT (กระแสรายวัน) / FIXED (ฝากประจำ)
  gl_account_id    INT REFERENCES gl_account(id),
  is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
  remark           TEXT,
  created_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  created_by       INT,
  updated_by       INT
);

-- ──────────────────────────────���──────────────────────────────────────────────
-- 3. cm_payment_method  — ประเภทการชำระเงิน
-- ────────────────────────────────────────────��───────────────────────────���────
-- GL resolution priority (for AR/AP posting):
--   1st: ar_gl_account_setup (by doc_type)
--   2nd: cm_payment_method.gl_account_id
--   3rd: cm_bank_account.gl_account_id
CREATE TABLE IF NOT EXISTS cm_payment_method (
  id                  SERIAL PRIMARY KEY,
  method_code         VARCHAR(50)  UNIQUE NOT NULL,
  method_name_th      VARCHAR(200) NOT NULL,
  method_name_en      VARCHAR(200),
  method_type         VARCHAR(30)  NOT NULL DEFAULT 'CASH',
                      -- CASH / CHECK / TRANSFER / BILL_OF_EXCHANGE
  gl_account_id       INT REFERENCES gl_account(id),
  cm_bank_account_id  INT REFERENCES cm_bank_account(id),
  is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
  remark              TEXT,
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  created_by          INT,
  updated_by          INT
);
