-- cd_sales_territory: เขตการขาย (ลำดับชั้นได้ด้วย parent_id)
CREATE TABLE IF NOT EXISTS cd_sales_territory (
    id                  SERIAL PRIMARY KEY,
    territory_code      VARCHAR(20)  NOT NULL UNIQUE,
    territory_name_thai VARCHAR(100) NOT NULL,
    territory_name_eng  VARCHAR(100),
    parent_id           INTEGER REFERENCES cd_sales_territory(id),
    sort_order          SMALLINT NOT NULL DEFAULT 0,
    description         TEXT,
    effective_date_from DATE,
    effective_date_to   DATE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    created_by          VARCHAR(100),
    updated_by          VARCHAR(100)
);

-- cd_salesperson: พนักงานขาย (บุคคลภายใน/นอก/บริษัท)
CREATE TABLE IF NOT EXISTS cd_salesperson (
    id                   SERIAL PRIMARY KEY,
    salesperson_code     VARCHAR(20)  NOT NULL UNIQUE,
    salesperson_name_thai VARCHAR(200) NOT NULL,
    salesperson_name_eng  VARCHAR(200),
    salesperson_type     VARCHAR(20)  NOT NULL DEFAULT 'EMPLOYEE'
                         CHECK (salesperson_type IN ('EMPLOYEE','INDIVIDUAL','COMPANY')),
    user_id              INTEGER REFERENCES sa_user(id),
    tax_id               VARCHAR(20),
    branch_code          VARCHAR(10),
    phone                VARCHAR(30),
    email                VARCHAR(100),
    address              TEXT,
    commission_rate      NUMERIC(5,2) NOT NULL DEFAULT 0,
    effective_date_from  DATE,
    effective_date_to    DATE,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    created_by           VARCHAR(100),
    updated_by           VARCHAR(100)
);

-- cd_salesperson_territory: M:N ระหว่างพนักงานขายกับเขตการขาย
CREATE TABLE IF NOT EXISTS cd_salesperson_territory (
    id              SERIAL PRIMARY KEY,
    salesperson_id  INTEGER NOT NULL REFERENCES cd_salesperson(id) ON DELETE CASCADE,
    territory_id    INTEGER NOT NULL REFERENCES cd_sales_territory(id) ON DELETE CASCADE,
    is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
    effective_date_from DATE,
    effective_date_to   DATE,
    UNIQUE (salesperson_id, territory_id)
);

-- เพิ่ม FK ใน ar_customer
ALTER TABLE ar_customer
    ADD COLUMN IF NOT EXISTS territory_id   INTEGER REFERENCES cd_sales_territory(id),
    ADD COLUMN IF NOT EXISTS salesperson_id INTEGER REFERENCES cd_salesperson(id);

-- เพิ่ม business_unit_id ใน cd_salesperson
ALTER TABLE cd_salesperson
    ADD COLUMN IF NOT EXISTS business_unit_id INTEGER REFERENCES cd_business_unit(id);

-- เปลี่ยน branch_code เป็น branch_id (FK → cd_branch.id)
ALTER TABLE cd_salesperson
    DROP COLUMN IF EXISTS branch_code,
    ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES cd_branch(id);
