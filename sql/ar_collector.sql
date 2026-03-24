-- ar_collector: ผู้วางบิล/รับชำระ
-- สร้างตารางหลัก
CREATE TABLE IF NOT EXISTS ar_collector (
    id                   SERIAL PRIMARY KEY,
    collector_code       VARCHAR(20)  NOT NULL UNIQUE,
    collector_name_thai  VARCHAR(200) NOT NULL,
    collector_name_eng   VARCHAR(200),
    collector_type       VARCHAR(20)  NOT NULL DEFAULT 'EMPLOYEE'
                         CHECK (collector_type IN ('EMPLOYEE','INDIVIDUAL','COMPANY')),
    tax_id               VARCHAR(20),
    branch_id            INTEGER REFERENCES cd_branch(id),
    business_unit_id     INTEGER REFERENCES cd_business_unit(id),
    phone                VARCHAR(50),
    email                VARCHAR(200),
    address              TEXT,
    effective_date_from  DATE,
    effective_date_to    DATE,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    created_by           VARCHAR(100),
    updated_by           VARCHAR(100)
);

-- เพิ่ม FK ใน ar_customer สำหรับผู้วางบิลและผู้รับชำระ
ALTER TABLE ar_customer
    ADD COLUMN IF NOT EXISTS billing_collector_id    INTEGER REFERENCES ar_collector(id),
    ADD COLUMN IF NOT EXISTS collection_collector_id INTEGER REFERENCES ar_collector(id);
