-- เมนู "พิมพ์ใบสำคัญจ่าย (ซื้อเงินสด)" (ImPrintPaymentVoucherScreen — แหล่งข้อมูลพิมพ์ PAYMENT_VOUCHER) — 2026-11-13
-- วางในกลุ่มเดียวกับเมนูพิมพ์ฟอร์มธุรกรรมสินค้าคงคลัง (อ้างอิงด้วย target_path เพราะ id ต่างกันในแต่ละฐานข้อมูล)
-- idempotent รันซ้ำได้; สิทธิ์ใช้เมนูให้กำหนดที่หน้าสิทธิ์กลุ่ม/ผู้ใช้ตามปกติ

BEGIN;

INSERT INTO sa_menu (parent_id, menu_name, menu_name_en, menu_type, target_path, sort_order, is_active)
SELECT p.parent_id, 'พิมพ์ใบสำคัญจ่าย (ซื้อเงินสด)', 'Print Payment Voucher (Cash Purchase)', 'widget', 'ImPrintPaymentVoucherScreen',
       p.sort_order + 1, true
  FROM sa_menu p
 WHERE p.target_path = 'ImPrintSalesInvoiceScreen'
   AND NOT EXISTS (SELECT 1 FROM sa_menu WHERE target_path = 'ImPrintPaymentVoucherScreen')
 LIMIT 1;

COMMIT;
