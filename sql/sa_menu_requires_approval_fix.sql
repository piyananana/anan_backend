-- ปรับสวิตช์ "มีผู้อนุมัติได้" (sa_menu.requires_approval) ให้ตรงกับเมนูที่มีขั้นตอนขออนุมัติจริง — 2026-11-04
-- อ้างอิงเมนูด้วย target_path (id ต่างกันในแต่ละฐานข้อมูล) — idempotent รันซ้ำได้
-- เมนูที่ปิด: ไม่ลบคิวผู้อนุมัติ/ประเภทเอกสารที่ตั้งไว้ (ไม่มีผลกับการทำงาน และกลับมาครบถ้าเปิดใหม่)

BEGIN;

-- เปิด: มีขั้นตอนส่งอนุมัติผ่านคิวกลาง (doc_approval) แต่ยังไม่ได้เปิด จึงอนุมัติอัตโนมัติและตั้งคิวไม่ได้
UPDATE sa_menu SET requires_approval = true
 WHERE target_path IN ('QuoteTransactionScreen',     -- ใบเสนอราคา (QUOTE)
                       'ImPriceChangeScreen',        -- ธุรกรรมเปลี่ยนแปลงราคา (IM_PRICE)
                       'ImStockCountSummaryScreen',  -- สรุปผลการตรวจนับและปรับยอด (IM_COUNT)
                       'CmTransactionScreen')        -- ธุรกรรม CM: 20/30/40/50 ต้องอนุมัติก่อน Post (CM_TXN, 2026-11-05)
   AND requires_approval IS DISTINCT FROM true;

-- ปิด: เปิดไว้แต่ไม่มีเอกสารให้ขออนุมัติ
UPDATE sa_menu SET requires_approval = false
 WHERE target_path IN ('PoReplenishmentReportScreen')  -- สร้างใบขอซื้อเป็นร่าง ส่งอนุมัติที่เมนูใบขอซื้อ
   AND requires_approval IS DISTINCT FROM false;

COMMIT;

SELECT id, menu_name, target_path, requires_approval
  FROM sa_menu
 WHERE target_path IN ('QuoteTransactionScreen', 'ImPriceChangeScreen', 'ImStockCountSummaryScreen',
                       'CmTransactionScreen', 'PoReplenishmentReportScreen')
 ORDER BY requires_approval DESC, target_path;
