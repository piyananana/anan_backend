-- ใบสั่งผลิต: ถอยสถานะ (Released -> Draft, Closed -> Completed) / ยกเลิกแบบมีเหตุผล / ลบแบบเก็บไว้ (status 'Deleted')
ALTER TABLE mo_header
    ADD COLUMN IF NOT EXISTS close_gl_entry_id    INTEGER,
    ADD COLUMN IF NOT EXISTS close_date           DATE,
    ADD COLUMN IF NOT EXISTS kept_close_gl_doc_no VARCHAR(50),
    ADD COLUMN IF NOT EXISTS cancel_reason        TEXT,
    ADD COLUMN IF NOT EXISTS cancelled_by         VARCHAR(100),
    ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ;
