-- หน่วยนับหลายหน่วย (2026-11-21): หน่วยนับตั้งทศนิยมได้ถึง 6 ตำแหน่ง
-- ขยายทุกคอลัมน์จำนวน (ชื่อมี qty / quantity) ที่ทศนิยมน้อยกว่า 6 เป็น NUMERIC(p,6)
-- โดยคงจำนวนหลักหน้าจุดเท่าเดิม (อย่างน้อย 14 หลัก) — รันซ้ำได้ (ข้ามคอลัมน์ที่เป็น 6 แล้ว)
-- apply ต่อ DB: node apply_sql <db> sql/qty_scale_6.sql
DO $$
DECLARE
    r RECORD;
    new_p INT;
    had_tv BOOLEAN;
BEGIN
    -- im_stock_balance.total_value เป็น generated column จาก qty_on_hand — ต้องถอดออกก่อนแล้วสร้างกลับ
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'im_stock_balance' AND column_name = 'qty_on_hand'
                      AND numeric_scale < 6)
      INTO had_tv;
    IF had_tv THEN
        ALTER TABLE im_stock_balance DROP COLUMN IF EXISTS total_value;
    END IF;

    FOR r IN
        SELECT c.table_name, c.column_name, c.numeric_precision AS p, c.numeric_scale AS s
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
         WHERE c.table_schema = 'public'
           AND c.data_type = 'numeric'
           AND (c.column_name ILIKE '%qty%' OR c.column_name ILIKE '%quantity%')
           AND COALESCE(c.numeric_scale, 6) < 6
    LOOP
        new_p := GREATEST(r.p - r.s, 14) + 6;
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE NUMERIC(%s,6)', r.table_name, r.column_name, new_p);
        RAISE NOTICE '% .% NUMERIC(%,%) -> NUMERIC(%,6)', r.table_name, r.column_name, r.p, r.s, new_p;
    END LOOP;

    IF had_tv THEN
        ALTER TABLE im_stock_balance
            ADD COLUMN total_value NUMERIC(18,4) GENERATED ALWAYS AS (qty_on_hand * avg_unit_cost) STORED;
    END IF;
END $$;
