-- ล้างสิทธิ์ "อนุมัติ" (can_approve) ของผู้ใช้/กลุ่ม บนเมนูที่ไม่มีขั้นตอนอนุมัติ (sa_menu.requires_approval = false) — 2026-11-05
-- หน้าจอสิทธิ์ผู้ใช้/กลุ่มแสดงช่องอนุมัติเฉพาะเมนูที่มีขั้นตอนอนุมัติแล้ว ค่าที่ค้างอยู่จึงแก้จากหน้าจอไม่ได้
-- คิวผู้อนุมัติ (sa_module_approver) sync มาจาก sa_user_menu.can_approve จึงลบคิวของเมนูเหล่านี้ด้วย
-- idempotent รันซ้ำได้

BEGIN;

UPDATE sa_user_menu um SET can_approve = false
  FROM sa_menu m
 WHERE m.id = um.menu_id AND um.can_approve AND NOT COALESCE(m.requires_approval, false);

UPDATE sa_group_menu gm SET can_approve = false
  FROM sa_menu m
 WHERE m.id = gm.menu_id AND gm.can_approve AND NOT COALESCE(m.requires_approval, false);

DELETE FROM sa_module_approver a
 USING sa_menu m
 WHERE m.id = a.menu_id AND NOT COALESCE(m.requires_approval, false);

COMMIT;
