-- ============================================================
-- GL Dimension Framework — Phase 2 Complete Migration
-- รันไฟล์นี้หลังจาก Phase 1 (gl_dimension_framework*.sql) เสร็จแล้ว
-- ไฟล์นี้เป็น idempotent: รันซ้ำได้ ไม่เกิด error
-- ============================================================

-- ── PART 1: สร้าง gl_dim_combination ─────────────────────────────────────
-- ตาราง lookup สำหรับ dimension combination
-- ช่วยให้ gl_balance_accum มี PK แค่ 4 columns แทน 9

CREATE TABLE IF NOT EXISTS gl_dim_combination (
    id          SERIAL      PRIMARY KEY,
    branch_id   INT         NOT NULL DEFAULT 0,
    dim1_id     INT         NOT NULL DEFAULT 0,
    dim2_id     INT         NOT NULL DEFAULT 0,
    dim3_id     INT         NOT NULL DEFAULT 0,
    dim4_id     INT         NOT NULL DEFAULT 0,
    dim5_id     INT         NOT NULL DEFAULT 0,
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

-- ── PART 2: Seed combinations จาก gl_balance_accum เดิม ──────────────────
-- (รันซ้ำได้ ด้วย ON CONFLICT DO NOTHING)
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

-- ── PART 3: Rebuild gl_balance_accum ด้วย combo_id ───────────────────────
-- ทำเฉพาะถ้า gl_balance_accum ยังไม่มี column combo_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gl_balance_accum' AND column_name = 'combo_id'
    ) THEN
        -- สร้าง table ใหม่ด้วย schema ถูกต้อง
        CREATE TABLE gl_balance_accum_new (
            period_id     INT           NOT NULL,
            account_id    INT           NOT NULL REFERENCES gl_account(id),
            combo_id      INT           NOT NULL REFERENCES gl_dim_combination(id),
            currency_id   INT           NOT NULL,
            debit_amount  NUMERIC(15,2) NOT NULL DEFAULT 0,
            credit_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
            end_balance   NUMERIC(15,2) NOT NULL DEFAULT 0,
            updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            PRIMARY KEY (period_id, account_id, combo_id, currency_id)
        );

        -- Migrate ข้อมูล
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

        -- Cutover
        ALTER TABLE gl_balance_accum     RENAME TO gl_balance_accum_phase1;
        ALTER TABLE gl_balance_accum_new RENAME TO gl_balance_accum;

        RAISE NOTICE 'PART 3: gl_balance_accum rebuilt with combo_id';
    ELSE
        RAISE NOTICE 'PART 3: gl_balance_accum already has combo_id — skipped';
    END IF;
END $$;

-- ── PART 4: เพิ่ม dim1–dim5 ใน gl_fin_report_row ────────────────────────
-- สำหรับกำหนด dimension filter condition ต่อบรรทัดในงบการเงิน
ALTER TABLE gl_fin_report_row
    ADD COLUMN IF NOT EXISTS dim1_id INT,
    ADD COLUMN IF NOT EXISTS dim2_id INT,
    ADD COLUMN IF NOT EXISTS dim3_id INT,
    ADD COLUMN IF NOT EXISTS dim4_id INT,
    ADD COLUMN IF NOT EXISTS dim5_id INT;

-- ── PART 5: ผลลัพธ์ ──────────────────────────────────────────────────────
DO $$
DECLARE
    v_combos        INT;
    v_bal_rows      INT;
    v_bal_has_combo BOOLEAN;
    v_report_dims   INT;
BEGIN
    SELECT COUNT(*) INTO v_combos   FROM gl_dim_combination;
    SELECT COUNT(*) INTO v_bal_rows FROM gl_balance_accum;
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'gl_balance_accum' AND column_name = 'combo_id'
    ) INTO v_bal_has_combo;
    SELECT COUNT(*) INTO v_report_dims
        FROM information_schema.columns
        WHERE table_name = 'gl_fin_report_row' AND column_name LIKE 'dim%_id';

    RAISE NOTICE '======= Phase 2 Migration Summary =======';
    RAISE NOTICE 'gl_dim_combination rows       : %', v_combos;
    RAISE NOTICE 'gl_balance_accum rows         : %  (combo_id exists: %)', v_bal_rows, v_bal_has_combo;
    RAISE NOTICE 'gl_fin_report_row dim columns : %  (ต้อง = 5)', v_report_dims;
    RAISE NOTICE '=========================================';
END $$;
