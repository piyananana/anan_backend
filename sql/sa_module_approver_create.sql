-- sa_module_approver: ตั้งค่าผู้อนุมัติต่อโมดูลและประเภทงาน
CREATE TABLE IF NOT EXISTS sa_module_approver (
    id                SERIAL PRIMARY KEY,
    module_code       VARCHAR(10)  NOT NULL,   -- 'AP', 'AR', 'GL', ...
    doc_category      VARCHAR(50)  NOT NULL,   -- 'payment_run', 'receipt_run', ...
    approval_level    INTEGER      NOT NULL DEFAULT 1,
    approver_user_id  INTEGER      NOT NULL,
    signature_image   TEXT,                    -- base64 data URL ของลายเซ็น
    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by        VARCHAR(100),
    updated_by        VARCHAR(100),
    UNIQUE (module_code, doc_category, approval_level)
);
