-- AR Customer tables

CREATE TABLE IF NOT EXISTS ar_customer (
  id SERIAL PRIMARY KEY,
  customer_code VARCHAR(20) NOT NULL UNIQUE,
  customer_name_th VARCHAR(200) NOT NULL,
  customer_name_en VARCHAR(200),
  tax_id VARCHAR(20),
  business_type VARCHAR(20) DEFAULT 'trading', -- trading, manufacturing, service, mixed
  credit_days INT DEFAULT 30,
  credit_limit NUMERIC(18,2) DEFAULT 0,
  currency_code VARCHAR(10) DEFAULT 'THB',
  is_active BOOLEAN DEFAULT TRUE,
  remark TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by VARCHAR(100),
  updated_at TIMESTAMP DEFAULT NOW(),
  updated_by VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS ar_customer_address (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES ar_customer(id) ON DELETE CASCADE,
  address_type VARCHAR(20) DEFAULT 'billing', -- billing, shipping, other
  address_no VARCHAR(50),
  address_building_village VARCHAR(100),
  address_alley VARCHAR(100),
  address_road VARCHAR(100),
  address_sub_district VARCHAR(100),
  address_district VARCHAR(100),
  address_province VARCHAR(100),
  address_country VARCHAR(100) DEFAULT 'Thailand',
  address_zip_code VARCHAR(10),
  is_default BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS ar_customer_contact (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES ar_customer(id) ON DELETE CASCADE,
  contact_name VARCHAR(200) NOT NULL,
  position VARCHAR(100),
  phone VARCHAR(50),
  mobile VARCHAR(50),
  email VARCHAR(200),
  is_default BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS ar_customer_bank_account (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES ar_customer(id) ON DELETE CASCADE,
  bank_name VARCHAR(100),
  branch_name VARCHAR(100),
  account_number VARCHAR(50),
  account_name VARCHAR(200),
  account_type VARCHAR(20) DEFAULT 'current', -- current, savings
  is_default BOOLEAN DEFAULT FALSE
);
