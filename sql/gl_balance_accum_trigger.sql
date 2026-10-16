-- ============================================================
-- gl_balance_accum: ยอดสะสมรายงวดคำนวณจากรายการบัญชีที่ผ่านรายการแล้ว (status = 'Posted') ด้วย trigger
--
-- เดิมมีเฉพาะ GL Entry / นำเข้ายอดยกมา / ปิดบัญชีสิ้นปี ที่อัปเดตยอดสะสมเอง (โค้ด Node)
-- รายการที่ AP/AR/CM/IM/MO ลงบัญชีอัตโนมัติ (และการ Void) จึงไม่เข้ายอดสะสม → งบการเงิน/งบทดลองเป็นศูนย์
-- ตอนนี้ trigger บนตาราง gl_entry_header / gl_entry_detail ดูแลทุกช่องทางที่เขียนรายการบัญชี:
--   - เพิ่ม/แก้/ลบบรรทัดของรายการที่ Posted               → ปรับยอดตามบรรทัด
--   - เปลี่ยนสถานะเป็น/จาก Posted (ผ่านรายการ, Void, ถอยเป็น Draft) → บวก/ลบทั้งรายการ
--   - แก้งวด/สาขา/สกุลเงินของรายการที่ Posted           → ย้ายยอดจากค่าเดิมไปค่าใหม่
--   - ลบหัวรายการที่ Posted                              → ลบยอดทุกบรรทัด
-- คีย์ยอดสะสมเหมือนเดิม: งวด + บัญชี + ชุดมิติ (สาขาจากหัวรายการ + dim1-5 จากบรรทัด) + สกุลเงิน (ค่าว่าง = 1)
-- end_balance = ยอดเคลื่อนไหวสุทธิของงวด (เดบิต - เครดิต) ไม่ใช่ยอดยกไป
--
-- gl_rebuild_balance_accum() ล้างแล้วคำนวณยอดสะสมใหม่ทั้งหมดจากรายการที่ Posted — ไฟล์นี้เรียกให้ท้ายไฟล์
-- (ทุกช่องทางเดิมที่เขียนยอดสะสมล้วนมาจากรายการบัญชี จึงคำนวณใหม่ได้ครบ)
--
-- ต้องใช้คู่กับ backend ที่เลิกเรียก updateBalanceAccum ในโค้ดแล้ว ไม่งั้นยอดจะถูกนับสองครั้ง
-- ถ้ารันไฟล์นี้ก่อน restart backend ให้เรียก SELECT gl_rebuild_balance_accum(); อีกครั้งหลัง restart
-- รันซ้ำได้
-- ============================================================

-- บวก/ลบยอดหนึ่งบรรทัดเข้ายอดสะสม (p_sign = 1 บวก, -1 ลบ)
CREATE OR REPLACE FUNCTION gl_accum_apply(
    p_period_id INT, p_account_id INT, p_currency_id INT, p_branch_id INT,
    p_dim1 INT, p_dim2 INT, p_dim3 INT, p_dim4 INT, p_dim5 INT,
    p_debit NUMERIC, p_credit NUMERIC, p_sign INT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_combo_id INT;
    v_debit  NUMERIC := COALESCE(p_debit, 0)  * p_sign;
    v_credit NUMERIC := COALESCE(p_credit, 0) * p_sign;
BEGIN
    IF p_period_id IS NULL OR p_account_id IS NULL OR (v_debit = 0 AND v_credit = 0) THEN
        RETURN;
    END IF;
    INSERT INTO gl_dim_combination (branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
    VALUES (COALESCE(p_branch_id, 0), COALESCE(p_dim1, 0), COALESCE(p_dim2, 0),
            COALESCE(p_dim3, 0), COALESCE(p_dim4, 0), COALESCE(p_dim5, 0))
    ON CONFLICT (combo_key) DO UPDATE SET id = gl_dim_combination.id
    RETURNING id INTO v_combo_id;

    INSERT INTO gl_balance_accum
        (period_id, account_id, combo_id, currency_id, debit_amount, credit_amount, end_balance, updated_at)
    VALUES (p_period_id, p_account_id, v_combo_id, COALESCE(p_currency_id, 1),
            v_debit, v_credit, v_debit - v_credit, NOW())
    ON CONFLICT (period_id, account_id, combo_id, currency_id) DO UPDATE SET
        debit_amount  = gl_balance_accum.debit_amount  + EXCLUDED.debit_amount,
        credit_amount = gl_balance_accum.credit_amount + EXCLUDED.credit_amount,
        end_balance   = gl_balance_accum.end_balance   + EXCLUDED.end_balance,
        updated_at    = NOW();
END;
$$;

-- บวก/ลบทุกบรรทัดของรายการ โดยใช้งวด/สาขา/สกุลเงินที่ส่งมา (ค่าหัวรายการเดิมหรือใหม่)
CREATE OR REPLACE FUNCTION gl_accum_apply_entry(
    p_header_id INT, p_period_id INT, p_currency_id INT, p_branch_id INT, p_sign INT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    d RECORD;
BEGIN
    FOR d IN SELECT * FROM gl_entry_detail WHERE header_id = p_header_id LOOP
        PERFORM gl_accum_apply(p_period_id, d.account_id, p_currency_id, p_branch_id,
            d.dim1_id, d.dim2_id, d.dim3_id, d.dim4_id, d.dim5_id, d.debit_lc, d.credit_lc, p_sign);
    END LOOP;
END;
$$;

-- บรรทัดรายการ: มีผลเฉพาะเมื่อหัวรายการเป็น Posted
CREATE OR REPLACE FUNCTION gl_entry_detail_accum_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    h RECORD;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT period_id, currency_id, branch_id, status INTO h FROM gl_entry_header WHERE id = OLD.header_id;
        IF FOUND AND h.status = 'Posted' THEN
            PERFORM gl_accum_apply(h.period_id, OLD.account_id, h.currency_id, h.branch_id,
                OLD.dim1_id, OLD.dim2_id, OLD.dim3_id, OLD.dim4_id, OLD.dim5_id, OLD.debit_lc, OLD.credit_lc, -1);
        END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT period_id, currency_id, branch_id, status INTO h FROM gl_entry_header WHERE id = NEW.header_id;
        IF FOUND AND h.status = 'Posted' THEN
            PERFORM gl_accum_apply(h.period_id, NEW.account_id, h.currency_id, h.branch_id,
                NEW.dim1_id, NEW.dim2_id, NEW.dim3_id, NEW.dim4_id, NEW.dim5_id, NEW.debit_lc, NEW.credit_lc, 1);
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

-- หัวรายการ: เปลี่ยนสถานะเป็น/จาก Posted หรือแก้งวด/สาขา/สกุลเงินระหว่าง Posted
CREATE OR REPLACE FUNCTION gl_entry_header_accum_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'Posted' THEN
        PERFORM gl_accum_apply_entry(OLD.id, OLD.period_id, OLD.currency_id, OLD.branch_id, -1);
    END IF;
    IF NEW.status = 'Posted' THEN
        PERFORM gl_accum_apply_entry(NEW.id, NEW.period_id, NEW.currency_id, NEW.branch_id, 1);
    END IF;
    RETURN NULL;
END;
$$;

-- ลบหัวรายการ: ลบบรรทัดก่อน (trigger ของบรรทัดหักยอดขณะหัวรายการยังอยู่) แทนการพึ่ง ON DELETE CASCADE
CREATE OR REPLACE FUNCTION gl_entry_header_delete_accum_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM gl_entry_detail WHERE header_id = OLD.id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_gl_entry_detail_accum ON gl_entry_detail;
CREATE TRIGGER trg_gl_entry_detail_accum
    AFTER INSERT OR UPDATE OR DELETE ON gl_entry_detail
    FOR EACH ROW EXECUTE FUNCTION gl_entry_detail_accum_trg();

DROP TRIGGER IF EXISTS trg_gl_entry_header_accum ON gl_entry_header;
CREATE TRIGGER trg_gl_entry_header_accum
    AFTER UPDATE OF status, period_id, currency_id, branch_id ON gl_entry_header
    FOR EACH ROW
    WHEN ((OLD.status = 'Posted' OR NEW.status = 'Posted') AND (
          OLD.status IS DISTINCT FROM NEW.status
       OR OLD.period_id IS DISTINCT FROM NEW.period_id
       OR OLD.currency_id IS DISTINCT FROM NEW.currency_id
       OR OLD.branch_id IS DISTINCT FROM NEW.branch_id))
    EXECUTE FUNCTION gl_entry_header_accum_trg();

DROP TRIGGER IF EXISTS trg_gl_entry_header_delete_accum ON gl_entry_header;
CREATE TRIGGER trg_gl_entry_header_delete_accum
    BEFORE DELETE ON gl_entry_header
    FOR EACH ROW EXECUTE FUNCTION gl_entry_header_delete_accum_trg();

-- คำนวณยอดสะสมใหม่ทั้งหมดจากรายการที่ Posted — คืนจำนวนแถวยอดสะสม
CREATE OR REPLACE FUNCTION gl_rebuild_balance_accum() RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    n INT;
BEGIN
    LOCK TABLE gl_balance_accum IN EXCLUSIVE MODE;
    DELETE FROM gl_balance_accum;

    INSERT INTO gl_dim_combination (branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
    SELECT DISTINCT COALESCE(h.branch_id, 0), COALESCE(d.dim1_id, 0), COALESCE(d.dim2_id, 0),
           COALESCE(d.dim3_id, 0), COALESCE(d.dim4_id, 0), COALESCE(d.dim5_id, 0)
      FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
     WHERE h.status = 'Posted'
    ON CONFLICT (combo_key) DO NOTHING;

    INSERT INTO gl_balance_accum
        (period_id, account_id, combo_id, currency_id, debit_amount, credit_amount, end_balance, updated_at)
    SELECT h.period_id, d.account_id, c.id, COALESCE(h.currency_id, 1),
           SUM(COALESCE(d.debit_lc, 0)), SUM(COALESCE(d.credit_lc, 0)),
           SUM(COALESCE(d.debit_lc, 0) - COALESCE(d.credit_lc, 0)), NOW()
      FROM gl_entry_detail d
      JOIN gl_entry_header h ON h.id = d.header_id
      JOIN gl_dim_combination c
        ON c.branch_id = COALESCE(h.branch_id, 0) AND c.dim1_id = COALESCE(d.dim1_id, 0)
       AND c.dim2_id = COALESCE(d.dim2_id, 0) AND c.dim3_id = COALESCE(d.dim3_id, 0)
       AND c.dim4_id = COALESCE(d.dim4_id, 0) AND c.dim5_id = COALESCE(d.dim5_id, 0)
     WHERE h.status = 'Posted' AND h.period_id IS NOT NULL AND d.account_id IS NOT NULL
     GROUP BY h.period_id, d.account_id, c.id, COALESCE(h.currency_id, 1);

    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

SELECT gl_rebuild_balance_accum() AS accum_rows;
