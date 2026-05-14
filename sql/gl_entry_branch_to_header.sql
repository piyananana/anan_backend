-- ============================================================
-- GL Entry: ย้าย branch_id จาก gl_entry_detail → gl_entry_header
-- Branch เป็น structural entity ระดับ document ทั้งใบ ไม่ใช่ per-line
-- ============================================================

-- STEP 1: เพิ่ม branch_id ใน gl_entry_header
ALTER TABLE gl_entry_header
    ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES cd_branch(id);

-- STEP 2: Backfill จาก detail บรรทัดแรกที่มี branch_id
UPDATE gl_entry_header h
SET branch_id = (
    SELECT d.branch_id
    FROM gl_entry_detail d
    WHERE d.header_id = h.id
      AND d.branch_id IS NOT NULL
    ORDER BY d.line_no
    LIMIT 1
)
WHERE h.branch_id IS NULL;

-- STEP 3: ยืนยันผล
DO $$
DECLARE
    v_header_with_branch INT;
    v_total_headers      INT;
BEGIN
    SELECT COUNT(*) INTO v_total_headers FROM gl_entry_header;
    SELECT COUNT(*) INTO v_header_with_branch
        FROM gl_entry_header WHERE branch_id IS NOT NULL;
    RAISE NOTICE 'gl_entry_header: total=%, with branch_id=%', v_total_headers, v_header_with_branch;
END $$;

-- NOTE: gl_entry_detail.branch_id column ยังคงอยู่ในฐานข้อมูลเพื่อ backward compat
-- แต่ application code จะหยุด read/write ค่านี้แล้ว
-- สามารถ DROP ได้ในภายหลังเมื่อยืนยันว่าระบบทำงานถูกต้อง:
-- ALTER TABLE gl_entry_detail DROP COLUMN IF EXISTS branch_id;
