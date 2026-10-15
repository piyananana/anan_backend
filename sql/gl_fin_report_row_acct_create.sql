-- ============================================================
-- gl_fin_report_row_acct: เงื่อนไขเลือกบัญชีของบรรทัด (ACCOUNTS) ได้หลายเงื่อนไข
-- Financial report builder redesign — Phase 3
--
-- บัญชีอยู่ในบรรทัด เมื่อ ตรงเงื่อนไข "รวม" อย่างน้อย 1 เงื่อนไข และไม่ตรงเงื่อนไข "ยกเว้น" ใดเลย
--   sel_type = RANGE        ช่วงรหัส account_from..account_to (account_to รวมบัญชีลูกที่ขึ้นต้นด้วยรหัสนั้น)
--   sel_type = UNDER_HEADER ทุกบัญชีใต้หัวบัญชี header_account_code (ตาม parent_id รวมตัวมันเอง)
--   sel_type = ACCOUNT_TYPE ทุกบัญชีที่ account_type ตรงกัน (ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE)
--
-- แทน gl_fin_report_row.account_from/account_to (ช่วงเดียว) — สคริปต์นี้ย้ายช่วงเดิมมาเป็น RANGE
-- แล้วล้างค่าเดิมในบรรทัด (engine ยังอ่านค่าเดิมถ้าบรรทัดไม่มีเงื่อนไขในตารางนี้)
-- รันซ้ำได้
-- ============================================================

CREATE TABLE IF NOT EXISTS gl_fin_report_row_acct (
    id                   SERIAL PRIMARY KEY,
    row_id               INT NOT NULL REFERENCES gl_fin_report_row(id) ON DELETE CASCADE,
    seq_no               INT NOT NULL DEFAULT 0,
    sel_type             VARCHAR(15) NOT NULL DEFAULT 'RANGE',   -- RANGE | UNDER_HEADER | ACCOUNT_TYPE
    is_exclude           BOOLEAN NOT NULL DEFAULT FALSE,         -- TRUE = ยกเว้นบัญชีที่ตรงเงื่อนไขนี้
    account_from         VARCHAR(50),                            -- RANGE
    account_to           VARCHAR(50),                            -- RANGE
    header_account_code  VARCHAR(50),                            -- UNDER_HEADER (เก็บรหัส ไม่ใช่ id เพื่อย้ายข้ามฐานข้อมูลได้)
    account_type         VARCHAR(20),                            -- ACCOUNT_TYPE
    created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT gl_fin_report_row_acct_type_ck CHECK (sel_type IN ('RANGE', 'UNDER_HEADER', 'ACCOUNT_TYPE')),
    CONSTRAINT gl_fin_report_row_acct_fields_ck CHECK (
        (sel_type = 'RANGE'        AND account_from IS NOT NULL AND account_to IS NOT NULL) OR
        (sel_type = 'UNDER_HEADER' AND header_account_code IS NOT NULL) OR
        (sel_type = 'ACCOUNT_TYPE' AND account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'))
    )
);

CREATE INDEX IF NOT EXISTS gl_fin_report_row_acct_row_idx ON gl_fin_report_row_acct (row_id);

-- ย้ายช่วงบัญชีเดิมของบรรทัดมาเป็นเงื่อนไข RANGE แล้วล้างค่าเดิม
INSERT INTO gl_fin_report_row_acct (row_id, seq_no, sel_type, account_from, account_to)
SELECT r.id, 10, 'RANGE', r.account_from, r.account_to
  FROM gl_fin_report_row r
 WHERE COALESCE(r.account_from, '') <> '' AND COALESCE(r.account_to, '') <> ''
   AND NOT EXISTS (SELECT 1 FROM gl_fin_report_row_acct x WHERE x.row_id = r.id);

UPDATE gl_fin_report_row r SET account_from = NULL, account_to = NULL
 WHERE (COALESCE(r.account_from, '') <> '' OR COALESCE(r.account_to, '') <> '')
   AND EXISTS (SELECT 1 FROM gl_fin_report_row_acct x WHERE x.row_id = r.id);

-- ตรวจสอบผล
DO $$
DECLARE v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count FROM information_schema.columns WHERE table_name = 'gl_fin_report_row_acct';
    RAISE NOTICE 'gl_fin_report_row_acct columns: % (ต้อง = 10)', v_count;
END $$;
