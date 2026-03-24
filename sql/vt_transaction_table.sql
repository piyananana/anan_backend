-- ============================================================
-- VAT Transaction Table (ตารางกลางภาษีซื้อ/ขาย)
-- ใช้ร่วมกันระหว่าง AR, AP, GL, IC
-- ============================================================

CREATE TABLE IF NOT EXISTS vt_transaction (
    id                   SERIAL PRIMARY KEY,
    module_code          VARCHAR(10) NOT NULL,   -- 'AR', 'AP', 'GL', 'IC'
    vat_type             VARCHAR(15) NOT NULL,   -- 'OUTPUT_VAT', 'INPUT_VAT'
    -- อ้างอิงเอกสารต้นทาง
    doc_id               INTEGER,               -- FK -> sa_module_document.id
    source_header_id     INTEGER NOT NULL,      -- ar_transaction.id, ap_transaction.id, gl_entry_header.id
    source_detail_id     INTEGER,               -- FK -> detail line (optional)
    doc_no               VARCHAR(30),
    doc_date             DATE NOT NULL,
    -- ใบกำกับภาษี
    tax_invoice_no       VARCHAR(30),
    tax_invoice_date     DATE,
    -- ยอดเงิน
    vat_rate             NUMERIC(5,2) NOT NULL DEFAULT 7,
    base_amount_lc       NUMERIC(18,2) NOT NULL DEFAULT 0,  -- ยอดก่อน VAT (LC)
    vat_amount_lc        NUMERIC(18,2) NOT NULL DEFAULT 0,  -- VAT (LC)
    base_amount_fc       NUMERIC(18,2) NOT NULL DEFAULT 0,
    vat_amount_fc        NUMERIC(18,2) NOT NULL DEFAULT 0,
    currency_id          INTEGER,
    exchange_rate        NUMERIC(18,6) NOT NULL DEFAULT 1,
    -- คู่ค้า
    customer_id          INTEGER,               -- AR
    supplier_id          INTEGER,               -- AP
    entity_name          VARCHAR(200),          -- ชื่อผู้ประกอบการ
    entity_tax_id        VARCHAR(20),           -- เลขผู้เสียภาษี
    entity_branch_code   VARCHAR(10),           -- 00000 = สำนักงานใหญ่
    -- สถานะ
    is_voided            BOOLEAN NOT NULL DEFAULT FALSE,
    -- Audit
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    created_by           VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_vt_module_source  ON vt_transaction(module_code, source_header_id);
CREATE INDEX IF NOT EXISTS idx_vt_doc_date        ON vt_transaction(doc_date);
CREATE INDEX IF NOT EXISTS idx_vt_vat_type        ON vt_transaction(vat_type);
CREATE INDEX IF NOT EXISTS idx_vt_customer        ON vt_transaction(customer_id);
CREATE INDEX IF NOT EXISTS idx_vt_supplier        ON vt_transaction(supplier_id);
