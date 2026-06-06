-- ============================================================
-- AR Year-End Closing Tables
-- รัน 1 ครั้งต่อ database
-- ============================================================

-- 1. ตั้งค่าบัญชีสำหรับปิดสิ้นปี AR (one row per company/database)
CREATE TABLE IF NOT EXISTS ar_year_end_setup (
    id                              SERIAL PRIMARY KEY,
    -- FX Revaluation – Realized (กำไร/ขาดทุนจากอัตราแลกเปลี่ยนที่รับรู้แล้ว)
    fx_gain_account_id              INT REFERENCES gl_account(id) ON DELETE SET NULL,
    fx_loss_account_id              INT REFERENCES gl_account(id) ON DELETE SET NULL,
    -- FX Revaluation – Reversing (ยังไม่รับรู้ — กลับรายการต้นงวดใหม่)
    unrealized_fx_gain_account_id   INT REFERENCES gl_account(id) ON DELETE SET NULL,
    unrealized_fx_loss_account_id   INT REFERENCES gl_account(id) ON DELETE SET NULL,
    -- Allowance for Doubtful Accounts
    allowance_expense_account_id    INT REFERENCES gl_account(id) ON DELETE SET NULL,
    allowance_contra_account_id     INT REFERENCES gl_account(id) ON DELETE SET NULL,
    -- GL Document Type ที่ใช้สร้าง GL entry
    fx_reval_gl_doc_id              INT REFERENCES sa_module_document(id) ON DELETE SET NULL,
    allowance_gl_doc_id             INT REFERENCES sa_module_document(id) ON DELETE SET NULL,
    updated_by                      VARCHAR(100),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. กฎ % สำรองตามอายุหนี้ (user-configurable)
CREATE TABLE IF NOT EXISTS ar_allowance_rule (
    id              SERIAL PRIMARY KEY,
    age_from_days   INT NOT NULL,
    age_to_days     INT,                        -- NULL = ไม่จำกัด (> age_from_days)
    rate            NUMERIC(5,2) NOT NULL CHECK (rate >= 0 AND rate <= 100),
    sort_order      INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true
);

-- Default rules (insert only if table empty)
INSERT INTO ar_allowance_rule (age_from_days, age_to_days, rate, sort_order)
SELECT * FROM (VALUES
    (0,   90,    0.00, 1),
    (91,  180,  20.00, 2),
    (181, 365,  50.00, 3),
    (366, NULL, 100.00, 4)
) AS v(age_from_days, age_to_days, rate, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM ar_allowance_rule);

-- 3. FX Revaluation Header
CREATE TABLE IF NOT EXISTS ar_fx_revaluation (
    id                      SERIAL PRIMARY KEY,
    reval_date              DATE NOT NULL,
    period_year             INT NOT NULL,
    method                  VARCHAR(20) NOT NULL CHECK (method IN ('realized', 'reversing')),
    status                  VARCHAR(20) NOT NULL DEFAULT 'Draft'
                            CHECK (status IN ('Draft', 'Posted', 'Void')),
    total_fx_gain_loss      NUMERIC(18,2) NOT NULL DEFAULT 0,
    gl_entry_id             INT REFERENCES gl_entry_header(id) ON DELETE SET NULL,
    reversal_date           DATE,                               -- reversing: วันกลับรายการ
    reversal_gl_entry_id    INT REFERENCES gl_entry_header(id) ON DELETE SET NULL,
    note                    TEXT,
    created_by              VARCHAR(100),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              VARCHAR(100),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. FX Revaluation Detail (per outstanding invoice)
CREATE TABLE IF NOT EXISTS ar_fx_revaluation_detail (
    id                  SERIAL PRIMARY KEY,
    revaluation_id      INT NOT NULL REFERENCES ar_fx_revaluation(id) ON DELETE CASCADE,
    invoice_id          INT NOT NULL REFERENCES ar_transaction(id),
    customer_id         INT NOT NULL,
    currency_code       VARCHAR(10) NOT NULL,
    balance_amount_fc   NUMERIC(18,4) NOT NULL,
    original_rate       NUMERIC(18,6) NOT NULL,
    balance_amount_lc   NUMERIC(18,2) NOT NULL,     -- ก่อน revalue
    year_end_rate       NUMERIC(18,6) NOT NULL,
    revalued_amount_lc  NUMERIC(18,2) NOT NULL,     -- balance_fc × year_end_rate
    fx_gain_loss        NUMERIC(18,2) NOT NULL       -- + = gain, - = loss
);

CREATE INDEX IF NOT EXISTS idx_ar_fx_reval_detail_reval ON ar_fx_revaluation_detail(revaluation_id);
CREATE INDEX IF NOT EXISTS idx_ar_fx_reval_detail_inv   ON ar_fx_revaluation_detail(invoice_id);

-- 5. Allowance Run Header
CREATE TABLE IF NOT EXISTS ar_allowance_run (
    id                  SERIAL PRIMARY KEY,
    run_date            DATE NOT NULL,
    period_year         INT NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'Draft'
                        CHECK (status IN ('Draft', 'Posted', 'Void')),
    total_allowance     NUMERIC(18,2) NOT NULL DEFAULT 0,   -- ยอดที่ควรเป็น
    prior_allowance     NUMERIC(18,2) NOT NULL DEFAULT 0,   -- ยอดสะสมที่มีอยู่แล้ว
    adjustment_amount   NUMERIC(18,2) NOT NULL DEFAULT 0,   -- บันทึก GL เฉพาะส่วนนี้
    gl_entry_id         INT REFERENCES gl_entry_header(id) ON DELETE SET NULL,
    note                TEXT,
    created_by          VARCHAR(100),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by          VARCHAR(100),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Allowance Run Detail (per outstanding invoice)
CREATE TABLE IF NOT EXISTS ar_allowance_run_detail (
    id                  SERIAL PRIMARY KEY,
    run_id              INT NOT NULL REFERENCES ar_allowance_run(id) ON DELETE CASCADE,
    invoice_id          INT NOT NULL REFERENCES ar_transaction(id),
    customer_id         INT NOT NULL,
    doc_no              VARCHAR(30),
    doc_date            DATE,
    due_date            DATE,
    age_days            INT NOT NULL,
    balance_amount_lc   NUMERIC(18,2) NOT NULL,
    rate                NUMERIC(5,2) NOT NULL,
    allowance_amount    NUMERIC(18,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ar_allowance_run_detail_run ON ar_allowance_run_detail(run_id);

-- 7. เพิ่ม revaluation_rate ใน ar_transaction
--    NULL = ยังไม่ถูก revalue หรือ reversing method
--    NOT NULL = ถูก realized revalue → ใช้คำนวณ FX เมื่อชำระปีถัดไป
ALTER TABLE ar_transaction
    ADD COLUMN IF NOT EXISTS revaluation_rate NUMERIC(18,6);
