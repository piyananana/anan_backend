-- พนักงานขายหลายคนต่อลูกค้า พร้อมสัดส่วน % (ค่าเริ่มต้นของเอกสารขาย: ใบเสนอราคา/ใบสั่งขาย/ใบส่งสินค้า/ใบแจ้งหนี้)
-- ar_customer.salesperson_id ยังคงอยู่ = พนักงานขายหลัก (sync จากตารางนี้)
-- โครงสร้างเดียวกับ utils/docSalesperson.js — รันซ้ำได้ (apply per DB)

CREATE TABLE IF NOT EXISTS ar_customer_salesperson (
    id             SERIAL PRIMARY KEY,
    customer_id    INTEGER NOT NULL REFERENCES ar_customer(id) ON DELETE CASCADE,
    line_no        SMALLINT NOT NULL DEFAULT 1,
    salesperson_id INTEGER NOT NULL REFERENCES cd_salesperson(id),
    is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
    share_percent  NUMERIC(7,4),
    share_amount   NUMERIC(18,2),
    UNIQUE (customer_id, salesperson_id)
);
CREATE INDEX IF NOT EXISTS idx_ar_customer_salesperson_sp ON ar_customer_salesperson (salesperson_id);

-- ย้ายพนักงานขายเดิม (คนเดียว) มาเป็นคนหลัก
INSERT INTO ar_customer_salesperson (customer_id, line_no, salesperson_id, is_primary)
SELECT c.id, 1, c.salesperson_id, TRUE
  FROM ar_customer c
 WHERE c.salesperson_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ar_customer_salesperson x WHERE x.customer_id = c.id);
