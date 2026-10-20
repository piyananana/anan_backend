-- ขออนุมัติเกินวงเงินเครดิตลูกหนี้ (AR / IM) — โครงสร้างเดียวกับ utils/creditCheck.js — รันซ้ำได้ (apply per DB)
-- ar_customer.credit_limit = 0 → ไม่ตรวจ; เอกสารยังเป็น Draft ระหว่างขออนุมัติ ใช้ credit_status: NULL / Pending / Approved

ALTER TABLE ar_transaction
    ADD COLUMN IF NOT EXISTS credit_status         VARCHAR(10),
    ADD COLUMN IF NOT EXISTS credit_amount         NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS credit_limit_at       NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS credit_outstanding_at NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS credit_approval_mode  VARCHAR(10),
    ADD COLUMN IF NOT EXISTS credit_requested_by   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS credit_requested_at   TIMESTAMPTZ;

ALTER TABLE im_transaction
    ADD COLUMN IF NOT EXISTS credit_status         VARCHAR(10),
    ADD COLUMN IF NOT EXISTS credit_amount         NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS credit_limit_at       NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS credit_outstanding_at NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS credit_approval_mode  VARCHAR(10),
    ADD COLUMN IF NOT EXISTS credit_requested_by   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS credit_requested_at   TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS credit_approval (
    id                 SERIAL PRIMARY KEY,
    module             VARCHAR(2)  NOT NULL,        -- 'AR' | 'IM'
    record_id          INTEGER     NOT NULL,        -- ar_transaction.id / im_transaction.id
    approver_user_id   INTEGER     NOT NULL,
    approver_user_name VARCHAR(100),
    sequence_no        INTEGER     NOT NULL DEFAULT 1,
    status             VARCHAR(20) NOT NULL DEFAULT 'Pending', -- Pending / Approved / Rejected / Skipped
    remarks            TEXT,
    approved_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_approval_record ON credit_approval (module, record_id);

-- ไม่มีผู้อนุมัติในคิว: ALLOW = ให้ผ่าน (อนุมัติอัตโนมัติ), BLOCK = ไม่ให้ผ่าน — ตั้งที่หน้าจอผู้อนุมัติ
ALTER TABLE sa_menu ADD COLUMN IF NOT EXISTS no_approver_action VARCHAR(10) DEFAULT 'ALLOW';
-- วงเงินอนุมัติของผู้อนุมัติ (จำกัดส่วนที่เกินวงเงินเครดิต; 0 = ไม่จำกัด)
ALTER TABLE sa_module_approver ADD COLUMN IF NOT EXISTS approval_limit NUMERIC(18,2) DEFAULT 0;
