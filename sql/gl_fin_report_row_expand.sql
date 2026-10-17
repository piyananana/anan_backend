-- ============================================================
-- งบการเงิน: ตัวเลือกพิมพ์บรรทัดบัญชี (row_kind = ACCOUNTS) แบบแตกเป็นรายบัญชีย่อย
--   NONE         = ใช้ชื่อบรรทัด ยอดรวมบรรทัดเดียว (ค่าเดิม)
--   DETAIL       = ชื่อบรรทัดเป็นหัวข้อ ตามด้วยรายบัญชีลงรายการพร้อมยอดเงิน
--   DETAIL_TOTAL = เหมือน DETAIL แล้วปิดท้ายด้วยบรรทัด "รวม..." ที่มียอดของบรรทัด
-- บัญชีที่ยอดเป็นศูนย์ทุกคอลัมน์ไม่พิมพ์ ยอดของบรรทัดที่ใช้ในสูตร/บรรทัดยอดรวมไม่เปลี่ยน
-- รันซ้ำได้
-- ============================================================

ALTER TABLE gl_fin_report_row
    ADD COLUMN IF NOT EXISTS expand_mode VARCHAR(20) NOT NULL DEFAULT 'NONE';

ALTER TABLE gl_fin_report_row DROP CONSTRAINT IF EXISTS gl_fin_report_row_expand_mode_chk;
ALTER TABLE gl_fin_report_row ADD CONSTRAINT gl_fin_report_row_expand_mode_chk
    CHECK (expand_mode IN ('NONE', 'DETAIL', 'DETAIL_TOTAL'));
