-- ============================================================
-- Fix v3: สร้าง PK ใหม่ให้ gl_balance_accum
-- Drop ทุก unique/pk constraints ก่อน แล้ว dedup + add new PK
-- ============================================================

-- ── Step 1: เพิ่ม dim1-5 columns ถ้ายังไม่มี ────────────────────────────
ALTER TABLE gl_balance_accum
    ADD COLUMN IF NOT EXISTS dim1_id INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dim2_id INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dim3_id INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dim4_id INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dim5_id INT NOT NULL DEFAULT 0;

-- ── Step 2: Backfill dim1/dim2 จาก old columns ──────────────────────────
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'gl_balance_accum' AND column_name = 'business_unit_id') THEN
        UPDATE gl_balance_accum SET dim1_id = COALESCE(business_unit_id, 0)
        WHERE dim1_id = 0 AND COALESCE(business_unit_id, 0) != 0;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'gl_balance_accum' AND column_name = 'project_id') THEN
        UPDATE gl_balance_accum SET dim2_id = COALESCE(project_id, 0)
        WHERE dim2_id = 0 AND COALESCE(project_id, 0) != 0;
    END IF;
END $$;

-- ── Step 3: fix branch_id ให้ NOT NULL ───────────────────────────────────
UPDATE gl_balance_accum SET branch_id = 0 WHERE branch_id IS NULL;

-- ── Step 4: Drop ทุก UNIQUE / PRIMARY KEY constraints บน table นี้ ───────
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'gl_balance_accum'
          AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    LOOP
        EXECUTE format('ALTER TABLE gl_balance_accum DROP CONSTRAINT IF EXISTS %I', r.constraint_name);
        RAISE NOTICE 'Dropped constraint: %', r.constraint_name;
    END LOOP;
END $$;

-- ── Step 5: Deduplicate โดย SUM ──────────────────────────────────────────
-- กลุ่ม key ใหม่คือ (period_id, account_id, branch_id, dim1-5, currency_id)
DROP TABLE IF EXISTS _bal_dedup;
CREATE TEMP TABLE _bal_dedup AS
SELECT
    period_id,
    account_id,
    COALESCE(branch_id, 0)  AS branch_id,
    COALESCE(dim1_id, 0)    AS dim1_id,
    COALESCE(dim2_id, 0)    AS dim2_id,
    COALESCE(dim3_id, 0)    AS dim3_id,
    COALESCE(dim4_id, 0)    AS dim4_id,
    COALESCE(dim5_id, 0)    AS dim5_id,
    currency_id,
    SUM(COALESCE(debit_amount, 0))   AS debit_amount,
    SUM(COALESCE(credit_amount, 0))  AS credit_amount,
    SUM(COALESCE(end_balance, 0))    AS end_balance,
    MAX(COALESCE(updated_at, NOW())) AS updated_at
FROM gl_balance_accum
GROUP BY
    period_id, account_id,
    COALESCE(branch_id, 0),
    COALESCE(dim1_id, 0), COALESCE(dim2_id, 0),
    COALESCE(dim3_id, 0), COALESCE(dim4_id, 0), COALESCE(dim5_id, 0),
    currency_id;

-- ── Step 6: Repopulate ───────────────────────────────────────────────────
TRUNCATE TABLE gl_balance_accum;

INSERT INTO gl_balance_accum
    (period_id, account_id, branch_id,
     dim1_id, dim2_id, dim3_id, dim4_id, dim5_id,
     currency_id, debit_amount, credit_amount, end_balance, updated_at)
SELECT
    period_id, account_id, branch_id,
    dim1_id, dim2_id, dim3_id, dim4_id, dim5_id,
    currency_id, debit_amount, credit_amount, end_balance, updated_at
FROM _bal_dedup;

-- ── Step 7: สร้าง Primary Key ใหม่ ─────────────────────────────────────
ALTER TABLE gl_balance_accum
    ADD PRIMARY KEY (period_id, account_id, branch_id,
                     dim1_id, dim2_id, dim3_id, dim4_id, dim5_id,
                     currency_id);

-- ── Step 8: ผลลัพธ์ ──────────────────────────────────────────────────────
DO $$
DECLARE
    v_total  INT;
    v_unique INT;
BEGIN
    SELECT COUNT(*) INTO v_total  FROM gl_balance_accum;
    SELECT COUNT(*) INTO v_unique FROM (
        SELECT period_id, account_id, branch_id,
               dim1_id, dim2_id, dim3_id, dim4_id, dim5_id, currency_id
        FROM gl_balance_accum
        GROUP BY period_id, account_id, branch_id,
                 dim1_id, dim2_id, dim3_id, dim4_id, dim5_id, currency_id
    ) t;
    RAISE NOTICE 'Done — total_rows=%, unique_combinations=% (ต้องเท่ากัน)', v_total, v_unique;
END $$;
