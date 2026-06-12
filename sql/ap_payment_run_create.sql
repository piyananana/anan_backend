-- ap_payment_run: AP payment run batch header
CREATE TABLE IF NOT EXISTS ap_payment_run (
    id              SERIAL PRIMARY KEY,
    run_number      VARCHAR(30)  NOT NULL UNIQUE,   -- PR-YYYYMMDD-NNN
    run_date        DATE         NOT NULL,
    description     VARCHAR(200),
    bank_file_format_id  INTEGER REFERENCES cm_bank_file_format(id),
    total_amount_lc NUMERIC(18,4) NOT NULL DEFAULT 0,
    status          VARCHAR(20)  NOT NULL DEFAULT 'Draft',  -- Draft / Submitted / Approved / Rejected / Completed / Void
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by      VARCHAR(100),
    updated_by      VARCHAR(100)
);

-- ap_payment_run_detail: one row per invoice included in the run
CREATE TABLE IF NOT EXISTS ap_payment_run_detail (
    id                  SERIAL PRIMARY KEY,
    run_id              INTEGER NOT NULL REFERENCES ap_payment_run(id) ON DELETE CASCADE,
    ap_transaction_id   INTEGER NOT NULL REFERENCES ap_transaction(id),
    vendor_id           INTEGER NOT NULL,
    vendor_code         VARCHAR(30),
    vendor_name_th      VARCHAR(200),
    bank_name           VARCHAR(100),
    bank_branch_name    VARCHAR(100),
    account_number      VARCHAR(50),
    account_name        VARCHAR(200),
    invoice_no          VARCHAR(50),
    invoice_date        DATE,
    due_date            DATE,
    invoice_amount_lc   NUMERIC(18,4) NOT NULL DEFAULT 0,
    payment_amount_lc   NUMERIC(18,4) NOT NULL DEFAULT 0,
    currency_code       VARCHAR(10)   NOT NULL DEFAULT 'THB',
    exchange_rate       NUMERIC(18,6) NOT NULL DEFAULT 1,
    sort_order          INTEGER       NOT NULL DEFAULT 0
);

-- ap_payment_run_approval: approver records created when run is submitted
CREATE TABLE IF NOT EXISTS ap_payment_run_approval (
    id                  SERIAL PRIMARY KEY,
    run_id              INTEGER NOT NULL REFERENCES ap_payment_run(id) ON DELETE CASCADE,
    approver_user_id    INTEGER NOT NULL,
    approver_user_name  VARCHAR(100),
    sequence_no         INTEGER NOT NULL DEFAULT 1,
    status              VARCHAR(20) NOT NULL DEFAULT 'Pending',  -- Pending / Approved / Rejected
    remarks             TEXT,
    approved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
