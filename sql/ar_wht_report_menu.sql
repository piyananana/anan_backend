-- เมนู "รายงานภาษีถูกหัก ณ ที่จ่าย" ของ AR (ArWhtReportScreen) — 2026-11-09
-- วางในกลุ่มรายงาน AR เดียวกับรายงานการเคลื่อนไหวลูกหนี้ (อ้างอิงด้วย target_path เพราะ id ต่างกันในแต่ละฐานข้อมูล)
-- idempotent รันซ้ำได้; สิทธิ์ใช้เมนูให้กำหนดที่หน้าสิทธิ์กลุ่ม/ผู้ใช้ตามปกติ

BEGIN;

INSERT INTO sa_menu (parent_id, menu_name, menu_name_en, menu_type, target_path, sort_order, is_active)
SELECT p.parent_id, 'รายงานภาษีถูกหัก ณ ที่จ่าย', 'Withholding Tax Deducted Report', 'widget', 'ArWhtReportScreen',
       COALESCE((SELECT MAX(sort_order) FROM sa_menu WHERE parent_id = p.parent_id), 0) + 10, true
  FROM sa_menu p
 WHERE p.target_path = 'ArMovementReportScreen'
   AND NOT EXISTS (SELECT 1 FROM sa_menu WHERE target_path = 'ArWhtReportScreen')
 LIMIT 1;

COMMIT;
