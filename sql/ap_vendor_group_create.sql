-- สร้างตาราง ap_vendor_group และเพิ่ม vendor_group_id ใน ap_vendor

-- 1. ตาราง ap_vendor_group
CREATE TABLE IF NOT EXISTS ap_vendor_group (
    id                   SERIAL PRIMARY KEY,
    group_code           VARCHAR(50) UNIQUE NOT NULL,
    group_name_thai      VARCHAR(255) NOT NULL,
    group_name_eng       VARCHAR(255) DEFAULT '',
    description          TEXT,
    credit_term_months   INTEGER DEFAULT 0,
    credit_term_days     INTEGER DEFAULT 30,
    currency_code        VARCHAR(10) DEFAULT 'THB',
    ap_account_id        INTEGER REFERENCES gl_account(id) ON DELETE SET NULL,
    is_auto_number       BOOLEAN DEFAULT FALSE,
    running_prefix       VARCHAR(20) DEFAULT 'VEND',
    running_separator    VARCHAR(5)  DEFAULT '-',
    running_suffix_date  VARCHAR(10) DEFAULT '',
    running_length       INTEGER DEFAULT 4,
    running_next_number  INTEGER DEFAULT 1,
    is_active            BOOLEAN DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by           VARCHAR(100),
    updated_by           VARCHAR(100)
);

-- 2. เพิ่ม vendor_group_id ใน ap_vendor
ALTER TABLE ap_vendor
    ADD COLUMN IF NOT EXISTS vendor_group_id INTEGER REFERENCES ap_vendor_group(id) ON DELETE SET NULL;
