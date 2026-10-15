// controllers/gl/glFinancialReportTransferController.js
// ย้ายแบบงบการเงินข้ามฐานข้อมูล (export/import JSON) และสร้างงบจากแม่แบบ (templates/fin_report/*.json)
//
// รูปแบบไฟล์ (format = 'anan.gl_fin_report', version = 1):
//   { report: {...}, cols: [...], rows: [{ ..., columns: [...], accounts: [...] }] }
// id ของแต่ละฐานข้อมูลไม่ติดไปด้วย — สาขาเก็บเป็น branch_code, มิติเก็บเป็น dims: [{ type_code, value_code }]
// (ตอนนำเข้าหา slot ของมิติจาก type_code ของฐานปลายทาง จึงไม่ขึ้นกับว่ามิติอยู่ช่องที่เท่าไร)
const fs = require('fs');
const path = require('path');

const FORMAT = 'anan.gl_fin_report';
const VERSION = 1;
const TEMPLATE_DIR = path.join(__dirname, '../../templates/fin_report');
const TEMPLATE_ID_RE = /^[a-z0-9_]+$/;
const SKIP = new Set(['id', 'report_id', 'row_id', 'created_at', 'updated_at']);
const DIM_KEYS = ['dim1_id', 'dim2_id', 'dim3_id', 'dim4_id', 'dim5_id'];

const tableColumns = async (client, table) => {
    const res = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema()`, [table]);
    return new Set(res.rows.map(r => r.column_name));
};

const loadLookups = async (client) => {
    const br = await client.query(`SELECT id, branch_code FROM cd_branch`);
    const dv = await client.query(`
        SELECT v.id, v.type_code, v.value_code, t.slot_no
          FROM gl_dimension_value v JOIN gl_dimension_type t ON t.type_code = v.type_code`);
    return {
        branchById: new Map(br.rows.map(b => [b.id, b.branch_code])),
        branchByCode: new Map(br.rows.map(b => [b.branch_code, b.id])),
        dimById: new Map(dv.rows.map(d => [d.id, d])),
        dimByKey: new Map(dv.rows.map(d => [`${d.type_code}\u0000${d.value_code}`, d])),
    };
};

// แถวจากฐานข้อมูล → แถวในไฟล์ (ตัด id, แปลงสาขา/มิติเป็นรหัส)
const toPortable = (obj, lk) => {
    const o = Object.fromEntries(Object.entries(obj).filter(([k]) => !SKIP.has(k)));
    if ('branch_id' in o) {
        o.branch_code = o.branch_id ? (lk.branchById.get(o.branch_id) ?? null) : null;
        delete o.branch_id;
    }
    if (DIM_KEYS.some(k => k in o)) {
        o.dims = DIM_KEYS.map(k => o[k] && lk.dimById.get(o[k])).filter(Boolean)
            .map(d => ({ type_code: d.type_code, value_code: d.value_code }));
        DIM_KEYS.forEach(k => delete o[k]);
    }
    return o;
};

// แถวในไฟล์ → ค่าที่บันทึกได้ (รหัสสาขา/มิติที่ไม่มีในฐานนี้ → ว่าง + คำเตือน)
const fromPortable = (o, lk, warnings, where) => {
    const out = { ...o };
    if ('branch_code' in out) {
        out.branch_id = null;
        if (out.branch_code) {
            out.branch_id = lk.branchByCode.get(out.branch_code) ?? null;
            if (!out.branch_id) warnings.push({ code: 'BRANCH_NOT_FOUND', where, value: out.branch_code });
        }
        delete out.branch_code;
    }
    if (Array.isArray(out.dims)) {
        for (const d of out.dims) {
            const found = lk.dimByKey.get(`${d.type_code}\u0000${d.value_code}`);
            if (found) out[`dim${found.slot_no}_id`] = found.id;
            else warnings.push({ code: 'DIM_NOT_FOUND', where, value: `${d.type_code}:${d.value_code}` });
        }
    }
    delete out.dims;
    return out;
};

// INSERT เฉพาะคอลัมน์ที่มีจริงในตาราง (ชื่อคอลัมน์มาจาก information_schema จึงไม่รับชื่อจากไฟล์ตรงๆ)
const insertInto = async (client, table, columns, values) => {
    const keys = Object.keys(values).filter(k => columns.has(k) && !SKIP.has(k));
    const extra = Object.entries(values).filter(([k]) => k === 'report_id' || k === 'row_id');
    const allKeys = [...extra.map(([k]) => k), ...keys];
    const params = [...extra.map(([, v]) => v), ...keys.map(k => {
        const v = values[k];
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    })];
    const res = await client.query(
        `INSERT INTO ${table} (${allKeys.join(', ')}) VALUES (${allKeys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        params);
    return res.rows[0];
};

const buildExport = async (client, reportId) => {
    const rep = await client.query(`SELECT * FROM gl_fin_report WHERE id = $1`, [reportId]);
    if (rep.rows.length === 0) return null;
    const lk = await loadLookups(client);
    const cols = await client.query(`SELECT * FROM gl_fin_report_col WHERE report_id = $1 ORDER BY col_seq_no`, [reportId]);
    const rows = await client.query(`SELECT * FROM gl_fin_report_row WHERE report_id = $1 ORDER BY row_seq_no`, [reportId]);
    const ids = rows.rows.map(r => r.id);
    const cells = ids.length ? (await client.query(
        `SELECT * FROM gl_fin_report_column WHERE row_id = ANY($1::int[]) ORDER BY row_id, column_seq_no`, [ids])).rows : [];
    const accts = ids.length ? (await client.query(
        `SELECT * FROM gl_fin_report_row_acct WHERE row_id = ANY($1::int[]) ORDER BY row_id, seq_no, id`, [ids])).rows : [];
    return {
        format: FORMAT,
        version: VERSION,
        exported_at: new Date().toISOString(),
        report: toPortable(rep.rows[0], lk),
        cols: cols.rows.map(c => toPortable(c, lk)),
        rows: rows.rows.map(r => ({
            ...toPortable(r, lk),
            columns: cells.filter(c => c.row_id === r.id).map(c => toPortable(c, lk)),
            accounts: accts.filter(a => a.row_id === r.id).map(a => toPortable(a, lk)),
        })),
    };
};

const exportReport = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const data = await buildExport(client, Number(req.params.id));
        if (!data) return res.status(404).json({ error: 'Report not found' });
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const readTemplate = (id) => {
    if (!TEMPLATE_ID_RE.test(id || '')) return null;
    const file = path.join(TEMPLATE_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const listTemplates = async (req, res) => {
    try {
        const files = fs.existsSync(TEMPLATE_DIR) ? fs.readdirSync(TEMPLATE_DIR).filter(f => f.endsWith('.json')).sort() : [];
        res.status(200).json(files.map(f => {
            const id = f.replace(/\.json$/, '');
            const t = readTemplate(id);
            return { id, ...(t.template || {}), report_code: t.report.report_code, row_count: t.rows.length };
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// body: { data } (ไฟล์ที่ export มา) หรือ { template: '<id>' } + report_code, report_name_thai, report_name_eng (ไม่บังคับ)
// คืน { report, warnings } — warnings = สาขา/มิติ/หัวบัญชีที่ไม่มีในฐานนี้ (บันทึกเป็นค่าว่าง ให้ผู้ใช้แก้ต่อ)
const importReport = async (req, res) => {
    const data = req.body.template ? readTemplate(req.body.template) : req.body.data;
    if (!data) return res.status(404).json({ error: 'Template not found', code: 'NOT_FOUND' });
    if (data.format !== FORMAT || !data.report || !Array.isArray(data.rows) || !Array.isArray(data.cols)) {
        return res.status(400).json({ error: 'Not an ANAN financial report file', code: 'INVALID_FILE' });
    }
    if (data.version > VERSION) {
        return res.status(400).json({ error: `File version ${data.version} is newer than this system supports (${VERSION})`, code: 'INVALID_FILE' });
    }
    const reportCode = String(req.body.report_code || data.report.report_code || '').trim();
    if (!reportCode) return res.status(400).json({ error: 'report_code is required', code: 'INVALID_CODE' });

    const client = await req.dbPool.connect();
    try {
        const dup = await client.query(`SELECT 1 FROM gl_fin_report WHERE report_code = $1`, [reportCode]);
        if (dup.rows.length > 0) return res.status(409).json({ error: 'report_code already exists', code: 'DUPLICATE_CODE' });

        const lk = await loadLookups(client);
        const tc = {
            report: await tableColumns(client, 'gl_fin_report'),
            col: await tableColumns(client, 'gl_fin_report_col'),
            row: await tableColumns(client, 'gl_fin_report_row'),
            cell: await tableColumns(client, 'gl_fin_report_column'),
            acct: await tableColumns(client, 'gl_fin_report_row_acct'),
        };
        const warnings = [];
        const acctCodes = new Set((await client.query(`SELECT account_code FROM gl_account`)).rows.map(r => r.account_code));

        await client.query('BEGIN');
        const report = await insertInto(client, 'gl_fin_report', tc.report, {
            ...fromPortable(data.report, lk, warnings, 'report'),
            report_code: reportCode,
            ...(req.body.report_name_thai ? { report_name_thai: req.body.report_name_thai } : {}),
            ...(req.body.report_name_eng ? { report_name_eng: req.body.report_name_eng } : {}),
        });
        for (const c of data.cols) {
            await insertInto(client, 'gl_fin_report_col', tc.col,
                { ...fromPortable(c, lk, warnings, `[${c.col_code}]`), report_id: report.id });
        }
        for (const r of data.rows) {
            const where = r.row_code || `R${r.row_seq_no}`;
            const { columns = [], accounts = [], ...rowData } = r;
            const row = await insertInto(client, 'gl_fin_report_row', tc.row,
                { ...fromPortable(rowData, lk, warnings, where), report_id: report.id });
            for (const c of columns) {
                await insertInto(client, 'gl_fin_report_column', tc.cell, { ...fromPortable(c, lk, warnings, where), row_id: row.id });
            }
            for (const a of accounts) {
                if (a.sel_type === 'UNDER_HEADER' && !acctCodes.has(a.header_account_code)) {
                    warnings.push({ code: 'ACCOUNT_NOT_FOUND', where, value: a.header_account_code });
                }
                await insertInto(client, 'gl_fin_report_row_acct', tc.acct, { ...fromPortable(a, lk, warnings, where), row_id: row.id });
            }
        }
        await client.query('COMMIT');
        // บรรทัด ACCOUNTS ที่ยังไม่ได้เลือกบัญชี (เช่น สร้างจากแม่แบบ) — ให้หน้าจอแจ้งผู้ใช้
        const emptyAccountRows = data.rows
            .filter(r => (r.row_kind || 'ACCOUNTS') === 'ACCOUNTS' && !(r.accounts || []).length && !(r.account_from && r.account_to))
            .map(r => r.row_code || `R${r.row_seq_no}`);
        res.status(201).json({ report, warnings, empty_account_rows: emptyAccountRows });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') return res.status(409).json({ error: err.detail || err.message, code: 'DUPLICATE_CODE' });
        if (err.code === '23514' || err.code === '22P02' || err.code === '23502') {
            return res.status(400).json({ error: err.message, code: 'INVALID_FILE' });
        }
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { exportReport, importReport, listTemplates, buildExport };
