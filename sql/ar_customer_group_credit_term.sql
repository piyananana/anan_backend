-- Migration: rename credit_days → credit_term, add credit_term_type in ar_customer_group
ALTER TABLE ar_customer_group RENAME COLUMN credit_days TO credit_term;
ALTER TABLE ar_customer_group ADD COLUMN IF NOT EXISTS credit_term_type VARCHAR(10) NOT NULL DEFAULT 'DAY';
