-- ============================================================
-- GL Dimension Framework — Full Remaining Steps
-- สร้างตารางและ migrate ข้อมูล (รันหลัง fix_pk สำเร็จ)
-- ============================================================

-- ── 1. สร้าง gl_dimension_type ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_dimension_type (
    slot_no       SMALLINT     PRIMARY KEY CHECK (slot_no BETWEEN 1 AND 5),
    type_code     VARCHAR(30)  NOT NULL UNIQUE,
    name_thai     VARCHAR(100) NOT NULL,
    name_eng      VARCHAR(100),
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    sort_order    SMALLINT     NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 2. สร้าง gl_dimension_value ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_dimension_value (
    id              SERIAL       PRIMARY KEY,
    type_code       VARCHAR(30)  NOT NULL REFERENCES gl_dimension_type(type_code) ON UPDATE CASCADE,
    value_code      VARCHAR(50)  NOT NULL,
    value_name_thai VARCHAR(200) NOT NULL,
    value_name_eng  VARCHAR(200),
    parent_id       INT          REFERENCES gl_dimension_value(id),
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    sort_order      INT          NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by      VARCHAR(100),
    updated_by      VARCHAR(100),
    UNIQUE(type_code, value_code)
);

CREATE INDEX IF NOT EXISTS idx_gl_dim_value_type ON gl_dimension_value(type_code, is_active);

-- ── 3. สร้าง gl_account_dim_rule ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_account_dim_rule (
    account_id    INT         NOT NULL REFERENCES gl_account(id) ON DELETE CASCADE,
    type_code     VARCHAR(30) NOT NULL REFERENCES gl_dimension_type(type_code) ON UPDATE CASCADE,
    is_required   BOOLEAN     NOT NULL DEFAULT FALSE,
    PRIMARY KEY(account_id, type_code)
);

-- ── 4. เพิ่ม dim1–dim5 ใน gl_entry_detail ──────────────────────────────
ALTER TABLE gl_entry_detail
    ADD COLUMN IF NOT EXISTS dim1_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim2_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim3_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim4_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim5_id INT REFERENCES gl_dimension_value(id);

-- ── 5. เพิ่ม dim1–dim5 ใน ar_transaction ───────────────────────────────
ALTER TABLE ar_transaction
    ADD COLUMN IF NOT EXISTS dim1_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim2_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim3_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim4_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim5_id INT REFERENCES gl_dimension_value(id);

-- ── 6. Seed default dimension types ─────────────────────────────────────
INSERT INTO gl_dimension_type (slot_no, type_code, name_thai, name_eng, is_active, sort_order)
VALUES
    (1, 'BU',      'หน่วยธุรกิจ', 'Business Unit', TRUE, 1),
    (2, 'PROJECT', 'โครงการ',     'Project',        TRUE, 2)
ON CONFLICT (slot_no) DO NOTHING;

-- ── 7. Migrate cd_business_unit → gl_dimension_value ────────────────────
INSERT INTO gl_dimension_value
    (type_code, value_code, value_name_thai, value_name_eng, is_active, created_at)
SELECT 'BU', bu_code, bu_name_thai, COALESCE(bu_name_eng, ''), is_active, COALESCE(created_at, NOW())
FROM cd_business_unit
ON CONFLICT (type_code, value_code) DO NOTHING;

-- ── 8. Migrate cd_project → gl_dimension_value ──────────────────────────
INSERT INTO gl_dimension_value
    (type_code, value_code, value_name_thai, value_name_eng, is_active, created_at)
SELECT 'PROJECT', project_code, project_name_thai, COALESCE(project_name_eng, ''), is_active, COALESCE(created_at, NOW())
FROM cd_project
ON CONFLICT (type_code, value_code) DO NOTHING;

-- ── 9. Backfill gl_entry_detail dim1_id / dim2_id ───────────────────────
UPDATE gl_entry_detail d
SET
    dim1_id = (
        SELECT gv.id FROM gl_dimension_value gv
        JOIN cd_business_unit bu ON bu.bu_code = gv.value_code
        WHERE gv.type_code = 'BU' AND bu.id = d.business_unit_id
        LIMIT 1
    ),
    dim2_id = (
        SELECT gv.id FROM gl_dimension_value gv
        JOIN cd_project p ON p.project_code = gv.value_code
        WHERE gv.type_code = 'PROJECT' AND p.id = d.project_id
        LIMIT 1
    )
WHERE d.business_unit_id IS NOT NULL OR d.project_id IS NOT NULL;

-- ── 10. Summary ──────────────────────────────────────────────────────────
DO $$
DECLARE
    v_dim_types     INT;
    v_dim_values    INT;
    v_ar_cols       INT;
    v_gl_cols       INT;
    v_gl_backfilled INT;
    v_bal_rows      INT;
BEGIN
    SELECT COUNT(*) INTO v_dim_types  FROM gl_dimension_type;
    SELECT COUNT(*) INTO v_dim_values FROM gl_dimension_value;
    SELECT COUNT(*) INTO v_ar_cols
        FROM information_schema.columns
        WHERE table_name = 'ar_transaction' AND column_name LIKE 'dim%_id';
    SELECT COUNT(*) INTO v_gl_cols
        FROM information_schema.columns
        WHERE table_name = 'gl_entry_detail' AND column_name LIKE 'dim%_id';
    SELECT COUNT(*) INTO v_gl_backfilled
        FROM gl_entry_detail WHERE dim1_id IS NOT NULL OR dim2_id IS NOT NULL;
    SELECT COUNT(*) INTO v_bal_rows FROM gl_balance_accum;

    RAISE NOTICE '======= Migration Complete =======';
    RAISE NOTICE 'gl_dimension_type rows  : %  (ต้อง >= 2)', v_dim_types;
    RAISE NOTICE 'gl_dimension_value rows : %', v_dim_values;
    RAISE NOTICE 'ar_transaction dim cols : %  (ต้อง = 5)', v_ar_cols;
    RAISE NOTICE 'gl_entry_detail dim cols: %  (ต้อง = 5)', v_gl_cols;
    RAISE NOTICE 'gl_entry_detail backfilled: % rows', v_gl_backfilled;
    RAISE NOTICE 'gl_balance_accum rows   : %', v_bal_rows;
    RAISE NOTICE '==================================';
END $$;
