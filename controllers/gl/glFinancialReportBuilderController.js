// controllers/gl/glFinancialReportBuilderController.js
const { parse: parseFormula, collectColRefs, collectRowRefs, renumberRowRefs, FUNCTIONS } = require('../../utils/finReportFormula');
const { SEL_TYPES, ACCOUNT_TYPES, loadAccounts, buildAccountIndex, rowSelections, resolveRowAccounts } = require('../../utils/finReportAccounts');

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

// ตรวจว่าทุก [CODE] และรหัสบรรทัดในสูตรมีอยู่จริงในรายงาน — คืน null หรือ error object
//   selfCode    = col_code ของคอลัมน์ CALC ที่กำลังบันทึก (ห้ามอ้างตัวเอง)
//   selfRowCode = row_code ของบรรทัด FORMULA ที่กำลังบันทึก (ห้ามอ้างตัวเอง)
const validateColRefsExist = async (client, reportId, formulaText, selfCode = null, selfRowCode = null) => {
    if (!formulaText) return null;
    let codes, rowCodes;
    try {
        const ast = parseFormula(formulaText);
        codes = [...collectColRefs(ast)];
        rowCodes = [...collectRowRefs(ast)];
    } catch (_) {
        return null; // syntax ตรวจแยกแล้ว
    }
    if (selfCode && codes.includes(selfCode)) {
        return { error: `Column [${selfCode}] cannot reference itself`, code: 'CIRCULAR', detail: { code: selfCode } };
    }
    if (selfRowCode && rowCodes.includes(selfRowCode)) {
        return { error: `Row ${selfRowCode} cannot reference itself`, code: 'CIRCULAR', detail: { row_code: selfRowCode } };
    }
    if (codes.length > 0) {
        const res = await client.query(
            `SELECT col_code FROM gl_fin_report_col WHERE report_id = $1 AND col_code = ANY($2::text[])`,
            [reportId, codes]
        );
        const found = new Set(res.rows.map(r => r.col_code));
        const missing = codes.find(c => !found.has(c));
        if (missing) return { error: `Column [${missing}] not found in this report`, code: 'UNKNOWN_REF', detail: { code: missing } };
    }
    if (rowCodes.length > 0) {
        const res = await client.query(
            `SELECT row_code FROM gl_fin_report_row WHERE report_id = $1 AND row_code = ANY($2::text[])`,
            [reportId, rowCodes]
        );
        const found = new Set(res.rows.map(r => r.row_code));
        const missing = rowCodes.find(c => !found.has(c));
        if (missing) return { error: `Row ${missing} not found in this report`, code: 'UNKNOWN_REF', detail: { row_code: missing } };
    }
    return null;
};

// สูตร/บรรทัดอื่นในรายงานที่อ้างถึงรหัสบรรทัดนี้ — กันลบ/เปลี่ยนรหัสแล้วสูตรหรือยอดรวมพัง
const findRowCodeUsages = async (client, reportId, rowCode, excludeRowId) => {
    const res = await client.query(`
        SELECT 'COL' AS src, col_code AS ref, formula_text FROM gl_fin_report_col
         WHERE report_id = $1 AND col_kind = 'CALC'
        UNION ALL
        SELECT 'CELL', 'R' || r.row_seq_no || ',C' || c.column_seq_no, c.formula_text
          FROM gl_fin_report_column c JOIN gl_fin_report_row r ON r.id = c.row_id
         WHERE r.report_id = $1 AND c.column_type = 'FORMULA'
        UNION ALL
        SELECT 'ROW', COALESCE(row_code, 'R' || row_seq_no), row_formula FROM gl_fin_report_row
         WHERE report_id = $1 AND row_kind = 'FORMULA' AND id <> $2
        UNION ALL
        SELECT 'CHILD', COALESCE(row_code, 'R' || row_seq_no), NULL FROM gl_fin_report_row
         WHERE report_id = $1 AND parent_row_code = $3 AND id <> $2`, [reportId, excludeRowId || 0, rowCode]);
    return res.rows.filter(r => {
        if (r.src === 'CHILD') return true;
        try { return collectRowRefs(parseFormula(r.formula_text)).has(rowCode); } catch (_) { return false; }
    }).map(r => {
        if (r.src === 'COL') return `[${r.ref}]`;
        if (r.src === 'CELL') return `(${r.ref})`;
        if (r.src === 'CHILD') return `${r.ref} (total)`;
        return r.ref;
    });
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
    const { report_code, report_name_thai, report_name_eng, is_active, parenthesis_for_minus, page_orientation, margin_top, margin_right, margin_bottom, margin_left } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `INSERT INTO gl_fin_report (report_code, report_name_thai, is_active, parenthesis_for_minus, page_orientation, margin_top, margin_right, margin_bottom, margin_left, report_name_eng)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [report_code, report_name_thai, is_active ?? true, parenthesis_for_minus ?? true,
             page_orientation ?? 'PORTRAIT', margin_top ?? 30, margin_right ?? 30, margin_bottom ?? 30, margin_left ?? 30,
             report_name_eng || null]
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
    const { report_code, report_name_thai, report_name_eng, is_active, parenthesis_for_minus, page_orientation, margin_top, margin_right, margin_bottom, margin_left } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `UPDATE gl_fin_report SET report_code=$1, report_name_thai=$2, is_active=$3, parenthesis_for_minus=$4,
             page_orientation=$5, margin_top=$6, margin_right=$7, margin_bottom=$8, margin_left=$9, report_name_eng=$11
             WHERE id=$10 RETURNING *`,
            [report_code, report_name_thai, is_active, parenthesis_for_minus, page_orientation,
             margin_top, margin_right, margin_bottom, margin_left, id, report_name_eng || null]
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
        const accts = await fetchRowAccts(client, rowIds);
        const result = rows.map(row => ({
            ...row,
            columns: cols.filter(c => c.row_id === row.id),
            accounts: accts.filter(a => a.row_id === row.id),
        }));
        res.status(200).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const ROW_KINDS = ['ACCOUNTS', 'HEADING', 'TOTAL', 'FORMULA', 'BLANK'];
const LINE_STYLES = ['NONE', 'SINGLE', 'DOUBLE'];
const ROW_CODE_RE = /^[A-Z][A-Z0-9_]{0,29}$/;

const upperOrNull = (v) => {
    const t = String(v ?? '').trim().toUpperCase();
    return t === '' ? null : t;
};

const normalizeRow = (body) => {
    const rowKind = body.row_kind || 'ACCOUNTS';
    return {
        row_seq_no: parseInt(body.row_seq_no, 10),
        row_type: body.row_type || 'BODY',
        print_control: body.print_control || 'SHOW',
        account_from: body.account_from || null,
        account_to: body.account_to || null,
        normal_sign: body.normal_sign || 'DEBIT',
        branch_id: body.branch_id || null,
        dim1_id: body.dim1_id || null,
        dim2_id: body.dim2_id || null,
        dim3_id: body.dim3_id || null,
        dim4_id: body.dim4_id || null,
        dim5_id: body.dim5_id || null,
        row_code: upperOrNull(body.row_code),
        row_kind: rowKind,
        label_thai: body.label_thai || null,
        label_eng: body.label_eng || null,
        indent_level: Math.max(0, Math.min(10, parseInt(body.indent_level, 10) || 0)),
        parent_row_code: upperOrNull(body.parent_row_code),
        row_formula: rowKind === 'FORMULA' ? (String(body.row_formula || '').trim() || null) : null,
        is_bold: body.is_bold ?? false,
        line_above: body.line_above || 'NONE',
        line_below: body.line_below || 'NONE',
        hide_if_zero: body.hide_if_zero ?? false,
    };
};

const ROW_FIELDS = ['row_seq_no', 'row_type', 'print_control', 'account_from', 'account_to', 'normal_sign',
    'branch_id', 'dim1_id', 'dim2_id', 'dim3_id', 'dim4_id', 'dim5_id',
    'row_code', 'row_kind', 'label_thai', 'label_eng', 'indent_level', 'parent_row_code', 'row_formula',
    'is_bold', 'line_above', 'line_below', 'hide_if_zero'];

// ตรวจค่าบรรทัด — คืน null หรือ error object
const validateRow = async (client, reportId, r, rowId = null) => {
    if (!Number.isInteger(r.row_seq_no)) return { error: 'row_seq_no is required', code: 'INVALID_SEQ' };
    if (!ROW_KINDS.includes(r.row_kind) || !LINE_STYLES.includes(r.line_above) || !LINE_STYLES.includes(r.line_below)) {
        return { error: 'Invalid row_kind or line style', code: 'INVALID_KIND' };
    }
    if (r.row_code && (!ROW_CODE_RE.test(r.row_code) || FUNCTIONS[r.row_code])) {
        return { error: 'row_code must start with a letter, contain only A-Z, 0-9, _ (max 30) and not be a function name', code: 'INVALID_CODE' };
    }
    if (r.row_kind === 'TOTAL' && !r.row_code) {
        return { error: 'A TOTAL row needs a row_code so other rows can be added into it', code: 'CODE_REQUIRED' };
    }
    if (r.row_kind === 'FORMULA') {
        if (!r.row_formula) return { error: 'Formula is required for FORMULA rows', code: 'SYNTAX' };
        const syntaxErr = validateFormulaColumn('FORMULA', r.row_formula);
        if (syntaxErr) return syntaxErr;
        const refErr = await validateColRefsExist(client, reportId, r.row_formula, null, r.row_code);
        if (refErr) return refErr;
    }
    if (r.parent_row_code) {
        if (r.parent_row_code === r.row_code) {
            return { error: 'A row cannot be added into itself', code: 'CIRCULAR', detail: { row_code: r.row_code } };
        }
        const all = await client.query(
            `SELECT id, row_code, row_kind, parent_row_code FROM gl_fin_report_row WHERE report_id = $1`, [reportId]);
        const byCode = new Map(all.rows.filter(x => x.row_code && x.id !== rowId).map(x => [x.row_code, x]));
        const parent = byCode.get(r.parent_row_code);
        if (!parent || parent.row_kind !== 'TOTAL') {
            return { error: `Total row ${r.parent_row_code} not found in this report`, code: 'UNKNOWN_REF', detail: { row_code: r.parent_row_code } };
        }
        // บรรทัดรวมที่ซ้อนกันต้องไม่วนกลับมาที่บรรทัดนี้
        let p = parent;
        for (let depth = 0; p && depth < 100; depth++) {
            if (r.row_code && p.parent_row_code === r.row_code) {
                return { error: `Total rows loop back to ${r.row_code}`, code: 'CIRCULAR', detail: { row_code: r.row_code } };
            }
            p = p.parent_row_code ? byCode.get(p.parent_row_code) : null;
        }
    }
    return null;
};

// --- gl_fin_report_row_acct (เงื่อนไขเลือกบัญชีของบรรทัด บันทึกพร้อมบรรทัด) ---

const fetchRowAccts = async (client, rowIds) => {
    if (rowIds.length === 0) return [];
    const res = await client.query(
        `SELECT * FROM gl_fin_report_row_acct WHERE row_id = ANY($1::int[]) ORDER BY row_id, seq_no, id`, [rowIds]);
    return res.rows;
};

// body.accounts → รายการที่บันทึกได้ (undefined = ไม่ได้ส่งมา ไม่แตะของเดิม)
const normalizeAccts = (list) => {
    if (!Array.isArray(list)) return undefined;
    const str = (v) => String(v ?? '').trim() || null;
    return list.map((a, i) => {
        const selType = a.sel_type || 'RANGE';
        return {
            seq_no: (i + 1) * 10,
            sel_type: selType,
            is_exclude: a.is_exclude === true,
            account_from: selType === 'RANGE' ? str(a.account_from) : null,
            account_to: selType === 'RANGE' ? str(a.account_to) : null,
            header_account_code: selType === 'UNDER_HEADER' ? str(a.header_account_code) : null,
            account_type: selType === 'ACCOUNT_TYPE' ? str(a.account_type) : null,
        };
    });
};

// ตรวจเงื่อนไขเลือกบัญชี — คืน null หรือ error object (detail.index = ลำดับเงื่อนไขที่ผิด เริ่ม 0)
const validateAccts = async (client, accts) => {
    for (const [index, a] of accts.entries()) {
        if (!SEL_TYPES.includes(a.sel_type)) return { error: 'Invalid sel_type', code: 'INVALID_KIND', detail: { index } };
        if (a.sel_type === 'RANGE' && (!a.account_from || !a.account_to || a.account_from > a.account_to)) {
            return { error: 'Account range needs from <= to', code: 'INVALID_RANGE', detail: { index } };
        }
        if (a.sel_type === 'ACCOUNT_TYPE' && !ACCOUNT_TYPES.includes(a.account_type)) {
            return { error: 'Invalid account_type', code: 'INVALID_KIND', detail: { index } };
        }
    }
    const headers = accts.filter(a => a.sel_type === 'UNDER_HEADER').map(a => a.header_account_code);
    if (headers.length > 0) {
        const res = await client.query(`SELECT account_code FROM gl_account WHERE account_code = ANY($1::text[])`, [headers]);
        const found = new Set(res.rows.map(r => r.account_code));
        const index = accts.findIndex(a => a.sel_type === 'UNDER_HEADER' && !found.has(a.header_account_code));
        if (index !== -1) {
            const code = accts[index].header_account_code;
            return { error: `Account ${code} not found`, code: 'UNKNOWN_ACCOUNT', detail: { index, account_code: code } };
        }
    }
    return null;
};

const replaceRowAccts = async (client, rowId, accts) => {
    await client.query(`DELETE FROM gl_fin_report_row_acct WHERE row_id = $1`, [rowId]);
    for (const a of accts) {
        await client.query(
            `INSERT INTO gl_fin_report_row_acct (row_id, seq_no, sel_type, is_exclude, account_from, account_to, header_account_code, account_type)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [rowId, a.seq_no, a.sel_type, a.is_exclude, a.account_from, a.account_to, a.header_account_code, a.account_type]);
    }
};

// ตรวจผังบัญชีกับรายงาน: บัญชีลงรายการ (active) แต่ละบัญชีอยู่ในบรรทัด ACCOUNTS ใดบ้าง
// UI ใช้หาบัญชีที่ไม่อยู่ในบรรทัดใดเลย (ยอดหายจากงบ) และบัญชีที่อยู่หลายบรรทัด (ยอดนับซ้ำ)
const getAccountMapping = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const rowRes = await client.query(
            `SELECT * FROM gl_fin_report_row WHERE report_id = $1 AND row_kind = 'ACCOUNTS' ORDER BY row_seq_no`, [id]);
        const rows = rowRes.rows;
        const sels = await fetchRowAccts(client, rows.map(r => r.id));
        const accounts = await loadAccounts(client);
        const index = buildAccountIndex(accounts);
        const dimKeys = ['branch_id', 'dim1_id', 'dim2_id', 'dim3_id', 'dim4_id', 'dim5_id'];
        const resolved = rows.map(r => ({
            ref: {
                row_seq_no: r.row_seq_no, row_code: r.row_code, label_thai: r.label_thai, label_eng: r.label_eng,
                has_dims: dimKeys.some(k => r[k]), // บรรทัดกรองมิติ — อยู่หลายบรรทัดอาจตั้งใจแยกตามมิติ
            },
            set: resolveRowAccounts(index, rowSelections(r, sels.filter(s => s.row_id === r.id))) || new Set(),
        }));
        const result = accounts.filter(a => a.is_normal_account && a.is_active).map(a => ({
            account_code: a.account_code,
            account_name_thai: a.account_name_thai,
            account_name_eng: a.account_name_eng,
            account_type: a.account_type,
            rows: resolved.filter(x => x.set.has(a.account_code)).map(x => x.ref),
        }));
        res.status(200).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const rowUniqueViolation = (err) => {
    if (err.code !== '23505') return null;
    return err.constraint === 'gl_fin_report_row_code_uq'
        ? { error: 'row_code already exists in this report', code: 'DUPLICATE_CODE' }
        : { error: 'row_seq_no already exists in this report', code: 'DUPLICATE_SEQ' };
};

const createRow = async (req, res) => {
    const reportId = req.body.report_id;
    const r = normalizeRow(req.body);
    const accts = normalizeAccts(req.body.accounts);
    if (accts) { r.account_from = null; r.account_to = null; } // ใช้ตาราง row_acct แทนช่วงเดิม
    const client = await req.dbPool.connect();
    try {
        const invalid = await validateRow(client, reportId, r) || (accts && await validateAccts(client, accts));
        if (invalid) return res.status(400).json(invalid);
        await client.query('BEGIN');
        const result = await client.query(
            `INSERT INTO gl_fin_report_row (report_id, ${ROW_FIELDS.join(', ')})
             VALUES ($1, ${ROW_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
            [reportId, ...ROW_FIELDS.map(f => r[f])]);
        const row = result.rows[0];
        if (accts) await replaceRowAccts(client, row.id, accts);
        await client.query('COMMIT');
        res.status(201).json({ ...row, accounts: await fetchRowAccts(client, [row.id]) });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const dup = rowUniqueViolation(err);
        if (dup) return res.status(409).json(dup);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const r = normalizeRow(req.body);
    const accts = normalizeAccts(req.body.accounts);
    if (accts) { r.account_from = null; r.account_to = null; } // ใช้ตาราง row_acct แทนช่วงเดิม
    const client = await req.dbPool.connect();
    try {
        const cur = await client.query(`SELECT report_id, row_code, row_kind FROM gl_fin_report_row WHERE id=$1`, [id]);
        if (cur.rows.length === 0) return res.status(404).json({ error: 'Row not found' });
        const { report_id: reportId, row_code: oldCode, row_kind: oldKind } = cur.rows[0];

        const invalid = await validateRow(client, reportId, r, Number(id)) || (accts && await validateAccts(client, accts));
        if (invalid) return res.status(400).json(invalid);
        // เปลี่ยน/ลบรหัส หรือเลิกเป็นบรรทัด TOTAL ทั้งที่ยังถูกอ้างอยู่ → สูตร/ยอดรวมจะพัง
        const codeChanged = oldCode && oldCode !== r.row_code;
        const totalDropped = oldCode && oldKind === 'TOTAL' && r.row_kind !== 'TOTAL';
        if (codeChanged || totalDropped) {
            const usages = (await findRowCodeUsages(client, reportId, oldCode, id))
                .filter(u => codeChanged || u.endsWith('(total)'));
            if (usages.length > 0) {
                return res.status(400).json({ error: `${oldCode} is used by ${usages.join(', ')}`, code: 'REF_IN_USE', detail: { row_code: oldCode, usages } });
            }
        }
        const sets = ROW_FIELDS.map((f, i) => `${f}=$${i + 1}`).join(', ');
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE gl_fin_report_row SET ${sets} WHERE id=$${ROW_FIELDS.length + 1} RETURNING *`,
            [...ROW_FIELDS.map(f => r[f]), id]);
        if (accts) await replaceRowAccts(client, Number(id), accts);
        await client.query('COMMIT');
        res.status(200).json({ ...result.rows[0], accounts: await fetchRowAccts(client, [Number(id)]) });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const dup = rowUniqueViolation(err);
        if (dup) return res.status(409).json(dup);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// เรียงบรรทัดใหม่ (ลากวาง) — body.row_ids = id ทุกบรรทัดของรายงานตามลำดับใหม่ → เลขบรรทัด 10, 20, 30, ...
// สูตรแบบเก่า (Rn, Cm) อ้างด้วยเลขบรรทัด จึงแก้เลขในสูตรทุกที่ให้ตรงกับเลขใหม่ในธุรกรรมเดียวกัน
// (สูตรที่อ้างด้วย row_code ไม่กระทบ)
const reorderRows = async (req, res) => {
    const reportId = Number(req.params.id);
    const ids = (req.body.row_ids || []).map(Number);
    const client = await req.dbPool.connect();
    try {
        const cur = await client.query(`SELECT id, row_seq_no FROM gl_fin_report_row WHERE report_id = $1`, [reportId]);
        const oldSeqById = new Map(cur.rows.map(r => [r.id, r.row_seq_no]));
        if (ids.length !== oldSeqById.size || new Set(ids).size !== ids.length || ids.some(id => !oldSeqById.has(id))) {
            return res.status(400).json({ error: 'row_ids must list every row of the report exactly once', code: 'INVALID_SEQ' });
        }
        const seqMap = new Map(ids.map((id, i) => [oldSeqById.get(id), (i + 1) * 10]));

        await client.query('BEGIN');
        // เลี่ยง unique (report_id, row_seq_no) ชนกันระหว่างย้าย: ติดลบก่อนแล้วค่อยใส่เลขจริง
        await client.query(`UPDATE gl_fin_report_row SET row_seq_no = -row_seq_no WHERE report_id = $1`, [reportId]);
        for (const [i, id] of ids.entries()) {
            await client.query(`UPDATE gl_fin_report_row SET row_seq_no = $1 WHERE id = $2`, [(i + 1) * 10, id]);
        }
        const formulas = await client.query(`
            SELECT 'CELL' AS src, c.id, c.formula_text AS f FROM gl_fin_report_column c
              JOIN gl_fin_report_row r ON r.id = c.row_id
             WHERE r.report_id = $1 AND c.formula_text IS NOT NULL
            UNION ALL
            SELECT 'ROW', id, row_formula FROM gl_fin_report_row WHERE report_id = $1 AND row_formula IS NOT NULL
            UNION ALL
            SELECT 'COL', id, formula_text FROM gl_fin_report_col WHERE report_id = $1 AND formula_text IS NOT NULL`, [reportId]);
        const sql = {
            CELL: `UPDATE gl_fin_report_column SET formula_text = $1 WHERE id = $2`,
            ROW: `UPDATE gl_fin_report_row SET row_formula = $1 WHERE id = $2`,
            COL: `UPDATE gl_fin_report_col SET formula_text = $1 WHERE id = $2`,
        };
        let formulasUpdated = 0;
        for (const f of formulas.rows) {
            const next = renumberRowRefs(f.f, seqMap);
            if (next === f.f) continue;
            await client.query(sql[f.src], [next, f.id]);
            formulasUpdated++;
        }
        await client.query('COMMIT');
        res.status(200).json({ rows: ids.length, formulas_updated: formulasUpdated });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const cur = await client.query(`SELECT report_id, row_code FROM gl_fin_report_row WHERE id=$1`, [id]);
        if (cur.rows[0]?.row_code) {
            const code = cur.rows[0].row_code;
            const usages = await findRowCodeUsages(client, cur.rows[0].report_id, code, id);
            if (usages.length > 0) {
                return res.status(400).json({ error: `${code} is used by ${usages.join(', ')}`, code: 'REF_IN_USE', detail: { row_code: code, usages } });
            }
        }
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
    const { row_id, column_seq_no, column_type, description_thai, description_eng, data_type, column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text } = req.body;
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
            `INSERT INTO gl_fin_report_column (row_id, column_seq_no, column_type, description_thai, data_type, column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text, description_eng)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
            [row_id, column_seq_no, column_type, description_thai || null, data_type || null,
             column_flex ?? 1, indent_level ?? 0, font_size ?? 10,
             font_weight ?? 'NORMAL', text_align ?? 'LEFT', period_offset ?? 0, formula_text || null,
             description_eng || null]
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
    const { column_seq_no, column_type, description_thai, description_eng, data_type, column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text } = req.body;
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
             column_flex=$5, indent_level=$6, font_size=$7, font_weight=$8, text_align=$9, period_offset=$10, formula_text=$11,
             description_eng=$12
             WHERE id=$13 RETURNING *`,
            [column_seq_no, column_type, description_thai || null, data_type || null,
             column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text || null,
             description_eng || null, id]
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

const COL_KINDS = ['LABEL', 'AMOUNT', 'CALC'];
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
    if (c.col_kind === 'LABEL') {
        // ชื่อบรรทัดแสดงได้ที่เดียว — รายงานละ 1 คอลัมน์ LABEL
        const other = await client.query(
            `SELECT col_code FROM gl_fin_report_col WHERE report_id = $1 AND col_kind = 'LABEL' AND col_code <> $2`,
            [reportId, c.col_code]);
        if (other.rows.length > 0) {
            return { error: `This report already has a LABEL column [${other.rows[0].col_code}]`, code: 'DUPLICATE_LABEL' };
        }
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
         WHERE r.report_id = $1 AND c.column_type = 'FORMULA'
        UNION ALL
        SELECT 'ROWF', COALESCE(row_code, 'R' || row_seq_no), row_formula FROM gl_fin_report_row
         WHERE report_id = $1 AND row_kind = 'FORMULA'`, [reportId, excludeColId || 0]);
    return res.rows.filter(r => {
        try { return collectColRefs(parseFormula(r.formula_text)).has(code); } catch (_) { return false; }
    }).map(r => r.src === 'COL' ? `[${r.ref}]` : r.src === 'ROWF' ? r.ref : `(${r.ref})`);
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
    getRows, createRow, updateRow, deleteRow, reorderRows, getAccountMapping,
    createColumn, updateColumn, deleteColumn,
    getReportCols, createReportCol, updateReportCol, deleteReportCol,
};
