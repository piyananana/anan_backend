-- ตาราง ar_customer_running: ตั้งค่ารหัสลูกหนี้อัตโนมัติ
-- สร้างครั้งแรก: 2026-03-17

CREATE TABLE IF NOT EXISTS ar_customer_running (
  id                  SERIAL PRIMARY KEY,
  is_auto_numbering   BOOLEAN       NOT NULL DEFAULT false,
  format_prefix       VARCHAR(20)   NOT NULL DEFAULT '',
  format_separator    VARCHAR(5)    NOT NULL DEFAULT '',
  format_suffix_date  VARCHAR(10)   NOT NULL DEFAULT '',
  running_length      INT           NOT NULL DEFAULT 4,
  next_running_number INT           NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by          VARCHAR(100),
  updated_by          VARCHAR(100)
);

-- เพิ่ม record เริ่มต้น (ถ้ายังไม่มี)
INSERT INTO ar_customer_running
  (is_auto_numbering, format_prefix, format_separator, format_suffix_date, running_length, next_running_number)
SELECT false, 'CUST', '-', '', 4, 1
WHERE NOT EXISTS (SELECT 1 FROM ar_customer_running);
