-- cm_bank_file_format: bank payment file format templates (Cash Management module)
CREATE TABLE IF NOT EXISTS cm_bank_file_format (
    id             SERIAL PRIMARY KEY,
    format_code    VARCHAR(20)  NOT NULL UNIQUE,
    format_name    VARCHAR(100) NOT NULL,
    bank_code      VARCHAR(10),
    file_extension VARCHAR(10)  NOT NULL DEFAULT 'txt',
    delimiter      VARCHAR(10)  NOT NULL DEFAULT '',   -- '' = fixed-width, ',' = CSV, '|' = pipe
    has_header     BOOLEAN      NOT NULL DEFAULT FALSE,
    has_footer     BOOLEAN      NOT NULL DEFAULT FALSE,
    columns        JSONB        NOT NULL DEFAULT '[]', -- array of column definitions
    is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by     VARCHAR(100),
    updated_by     VARCHAR(100)
);

-- Column definition shape stored in `columns` JSONB array:
-- {
--   "field_code":      "payment_date",  -- from predefined field list
--   "column_label":    "วันที่ชำระ",
--   "length":          8,               -- total column width
--   "align":           "L",             -- 'L' left | 'R' right
--   "pad_char":        " ",             -- padding character
--   "date_format":     "YYYYMMDD",      -- for date fields
--   "decimal_places":  2,               -- for decimal fields
--   "constant_value":  null             -- for constant fields
-- }
