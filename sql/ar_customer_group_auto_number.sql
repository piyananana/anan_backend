-- ar_customer_group_auto_number.sql
-- Add auto-number columns to ar_customer_group table

ALTER TABLE ar_customer_group
  ADD COLUMN IF NOT EXISTS is_auto_number      BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS running_prefix      VARCHAR(20)  NOT NULL DEFAULT 'CUST',
  ADD COLUMN IF NOT EXISTS running_separator   VARCHAR(5)   NOT NULL DEFAULT '-',
  ADD COLUMN IF NOT EXISTS running_suffix_date VARCHAR(10)  NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS running_length      INTEGER      NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS running_next_number INTEGER      NOT NULL DEFAULT 1;
