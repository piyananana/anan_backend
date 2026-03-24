-- Billing schedule fields for ar_customer
-- Run this migration to add billing appointment condition columns

ALTER TABLE ar_customer
  ADD COLUMN IF NOT EXISTS billing_day_of_week      SMALLINT,       -- 0=อาทิตย์,1=จันทร์,2=อังคาร,3=พุธ,4=พฤหัส,5=ศุกร์,6=เสาร์
  ADD COLUMN IF NOT EXISTS billing_week_of_month    SMALLINT[],     -- {1,2,3,4,-1}  1=แรก,2=ที่2,3=ที่3,4=ที่4,-1=สุดท้าย
  ADD COLUMN IF NOT EXISTS billing_date_from        SMALLINT,       -- วันที่เริ่มต้นของเดือน 1-31
  ADD COLUMN IF NOT EXISTS billing_date_to          SMALLINT,       -- วันที่สิ้นสุดของเดือน 1-31
  ADD COLUMN IF NOT EXISTS billing_time_from        VARCHAR(5),     -- เวลาเริ่มต้น 'HH:mm'
  ADD COLUMN IF NOT EXISTS billing_time_to          VARCHAR(5),     -- เวลาสิ้นสุด 'HH:mm'
  ADD COLUMN IF NOT EXISTS billing_exclude_holidays BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_remark           TEXT;
