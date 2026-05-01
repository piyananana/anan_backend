-- ar_transaction_payment.sql
-- ตารางเก็บรายละเอียดวิธีรับชำระเงินของเอกสาร AR Receipt (70) และ Advance Receipt (60)
-- แต่ละบรรทัดคือวิธีการชำระ 1 รายการ
-- GL: DR per payment line → CR AR Account (70) หรือ CR Advance Account (60)
-- payment_method_type: CASH / CHECK / TRANSFER / CREDIT_CARD / DEBIT_CARD /
--                      QR_CODE / MOBILE_BANKING / BILL_OF_EXCHANGE / OTHER

CREATE TABLE IF NOT EXISTS ar_transaction_payment (
    id                   SERIAL PRIMARY KEY,
    header_id            INT NOT NULL REFERENCES ar_transaction(id) ON DELETE CASCADE,
    line_no              INT NOT NULL DEFAULT 1,

    -- ── วิธีชำระ (snapshot จาก cm_payment_method) ──────────────────────
    payment_method_id    INT REFERENCES cm_payment_method(id),
    payment_method_code  VARCHAR(50),
    payment_method_name  VARCHAR(200),
    payment_method_type  VARCHAR(30) NOT NULL DEFAULT 'CASH',

    -- ── บัญชีธนาคารที่รับเงิน (ถ้ามี) ─────────────────────────────────
    cm_bank_account_id   INT REFERENCES cm_bank_account(id),

    -- ── GL account ที่ DR (resolved ณ เวลาบันทึก) ──────────────────────
    -- Priority: cm_payment_method.gl_account_id → cm_bank_account.gl_account_id
    --           → ar_gl_account_setup.cash_account_id
    gl_account_id        INT REFERENCES gl_account(id),

    -- ── จำนวนเงิน ────────────────────────────────────────────────────────
    amount_lc            NUMERIC(18,4) NOT NULL DEFAULT 0,
    amount_fc            NUMERIC(18,4) NOT NULL DEFAULT 0,

    -- ── ข้อมูลทั่วไป ─────────────────────────────────────────────────────
    ref_no               VARCHAR(100),   -- เลขที่เช็ค / เลขอ้างอิงการโอน / เลขตั๋ว
    payment_date         DATE,           -- วันที่บนเช็ค / วันที่โอน / วันครบกำหนดตั๋ว
    remark               TEXT,

    -- ── ข้อมูลเช็ค / โอน / ตั๋วแลกเงิน ─────────────────────────────────
    drawer_bank_name     VARCHAR(100),   -- ธนาคารผู้ออกเช็ค / ธนาคารต้นทาง
    drawer_bank_branch   VARCHAR(100),   -- สาขา
    drawer_account_no    VARCHAR(50),    -- เลขที่บัญชีเจ้าของเช็ค / ต้นทาง

    -- ── ข้อมูลบัตรเครดิต / เดบิต ─────────────────────────────────────────
    card_type            VARCHAR(20),    -- VISA/MASTERCARD/AMEX/JCB/UNIONPAY/OTHER
    card_last4           CHAR(4),        -- 4 หลักท้ายของบัตร
    approval_code        VARCHAR(20),    -- รหัสอนุมัติ (Authorization Code) — สำคัญสำหรับ dispute
    terminal_id          VARCHAR(20),    -- รหัสเครื่อง EDC
    batch_no             VARCHAR(20),    -- เลขที่ Batch

    -- ── Audit ─────────────────────────────────────────────────────────────
    created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
    created_by           VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_ar_transaction_payment_header ON ar_transaction_payment(header_id);
