-- ============================================================
-- gl_fin_report_row: เพิ่ม dim1–dim5 สำหรับกำหนด dimension filter
-- รันหลังจาก gl_dimension_framework_remaining.sql (Phase 1) เสร็จแล้ว
-- ============================================================

ALTER TABLE gl_fin_report_row
    ADD COLUMN IF NOT EXISTS dim1_id INT,
    ADD COLUMN IF NOT EXISTS dim2_id INT,
    ADD COLUMN IF NOT EXISTS dim3_id INT,
    ADD COLUMN IF NOT EXISTS dim4_id INT,
    ADD COLUMN IF NOT EXISTS dim5_id INT;

-- ตรวจสอบผล
DO $$
DECLARE v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM information_schema.columns
    WHERE table_name = 'gl_fin_report_row'
      AND column_name LIKE 'dim%_id';
    RAISE NOTICE 'gl_fin_report_row dim columns: % (ต้อง = 5)', v_count;
END $$;
