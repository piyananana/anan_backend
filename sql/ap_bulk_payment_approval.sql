-- ชุดจ่ายแบบกลุ่ม (AP Bulk Payment) ต้องผ่านการอนุมัติก่อนจ่าย
-- ตารางถูกสร้างอัตโนมัติโดย apBulkPaymentController.ensureBulkSchema — ไฟล์นี้สำหรับรันล่วงหน้าต่อฐานข้อมูล (idempotent)

CREATE TABLE IF NOT EXISTS ap_bulk_payment (
    id              SERIAL PRIMARY KEY,
    batch_no        VARCHAR(30) NOT NULL UNIQUE,
    payment_date    DATE NOT NULL,
    bank_account_id INTEGER NOT NULL,
    payment_method  VARCHAR(20) NOT NULL DEFAULT 'TRANSFER',
    description     TEXT,
    total_amount_lc NUMERIC(18,2) NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'Draft',  -- Draft / Submitted / Approved / Paid / Deleted
    approval_mode   VARCHAR(10) DEFAULT 'ALL',
    gl_entry_id     INTEGER,
    gl_doc_no       VARCHAR(50),
    paid_by         VARCHAR(100),
    paid_at         TIMESTAMPTZ,
    created_by      VARCHAR(100),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      VARCHAR(100),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ap_bulk_payment_detail (
    id                SERIAL PRIMARY KEY,
    batch_id          INTEGER NOT NULL REFERENCES ap_bulk_payment(id) ON DELETE CASCADE,
    ap_transaction_id INTEGER NOT NULL,
    amount_lc         NUMERIC(18,2) NOT NULL,
    sort_order        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ap_bulk_payment_detail_batch ON ap_bulk_payment_detail (batch_id);

-- เมนูจ่ายแบบกลุ่มมีขั้นตอนอนุมัติ (ให้สิทธิ์ "อนุมัติ" และตั้งคิวผู้อนุมัติ/วงเงินอนุมัติจ่ายได้)
UPDATE sa_menu SET requires_approval = true
 WHERE target_path = 'ApBulkPaymentScreen' AND requires_approval IS DISTINCT FROM true;
