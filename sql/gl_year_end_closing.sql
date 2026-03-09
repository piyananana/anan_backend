-- =====================================================
-- Year-End Closing Tables
-- =====================================================

-- 1. Closing Configuration (one row per company/database)
CREATE TABLE IF NOT EXISTS gl_closing_config (
    id                              SERIAL PRIMARY KEY,
    income_summary_account_id       INTEGER NOT NULL REFERENCES gl_account(id),
    retained_earnings_account_id    INTEGER NOT NULL REFERENCES gl_account(id),
    revenue_account_types           TEXT[]  NOT NULL DEFAULT ARRAY['REVENUE'],
    expense_account_types           TEXT[]  NOT NULL DEFAULT ARRAY['EXPENSE'],
    closing_doc_id                  INTEGER REFERENCES sa_module_document(id),
    carry_forward_doc_id            INTEGER REFERENCES sa_module_document(id),
    created_at                      TIMESTAMPTZ DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Adjusting Entry Templates
CREATE TABLE IF NOT EXISTS gl_adjusting_template (
    id                  SERIAL PRIMARY KEY,
    template_name       VARCHAR(200) NOT NULL,
    description         TEXT DEFAULT '',
    debit_account_id    INTEGER REFERENCES gl_account(id),
    credit_account_id   INTEGER REFERENCES gl_account(id),
    default_amount      NUMERIC(18,2) DEFAULT 0,
    is_active           BOOLEAN DEFAULT TRUE,
    sort_order          INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Year-End Closing Session
CREATE TABLE IF NOT EXISTS gl_year_end_closing (
    id                      SERIAL PRIMARY KEY,
    fiscal_year_id          INTEGER NOT NULL REFERENCES gl_fiscal_year(id),
    status                  VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS',
    step1_checklist_ok      BOOLEAN,
    step1_result            JSONB,
    step2_adjusting_ok      BOOLEAN,
    step3_closing_ok        BOOLEAN,
    step3_entry_id          INTEGER REFERENCES gl_entry_header(id),
    step4_transfer_ok       BOOLEAN,
    step4_entry_id          INTEGER REFERENCES gl_entry_header(id),
    step5_carry_forward_ok  BOOLEAN,
    step5_entry_id          INTEGER REFERENCES gl_entry_header(id),
    next_fiscal_year_id     INTEGER REFERENCES gl_fiscal_year(id),
    step6_lock_ok           BOOLEAN,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);
