-- พนักงานขายหลายคนต่อเอกสารขาย — ผู้ป้อนเลือกแค่รายชื่อ ระบบเก็บ % / จำนวนเงินจาก ar_customer_salesperson ณ ตอนบันทึก
-- (snapshot) ให้รายงานย้อนหลังไม่เปลี่ยนตามเมื่อแก้สัดส่วนที่ลูกค้าภายหลัง
-- โครงสร้างเดียวกับ utils/docSalesperson.js — รันซ้ำได้ (apply per DB)
--   ar_transaction_salesperson : ใบแจ้งหนี้ / เพิ่มหนี้ / ลดหนี้ AR (รายงาน AR กรองพนักงานขายจากตารางนี้)
--   im_transaction_salesperson : ส่งสินค้า / รับคืน / ลดหนี้ / เพิ่มหนี้ลูกหนี้ (คัดลอกไปใบ AR ที่สร้างอัตโนมัติ)
--   so_transaction_salesperson / quote_transaction_salesperson : ใบสั่งขาย / ใบเสนอราคา

CREATE TABLE IF NOT EXISTS ar_transaction_salesperson (
    id             SERIAL PRIMARY KEY,
    header_id      INTEGER NOT NULL REFERENCES ar_transaction(id) ON DELETE CASCADE,
    line_no        SMALLINT NOT NULL DEFAULT 1,
    salesperson_id INTEGER NOT NULL REFERENCES cd_salesperson(id),
    is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
    share_percent  NUMERIC(7,4),
    share_amount   NUMERIC(18,2),
    UNIQUE (header_id, salesperson_id)
);
CREATE INDEX IF NOT EXISTS idx_ar_transaction_salesperson_sp ON ar_transaction_salesperson (salesperson_id);

CREATE TABLE IF NOT EXISTS im_transaction_salesperson (
    id             SERIAL PRIMARY KEY,
    header_id      INTEGER NOT NULL REFERENCES im_transaction(id) ON DELETE CASCADE,
    line_no        SMALLINT NOT NULL DEFAULT 1,
    salesperson_id INTEGER NOT NULL REFERENCES cd_salesperson(id),
    is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
    share_percent  NUMERIC(7,4),
    share_amount   NUMERIC(18,2),
    UNIQUE (header_id, salesperson_id)
);
CREATE INDEX IF NOT EXISTS idx_im_transaction_salesperson_sp ON im_transaction_salesperson (salesperson_id);

CREATE TABLE IF NOT EXISTS so_transaction_salesperson (
    id             SERIAL PRIMARY KEY,
    header_id      INTEGER NOT NULL REFERENCES so_transaction(id) ON DELETE CASCADE,
    line_no        SMALLINT NOT NULL DEFAULT 1,
    salesperson_id INTEGER NOT NULL REFERENCES cd_salesperson(id),
    is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
    share_percent  NUMERIC(7,4),
    share_amount   NUMERIC(18,2),
    UNIQUE (header_id, salesperson_id)
);
CREATE INDEX IF NOT EXISTS idx_so_transaction_salesperson_sp ON so_transaction_salesperson (salesperson_id);

CREATE TABLE IF NOT EXISTS quote_transaction_salesperson (
    id             SERIAL PRIMARY KEY,
    header_id      INTEGER NOT NULL REFERENCES quote_transaction(id) ON DELETE CASCADE,
    line_no        SMALLINT NOT NULL DEFAULT 1,
    salesperson_id INTEGER NOT NULL REFERENCES cd_salesperson(id),
    is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
    share_percent  NUMERIC(7,4),
    share_amount   NUMERIC(18,2),
    UNIQUE (header_id, salesperson_id)
);
CREATE INDEX IF NOT EXISTS idx_quote_transaction_salesperson_sp ON quote_transaction_salesperson (salesperson_id);

-- เอกสารเดิม: ใส่พนักงานขายหลักของลูกค้า (ar_customer.salesperson_id ณ ตอนรัน) ให้รายงานตามพนักงานขาย
-- ย้อนหลังยังได้ผลเหมือนเดิม (เดิมรายงานกรองจากลูกค้า) — เฉพาะเอกสารที่ยังไม่มีรายชื่อ
INSERT INTO ar_transaction_salesperson (header_id, line_no, salesperson_id, is_primary)
SELECT t.id, 1, c.salesperson_id, TRUE
  FROM ar_transaction t
  JOIN sa_module_document d ON d.id = t.doc_id
  JOIN ar_customer c        ON c.id = t.customer_id
 WHERE d.sys_doc_type IN ('10', '30', '35', '50', '55')
   AND c.salesperson_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ar_transaction_salesperson x WHERE x.header_id = t.id);

INSERT INTO im_transaction_salesperson (header_id, line_no, salesperson_id, is_primary)
SELECT t.id, 1, c.salesperson_id, TRUE
  FROM im_transaction t
  JOIN sa_module_document d ON d.id = t.doc_id
  JOIN ar_customer c        ON c.id = t.customer_id
 WHERE d.sys_doc_type IN ('30', '31', '32', '35', '40', '45')
   AND c.salesperson_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM im_transaction_salesperson x WHERE x.header_id = t.id);

INSERT INTO so_transaction_salesperson (header_id, line_no, salesperson_id, is_primary)
SELECT t.id, 1, c.salesperson_id, TRUE
  FROM so_transaction t
  JOIN ar_customer c ON c.id = t.customer_id
 WHERE c.salesperson_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM so_transaction_salesperson x WHERE x.header_id = t.id);

INSERT INTO quote_transaction_salesperson (header_id, line_no, salesperson_id, is_primary)
SELECT t.id, 1, c.salesperson_id, TRUE
  FROM quote_transaction t
  JOIN ar_customer c ON c.id = t.customer_id
 WHERE c.salesperson_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM quote_transaction_salesperson x WHERE x.header_id = t.id);

-- สัดส่วนของเอกสารที่ยังว่าง: เติมจากข้อมูลลูกค้าปัจจุบัน (ตรึงไว้ตั้งแต่ตอนนี้) — รันซ้ำได้ ไม่ทับค่าที่มีแล้ว
UPDATE ar_transaction_salesperson x
   SET share_percent = cs.share_percent, share_amount = cs.share_amount
  FROM ar_transaction t
  JOIN ar_customer_salesperson cs ON cs.customer_id = t.customer_id
 WHERE t.id = x.header_id
   AND cs.salesperson_id = x.salesperson_id
   AND x.share_percent IS NULL AND x.share_amount IS NULL
   AND (cs.share_percent IS NOT NULL OR cs.share_amount IS NOT NULL);

UPDATE im_transaction_salesperson x
   SET share_percent = cs.share_percent, share_amount = cs.share_amount
  FROM im_transaction t
  JOIN ar_customer_salesperson cs ON cs.customer_id = t.customer_id
 WHERE t.id = x.header_id
   AND cs.salesperson_id = x.salesperson_id
   AND x.share_percent IS NULL AND x.share_amount IS NULL
   AND (cs.share_percent IS NOT NULL OR cs.share_amount IS NOT NULL);

UPDATE so_transaction_salesperson x
   SET share_percent = cs.share_percent, share_amount = cs.share_amount
  FROM so_transaction t
  JOIN ar_customer_salesperson cs ON cs.customer_id = t.customer_id
 WHERE t.id = x.header_id
   AND cs.salesperson_id = x.salesperson_id
   AND x.share_percent IS NULL AND x.share_amount IS NULL
   AND (cs.share_percent IS NOT NULL OR cs.share_amount IS NOT NULL);

UPDATE quote_transaction_salesperson x
   SET share_percent = cs.share_percent, share_amount = cs.share_amount
  FROM quote_transaction t
  JOIN ar_customer_salesperson cs ON cs.customer_id = t.customer_id
 WHERE t.id = x.header_id
   AND cs.salesperson_id = x.salesperson_id
   AND x.share_percent IS NULL AND x.share_amount IS NULL
   AND (cs.share_percent IS NOT NULL OR cs.share_amount IS NOT NULL);
