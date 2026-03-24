-- ============================================================
-- AR Transaction Tables
-- ============================================================

-- 1. ตารางหัวเอกสาร AR (Invoice, Debit Note, Credit Note, Receipt)
CREATE TABLE IF NOT EXISTS ar_transaction (
    id                       SERIAL PRIMARY KEY,
    doc_id                   INTEGER NOT NULL,          -- FK -> sa_module_document.id
    doc_no                   VARCHAR(30) NOT NULL,
    doc_date                 DATE NOT NULL,
    due_date                 DATE,
    period_id                INTEGER NOT NULL,          -- FK -> gl_posting_period.id
    customer_id              INTEGER NOT NULL,          -- FK -> ar_customer.id
    customer_code            VARCHAR(20),               -- denorm snapshot
    customer_name_th         VARCHAR(200),
    ar_account_id            INTEGER,                   -- FK -> gl_account.id (ลูกหนี้)
    -- สกุลเงิน
    currency_id              INTEGER,                   -- FK -> cd_currency.id
    currency_code            CHAR(3) DEFAULT 'THB',
    exchange_rate            NUMERIC(18,6) NOT NULL DEFAULT 1,
    -- ยอดเงิน FC (Foreign Currency)
    subtotal_fc              NUMERIC(18,2) NOT NULL DEFAULT 0,
    discount_amount_fc       NUMERIC(18,2) NOT NULL DEFAULT 0,
    before_vat_fc            NUMERIC(18,2) NOT NULL DEFAULT 0,
    vat_amount_fc            NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount_fc          NUMERIC(18,2) NOT NULL DEFAULT 0,
    -- ยอดเงิน LC (Local Currency / Base Currency)
    subtotal_lc              NUMERIC(18,2) NOT NULL DEFAULT 0,
    discount_amount_lc       NUMERIC(18,2) NOT NULL DEFAULT 0,
    before_vat_lc            NUMERIC(18,2) NOT NULL DEFAULT 0,
    vat_amount_lc            NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount_lc          NUMERIC(18,2) NOT NULL DEFAULT 0,
    paid_amount_lc           NUMERIC(18,2) NOT NULL DEFAULT 0,  -- denorm: ยอดชำระแล้ว
    balance_amount_lc        NUMERIC(18,2) NOT NULL DEFAULT 0,  -- denorm: ยอดคงเหลือ
    -- ข้อมูลอ้างอิง
    ref_no                   VARCHAR(30),
    ref_doc_id               INTEGER,                   -- FK -> ar_transaction.id (เอกสารต้นทาง เช่น Invoice ที่ CN อ้างถึง)
    ref_doc_no               VARCHAR(30),
    description              TEXT,
    -- สถานะ
    status                   VARCHAR(20) NOT NULL DEFAULT 'Draft',  -- Draft, Posted, Void
    -- GL
    gl_entry_id              INTEGER,                   -- FK -> gl_entry_header.id (หลัง Post)
    -- Audit
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW(),
    created_by               VARCHAR(100),
    updated_by               VARCHAR(100)
);

-- Index สำหรับค้นหาเร็ว
CREATE INDEX IF NOT EXISTS idx_ar_transaction_customer  ON ar_transaction(customer_id);
CREATE INDEX IF NOT EXISTS idx_ar_transaction_doc_date  ON ar_transaction(doc_date);
CREATE INDEX IF NOT EXISTS idx_ar_transaction_status    ON ar_transaction(status);
CREATE INDEX IF NOT EXISTS idx_ar_transaction_period    ON ar_transaction(period_id);

-- 2. ตารางรายละเอียดเอกสาร AR (สินค้า/บริการ)
CREATE TABLE IF NOT EXISTS ar_transaction_detail (
    id                       SERIAL PRIMARY KEY,
    header_id                INTEGER NOT NULL REFERENCES ar_transaction(id) ON DELETE CASCADE,
    line_no                  SMALLINT NOT NULL,
    item_code                VARCHAR(30),
    item_name                VARCHAR(200),
    description              TEXT,
    quantity                 NUMERIC(18,4) NOT NULL DEFAULT 1,
    unit_code                VARCHAR(10),
    unit_price_fc            NUMERIC(18,4) NOT NULL DEFAULT 0,
    discount_percent         NUMERIC(5,2) NOT NULL DEFAULT 0,
    discount_amount_fc       NUMERIC(18,2) NOT NULL DEFAULT 0,
    subtotal_fc              NUMERIC(18,2) NOT NULL DEFAULT 0,  -- qty*price - discount
    -- VAT
    vat_type                 VARCHAR(10) NOT NULL DEFAULT 'VAT7',  -- VAT7, VAT0, NOVAT
    vat_rate                 NUMERIC(5,2) NOT NULL DEFAULT 7,
    vat_amount_fc            NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount_fc          NUMERIC(18,2) NOT NULL DEFAULT 0,
    -- GL Account
    revenue_account_id       INTEGER,                   -- FK -> gl_account.id (รายได้)
    -- LC equivalents
    subtotal_lc              NUMERIC(18,2) NOT NULL DEFAULT 0,
    vat_amount_lc            NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount_lc          NUMERIC(18,2) NOT NULL DEFAULT 0
);

-- 3. ตารางการจับคู่ชำระหนี้ (Receipt/CN → Invoice/DN)
CREATE TABLE IF NOT EXISTS ar_transaction_apply (
    id                       SERIAL PRIMARY KEY,
    transaction_id           INTEGER NOT NULL REFERENCES ar_transaction(id),  -- Receipt หรือ CN
    applied_to_id            INTEGER NOT NULL REFERENCES ar_transaction(id),  -- Invoice หรือ DN ที่จับคู่
    applied_amount_lc        NUMERIC(18,2) NOT NULL DEFAULT 0,
    applied_amount_fc        NUMERIC(18,2) NOT NULL DEFAULT 0,
    applied_date             DATE NOT NULL,
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    created_by               VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_ar_apply_transaction   ON ar_transaction_apply(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ar_apply_applied_to    ON ar_transaction_apply(applied_to_id);

-- 4. เพิ่ม ar_account_id ใน ar_customer
ALTER TABLE ar_customer ADD COLUMN IF NOT EXISTS ar_account_id INTEGER;

COMMENT ON COLUMN ar_customer.ar_account_id IS 'FK -> gl_account.id: บัญชีลูกหนี้สำหรับลูกค้ารายนี้ (ค่า default มาจาก ar_customer_group.gl_account_id)';
