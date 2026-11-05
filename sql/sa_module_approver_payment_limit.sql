-- วงเงินอนุมัติจ่าย (เอกสารจ่ายเงิน AP/CM) — 2026-11-05
-- แยกจาก approval_limit (วงเงินอนุมัติเกินวงเงินเครดิต AR/IM/SO); 0 = ไม่มีวงเงินจ่าย (อนุมัติจ่ายไม่ได้)
-- ใช้ใน utils/docApproval.js paymentChain — idempotent (ระบบเพิ่มให้เองตอนใช้งานครั้งแรกด้วย)
ALTER TABLE sa_module_approver ADD COLUMN IF NOT EXISTS payment_limit NUMERIC(18,2) DEFAULT 0;
