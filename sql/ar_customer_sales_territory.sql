-- เพิ่มฟีลด์เขตการขายและพนักงานขายใน ar_customer
ALTER TABLE ar_customer
  ADD COLUMN IF NOT EXISTS sales_territory_id INTEGER REFERENCES cd_sales_territory(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS salesperson_id     INTEGER REFERENCES cd_salesperson(id)     ON DELETE SET NULL;
