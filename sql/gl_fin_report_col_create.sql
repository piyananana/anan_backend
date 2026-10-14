-- ============================================================
-- gl_fin_report_col: คอลัมน์ระดับรายงาน (กำหนดครั้งเดียว ใช้กับทุกบรรทัด)
-- Financial report builder redesign — Phase 1
--
-- ทำงานร่วมกับ gl_fin_report_column (คอลัมน์รายบรรทัด) แบบ hybrid:
--   * คอลัมน์ระดับรายงาน = ตัวเลข (AMOUNT / CALC) ที่เหมือนกันทุกบรรทัด
--   * คอลัมน์รายบรรทัด   = ข้อความ/เส้นคั่น/สูตรเฉพาะบรรทัด
--   * ถ้าบรรทัดมีคอลัมน์รายบรรทัดที่ column_seq_no ตรงกับ col_seq_no
--     ช่องนั้นจะใช้คอลัมน์รายบรรทัดแทน (override) เช่น สูตรยอดรวมเฉพาะบรรทัด
-- ============================================================

CREATE TABLE IF NOT EXISTS gl_fin_report_col (
    id                      SERIAL PRIMARY KEY,
    report_id               INT NOT NULL REFERENCES gl_fin_report(id) ON DELETE CASCADE,
    col_seq_no              INT NOT NULL,
    col_code                VARCHAR(20) NOT NULL,          -- ใช้อ้างอิงในสูตร เช่น [CUR] - [PY]
    header_thai             VARCHAR(200),                  -- รองรับตัวแปร $colPeriodName, $colFiscalYear
    header_eng              VARCHAR(200),
    col_kind                VARCHAR(10) NOT NULL DEFAULT 'AMOUNT',   -- AMOUNT | CALC
    period_range            VARCHAR(10) NOT NULL DEFAULT 'MTD',      -- MTD | QTD | YTD | FULL_YEAR
    offset_years            INT NOT NULL DEFAULT 0,        -- -1 = งวดเดียวกันของปีก่อน
    offset_periods          INT NOT NULL DEFAULT 0,        -- -1 = งวดก่อนหน้า
    formula_text            VARCHAR(500),                  -- เฉพาะ CALC
    branch_id               INT,                           -- กรองเพิ่มเฉพาะคอลัมน์ (เช่น คอลัมน์แยกสาขา)
    dim1_id                 INT,
    dim2_id                 INT,
    dim3_id                 INT,
    dim4_id                 INT,
    dim5_id                 INT,
    exclude_closing_entries BOOLEAN NOT NULL DEFAULT TRUE, -- ตัดรายการปิดบัญชีสิ้นปี (Step 3/4) ออก
    data_source             VARCHAR(10) NOT NULL DEFAULT 'ACTUAL',   -- เผื่ออนาคต: BUDGET
    column_flex             INT NOT NULL DEFAULT 1,
    text_align              VARCHAR(10) NOT NULL DEFAULT 'RIGHT',
    font_weight             VARCHAR(10) NOT NULL DEFAULT 'NORMAL',
    font_size               INT NOT NULL DEFAULT 10,
    is_hidden               BOOLEAN NOT NULL DEFAULT FALSE, -- คอลัมน์ช่วยคำนวณ ไม่แสดงผล
    created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT gl_fin_report_col_seq_uq  UNIQUE (report_id, col_seq_no),
    CONSTRAINT gl_fin_report_col_code_uq UNIQUE (report_id, col_code),
    CONSTRAINT gl_fin_report_col_kind_ck  CHECK (col_kind IN ('AMOUNT', 'CALC')),
    CONSTRAINT gl_fin_report_col_range_ck CHECK (period_range IN ('MTD', 'QTD', 'YTD', 'FULL_YEAR'))
);

CREATE INDEX IF NOT EXISTS gl_fin_report_col_report_idx ON gl_fin_report_col (report_id);

-- ตรวจสอบผล
DO $$
DECLARE v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count FROM information_schema.columns WHERE table_name = 'gl_fin_report_col';
    RAISE NOTICE 'gl_fin_report_col columns: % (ต้อง = 26)', v_count;
END $$;
