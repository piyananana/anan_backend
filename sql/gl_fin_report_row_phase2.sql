-- ============================================================
-- gl_fin_report_row: รหัสบรรทัด, ชนิดบรรทัด, ชื่อบรรทัดสองภาษา
-- Financial report builder redesign — Phase 2
--
--   row_code        รหัสคงที่ของบรรทัด ใช้อ้างอิงในสูตร เช่น GROSS_PROFIT = REV_TOTAL - COGS_TOTAL
--                   (เรียงลำดับบรรทัดใหม่ได้โดยสูตรไม่พัง ต่างจาก (R100, C20))
--   row_kind        ACCOUNTS  ยอดจากช่วงบัญชีของบรรทัด (แบบเดิม)
--                   HEADING   หัวข้อ แสดงชื่ออย่างเดียว
--                   TOTAL     รวมยอดของบรรทัดที่ระบุ parent_row_code = รหัสบรรทัดนี้
--                   FORMULA   ทุกคอลัมน์ AMOUNT คำนวณจาก row_formula
--                   BLANK     บรรทัดว่าง
--   parent_row_code บรรทัดนี้ถูกรวมเข้าบรรทัด TOTAL ใด
--   label_thai/eng  ชื่อบรรทัด แสดงในคอลัมน์ LABEL ของรายงาน (gl_fin_report_col.col_kind = 'LABEL')
--   line_above/below เส้นใต้/เส้นบนของยอดเงิน NONE | SINGLE | DOUBLE (เช่น ยอดรวมสุทธิขีดเส้นคู่)
--   hide_if_zero    ไม่พิมพ์บรรทัดถ้ายอดทุกคอลัมน์เป็นศูนย์/ว่าง
--
-- รันซ้ำได้ (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS)
-- ============================================================

ALTER TABLE gl_fin_report_row
    ADD COLUMN IF NOT EXISTS row_code        VARCHAR(30),
    ADD COLUMN IF NOT EXISTS row_kind        VARCHAR(10)  NOT NULL DEFAULT 'ACCOUNTS',
    ADD COLUMN IF NOT EXISTS label_thai      VARCHAR(255),
    ADD COLUMN IF NOT EXISTS label_eng       VARCHAR(255),
    ADD COLUMN IF NOT EXISTS indent_level    INT          NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS parent_row_code VARCHAR(30),
    ADD COLUMN IF NOT EXISTS row_formula     VARCHAR(500),
    ADD COLUMN IF NOT EXISTS is_bold         BOOLEAN      NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS line_above      VARCHAR(10)  NOT NULL DEFAULT 'NONE',
    ADD COLUMN IF NOT EXISTS line_below      VARCHAR(10)  NOT NULL DEFAULT 'NONE',
    ADD COLUMN IF NOT EXISTS hide_if_zero    BOOLEAN      NOT NULL DEFAULT FALSE;

ALTER TABLE gl_fin_report_row DROP CONSTRAINT IF EXISTS gl_fin_report_row_kind_ck;
ALTER TABLE gl_fin_report_row ADD CONSTRAINT gl_fin_report_row_kind_ck
    CHECK (row_kind IN ('ACCOUNTS', 'HEADING', 'TOTAL', 'FORMULA', 'BLANK'));

ALTER TABLE gl_fin_report_row DROP CONSTRAINT IF EXISTS gl_fin_report_row_code_ck;
ALTER TABLE gl_fin_report_row ADD CONSTRAINT gl_fin_report_row_code_ck
    CHECK (row_code IS NULL OR row_code ~ '^[A-Z][A-Z0-9_]*$');

ALTER TABLE gl_fin_report_row DROP CONSTRAINT IF EXISTS gl_fin_report_row_lines_ck;
ALTER TABLE gl_fin_report_row ADD CONSTRAINT gl_fin_report_row_lines_ck
    CHECK (line_above IN ('NONE', 'SINGLE', 'DOUBLE') AND line_below IN ('NONE', 'SINGLE', 'DOUBLE'));

ALTER TABLE gl_fin_report_row DROP CONSTRAINT IF EXISTS gl_fin_report_row_indent_ck;
ALTER TABLE gl_fin_report_row ADD CONSTRAINT gl_fin_report_row_indent_ck
    CHECK (indent_level BETWEEN 0 AND 10);

-- รหัสบรรทัดไม่ซ้ำภายในรายงาน (ไม่บังคับต้องมี)
CREATE UNIQUE INDEX IF NOT EXISTS gl_fin_report_row_code_uq
    ON gl_fin_report_row (report_id, row_code) WHERE row_code IS NOT NULL;

-- คอลัมน์ระดับรายงานชนิด LABEL = ตำแหน่ง/ความกว้าง/หัวคอลัมน์ของชื่อบรรทัด
ALTER TABLE gl_fin_report_col DROP CONSTRAINT IF EXISTS gl_fin_report_col_kind_ck;
ALTER TABLE gl_fin_report_col ADD CONSTRAINT gl_fin_report_col_kind_ck
    CHECK (col_kind IN ('LABEL', 'AMOUNT', 'CALC'));

-- ตรวจสอบผล
DO $$
DECLARE v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count FROM information_schema.columns WHERE table_name = 'gl_fin_report_row';
    RAISE NOTICE 'gl_fin_report_row columns: % (ต้อง = 27)', v_count;
END $$;
