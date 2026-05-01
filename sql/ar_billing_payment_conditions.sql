-- =============================================================================
-- Migration: billing/payment conditions + credit term refactor
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ar_customer_billing_condition
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ar_customer_billing_condition (
  id                    SERIAL PRIMARY KEY,
  customer_id           INTEGER NOT NULL REFERENCES ar_customer(id) ON DELETE CASCADE,
  sort_order            SMALLINT NOT NULL DEFAULT 1,
  bill_with_delivery    BOOLEAN NOT NULL DEFAULT false,
  billing_day_of_month  SMALLINT[],   -- [1..30, 31=สิ้นเดือน]  null/{}=ไม่ระบุ
  billing_day_of_week   SMALLINT[],   -- [0..6]                  null/{}=ไม่ระบุ
  billing_week_of_month SMALLINT[],   -- [1,2,3,4,-1=สุดท้าย]   null/{}=ทุกสัปดาห์
  billing_time_from     VARCHAR(5),   -- 'HH:mm'
  billing_time_to       VARCHAR(5),   -- 'HH:mm'
  due_from_billing_date BOOLEAN NOT NULL DEFAULT false,
  remark                TEXT
);
CREATE INDEX IF NOT EXISTS idx_ar_billing_cond_customer ON ar_customer_billing_condition(customer_id);

-- -----------------------------------------------------------------------------
-- 2. ar_customer_payment_condition
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ar_customer_payment_condition (
  id                          SERIAL PRIMARY KEY,
  customer_id                 INTEGER NOT NULL REFERENCES ar_customer(id) ON DELETE CASCADE,
  sort_order                  SMALLINT NOT NULL DEFAULT 1,
  payment_day_of_month        SMALLINT[],   -- [1..30, 31=สิ้นเดือน]
  payment_day_of_week         SMALLINT[],   -- [0..6]
  payment_week_of_month       SMALLINT[],   -- [1,2,3,4,-1=สุดท้าย]
  payment_time_from           VARCHAR(5),
  payment_time_to             VARCHAR(5),
  within_months_from_billing  SMALLINT NOT NULL DEFAULT 0,
  additional_days             SMALLINT NOT NULL DEFAULT 0,
  remark                      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ar_payment_cond_customer ON ar_customer_payment_condition(customer_id);

-- -----------------------------------------------------------------------------
-- 3. ar_customer — เพิ่ม credit_term_months, credit_term_days, requires_billing
--    แล้ว migrate ข้อมูลจาก credit_term/credit_term_type เดิม
-- -----------------------------------------------------------------------------
ALTER TABLE ar_customer
  ADD COLUMN IF NOT EXISTS credit_term_months  SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_term_days    SMALLINT NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS requires_billing    BOOLEAN  NOT NULL DEFAULT false;

-- Migrate: credit_term_type='MONTH' → months, อื่น ๆ → days
UPDATE ar_customer
SET credit_term_months = credit_term,
    credit_term_days   = 0
WHERE credit_term_type = 'MONTH'
  AND credit_term_months = 0
  AND credit_term_days   = 30;

UPDATE ar_customer
SET credit_term_days   = credit_term,
    credit_term_months = 0
WHERE credit_term_type IN ('DAY', 'WEEK')
  AND credit_term_months = 0
  AND credit_term_days   = 30;

-- Drop คอลัมน์เดิม (comment out ถ้ายังไม่พร้อม)
ALTER TABLE ar_customer
  DROP COLUMN IF EXISTS credit_term,
  DROP COLUMN IF EXISTS credit_term_type,
  DROP COLUMN IF EXISTS billing_day_of_week,
  DROP COLUMN IF EXISTS billing_week_of_month,
  DROP COLUMN IF EXISTS billing_date_from,
  DROP COLUMN IF EXISTS billing_date_to,
  DROP COLUMN IF EXISTS billing_time_from,
  DROP COLUMN IF EXISTS billing_time_to,
  DROP COLUMN IF EXISTS billing_exclude_holidays,
  DROP COLUMN IF EXISTS billing_remark;

-- -----------------------------------------------------------------------------
-- 4. ar_customer_group — เพิ่ม credit_term_months, credit_term_days
-- -----------------------------------------------------------------------------
ALTER TABLE ar_customer_group
  ADD COLUMN IF NOT EXISTS credit_term_months SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_term_days   SMALLINT NOT NULL DEFAULT 30;

-- Migrate
UPDATE ar_customer_group
SET credit_term_months = credit_term,
    credit_term_days   = 0
WHERE credit_term_type = 'MONTH'
  AND credit_term_months = 0
  AND credit_term_days   = 30;

UPDATE ar_customer_group
SET credit_term_days   = credit_term,
    credit_term_months = 0
WHERE credit_term_type IN ('DAY', 'WEEK')
  AND credit_term_months = 0
  AND credit_term_days   = 30;

-- Drop คอลัมน์เดิม (comment out ถ้ายังไม่พร้อม)
ALTER TABLE ar_customer_group
  DROP COLUMN IF EXISTS credit_term,
  DROP COLUMN IF EXISTS credit_term_type;

-- -----------------------------------------------------------------------------
-- 5. ar_customer_group — เพิ่ม requires_billing + ตารางเงื่อนไขวางบิล/ชำระ
-- -----------------------------------------------------------------------------
ALTER TABLE ar_customer_group
  ADD COLUMN IF NOT EXISTS requires_billing BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS ar_customer_group_billing_condition (
  id                    SERIAL PRIMARY KEY,
  group_id              INTEGER NOT NULL REFERENCES ar_customer_group(id) ON DELETE CASCADE,
  sort_order            SMALLINT NOT NULL DEFAULT 1,
  bill_with_delivery    BOOLEAN NOT NULL DEFAULT false,
  billing_day_of_month  SMALLINT[],
  billing_day_of_week   SMALLINT[],
  billing_week_of_month SMALLINT[],
  billing_time_from     VARCHAR(5),
  billing_time_to       VARCHAR(5),
  due_from_billing_date BOOLEAN NOT NULL DEFAULT false,
  remark                TEXT
);
CREATE INDEX IF NOT EXISTS idx_ar_group_billing_cond ON ar_customer_group_billing_condition(group_id);

CREATE TABLE IF NOT EXISTS ar_customer_group_payment_condition (
  id                          SERIAL PRIMARY KEY,
  group_id                    INTEGER NOT NULL REFERENCES ar_customer_group(id) ON DELETE CASCADE,
  sort_order                  SMALLINT NOT NULL DEFAULT 1,
  payment_day_of_month        SMALLINT[],
  payment_day_of_week         SMALLINT[],
  payment_week_of_month       SMALLINT[],
  payment_time_from           VARCHAR(5),
  payment_time_to             VARCHAR(5),
  within_months_from_billing  SMALLINT NOT NULL DEFAULT 0,
  additional_days             SMALLINT NOT NULL DEFAULT 0,
  remark                      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ar_group_payment_cond ON ar_customer_group_payment_condition(group_id);
