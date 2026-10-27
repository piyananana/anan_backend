// controllers/im/imPrintFormController.js — แบบฟอร์มพิมพ์กลาง (หน้าจอออกแบบ + หน้าจอพิมพ์)
// ฟอร์ม = im_print_form (+ ชุดสำเนา im_print_form_copy), ข้อมูลตามแหล่งข้อมูลใน utils/printDataSources.js,
// ประวัติการพิมพ์ = im_print_log — ตาราง/คำอธิบายอยู่ใน sql/print_form.sql (ระบบรันให้เองครั้งแรก)

const fs = require('fs');
const path = require('path');
const { SOURCES, loadCompany } = require('../../utils/printDataSources');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', '..', 'sql', 'print_form.sql'), 'utf8');
const ensured = new Set();
const ensureSchema = async (pool) => {
    const dbName = pool.options?.database || pool.database;
    if (dbName && ensured.has(dbName)) return;
    await pool.query(SCHEMA_SQL);
    if (dbName && typeof pool.release !== 'function') ensured.add(dbName);
};

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const sendErr = (res, error, label) => {
    if (error.status) return res.status(error.status).json({ message: error.message });
    if (error.code === '23505') return res.status(400).json({ message: 'รหัสแบบฟอร์มซ้ำ' });
    console.error(label, error);
    res.status(500).json({ message: 'Internal server error' });
};

const getSource = (key) => {
    const src = SOURCES[key];
    if (!src) throw httpErr(400, `ไม่พบแหล่งข้อมูล ${key}`);
    return src;
};

const MODES = ['LASER', 'PREPRINTED'];
const numOr = (v, d) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));

// ── แหล่งข้อมูล ─────────────────────────────────────────────────────────────
// GET /print_form_source — รายการแหล่งข้อมูล + ฟิลด์ (สำหรับหน้าจอออกแบบ)
const fetchSources = async (req, res) => {
    res.status(200).json(Object.values(SOURCES).map(s => ({
        key: s.key, name_th: s.name_th, name_en: s.name_en, fields: s.fields,
    })));
};

// ประเภทเอกสารของแหล่งข้อมูลที่ผู้ใช้มีสิทธิ์ (sa_user_document)
const permittedDocTypes = async (db, src, userId) => {
    const rows = [];
    for (const t of src.docTypes) {
        const r = await db.query(`
            SELECT m.id, m.doc_code, m.doc_name_thai, m.doc_name_eng, m.sys_doc_type, $3::text AS module
              FROM sa_module_document m
              JOIN sa_user_document u ON u.doc_id = m.id
             WHERE u.user_id = $1 AND m.sys_module = $2 AND m.sys_doc_type = ANY($4::text[])
               AND m.is_active = TRUE AND m.is_doc_type = TRUE
             ORDER BY m.doc_code`, [userId, t.sys_module, t.module, t.sys_doc_types]);
        rows.push(...r.rows);
    }
    return rows;
};

// GET /print_form_source/:key/doc_types
const fetchDocTypes = async (req, res) => {
    try {
        const src = getSource(req.params.key);
        const userId = Number(req.headers.userid);
        if (!userId) throw httpErr(401, 'ต้องระบุ UserId');
        res.status(200).json(await permittedDocTypes(req.dbPool, src, userId));
    } catch (error) { sendErr(res, error, 'Error fetching print doc types:'); }
};

// จำนวนครั้งที่พิมพ์แล้วต่อเอกสาร: Map(key → count)
const printCounts = async (db, keys) => {
    const pairs = keys.map(k => k.split(':')).filter(p => p.length === 2 && Number(p[1]));
    if (!pairs.length) return new Map();
    const r = await db.query(`
        SELECT doc_module || ':' || record_id AS key, MAX(print_no) AS cnt
          FROM im_print_log
         WHERE (doc_module, record_id) IN (SELECT * FROM unnest($1::text[], $2::int[]))
         GROUP BY doc_module, record_id`, [pairs.map(p => p[0]), pairs.map(p => Number(p[1]))]);
    return new Map(r.rows.map(x => [x.key, Number(x.cnt)]));
};

// GET /print_form_source/:key/docs?doc_ids=1,2&doc_no_from=&doc_no_to=&date_from=&date_to=
// เอกสารโพสต์แล้วที่ตรงเงื่อนไข (เฉพาะประเภทเอกสารที่ผู้ใช้มีสิทธิ์) + จำนวนครั้งที่พิมพ์แล้ว
const fetchDocs = async (req, res) => {
    try {
        const src = getSource(req.params.key);
        const userId = Number(req.headers.userid);
        if (!userId) throw httpErr(401, 'ต้องระบุ UserId');
        await ensureSchema(req.dbPool);
        const allowed = (await permittedDocTypes(req.dbPool, src, userId)).map(d => d.id);
        const wanted = String(req.query.doc_ids || '').split(',').map(Number).filter(Boolean);
        const docIds = wanted.length ? allowed.filter(id => wanted.includes(id)) : allowed;
        if (!docIds.length) return res.status(200).json([]);
        const rows = await src.listDocs(req.dbPool, {
            docIds, docNoFrom: req.query.doc_no_from || null, docNoTo: req.query.doc_no_to || null,
            dateFrom: req.query.date_from || null, dateTo: req.query.date_to || null,
        });
        const counts = await printCounts(req.dbPool, rows.map(r => r.key));
        res.status(200).json(rows.map(r => ({ ...r, print_count: counts.get(r.key) || 0 })));
    } catch (error) { sendErr(res, error, 'Error fetching print docs:'); }
};

// POST /print_form_source/:key/data { keys: ['IM:1', ...], form_id, log: bool, copies: 'ต้นฉบับ, สำเนา' }
// ข้อมูลพิมพ์ตามลำดับ keys — log = true บันทึกประวัติการพิมพ์ (ปุ่มพิมพ์) / false = ดูตัวอย่าง (ไม่นับครั้ง)
// print_no = ครั้งที่ของการพิมพ์นี้ (ดูตัวอย่าง = ครั้งถัดไปที่จะเป็น), reprint_label ว่างเมื่อเป็นครั้งแรก
const fetchPrintData = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const src = getSource(req.params.key);
        const userId = Number(req.headers.userid);
        if (!userId) throw httpErr(401, 'ต้องระบุ UserId');
        await ensureSchema(req.dbPool);
        const keys = [...new Set((Array.isArray(req.body.keys) ? req.body.keys : []).map(String))];
        if (!keys.length) throw httpErr(400, 'ไม่ได้เลือกเอกสาร');
        if (keys.length > 500) throw httpErr(400, 'พิมพ์ได้ครั้งละไม่เกิน 500 เอกสาร');

        const docs = await src.loadDocs(client, keys);
        // ตรวจสิทธิ์ประเภทเอกสาร + สถานะโพสต์แล้ว: ใช้ listDocs กรองเฉพาะเอกสารที่ขอ
        const allowed = (await permittedDocTypes(client, src, userId)).map(d => d.id);
        const okKeys = new Set(allowed.length
            ? (await src.listDocs(client, { docIds: allowed, keys })).map(r => r.key) : []);
        const printable = keys.filter(k => docs.has(k) && okKeys.has(k));
        if (!printable.length) throw httpErr(400, 'ไม่มีเอกสารที่พิมพ์ได้ (ต้องโพสต์แล้วและมีสิทธิ์ประเภทเอกสาร)');

        const log = req.body.log === true;
        const formId = Number(req.body.form_id) || null;
        let formName = null;
        if (formId) formName = (await client.query(`SELECT form_name_th FROM im_print_form WHERE id = $1`, [formId])).rows[0]?.form_name_th || null;

        await client.query('BEGIN');
        if (log) await client.query(`LOCK TABLE im_print_log IN SHARE ROW EXCLUSIVE MODE`);
        const counts = await printCounts(client, printable);
        const result = [];
        for (const key of printable) {
            const d = docs.get(key);
            const printNo = (counts.get(key) || 0) + 1;
            if (log) {
                const [module, id] = key.split(':');
                await client.query(`
                    INSERT INTO im_print_log (data_source, doc_module, record_id, doc_no, form_id, form_name, print_no, copies, printed_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                    [src.key, module, Number(id), d.header.doc_no, formId, formName, printNo,
                     req.body.copies ? String(req.body.copies).slice(0, 200) : null, req.headers.username || null]);
            }
            result.push({
                key,
                header: {
                    ...d.header, print_no: printNo,
                    reprint_label: printNo > 1 ? `พิมพ์ซ้ำครั้งที่ ${printNo - 1}` : '',
                    reprint_label_en: printNo > 1 ? `Reprint #${printNo - 1}` : '',
                },
                lines: d.lines,
            });
        }
        await client.query('COMMIT');
        res.status(200).json({ company: await loadCompany(client), docs: result, skipped: keys.filter(k => !printable.includes(k)) });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        sendErr(res, error, 'Error fetching print data:');
    } finally {
        client.release();
    }
};

// GET /print_form_log?module=IM&record_id=1 — ประวัติการพิมพ์ของเอกสาร
const fetchPrintLog = async (req, res) => {
    try {
        await ensureSchema(req.dbPool);
        const r = await req.dbPool.query(`
            SELECT id, data_source, doc_module, record_id, doc_no, form_name, print_no, copies, printed_by, printed_at
              FROM im_print_log WHERE doc_module = $1 AND record_id = $2 ORDER BY print_no DESC, id DESC`,
            [String(req.query.module || ''), Number(req.query.record_id) || 0]);
        res.status(200).json(r.rows);
    } catch (error) { sendErr(res, error, 'Error fetching print log:'); }
};

// ── แบบฟอร์ม ────────────────────────────────────────────────────────────────
const FORM_COLS = `f.id, f.form_code, f.form_name_th, f.form_name_en, f.data_source, f.print_mode, f.paper_size,
    f.paper_width_mm::float AS paper_width_mm, f.paper_height_mm::float AS paper_height_mm,
    f.offset_x_mm::float AS offset_x_mm, f.offset_y_mm::float AS offset_y_mm,
    f.is_default, f.is_active, f.remark, f.updated_by, f.updated_at`;

// GET /print_form?data_source=&active=1 — รายการฟอร์ม (ไม่รวม layout/รูป)
const fetchForms = async (req, res) => {
    try {
        await ensureSchema(req.dbPool);
        const p = [];
        let where = 'WHERE 1=1';
        if (req.query.data_source) { p.push(req.query.data_source); where += ` AND f.data_source = $${p.length}`; }
        if (req.query.active === '1') where += ' AND f.is_active';
        const r = await req.dbPool.query(`
            SELECT ${FORM_COLS}, (SELECT COUNT(*)::int FROM im_print_form_copy c WHERE c.form_id = f.id) AS copy_count
              FROM im_print_form f ${where} ORDER BY f.data_source, f.is_default DESC, f.form_code`, p);
        res.status(200).json(r.rows);
    } catch (error) { sendErr(res, error, 'Error fetching print forms:'); }
};

const loadForm = async (db, id) => {
    const f = (await db.query(`SELECT ${FORM_COLS}, f.layout_json FROM im_print_form f WHERE f.id = $1`, [id])).rows[0];
    if (!f) return null;
    f.copies = (await db.query(`
        SELECT id, copy_no, copy_name_th, copy_name_en, bg_image,
               bg_offset_x_mm::float AS bg_offset_x_mm, bg_offset_y_mm::float AS bg_offset_y_mm,
               bg_scale::float AS bg_scale, bg_rotate_deg::float AS bg_rotate_deg
          FROM im_print_form_copy WHERE form_id = $1 ORDER BY copy_no`, [id])).rows;
    return f;
};

// GET /print_form/:id — ฟอร์มเต็ม (layout + ชุดสำเนาพร้อมรูป)
const fetchFormById = async (req, res) => {
    try {
        await ensureSchema(req.dbPool);
        const f = await loadForm(req.dbPool, Number(req.params.id));
        if (!f) return res.status(404).json({ message: 'ไม่พบแบบฟอร์ม' });
        res.status(200).json(f);
    } catch (error) { sendErr(res, error, 'Error fetching print form:'); }
};

const validateForm = (b) => {
    const code = String(b.form_code || '').trim();
    const name = String(b.form_name_th || '').trim();
    if (!code) throw httpErr(400, 'กรุณาระบุรหัสแบบฟอร์ม');
    if (!name) throw httpErr(400, 'กรุณาระบุชื่อแบบฟอร์ม');
    getSource(b.data_source);
    const mode = MODES.includes(b.print_mode) ? b.print_mode : 'LASER';
    const w = numOr(b.paper_width_mm, 0), h = numOr(b.paper_height_mm, 0);
    if (w < 20 || h < 20 || w > 1000 || h > 1000) throw httpErr(400, 'ขนาดกระดาษไม่ถูกต้อง (20-1000 มม.)');
    const copies = Array.isArray(b.copies) ? b.copies : [];
    if (!copies.length) throw httpErr(400, 'ต้องมีชุดสำเนาอย่างน้อย 1 ชุด');
    if (copies.length > 10) throw httpErr(400, 'ชุดสำเนาได้ไม่เกิน 10 ชุด');
    copies.forEach((c, i) => { if (!String(c.copy_name_th || '').trim()) throw httpErr(400, `กรุณาระบุชื่อสำเนาที่ ${i + 1}`); });
    const layout = b.layout_json && typeof b.layout_json === 'object' ? b.layout_json : { elements: [] };
    if (!Array.isArray(layout.elements)) layout.elements = [];
    return { code, name, mode, w, h, copies, layout };
};

const saveCopies = async (client, formId, copies) => {
    await client.query(`DELETE FROM im_print_form_copy WHERE form_id = $1`, [formId]);
    let i = 0;
    for (const c of copies) {
        await client.query(`
            INSERT INTO im_print_form_copy (form_id, copy_no, copy_name_th, copy_name_en, bg_image,
                   bg_offset_x_mm, bg_offset_y_mm, bg_scale, bg_rotate_deg)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [formId, ++i, String(c.copy_name_th).trim(), String(c.copy_name_en || '').trim() || null, c.bg_image || null,
             numOr(c.bg_offset_x_mm, 0), numOr(c.bg_offset_y_mm, 0), numOr(c.bg_scale, 1) || 1, numOr(c.bg_rotate_deg, 0)]);
    }
};

// ฟอร์มเริ่มต้นมีได้ 1 ฟอร์มต่อแหล่งข้อมูล
const clearOtherDefaults = async (client, formId, source) => {
    await client.query(`UPDATE im_print_form SET is_default = FALSE WHERE data_source = $1 AND id <> $2 AND is_default`, [source, formId]);
};

// POST /print_form
const createForm = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureSchema(req.dbPool);
        const v = validateForm(req.body);
        const b = req.body;
        const user = req.headers.username || null;
        await client.query('BEGIN');
        const r = await client.query(`
            INSERT INTO im_print_form (form_code, form_name_th, form_name_en, data_source, print_mode, paper_size,
                   paper_width_mm, paper_height_mm, offset_x_mm, offset_y_mm, layout_json, is_default, is_active, remark,
                   created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING id`,
            [v.code, v.name, String(b.form_name_en || '').trim() || null, b.data_source, v.mode, b.paper_size || 'CUSTOM',
             v.w, v.h, numOr(b.offset_x_mm, 0), numOr(b.offset_y_mm, 0), JSON.stringify(v.layout),
             !!b.is_default, b.is_active !== false, b.remark || null, user]);
        const id = r.rows[0].id;
        await saveCopies(client, id, v.copies);
        if (b.is_default) await clearOtherDefaults(client, id, b.data_source);
        await client.query('COMMIT');
        res.status(201).json(await loadForm(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        sendErr(res, error, 'Error creating print form:');
    } finally { client.release(); }
};

// PUT /print_form/:id — แทนที่ทั้งฟอร์ม (รวมชุดสำเนา)
const updateForm = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureSchema(req.dbPool);
        const id = Number(req.params.id);
        const v = validateForm(req.body);
        const b = req.body;
        await client.query('BEGIN');
        const r = await client.query(`
            UPDATE im_print_form SET form_code=$2, form_name_th=$3, form_name_en=$4, data_source=$5, print_mode=$6, paper_size=$7,
                   paper_width_mm=$8, paper_height_mm=$9, offset_x_mm=$10, offset_y_mm=$11, layout_json=$12,
                   is_default=$13, is_active=$14, remark=$15, updated_by=$16, updated_at=NOW()
             WHERE id = $1`,
            [id, v.code, v.name, String(b.form_name_en || '').trim() || null, b.data_source, v.mode, b.paper_size || 'CUSTOM',
             v.w, v.h, numOr(b.offset_x_mm, 0), numOr(b.offset_y_mm, 0), JSON.stringify(v.layout),
             !!b.is_default, b.is_active !== false, b.remark || null, req.headers.username || null]);
        if (!r.rowCount) throw httpErr(404, 'ไม่พบแบบฟอร์ม');
        await saveCopies(client, id, v.copies);
        if (b.is_default) await clearOtherDefaults(client, id, b.data_source);
        await client.query('COMMIT');
        res.status(200).json(await loadForm(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        sendErr(res, error, 'Error updating print form:');
    } finally { client.release(); }
};

// POST /print_form/:id/duplicate { form_code, form_name_th } — คัดลอกทั้งฟอร์มรวมชุดสำเนา/รูป (ไม่เป็นฟอร์มเริ่มต้น)
const duplicateForm = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureSchema(req.dbPool);
        const id = Number(req.params.id);
        const code = String(req.body.form_code || '').trim();
        if (!code) throw httpErr(400, 'กรุณาระบุรหัสแบบฟอร์ม');
        await client.query('BEGIN');
        const r = await client.query(`
            INSERT INTO im_print_form (form_code, form_name_th, form_name_en, data_source, print_mode, paper_size,
                   paper_width_mm, paper_height_mm, offset_x_mm, offset_y_mm, layout_json, is_default, is_active, remark,
                   created_by, updated_by)
            SELECT $2, COALESCE(NULLIF($3, ''), form_name_th), form_name_en, data_source, print_mode, paper_size,
                   paper_width_mm, paper_height_mm, offset_x_mm, offset_y_mm, layout_json, FALSE, is_active, remark, $4, $4
              FROM im_print_form WHERE id = $1 RETURNING id`,
            [id, code, String(req.body.form_name_th || '').trim(), req.headers.username || null]);
        if (!r.rowCount) throw httpErr(404, 'ไม่พบแบบฟอร์ม');
        const newId = r.rows[0].id;
        await client.query(`
            INSERT INTO im_print_form_copy (form_id, copy_no, copy_name_th, copy_name_en, bg_image,
                   bg_offset_x_mm, bg_offset_y_mm, bg_scale, bg_rotate_deg)
            SELECT $2, copy_no, copy_name_th, copy_name_en, bg_image, bg_offset_x_mm, bg_offset_y_mm, bg_scale, bg_rotate_deg
              FROM im_print_form_copy WHERE form_id = $1`, [id, newId]);
        await client.query('COMMIT');
        res.status(201).json(await loadForm(req.dbPool, newId));
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        sendErr(res, error, 'Error duplicating print form:');
    } finally { client.release(); }
};

// DELETE /print_form/:id — ประวัติการพิมพ์เก็บไว้ (form_id = NULL, ชื่อฟอร์มยังอยู่ใน form_name)
const deleteForm = async (req, res) => {
    try {
        await ensureSchema(req.dbPool);
        const r = await req.dbPool.query(`DELETE FROM im_print_form WHERE id = $1`, [Number(req.params.id)]);
        if (!r.rowCount) return res.status(404).json({ message: 'ไม่พบแบบฟอร์ม' });
        res.status(200).json({ message: 'ลบแบบฟอร์มแล้ว' });
    } catch (error) { sendErr(res, error, 'Error deleting print form:'); }
};

module.exports = {
    fetchSources, fetchDocTypes, fetchDocs, fetchPrintData, fetchPrintLog,
    fetchForms, fetchFormById, createForm, updateForm, duplicateForm, deleteForm,
};
