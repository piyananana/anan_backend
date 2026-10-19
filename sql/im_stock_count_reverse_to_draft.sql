-- ใบตรวจนับสต็อก: ถอย / ยกเลิก / ลบ (reverse-to-draft)
-- adj_doc_no / adj_gl_doc_no: เลขที่ใบปรับยอดและรายการบัญชีที่เก็บไว้ใช้ซ้ำหลังถอยจาก Closed
ALTER TABLE im_stock_count ADD COLUMN IF NOT EXISTS adj_doc_no    VARCHAR(30);
ALTER TABLE im_stock_count ADD COLUMN IF NOT EXISTS adj_gl_doc_no VARCHAR(30);
ALTER TABLE im_stock_count ADD COLUMN IF NOT EXISTS void_reason   TEXT;
ALTER TABLE im_stock_count ADD COLUMN IF NOT EXISTS voided_by     VARCHAR(100);
ALTER TABLE im_stock_count ADD COLUMN IF NOT EXISTS voided_at     TIMESTAMPTZ;
