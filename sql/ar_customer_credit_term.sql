-- Migration: rename credit_days → credit_term, add credit_term_type
ALTER TABLE ar_customer RENAME COLUMN credit_days TO credit_term;
ALTER TABLE ar_customer ADD COLUMN IF NOT EXISTS credit_term_type VARCHAR(10) NOT NULL DEFAULT 'DAY';
