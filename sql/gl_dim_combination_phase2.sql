-- ============================================================
-- GL Dimension Framework — Phase 2
-- แทนที่ 8-column PK ใน gl_balance_accum ด้วย combo_id
-- ============================================================

-- ── 1. สร้าง gl_dim_combination ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_dim_combination (
    id          SERIAL  PRIMARY KEY,
    branch_id   INT     NOT NULL DEFAULT 0,
    dim1_id     INT     NOT NULL DEFAULT 0,
    dim2_id     INT     NOT NULL DEFAULT 0,
    dim3_id     INT     NOT NULL DEFAULT 0,
    dim4_id     INT     NOT NULL DEFAULT 0,
    dim5_id     INT     NOT NULL DEFAULT 0,
    combo_key   VARCHAR(60) GENERATED ALWAYS AS (
        LPAD(branch_id::text, 6, '0') || '-' ||
        LPAD(dim1_id::text,   6, '0') || '-' ||
        LPAD(dim2_id::text,   6, '0') || '-' ||
        LPAD(dim3_id::text,   6, '0') || '-' ||
        LPAD(dim4_id::text,   6, '0') || '-' ||
        LPAD(dim5_id::text,   6, '0')
    ) STORED,
    UNIQUE(combo_key)
);

CREATE INDEX IF NOT EXISTS idx_gl_dim_combo_key ON gl_dim_combination(combo_key);

-- ── 2. Seed combinations จาก gl_balance_accum ที่มีอยู่ ─────────────────
INSERT INTO gl_dim_combination (branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
SELECT DISTINCT
    COALESCE(branch_id, 0),
    COALESCE(dim1_id,   0),
    COALESCE(dim2_id,   0),
    COALESCE(dim3_id,   0),
    COALESCE(dim4_id,   0),
    COALESCE(dim5_id,   0)
FROM gl_balance_accum
ON CONFLICT (combo_key) DO NOTHING;

-- ── 3. สร้าง gl_balance_accum ใหม่ (ใช้ combo_id) ────────────────────────
CREATE TABLE IF NOT EXISTS gl_balance_accum_new (
    period_id     INT             NOT NULL,
    account_id    INT             NOT NULL REFERENCES gl_account(id),
    combo_id      INT             NOT NULL REFERENCES gl_dim_combination(id),
    currency_id   INT             NOT NULL,
    debit_amount  NUMERIC(15,2)   NOT NULL DEFAULT 0,
    credit_amount NUMERIC(15,2)   NOT NULL DEFAULT 0,
    end_balance   NUMERIC(15,2)   NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    PRIMARY KEY (period_id, account_id, combo_id, currency_id)
);

-- ── 4. Migrate ข้อมูลจาก gl_balance_accum เดิม ────────────────────────────
INSERT INTO gl_balance_accum_new
    (period_id, account_id, combo_id, currency_id,
     debit_amount, credit_amount, end_balance, updated_at)
SELECT
    b.period_id,
    b.account_id,
    c.id AS combo_id,
    b.currency_id,
    b.debit_amount,
    b.credit_amount,
    b.end_balance,
    COALESCE(b.updated_at, NOW())
FROM gl_balance_accum b
JOIN gl_dim_combination c ON c.combo_key = (
    LPAD(COALESCE(b.branch_id, 0)::text, 6, '0') || '-' ||
    LPAD(COALESCE(b.dim1_id,   0)::text, 6, '0') || '-' ||
    LPAD(COALESCE(b.dim2_id,   0)::text, 6, '0') || '-' ||
    LPAD(COALESCE(b.dim3_id,   0)::text, 6, '0') || '-' ||
    LPAD(COALESCE(b.dim4_id,   0)::text, 6, '0') || '-' ||
    LPAD(COALESCE(b.dim5_id,   0)::text, 6, '0')
);

-- ── 5. Cutover (rename) ───────────────────────────────────────────────────
ALTER TABLE gl_balance_accum     RENAME TO gl_balance_accum_phase1;
ALTER TABLE gl_balance_accum_new RENAME TO gl_balance_accum;

-- ── 6. Summary ───────────────────────────────────────────────────────────
DO $$
DECLARE
    v_combos INT;
    v_old    INT;
    v_new    INT;
BEGIN
    SELECT COUNT(*) INTO v_combos FROM gl_dim_combination;
    SELECT COUNT(*) INTO v_old    FROM gl_balance_accum_phase1;
    SELECT COUNT(*) INTO v_new    FROM gl_balance_accum;
    RAISE NOTICE '=== Phase 2 Migration ===';
    RAISE NOTICE 'gl_dim_combination rows : %', v_combos;
    RAISE NOTICE 'old gl_balance_accum    : % rows (เก็บไว้ใน gl_balance_accum_phase1)', v_old;
    RAISE NOTICE 'new gl_balance_accum    : % rows (ต้องเท่ากัน)', v_new;
    RAISE NOTICE '========================';
END $$;

-- หมายเหตุ: gl_balance_accum_phase1 เก็บไว้ตรวจสอบ
-- ลบทีหลังได้ด้วย: DROP TABLE gl_balance_accum_phase1;
