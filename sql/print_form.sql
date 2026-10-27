-- แบบฟอร์มพิมพ์กลาง (หน้าจอออกแบบ + หน้าจอพิมพ์) — 2026-10-23
-- ใช้ร่วมทุกแบบฟอร์ม: แต่ละฟอร์มผูกกับแหล่งข้อมูล (utils/printDataSources.js) เช่น SALES_INVOICE
-- idempotent — รันซ้ำได้ (ระบบสร้างให้เองตอนใช้งานครั้งแรกด้วย: controllers/im/imPrintFormController.js)

CREATE TABLE IF NOT EXISTS im_print_form (
    id               SERIAL PRIMARY KEY,
    form_code        VARCHAR(30)  NOT NULL UNIQUE,
    form_name_th     VARCHAR(200) NOT NULL,
    form_name_en     VARCHAR(200),
    data_source      VARCHAR(30)  NOT NULL,                -- SALES_INVOICE ...
    print_mode       VARCHAR(12)  NOT NULL DEFAULT 'LASER',  -- LASER = พิมพ์รูปพื้นหลัง+ข้อมูล / PREPRINTED = ข้อมูลอย่างเดียว (dot-matrix)
    paper_size       VARCHAR(12)  NOT NULL DEFAULT 'A4',     -- A4 / A5 / LETTER / CONT_9x11 / CONT_9x5.5 / CUSTOM (ป้ายกำกับ — ขนาดจริงใช้ width/height)
    paper_width_mm   NUMERIC(7,2) NOT NULL DEFAULT 210,
    paper_height_mm  NUMERIC(7,2) NOT NULL DEFAULT 297,
    offset_x_mm      NUMERIC(6,2) NOT NULL DEFAULT 0,        -- ค่าชดเชยตำแหน่งทั้งหน้า (ปรับเครื่องพิมพ์ป้อนกระดาษเหลื่อม)
    offset_y_mm      NUMERIC(6,2) NOT NULL DEFAULT 0,
    layout_json      JSONB        NOT NULL DEFAULT '{"elements":[]}',  -- ชิ้นงานทั้งหมด (หน่วย มม.)
    is_default       BOOLEAN      NOT NULL DEFAULT FALSE,    -- ฟอร์มเริ่มต้นของแหล่งข้อมูล (มีได้ 1 ฟอร์มต่อแหล่งข้อมูล)
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    remark           TEXT,
    created_by       VARCHAR(100),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by       VARCHAR(100),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_im_print_form_source ON im_print_form (data_source);

-- ชุดสำเนา — LASER: จำนวนแถว = จำนวนแผ่นที่พิมพ์ต่อเอกสาร, แต่ละสำเนามีรูปพื้นหลังของตัวเอง
-- PREPRINTED: รูปพื้นหลังใช้จัดตำแหน่งในหน้าจอออกแบบเท่านั้น (พิมพ์ 1 ชุด กระดาษก๊อปปี้ทำสำเนาเอง)
-- แยกจาก im_print_form เพราะรูปมีขนาดใหญ่ — รายการฟอร์มไม่ต้องโหลดรูป
CREATE TABLE IF NOT EXISTS im_print_form_copy (
    id               SERIAL PRIMARY KEY,
    form_id          INTEGER      NOT NULL REFERENCES im_print_form(id) ON DELETE CASCADE,
    copy_no          SMALLINT     NOT NULL,
    copy_name_th     VARCHAR(100) NOT NULL,
    copy_name_en     VARCHAR(100),
    bg_image         TEXT,                                   -- data URL (JPEG/PNG base64)
    bg_offset_x_mm   NUMERIC(6,2) NOT NULL DEFAULT 0,        -- ปรับรูปให้ตรงกระดาษ: ขยับ / ย่อขยาย / หมุน
    bg_offset_y_mm   NUMERIC(6,2) NOT NULL DEFAULT 0,
    bg_scale         NUMERIC(6,4) NOT NULL DEFAULT 1,
    bg_rotate_deg    NUMERIC(6,2) NOT NULL DEFAULT 0,
    UNIQUE (form_id, copy_no)
);

-- ประวัติการพิมพ์ — print_no นับต่อเอกสาร (ครั้งที่ 2 ขึ้นไป = "พิมพ์ซ้ำครั้งที่ print_no-1")
CREATE TABLE IF NOT EXISTS im_print_log (
    id               SERIAL PRIMARY KEY,
    data_source      VARCHAR(30)  NOT NULL,
    doc_module       VARCHAR(10)  NOT NULL,                  -- IM / AR ...
    record_id        INTEGER      NOT NULL,
    doc_no           VARCHAR(50),
    form_id          INTEGER      REFERENCES im_print_form(id) ON DELETE SET NULL,
    form_name        VARCHAR(200),
    print_no         INTEGER      NOT NULL,
    copies           VARCHAR(200),                           -- ชื่อสำเนาที่พิมพ์ (คั่นด้วย , )
    printed_by       VARCHAR(100),
    printed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_im_print_log_doc ON im_print_log (doc_module, record_id);
