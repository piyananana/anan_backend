-- แก้โครงสร้าง ap_gl_account_setup ให้ตรงกับ ar_gl_account_setup
-- เพิ่ม id SERIAL PRIMARY KEY และเปลี่ยน doc_code เป็น NOT NULL UNIQUE

-- 1. เพิ่ม column id (ถ้ายังไม่มี)
ALTER TABLE ap_gl_account_setup ADD COLUMN IF NOT EXISTS id SERIAL;

-- 2. ย้าย PRIMARY KEY จาก doc_code → id
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'ap_gl_account_setup'::regclass AND contype = 'p'
    ) THEN
        ALTER TABLE ap_gl_account_setup DROP CONSTRAINT ap_gl_account_setup_pkey;
    END IF;
END $$;

ALTER TABLE ap_gl_account_setup ADD PRIMARY KEY (id);

-- 3. เพิ่ม UNIQUE constraint บน doc_code (ถ้ายังไม่มี)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'ap_gl_account_setup'::regclass
          AND contype = 'u'
    ) THEN
        ALTER TABLE ap_gl_account_setup ADD UNIQUE (doc_code);
    END IF;
END $$;
