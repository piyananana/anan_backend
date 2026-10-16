-- ============================================================
-- gl_fin_report: หน่วยจำนวนเงินและจำนวนทศนิยมของงบ
-- Financial report builder redesign — Phase 5
--
--   amount_unit     หน่วยที่แสดง 1 = บาท, 1000 = พันบาท, 1000000 = ล้านบาท
--                   (engine หารยอดบัญชีก่อนคำนวณสูตร สูตรอัตราส่วน/ร้อยละจึงไม่เพี้ยน)
--   decimal_places  จำนวนทศนิยมที่แสดง 0-4
--
-- รันซ้ำได้ (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS)
-- มีส่วน gl_fin_report_row (font_size/text_align) ต่อท้ายไฟล์
-- ============================================================

ALTER TABLE gl_fin_report
    ADD COLUMN IF NOT EXISTS amount_unit    INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS decimal_places INT NOT NULL DEFAULT 2;

ALTER TABLE gl_fin_report DROP CONSTRAINT IF EXISTS chk_gl_fin_report_amount_unit;
ALTER TABLE gl_fin_report ADD CONSTRAINT chk_gl_fin_report_amount_unit
    CHECK (amount_unit IN (1, 1000, 1000000));

ALTER TABLE gl_fin_report DROP CONSTRAINT IF EXISTS chk_gl_fin_report_decimal_places;
ALTER TABLE gl_fin_report ADD CONSTRAINT chk_gl_fin_report_decimal_places
    CHECK (decimal_places BETWEEN 0 AND 4);

-- ============================================================
-- gl_fin_report_row: ขนาด/การจัดวางตัวอักษรของบรรทัดหัวงบ/ท้ายงบ (row_type HEADER/FOOTER)
--   บรรทัด HEADER/FOOTER เป็นข้อความเต็มความกว้างบรรทัดเดียว ไม่ใช้คอลัมน์ของรายงาน
--   ตัวหนาใช้ is_bold เดิม
-- ============================================================

ALTER TABLE gl_fin_report_row
    ADD COLUMN IF NOT EXISTS font_size  INT         NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS text_align VARCHAR(10) NOT NULL DEFAULT 'CENTER';

ALTER TABLE gl_fin_report_row DROP CONSTRAINT IF EXISTS chk_gl_fin_report_row_font_size;
ALTER TABLE gl_fin_report_row ADD CONSTRAINT chk_gl_fin_report_row_font_size
    CHECK (font_size BETWEEN 6 AND 36);

ALTER TABLE gl_fin_report_row DROP CONSTRAINT IF EXISTS chk_gl_fin_report_row_text_align;
ALTER TABLE gl_fin_report_row ADD CONSTRAINT chk_gl_fin_report_row_text_align
    CHECK (text_align IN ('LEFT', 'CENTER', 'RIGHT'));
