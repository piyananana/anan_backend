// controllers/gl/glFinancialReportBuilderController.js
const { parse: parseFormula, collectColRefs } = require('../../utils/finReportFormula');

// ตรวจ syntax สูตรตอนบันทึก — คืน null ถ้าผ่าน หรือ { error, code, detail } ถ้าไม่ผ่าน
const validateFormulaColumn = (column_type, formula_text) => {
    if (column_type !== 'FORMULA') return null;
    try {
        parseFormula(formula_text);
        return null;
    } catch (err) {
        return { error: `Invalid formula: ${err.message}`, code: err.code || 'SYNTAX', detail: err.detail || {} };
    }
};

// ตรวจว่าทุก [CODE] ในสูตรมีอยู่จริงในคอลัมน์ระดับรายงาน (ยกเว้นตัวเอง) — คืน null หรือ error object
const validateColRefsExist = async (client, reportId, formulaText, selfCode = null) => {
    if (!formulaText) return null;
    let codes;
    try {
        codes = [...collectColRefs(parseFormula(formulaText))];
    } catch (_) {
        return null; // syntax ตรวจแยกแล้ว
    }
    if (codes.length === 0) return null;
    if (selfCode && codes.includes(selfCode)) {
        return { error: `Column [${selfCode}] cannot reference itself`, code: 'CIRCULAR', detail: { code: selfCode } };
    }
    const res = await client.query(
        `SELECT col_code FROM gl_fin_report_col WHERE report_id = $1 AND col_code = ANY($2::text[])`,
        [reportId, codes]
    );
    const found = new Set(res.rows.map(r => r.col_code));
    const missing = codes.find(c => !found.has(c));
    return missing
        ? { error: `Column [${missing}] not found in this report`, code: 'UNKNOWN_REF', detail: { code: missing } }
        : null;
};

// --- gl_fin_report (Master) ---

const getReports = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`SELECT * FROM gl_fin_report ORDER BY report_code`);
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const createReport = async (req, res) => {
    const { report_code, report_name_thai, is_active, parenthesis_for_minus, page_orientation, margin_top, margin_right, margin_bottom, margin_left } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `INSERT INTO gl_fin_report (report_code, report_name_thai, is_active, parenthesis_for_minus, page_orientation, margin_top, margin_right, margin_bottom, margin_left)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [report_code, report_name_thai, is_active ?? true, parenthesis_for_minus ?? true,
             page_orientation ?? 'PORTRAIT', margin_top ?? 30, margin_right ?? 30, margin_bottom ?? 30, margin_left ?? 30]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const updateReport = async (req, res) => {
    const { id } = req.params;
    const { report_code, report_name_thai, is_active, parenthesis_for_minus, page_orientation, margin_top, margin_right, margin_bottom, margin_left } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `UPDATE gl_fin_report SET report_code=$1, report_name_thai=$2, is_active=$3, parenthesis_for_minus=$4,
             page_orientation=$5, margin_top=$6, margin_right=$7, margin_bottom=$8, margin_left=$9
             WHERE id=$10 RETURNING *`,
            [report_code, report_name_thai, is_active, parenthesis_for_minus, page_orientation,
             margin_top, margin_right, margin_bottom, margin_left, id]
        );
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const deleteReport = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        // ลบ columns ก่อน แล้วลบ rows แล้วลบ master
        const rowRes = await client.query(`SELECT id FROM gl_fin_report_row WHERE report_id=$1`, [id]);
        const rowIds = rowRes.rows.map(r => r.id);
        if (rowIds.length > 0) {
            await client.query(`DELETE FROM gl_fin_report_column WHERE row_id = ANY($1::int[])`, [rowIds]);
        }
        await client.query(`DELETE FROM gl_fin_report_row WHERE report_id=$1`, [id]);
        await client.query(`DELETE FROM gl_fin_report WHERE id=$1`, [id]);
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- gl_fin_report_row ---

const getRows = async (req, res) => {
    const { report_id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const rowRes = await client.query(
            `SELECT * FROM gl_fin_report_row WHERE report_id=$1 ORDER BY row_seq_no`, [report_id]
        );
        const rows = rowRes.rows;
        const rowIds = rows.map(r => r.id);
        let cols = [];
        if (rowIds.length > 0) {
            const colRes = await client.query(
                `SELECT * FROM gl_fin_report_column WHERE row_id = ANY($1::int[]) ORDER BY row_id, column_seq_no`, [rowIds]
            );
            cols = colRes.rows;
        }
        const result = rows.map(row => ({ ...row, columns: cols.filter(c => c.row_id === row.id) }));
        res.status(200).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const createRow = async (req, res) => {
    const { report_id, row_seq_no, row_type, print_control, account_from, account_to, normal_sign,
            branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `INSERT INTO gl_fin_report_row
             (report_id, row_seq_no, row_type, print_control, account_from, account_to, normal_sign,
              branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
            [report_id, row_seq_no, row_type, print_control ?? 'SHOW',
             account_from || null, account_to || null, normal_sign,
             branch_id || null,
             dim1_id || null, dim2_id || null, dim3_id || null, dim4_id || null, dim5_id || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const { row_seq_no, row_type, print_control, account_from, account_to, normal_sign,
            branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `UPDATE gl_fin_report_row SET
             row_seq_no=$1, row_type=$2, print_control=$3,
             account_from=$4, account_to=$5, normal_sign=$6,
             branch_id=$7, dim1_id=$8, dim2_id=$9, dim3_id=$10, dim4_id=$11, dim5_id=$12
             WHERE id=$13 RETURNING *`,
            [row_seq_no, row_type, print_control,
             account_from || null, account_to || null, normal_sign,
             branch_id || null,
             dim1_id || null, dim2_id || null, dim3_id || null, dim4_id || null, dim5_id || null,
             id]
        );
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query(`DELETE FROM gl_fin_report_column WHERE row_id=$1`, [id]);
        await client.query(`DELETE FROM gl_fin_report_row WHERE id=$1`, [id]);
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- gl_fin_report_column ---

const createColumn = async (req, res) => {
    const { row_id, column_seq_no, column_type, description_thai, data_type, column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text } = req.body;
    const invalid = validateFormulaColumn(column_type, formula_text);
    if (invalid) return res.status(400).json(invalid);
    const client = await req.dbPool.connect();
    try {
        if (column_type === 'FORMULA') {
            const rowRes = await client.query(`SELECT report_id FROM gl_fin_report_row WHERE id=$1`, [row_id]);
            const refErr = rowRes.rows[0] && await validateColRefsExist(client, rowRes.rows[0].report_id, formula_text);
            if (refErr) return res.status(400).json(refErr);
        }
        const result = await client.query(
            `INSERT INTO gl_fin_report_column (row_id, column_seq_no, column_type, description_thai, data_type, column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [row_id, column_seq_no, column_type, description_thai || null, data_type || null,
             column_flex ?? 1, indent_level ?? 0, font_size ?? 10,
             font_weight ?? 'NORMAL', text_align ?? 'LEFT', period_offset ?? 0, formula_text || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const updateColumn = async (req, res) => {
    const { id } = req.params;
    const { column_seq_no, column_type, description_thai, data_type, column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text } = req.body;
    const invalid = validateFormulaColumn(column_type, formula_text);
    if (invalid) return res.status(400).json(invalid);
    const client = await req.dbPool.connect();
    try {
        if (column_type === 'FORMULA') {
            const rowRes = await client.query(
                `SELECT r.report_id FROM gl_fin_report_column c JOIN gl_fin_report_row r ON r.id = c.row_id WHERE c.id=$1`, [id]);
            const refErr = rowRes.rows[0] && await validateColRefsExist(client, rowRes.rows[0].report_id, formula_text);
            if (refErr) return res.status(400).json(refErr);
        }
        const result = await client.query(
            `UPDATE gl_fin_report_column SET column_seq_no=$1, column_type=$2, description_thai=$3, data_type=$4,
             column_flex=$5, indent_level=$6, font_size=$7, font_weight=$8, text_align=$9, period_offset=$10, formula_text=$11
             WHERE id=$12 RETURNING *`,
            [column_seq_no, column_type, description_thai || null, data_type || null,
             column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text || null, id]
        );
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const deleteColumn = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query(`DELETE FROM gl_fin_report_column WHERE id=$1`, [id]);
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- gl_fin_report_col (คอลัมน์ระดับรายงาน ใช้กับทุกบรรทัด) ---

const COL_KINDS = ['AMOUNT', 'CALC'];
const PERIOD_RANGES = ['MTD', 'QTD', 'YTD', 'FULL_YEAR'];
const COL_CODE_RE = /^[A-Z][A-Z0-9_]{0,19}$/;

const normalizeReportCol = (body) => ({
    col_seq_no: parseInt(body.col_seq_no, 10),
    col_code: String(body.col_code || '').trim().toUpperCase(),
    header_thai: body.header_thai || null,
    header_eng: body.header_eng || null,
    col_kind: body.col_kind || 'AMOUNT',
    period_range: body.period_range || 'MTD',
    offset_years: parseInt(body.offset_years, 10) || 0,
    offset_periods: parseInt(body.offset_periods, 10) || 0,
    formula_text: body.col_kind === 'CALC' ? (body.formula_text || '').trim() || null : null,
    branch_id: body.branch_id || null,
    dim1_id: body.dim1_id || null,
    dim2_id: body.dim2_id || null,
    dim3_id: body.dim3_id || null,
    dim4_id: body.dim4_id || null,
    dim5_id: body.dim5_id || null,
    exclude_closing_entries: body.exclude_closing_entries ?? true,
    column_flex: parseInt(body.column_flex, 10) || 1,
    text_align: body.text_align || 'RIGHT',
    font_weight: body.font_weight || 'NORMAL',
    font_size: parseInt(body.font_size, 10) || 10,
    is_hidden: body.is_hidden ?? false,
});

// ตรวจค่าพื้นฐาน + สูตร CALC — คืน null หรือ error object
const validateReportCol = async (client, reportId, c) => {
    if (!Number.isInteger(c.col_seq_no)) {
        return { error: 'col_seq_no is required', code: 'INVALID_SEQ' };
    }
    if (!COL_CODE_RE.test(c.col_code)) {
        return { error: 'col_code must start with a letter and contain only A-Z, 0-9, _ (max 20)', code: 'INVALID_CODE' };
    }
    if (!COL_KINDS.includes(c.col_kind) || !PERIOD_RANGES.includes(c.period_range)) {
        return { error: 'Invalid col_kind or period_range', code: 'INVALID_KIND' };
    }
    if (c.col_kind === 'CALC') {
        if (!c.formula_text) return { error: 'Formula is required for CALC columns', code: 'SYNTAX' };
        const syntaxErr = validateFormulaColumn('FORMULA', c.formula_text);
        if (syntaxErr) return syntaxErr;
        return validateColRefsExist(client, reportId, c.formula_text, c.col_code);
    }
    return null;
};

// สูตรอื่นในรายงาน (CALC ระดับรายงาน + FORMULA รายบรรทัด) ที่อ้างถึง code นี้ — กันลบ/เปลี่ยนชื่อแล้วสูตรพัง
const findColCodeUsages = async (client, reportId, code, excludeColId) => {
    const res = await client.query(`
        SELECT 'COL' AS src, col_code AS ref, formula_text FROM gl_fin_report_col
         WHERE report_id = $1 AND col_kind = 'CALC' AND id <> $2
        UNION ALL
        SELECT 'ROW' AS src, 'R' || r.row_seq_no || ',C' || c.column_seq_no AS ref, c.formula_text
          FROM gl_fin_report_column c JOIN gl_fin_report_row r ON r.id = c.row_id
         WHERE r.report_id = $1 AND c.column_type = 'FORMULA'`, [reportId, excludeColId || 0]);
    return res.rows.filter(r => {
        try { return collectColRefs(parseFormula(r.formula_text)).has(code); } catch (_) { return false; }
    }).map(r => r.src === 'COL' ? `[${r.ref}]` : `(${r.ref})`);
};

const uniqueViolation = (err) => {
    if (err.code !== '23505') return null;
    return err.constraint === 'gl_fin_report_col_code_uq'
        ? { error: 'col_code already exists in this report', code: 'DUPLICATE_CODE' }
        : { error: 'col_seq_no already exists in this report', code: 'DUPLICATE_SEQ' };
};

const REPORT_COL_FIELDS = ['col_seq_no', 'col_code', 'header_thai', 'header_eng', 'col_kind', 'period_range',
    'offset_years', 'offset_periods', 'formula_text', 'branch_id', 'dim1_id', 'dim2_id', 'dim3_id', 'dim4_id',
    'dim5_id', 'exclude_closing_entries', 'column_flex', 'text_align', 'font_weight', 'font_size', 'is_hidden'];

const getReportCols = async (req, res) => {
    const { report_id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `SELECT * FROM gl_fin_report_col WHERE report_id=$1 ORDER BY col_seq_no`, [report_id]);
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const createReportCol = async (req, res) => {
    const reportId = req.body.report_id;
    const c = normalizeReportCol(req.body);
    const client = await req.dbPool.connect();
    try {
        const invalid = await validateReportCol(client, reportId, c);
        if (invalid) return res.status(400).json(invalid);
        const values = REPORT_COL_FIELDS.map(f => c[f]);
        const result = await client.query(
            `INSERT INTO gl_fin_report_col (report_id, ${REPORT_COL_FIELDS.join(', ')})
             VALUES ($1, ${REPORT_COL_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
            [reportId, ...values]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        const dup = uniqueViolation(err);
        if (dup) return res.status(409).json(dup);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const updateReportCol = async (req, res) => {
    const { id } = req.params;
    const c = normalizeReportCol(req.body);
    const client = await req.dbPool.connect();
    try {
        const cur = await client.query(`SELECT report_id, col_code FROM gl_fin_report_col WHERE id=$1`, [id]);
        if (cur.rows.length === 0) return res.status(404).json({ error: 'Column not found' });
        const { report_id: reportId, col_code: oldCode } = cur.rows[0];

        const invalid = await validateReportCol(client, reportId, c);
        if (invalid) return res.status(400).json(invalid);
        if (oldCode !== c.col_code) {
            const usages = await findColCodeUsages(client, reportId, oldCode, id);
            if (usages.length > 0) {
                return res.status(400).json({ error: `[${oldCode}] is used by ${usages.join(', ')}`, code: 'REF_IN_USE', detail: { code: oldCode, usages } });
            }
        }
        const sets = REPORT_COL_FIELDS.map((f, i) => `${f}=$${i + 1}`).join(', ');
        const result = await client.query(
            `UPDATE gl_fin_report_col SET ${sets}, updated_at=NOW() WHERE id=$${REPORT_COL_FIELDS.length + 1} RETURNING *`,
            [...REPORT_COL_FIELDS.map(f => c[f]), id]);
        res.status(200).json(result.rows[0]);
    } catch (err) {
        const dup = uniqueViolation(err);
        if (dup) return res.status(409).json(dup);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const deleteReportCol = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const cur = await client.query(`SELECT report_id, col_code FROM gl_fin_report_col WHERE id=$1`, [id]);
        if (cur.rows.length === 0) return res.status(204).send();
        const usages = await findColCodeUsages(client, cur.rows[0].report_id, cur.rows[0].col_code, id);
        if (usages.length > 0) {
            const code = cur.rows[0].col_code;
            return res.status(400).json({ error: `[${code}] is used by ${usages.join(', ')}`, code: 'REF_IN_USE', detail: { code, usages } });
        }
        await client.query(`DELETE FROM gl_fin_report_col WHERE id=$1`, [id]);
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = {
    getReports, createReport, updateReport, deleteReport,
    getRows, createRow, updateRow, deleteRow,
    createColumn, updateColumn, deleteColumn,
    getReportCols, createReportCol, updateReportCol, deleteReportCol,
};
