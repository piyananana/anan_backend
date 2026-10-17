-- ============================================================
-- ห้ามลงรายการบัญชีที่บัญชีคุม (gl_account.is_normal_account = false)
--
-- เดิมไม่มีการตรวจที่ backend เลย ถ้าการตั้งค่าบัญชีของโมดูลใด (เช่น im_gl_account_setup) ชี้ไปที่บัญชีคุม
-- รายการที่ลงบัญชีอัตโนมัติจะลงบัญชีคุมได้ แล้วรายงานงบทดลองที่คำนวณยอดบัญชีคุมจากบัญชีลูก
-- จะทิ้งยอดนั้นไป ทำให้เดบิตไม่เท่ากับเครดิต (พบที่ anandev: เจ้าหนี้ฝากขายลงบัญชี 21 รวม 3,250.00)
--
-- 1. gl_entry_detail: เพิ่มบรรทัด หรือเปลี่ยนบัญชีของบรรทัด เป็นบัญชีคุม → error
--    (ตรวจเฉพาะ INSERT / UPDATE OF account_id แถวเก่าที่แก้ช่องอื่นไม่ถูกกระทบ)
-- 2. gl_account: เปลี่ยนบัญชีที่มีรายการแล้วให้เป็นบัญชีคุม → error (ไม่งั้นรายการเดิมจะกลายเป็นลงบัญชีคุม)
--
-- ก่อนรันให้ตรวจว่าไม่มีรายการลงบัญชีคุมค้างอยู่:
--   SELECT a.account_code, count(*) FROM gl_entry_detail d JOIN gl_account a ON a.id = d.account_id
--    WHERE NOT a.is_normal_account GROUP BY 1;
-- รันซ้ำได้
-- ============================================================

CREATE OR REPLACE FUNCTION gl_entry_detail_check_normal_account() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT account_code INTO v_code FROM gl_account WHERE id = NEW.account_id AND NOT is_normal_account;
    IF FOUND THEN
        RAISE EXCEPTION 'บัญชี % เป็นบัญชีคุม ลงรายการไม่ได้ กรุณาตรวจการตั้งค่าบัญชี', v_code
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gl_entry_detail_normal_account ON gl_entry_detail;
CREATE TRIGGER trg_gl_entry_detail_normal_account
    BEFORE INSERT OR UPDATE OF account_id ON gl_entry_detail
    FOR EACH ROW EXECUTE FUNCTION gl_entry_detail_check_normal_account();

CREATE OR REPLACE FUNCTION gl_account_check_header_has_no_entries() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.is_normal_account AND NOT NEW.is_normal_account
       AND EXISTS (SELECT 1 FROM gl_entry_detail WHERE account_id = NEW.id) THEN
        RAISE EXCEPTION 'บัญชี % มีรายการบัญชีแล้ว เปลี่ยนเป็นบัญชีคุมไม่ได้', NEW.account_code
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gl_account_header_no_entries ON gl_account;
CREATE TRIGGER trg_gl_account_header_no_entries
    BEFORE UPDATE OF is_normal_account ON gl_account
    FOR EACH ROW EXECUTE FUNCTION gl_account_check_header_has_no_entries();
