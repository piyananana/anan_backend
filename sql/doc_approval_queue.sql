-- คิวผู้อนุมัติกลาง (utils/docApproval.js) — 2026-10-20
-- เปลี่ยนการอนุมัติขั้นเดียว (ผู้มีสิทธิ์ "อนุมัติ" กดอนุมัติได้เลย) มาใช้คิวผู้อนุมัติของเมนู:
-- PO, SO, เปลี่ยนแปลงราคา (IM), ตรวจนับสต็อก (IM), ใบสั่งผลิต (MO)
-- idempotent — รันซ้ำได้ (ระบบสร้างให้เองตอนใช้งานครั้งแรกด้วย)

CREATE TABLE IF NOT EXISTS doc_approval (
    id                 SERIAL PRIMARY KEY,
    doc_kind           VARCHAR(20) NOT NULL,        -- PO / SO / IM_PRICE / IM_COUNT / MO
    record_id          INTEGER     NOT NULL,
    approver_user_id   INTEGER     NOT NULL,
    approver_user_name VARCHAR(100),
    sequence_no        INTEGER     NOT NULL DEFAULT 1,
    status             VARCHAR(20) NOT NULL DEFAULT 'Pending', -- Pending / Approved / Rejected / Skipped
    remarks            TEXT,
    approved_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doc_approval_record ON doc_approval (doc_kind, record_id);

-- โหมดการอนุมัติ (ALL / ANY) ณ ตอนส่ง + ผู้ส่ง/เวลาส่ง
ALTER TABLE po_transaction
    ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(10) DEFAULT 'ALL',
    ADD COLUMN IF NOT EXISTS submitted_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS submitted_by  VARCHAR(100);
ALTER TABLE so_transaction
    ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(10) DEFAULT 'ALL',
    ADD COLUMN IF NOT EXISTS submitted_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS submitted_by  VARCHAR(100);
ALTER TABLE im_price_change_header
    ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(10) DEFAULT 'ALL',
    ADD COLUMN IF NOT EXISTS submitted_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS submitted_by  VARCHAR(100);
ALTER TABLE im_stock_count
    ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(10) DEFAULT 'ALL',
    ADD COLUMN IF NOT EXISTS submitted_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS submitted_by  VARCHAR(100);
ALTER TABLE mo_header
    ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(10) DEFAULT 'ALL',
    ADD COLUMN IF NOT EXISTS submitted_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS submitted_by  VARCHAR(100);

-- ย้ายคิวเดิมที่แยกต่อเอกสารเข้าตารางกลาง (ครั้งเดียวต่อ doc_kind — ข้ามถ้า doc_kind นั้นมีแถวแล้ว)
-- ตารางเดิมเก็บไว้ ไม่มีโค้ดใดใช้แล้ว (ระบบย้ายให้เองด้วยตอนใช้งานครั้งแรก: utils/docApproval.js migrateLegacy)
DO $$
DECLARE
    m RECORD;
BEGIN
    FOR m IN SELECT * FROM (VALUES
        ('PR',        'pr_transaction_approval',    'header_id',      NULL),
        ('QUOTE',     'quote_transaction_approval', 'header_id',      NULL),
        ('AP_TXN',    'ap_transaction_approval',    'transaction_id', NULL),
        ('AP_PAYRUN', 'ap_payment_run_approval',    'run_id',         NULL),
        ('GL_CLOSE',  'gl_period_close_approval',   'request_id',     NULL),
        ('AR_CREDIT', 'credit_approval',            'record_id',      'module = ''AR'''),
        ('IM_CREDIT', 'credit_approval',            'record_id',      'module = ''IM''')
    ) AS t(kind, tbl, rec_col, cond)
    LOOP
        IF to_regclass(m.tbl) IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM doc_approval WHERE doc_kind = m.kind) THEN
            EXECUTE format(
                'INSERT INTO doc_approval (doc_kind, record_id, approver_user_id, approver_user_name, sequence_no, status, remarks, approved_at)
                 SELECT %L, %I, approver_user_id, approver_user_name, COALESCE(sequence_no, 1), status, remarks, approved_at
                   FROM %I %s ORDER BY id',
                m.kind, m.rec_col, m.tbl, CASE WHEN m.cond IS NULL THEN '' ELSE 'WHERE ' || m.cond END);
        END IF;
    END LOOP;
END $$;

-- โหมดการอนุมัติของคำขอปิดงวด GL + ให้สถานะงวด GL รองรับ PENDING_CLOSE (ฐานข้อมูลเดิมมี check แค่ OPEN/LOCKED/CLOSED)
ALTER TABLE gl_period_close_request ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(10) DEFAULT 'ALL';
ALTER TABLE gl_posting_period ALTER COLUMN gl_status TYPE VARCHAR(20);
ALTER TABLE gl_posting_period DROP CONSTRAINT IF EXISTS gl_posting_period_gl_status_check;
ALTER TABLE gl_posting_period ADD CONSTRAINT gl_posting_period_gl_status_check
    CHECK (gl_status IN ('OPEN', 'LOCKED', 'CLOSED', 'PENDING_CLOSE'));
