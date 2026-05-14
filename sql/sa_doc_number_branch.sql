-- Step A: Per-Branch Document Numbering
-- ตั้งค่าเลขที่เอกสารอัตโนมัติแยกตามสาขา

CREATE TABLE IF NOT EXISTS sa_doc_number_branch (
  id                   SERIAL PRIMARY KEY,
  doc_id               INT NOT NULL REFERENCES sa_module_document(id) ON DELETE CASCADE,
  branch_id            INT NOT NULL REFERENCES cd_branch(id)          ON DELETE CASCADE,
  -- Format overrides (NULL = inherit from sa_module_document)
  format_prefix        VARCHAR(20),
  format_separator     VARCHAR(5),
  format_suffix_date   VARCHAR(10),
  running_length       INT,
  -- Branch-specific running counter
  next_running_number  INT NOT NULL DEFAULT 1,
  UNIQUE (doc_id, branch_id)
);
