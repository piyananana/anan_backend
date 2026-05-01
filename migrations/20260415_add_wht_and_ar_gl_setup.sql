-- ============================================================
-- Migration: WHT Type (CD), AR Transaction WHT, AR GL Account Setup
-- Date: 2026-04-15
-- ============================================================

-- 1. ประเภทภาษีหัก ณ ที่จ่าย (Common Data — ใช้ทั้ง AR และ AP)
CREATE TABLE IF NOT EXISTS cd_wht_type (
    id              SERIAL PRIMARY KEY,
    wht_code        VARCHAR(20)  NOT NULL UNIQUE,
    wht_name        VARCHAR(200) NOT NULL,
    income_type     VARCHAR(20),          -- '40(1)'..'40(8)', '3'
    wht_rate        NUMERIC(5,2) DEFAULT 0,
    gl_account_id   INT REFERENCES gl_account(id) ON DELETE SET NULL,
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      VARCHAR(100),
    updated_by      VARCHAR(100)
);

-- 2. รายการ WHT ต่อเอกสาร AR
CREATE TABLE IF NOT EXISTS ar_transaction_wht (
    id              SERIAL PRIMARY KEY,
    header_id       INT NOT NULL REFERENCES ar_transaction(id) ON DELETE CASCADE,
    line_no         INT NOT NULL DEFAULT 1,
    wht_type_id     INT REFERENCES cd_wht_type(id) ON DELETE SET NULL,
    -- Snapshot ณ วันที่บันทึก
    wht_code        VARCHAR(20),
    wht_name        VARCHAR(200),
    income_type     VARCHAR(20),
    wht_rate        NUMERIC(5,2),
    base_amount_lc  NUMERIC(18,4) NOT NULL DEFAULT 0,
    wht_amount_lc   NUMERIC(18,4) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ar_transaction_wht_header ON ar_transaction_wht(header_id);

-- 3. ตั้งค่ารหัสบัญชี GL สำหรับ AR (key = doc_code จาก sa_module_document)
CREATE TABLE IF NOT EXISTS ar_gl_account_setup (
    id                      SERIAL PRIMARY KEY,
    doc_code                VARCHAR(20) NOT NULL UNIQUE,  -- FK จาก sa_module_document.doc_code

    -- Invoice / DN / CN
    ar_account_id           INT REFERENCES gl_account(id) ON DELETE SET NULL,
    revenue_account_id      INT REFERENCES gl_account(id) ON DELETE SET NULL,
    vat_output_account_id   INT REFERENCES gl_account(id) ON DELETE SET NULL,
    discount_account_id     INT REFERENCES gl_account(id) ON DELETE SET NULL,

    -- เงินมัดจำ (doc_type Advance + Receipt ตัดมัดจำ)
    advance_account_id      INT REFERENCES gl_account(id) ON DELETE SET NULL,

    -- Receipt
    cash_account_id         INT REFERENCES gl_account(id) ON DELETE SET NULL,
    wht_account_id          INT REFERENCES gl_account(id) ON DELETE SET NULL,
    fx_gain_account_id      INT REFERENCES gl_account(id) ON DELETE SET NULL,
    fx_loss_account_id      INT REFERENCES gl_account(id) ON DELETE SET NULL,

    -- GL Document Type ที่ใช้เมื่อ Post
    gl_doc_id               INT REFERENCES sa_module_document(id) ON DELETE SET NULL,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by              VARCHAR(100),
    updated_by              VARCHAR(100)
);

-- 4. เพิ่ม fields ใน ar_transaction สำหรับ WHT และ Advance summary
ALTER TABLE ar_transaction
    ADD COLUMN IF NOT EXISTS wht_amount_lc   NUMERIC(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS advance_amount_lc NUMERIC(18,4) NOT NULL DEFAULT 0;
