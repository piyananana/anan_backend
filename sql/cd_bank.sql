-- ตาราง cd_bank: ข้อมูลธนาคาร
-- ตาราง cd_bank_branch: ข้อมูลสาขาธนาคาร
-- สร้างครั้งแรก: 2026-03-17

CREATE TABLE IF NOT EXISTS cd_bank (
  id             SERIAL PRIMARY KEY,
  bank_code      VARCHAR(10)  NOT NULL UNIQUE,
  bank_name_thai VARCHAR(150) NOT NULL,
  bank_name_eng  VARCHAR(150),
  short_name     VARCHAR(30),
  swift_code     VARCHAR(20),
  is_active      BOOLEAN      NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     VARCHAR(100),
  updated_by     VARCHAR(100)
);

CREATE TABLE IF NOT EXISTS cd_bank_branch (
  id             SERIAL PRIMARY KEY,
  bank_id        INT          NOT NULL REFERENCES cd_bank(id) ON DELETE CASCADE,
  branch_code    VARCHAR(20),
  branch_name    VARCHAR(200) NOT NULL,
  branch_address TEXT,
  is_active      BOOLEAN      NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     VARCHAR(100),
  updated_by     VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_cd_bank_branch_bank_id ON cd_bank_branch(bank_id);
