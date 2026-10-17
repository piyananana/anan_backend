-- ============================================================
-- งบการเงิน: บรรทัดลูก "รวมเข้า" หรือ "หักจาก" บรรทัดยอดรวม (parent_row_code)
--   ADD      = บวกยอดของบรรทัดนี้เข้าบรรทัดยอดรวม (ค่าเดิม)
--   SUBTRACT = ลบยอดของบรรทัดนี้ออกจากบรรทัดยอดรวม
-- รันซ้ำได้
-- ============================================================

ALTER TABLE gl_fin_report_row
    ADD COLUMN IF NOT EXISTS parent_op VARCHAR(10) NOT NULL DEFAULT 'ADD';

ALTER TABLE gl_fin_report_row DROP CONSTRAINT IF EXISTS gl_fin_report_row_parent_op_chk;
ALTER TABLE gl_fin_report_row ADD CONSTRAINT gl_fin_report_row_parent_op_chk
    CHECK (parent_op IN ('ADD', 'SUBTRACT'));
