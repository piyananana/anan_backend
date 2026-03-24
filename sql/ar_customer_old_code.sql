-- Migration: add old_customer_code column to ar_customer
ALTER TABLE ar_customer
  ADD COLUMN IF NOT EXISTS old_customer_code VARCHAR(50);
