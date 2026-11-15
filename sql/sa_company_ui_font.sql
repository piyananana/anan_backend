-- ฟอนต์หลักของระบบ (ตั้งค่าที่หน้าข้อมูลบริษัท) — ใช้กับทุกหน้าจอของแอป ไม่รวม PDF
-- ค่าที่ใช้ได้ต้องตรงกับ family ที่ลงทะเบียนใน pubspec.yaml ของ Flutter: 'tahoma', 'IBMPlexSansThai'
ALTER TABLE sa_company ADD COLUMN IF NOT EXISTS ui_font VARCHAR(40) NOT NULL DEFAULT 'tahoma';
