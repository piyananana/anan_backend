-- ธุรกรรมเปลี่ยนแปลงราคา: ถอย / ยกเลิกแบบมีเหตุผล (ย้อนราคาในตารางราคา) / ลบแบบเก็บไว้ (status 'Deleted')
ALTER TABLE im_price_change_header
    ADD COLUMN IF NOT EXISTS void_reason TEXT,
    ADD COLUMN IF NOT EXISTS voided_by   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
-- วันสิ้นสุดเดิมของแถวราคาที่ถูกปิดตอนอนุมัติ (ใช้คืนค่าเมื่อถอย/ยกเลิก)
ALTER TABLE im_price_change_detail
    ADD COLUMN IF NOT EXISTS src_closed            BOOLEAN,
    ADD COLUMN IF NOT EXISTS src_prev_effective_to DATE;
