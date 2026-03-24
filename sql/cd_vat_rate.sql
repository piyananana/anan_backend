-- ตารางเก็บอัตราภาษีมูลค่าเพิ่ม (VAT Rate)
-- แต่ละแถวคืออัตราภาษีของรหัส VAT หนึ่งรหัสในช่วงเวลาหนึ่ง
-- effective_date = วันที่เริ่มใช้อัตรานี้
-- end_date = วันสุดท้ายที่ใช้อัตรานี้ (NULL = ยังใช้อยู่จนถึงปัจจุบัน)

CREATE TABLE IF NOT EXISTS cd_vat_rate (
    id               SERIAL PRIMARY KEY,
    vat_code         VARCHAR(20)      NOT NULL,                -- รหัสประเภทภาษี เช่น 'VAT', 'VAT0'
    vat_name_th      VARCHAR(100)     NOT NULL,                -- ชื่อภาษาไทย
    vat_name_en      VARCHAR(100),                             -- ชื่อภาษาอังกฤษ
    rate             NUMERIC(10, 4)   NOT NULL,                -- อัตราภาษี (%) เช่น 7.0000
    effective_date   DATE             NOT NULL,                -- วันที่มีผลบังคับใช้
    end_date         DATE,                                     -- วันสิ้นสุด (NULL = ปัจจุบัน)
    is_active        BOOLEAN          NOT NULL DEFAULT TRUE,
    remark           VARCHAR(200),
    created_at       TIMESTAMP        NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP        NOT NULL DEFAULT NOW(),
    created_by       VARCHAR(100),
    updated_by       VARCHAR(100),
    UNIQUE (vat_code, effective_date)  -- ป้องกันอัตราซ้ำในวันเดียวกันของรหัสเดียวกัน
);

-- ตัวอย่างข้อมูลเริ่มต้น
INSERT INTO cd_vat_rate (vat_code, vat_name_th, vat_name_en, rate, effective_date, end_date, created_by, updated_by)
VALUES
    ('VAT7',  'ภาษีมูลค่าเพิ่ม 7%',   'Value Added Tax 7%',  7.0000, '1999-04-01', NULL,         'system', 'system'),
    ('VAT0',  'ภาษีมูลค่าเพิ่ม 0%',   'Value Added Tax 0%',  0.0000, '1999-04-01', NULL,         'system', 'system'),
    ('EXEMPT','ยกเว้นภาษีมูลค่าเพิ่ม', 'VAT Exempt',          0.0000, '1999-04-01', NULL,         'system', 'system')
ON CONFLICT DO NOTHING;
