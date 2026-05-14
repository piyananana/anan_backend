-- ============================================================
-- GL Dimension Framework — Phase 1
-- แทนที่ hardcoded business_unit_id/project_id ด้วย
-- configurable dimension slots (dim1–dim5)
-- ============================================================

-- ── 1. Dimension Type (สูงสุด 5 slot, บริษัทตั้งค่าเอง) ────────────────────
CREATE TABLE IF NOT EXISTS gl_dimension_type (
    slot_no       SMALLINT PRIMARY KEY CHECK (slot_no BETWEEN 1 AND 5),
    type_code     VARCHAR(30)  NOT NULL UNIQUE,
    name_thai     VARCHAR(100) NOT NULL,
    name_eng      VARCHAR(100),
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    sort_order    SMALLINT     NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 2. Dimension Value (master ทุก type รวมในตารางเดียว) ──────────────────
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

-- ── 3. กฎ dimension requirement ต่อ GL Account ────────────────────────────
--    แทน branch_required/project_required boolean บน gl_account
CREATE TABLE IF NOT EXISTS gl_account_dim_rule (
    account_id    INT         NOT NULL REFERENCES gl_account(id) ON DELETE CASCADE,
    type_code     VARCHAR(30) NOT NULL REFERENCES gl_dimension_type(type_code) ON UPDATE CASCADE,
    is_required   BOOLEAN     NOT NULL DEFAULT FALSE,
    PRIMARY KEY(account_id, type_code)
);

-- ── 4. เพิ่ม dim1–dim5 ใน gl_entry_detail ─────────────────────────────────
ALTER TABLE gl_entry_detail
    ADD COLUMN IF NOT EXISTS dim1_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim2_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim3_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim4_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim5_id INT REFERENCES gl_dimension_value(id);

-- ── 5. เพิ่ม dim1–dim5 ใน gl_balance_accum + rebuild PK ──────────────────
ALTER TABLE gl_balance_accum
    ADD COLUMN IF NOT EXISTS dim1_id INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dim2_id INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dim3_id INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dim4_id INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dim5_id INT NOT NULL DEFAULT 0;

-- Drop PK เดิม
ALTER TABLE gl_balance_accum DROP CONSTRAINT IF EXISTS gl_balance_accum_pkey;

-- ── 6. เพิ่ม dim1–dim5 ใน ar_transaction (header) ─────────────────────────
ALTER TABLE ar_transaction
    ADD COLUMN IF NOT EXISTS dim1_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim2_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim3_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim4_id INT REFERENCES gl_dimension_value(id),
    ADD COLUMN IF NOT EXISTS dim5_id INT REFERENCES gl_dimension_value(id);

-- ── 7. Seed default dimension types (ย้าย BU→slot1, Project→slot2) ────────
INSERT INTO gl_dimension_type (slot_no, type_code, name_thai, name_eng, is_active, sort_order)
VALUES
    (1, 'BU',      'หน่วยธุรกิจ', 'Business Unit', TRUE, 1),
    (2, 'PROJECT', 'โครงการ',     'Project',        TRUE, 2)
ON CONFLICT (slot_no) DO NOTHING;

-- ── 8. Migrate cd_business_unit → gl_dimension_value ──────────────────────
INSERT INTO gl_dimension_value (type_code, value_code, value_name_thai, value_name_eng, is_active, created_at)
SELECT 'BU', bu_code, bu_name_thai, COALESCE(bu_name_eng, ''), is_active, COALESCE(created_at, NOW())
FROM cd_business_unit
ON CONFLICT (type_code, value_code) DO NOTHING;

-- ── 9. Migrate cd_project → gl_dimension_value ────────────────────────────
INSERT INTO gl_dimension_value (type_code, value_code, value_name_thai, value_name_eng, is_active, created_at)
SELECT 'PROJECT', project_code, project_name_thai, COALESCE(project_name_eng, ''), is_active, COALESCE(created_at, NOW())
FROM cd_project
ON CONFLICT (type_code, value_code) DO NOTHING;

-- ── 10. Backfill dim1_id / dim2_id ใน gl_entry_detail ────────────────────
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

-- ── 11. Backfill dim1_id / dim2_id ใน gl_balance_accum ───────────────────
UPDATE gl_balance_accum b
SET
    dim1_id = COALESCE(b.business_unit_id, 0),
    dim2_id = COALESCE(b.project_id, 0);

-- ── หมายเหตุ ──────────────────────────────────────────────────────────────
-- OLD columns (business_unit_id, project_id) ยังคงไว้สำหรับ backward compat
-- จะ DROP ใน Phase 2 หลังตรวจสอบแล้ว
