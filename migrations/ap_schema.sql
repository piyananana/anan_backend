-- AP Module Schema Migration
-- sys_module = '21' for AP documents in sa_module_document

-- ── Vendor master ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ap_vendor (
    id               SERIAL PRIMARY KEY,
    vendor_code      VARCHAR(50) UNIQUE NOT NULL,
    old_vendor_code  VARCHAR(50),
    vendor_name_th   VARCHAR(255) NOT NULL,
    vendor_name_en   VARCHAR(255),
    tax_id           VARCHAR(30),
    business_type_id INTEGER REFERENCES cd_business_type(id),
    credit_term_months INTEGER DEFAULT 0,
    credit_term_days   INTEGER DEFAULT 30,
    currency_code    VARCHAR(10) DEFAULT 'THB',
    is_active        BOOLEAN DEFAULT TRUE,
    remark           TEXT,
    ap_account_id    INTEGER REFERENCES gl_account(id),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    created_by       VARCHAR(100),
    updated_by       VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS ap_vendor_address (
    id                        SERIAL PRIMARY KEY,
    vendor_id                 INTEGER NOT NULL REFERENCES ap_vendor(id) ON DELETE CASCADE,
    address_type              VARCHAR(30) DEFAULT 'billing',
    address_no                VARCHAR(50),
    address_building_village  VARCHAR(255),
    address_alley             VARCHAR(100),
    address_road              VARCHAR(100),
    address_sub_district      VARCHAR(100),
    address_district          VARCHAR(100),
    address_province          VARCHAR(100),
    address_country           VARCHAR(100) DEFAULT 'Thailand',
    address_zip_code          VARCHAR(10),
    is_default                BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS ap_vendor_contact (
    id           SERIAL PRIMARY KEY,
    vendor_id    INTEGER NOT NULL REFERENCES ap_vendor(id) ON DELETE CASCADE,
    contact_name VARCHAR(255) NOT NULL,
    position     VARCHAR(100),
    phone        VARCHAR(50),
    mobile       VARCHAR(50),
    email        VARCHAR(255),
    is_default   BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS ap_vendor_bank_account (
    id             SERIAL PRIMARY KEY,
    vendor_id      INTEGER NOT NULL REFERENCES ap_vendor(id) ON DELETE CASCADE,
    bank_name      VARCHAR(100),
    branch_name    VARCHAR(100),
    account_number VARCHAR(50),
    account_name   VARCHAR(255),
    account_type   VARCHAR(30) DEFAULT 'current',
    is_default     BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS ap_vendor_running (
    id                  SERIAL PRIMARY KEY,
    is_auto_numbering   BOOLEAN DEFAULT FALSE,
    format_prefix       VARCHAR(20) DEFAULT '',
    format_separator    VARCHAR(5)  DEFAULT '',
    format_suffix_date  VARCHAR(10) DEFAULT '',
    running_length      INTEGER DEFAULT 4,
    next_running_number INTEGER DEFAULT 1,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    created_by          VARCHAR(100),
    updated_by          VARCHAR(100)
);

-- ── AP Transactions ───────────────────────────────────────────────────────
-- sys_doc_type reference (AP module = sys_module '21'):
--   10 = Purchase Invoice (PI)
--   30 = Credit Note from vendor (CN-AP, reduces AP)
--   50 = Debit Note (DN-AP, increases AP)
--   60 = Advance Payment (มัดจำจ่าย)
--   65 = Advance Refund (รับมัดจำคืน)
--   70 = Remittance Advice (RA, ใบแจ้งชำระ — informational)
--   80 = Payment (ชำระเงิน)

CREATE TABLE IF NOT EXISTS ap_transaction (
    id               SERIAL PRIMARY KEY,
    doc_id           INTEGER NOT NULL REFERENCES sa_module_document(id),
    doc_no           VARCHAR(50) NOT NULL,
    doc_date         DATE NOT NULL,
    due_date         DATE,
    period_id        INTEGER REFERENCES gl_posting_period(id),
    vendor_id        INTEGER NOT NULL REFERENCES ap_vendor(id),
    vendor_code      VARCHAR(50),
    vendor_name_th   VARCHAR(255),
    ap_account_id    INTEGER REFERENCES gl_account(id),
    gl_doc_id        INTEGER REFERENCES sa_module_document(id),
    currency_id      INTEGER REFERENCES cd_currency(id),
    currency_code    VARCHAR(10) DEFAULT 'THB',
    exchange_rate    NUMERIC(15,6) DEFAULT 1,
    subtotal_fc      NUMERIC(15,2) DEFAULT 0,
    discount_amount_fc NUMERIC(15,2) DEFAULT 0,
    before_vat_fc    NUMERIC(15,2) DEFAULT 0,
    vat_amount_fc    NUMERIC(15,2) DEFAULT 0,
    total_amount_fc  NUMERIC(15,2) DEFAULT 0,
    subtotal_lc      NUMERIC(15,2) DEFAULT 0,
    discount_amount_lc NUMERIC(15,2) DEFAULT 0,
    before_vat_lc    NUMERIC(15,2) DEFAULT 0,
    vat_amount_lc    NUMERIC(15,2) DEFAULT 0,
    total_amount_lc  NUMERIC(15,2) DEFAULT 0,
    paid_amount_lc   NUMERIC(15,2) DEFAULT 0,
    balance_amount_lc NUMERIC(15,2) DEFAULT 0,
    wht_amount_lc    NUMERIC(15,2) DEFAULT 0,
    advance_amount_lc NUMERIC(15,2) DEFAULT 0,
    ref_no           VARCHAR(100),
    ref_doc_id       INTEGER REFERENCES sa_module_document(id),
    ref_doc_no       VARCHAR(50),
    description      TEXT,
    status           VARCHAR(20) DEFAULT 'Draft',
    gl_entry_id      INTEGER REFERENCES gl_entry_header(id),
    dim1_id          INTEGER,
    dim2_id          INTEGER,
    dim3_id          INTEGER,
    dim4_id          INTEGER,
    dim5_id          INTEGER,
    branch_id        INTEGER REFERENCES cd_branch(id),
    revaluation_rate NUMERIC(15,6),
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    created_by       VARCHAR(100),
    updated_by       VARCHAR(100)
);
CREATE INDEX IF NOT EXISTS idx_ap_transaction_vendor  ON ap_transaction(vendor_id);
CREATE INDEX IF NOT EXISTS idx_ap_transaction_doc_date ON ap_transaction(doc_date);
CREATE INDEX IF NOT EXISTS idx_ap_transaction_status  ON ap_transaction(status);

CREATE TABLE IF NOT EXISTS ap_transaction_detail (
    id                 SERIAL PRIMARY KEY,
    header_id          INTEGER NOT NULL REFERENCES ap_transaction(id) ON DELETE CASCADE,
    line_no            INTEGER DEFAULT 1,
    description        TEXT,
    quantity           NUMERIC(15,4) DEFAULT 1,
    unit_price_fc      NUMERIC(15,4) DEFAULT 0,
    discount_percent   NUMERIC(5,2)  DEFAULT 0,
    discount_amount_fc NUMERIC(15,2) DEFAULT 0,
    subtotal_fc        NUMERIC(15,2) DEFAULT 0,
    vat_type           VARCHAR(10)   DEFAULT 'NOVAT',
    vat_rate           NUMERIC(5,2)  DEFAULT 0,
    vat_amount_fc      NUMERIC(15,2) DEFAULT 0,
    total_amount_fc    NUMERIC(15,2) DEFAULT 0,
    expense_account_id INTEGER REFERENCES gl_account(id),
    subtotal_lc        NUMERIC(15,2) DEFAULT 0,
    vat_amount_lc      NUMERIC(15,2) DEFAULT 0,
    total_amount_lc    NUMERIC(15,2) DEFAULT 0,
    dim1_id            INTEGER,
    dim2_id            INTEGER,
    dim3_id            INTEGER,
    dim4_id            INTEGER,
    dim5_id            INTEGER,
    is_deferred_vat    BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS ap_transaction_apply (
    id               SERIAL PRIMARY KEY,
    transaction_id   INTEGER NOT NULL REFERENCES ap_transaction(id) ON DELETE CASCADE,
    applied_to_id    INTEGER NOT NULL REFERENCES ap_transaction(id),
    applied_amount_lc NUMERIC(15,2) DEFAULT 0,
    applied_amount_fc NUMERIC(15,2) DEFAULT 0,
    applied_date     DATE,
    apply_type       VARCHAR(30) DEFAULT 'invoice',
    created_by       VARCHAR(100)
);
CREATE INDEX IF NOT EXISTS idx_ap_transaction_apply_to ON ap_transaction_apply(applied_to_id);

CREATE TABLE IF NOT EXISTS ap_transaction_payment (
    id                  SERIAL PRIMARY KEY,
    header_id           INTEGER NOT NULL REFERENCES ap_transaction(id) ON DELETE CASCADE,
    line_no             INTEGER NOT NULL DEFAULT 1,
    payment_method_id   INTEGER REFERENCES cm_payment_method(id),
    payment_method_code VARCHAR(50),
    payment_method_name VARCHAR(200),
    payment_method_type VARCHAR(30) NOT NULL DEFAULT 'CASH',
    cm_bank_account_id  INTEGER REFERENCES cm_bank_account(id),
    gl_account_id       INTEGER REFERENCES gl_account(id),
    amount_lc           NUMERIC(18,4) NOT NULL DEFAULT 0,
    amount_fc           NUMERIC(18,4) NOT NULL DEFAULT 0,
    ref_no              VARCHAR(100),
    payment_date        DATE,
    remark              TEXT,
    drawer_bank_name    VARCHAR(100),
    drawer_bank_branch  VARCHAR(100),
    drawer_account_no   VARCHAR(50),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by          VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS ap_transaction_wht (
    id             SERIAL PRIMARY KEY,
    header_id      INTEGER NOT NULL REFERENCES ap_transaction(id) ON DELETE CASCADE,
    wht_type       VARCHAR(100),
    wht_rate       NUMERIC(5,2) DEFAULT 0,
    base_amount_lc NUMERIC(15,2) DEFAULT 0,
    wht_amount_lc  NUMERIC(15,2) DEFAULT 0,
    description    TEXT
);

-- ── GL Account Setup ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ap_gl_account_setup (
    id                           SERIAL PRIMARY KEY,
    doc_code                     VARCHAR(20) NOT NULL UNIQUE,
    ap_account_id                INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    expense_account_id           INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    vat_input_account_id         INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    discount_account_id          INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    advance_account_id           INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    wht_payable_account_id       INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    cash_account_id              INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    check_account_id             INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    transfer_account_id          INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    fx_gain_account_id           INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    fx_loss_account_id           INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    vat_pending_input_account_id INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    gl_doc_id                    INTEGER REFERENCES sa_module_document(id) ON DELETE SET NULL,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by                   VARCHAR(100),
    updated_by                   VARCHAR(100)
);

-- ── vt_transaction extension for AP Input VAT ────────────────────────────
-- Ensure vendor_id column exists in vt_transaction (optional, for AP VAT tracking)
ALTER TABLE vt_transaction ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES ap_vendor(id);

-- ── sa_module_document sample records (run once per database) ─────────────
-- Uncomment and adjust to add AP document types to the system:
--
-- INSERT INTO sa_module_document (sys_module, doc_code, doc_name_thai, sys_doc_type, is_doc_type, is_active, sort_order, is_auto_numbering)
-- VALUES
--   ('21', 'PI',   'ใบแจ้งหนี้ (AP)',            '10', TRUE, TRUE, 10, TRUE),
--   ('21', 'CNAP', 'ใบลดหนี้จากผู้ขาย',           '30', TRUE, TRUE, 30, TRUE),
--   ('21', 'DNAP', 'ใบเพิ่มหนี้ (AP)',             '50', TRUE, TRUE, 50, TRUE),
--   ('21', 'ADVP', 'จ่ายเงินมัดจำ',               '60', TRUE, TRUE, 60, TRUE),
--   ('21', 'ADVR', 'รับเงินมัดจำคืน',             '65', TRUE, TRUE, 65, TRUE),
--   ('21', 'RA',   'ใบแจ้งการชำระเงิน (RA)',      '70', TRUE, TRUE, 70, TRUE),
--   ('21', 'PAY',  'ชำระเงิน',                    '80', TRUE, TRUE, 80, TRUE)
-- ON CONFLICT (doc_code) DO NOTHING;
