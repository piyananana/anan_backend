// controllers/gl/glDimensionToolsController.js
// สรุปของหน้าจอประเภทมิติแบบใหม่ (user 2026-11-28, IM design B):
//   - GET /gl_dimension_type/usage                    ต่อช่อง (slot 1-5): จำนวนค่า, บัญชีที่ต้องระบุ / ระบุได้ — การ์ดซ้าย
//   - GET /gl_dimension_type/:slot_no/summary?fiscal_year_id=
//         ค่าในมิติ (ใช้งาน/หยุดใช้), บัญชีที่ต้องระบุ/ระบุได้ + บรรทัดปีนี้ + บรรทัด Draft ที่ขาดมิติ,
//         บรรทัด Posted ที่ใช้มิตินี้ในปีบัญชี, ค่า 50 แรกพร้อมจำนวนบรรทัด
// บรรทัดรายการบัญชีเก็บมิติที่ gl_entry_detail.dim{slot}_id
'use strict';

const { resolveFiscalYear } = require('./glAccountToolsController');

const SLOTS = [1, 2, 3, 4, 5];
const slotOf = (v) => (SLOTS.includes(Number(v)) ? Number(v) : null);

// GET /gl_dimension_type/usage
const fetchTypeUsage = async (req, res) => {
    try {
        const r = await req.dbPool.query(`
            SELECT t.slot_no,
                   (SELECT COUNT(*)::int FROM gl_dimension_value v WHERE v.type_code = t.type_code) AS value_count,
                   (SELECT COUNT(*)::int FROM gl_account_dim_rule r WHERE r.type_code = t.type_code AND r.is_required) AS required_accounts,
                   (SELECT COUNT(*)::int FROM gl_account_dim_rule r WHERE r.type_code = t.type_code AND NOT r.is_required) AS optional_accounts
              FROM gl_dimension_type t ORDER BY t.slot_no`);
        res.json(r.rows);
    } catch (err) {
        console.error('gl_dimension_type usage:', err);
        res.status(500).json({ error: err.message });
    }
};

// GET /gl_dimension_type/:slot_no/summary
const fetchTypeSummary = async (req, res) => {
    const slot = slotOf(req.params.slot_no);
    if (!slot) return res.status(400).json({ error: 'slot_no must be 1-5' });
    const col = `dim${slot}_id`;
    const client = await req.dbPool.connect();
    try {
        const t = (await client.query(`SELECT type_code FROM gl_dimension_type WHERE slot_no = $1`, [slot])).rows[0];
        const fy = await resolveFiscalYear(client, req.query.fiscal_year_id);
        const fyId = fy?.id || 0;
        if (!t) {
            return res.json({ fiscal_year: fy, value_count: 0, active_values: 0, lines_year: 0, missing_draft: 0, accounts: [], values: [] });
        }
        const counts = (await client.query(`
            SELECT COUNT(*)::int AS value_count, COUNT(*) FILTER (WHERE is_active)::int AS active_values
              FROM gl_dimension_value WHERE type_code = $1`, [t.type_code])).rows[0];
        const lines = (await client.query(`
            SELECT COUNT(*)::int AS n FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
              JOIN gl_posting_period p ON p.id = h.period_id
             WHERE d.${col} IS NOT NULL AND h.status = 'Posted' AND p.fiscal_year_id = $1`, [fyId])).rows[0].n;
        // บัญชีที่ผูกมิตินี้ + บรรทัด Posted ปีนี้ + บรรทัด Draft ที่ขาดมิติ (เฉพาะบัญชีที่ต้องระบุ)
        const accounts = (await client.query(`
            SELECT a.id, a.account_code, a.account_name_thai, a.account_name_eng, a.account_type, r.is_required,
                   COUNT(d.id) FILTER (WHERE h.status = 'Posted' AND p.fiscal_year_id = $2)::int AS lines_year,
                   COUNT(d.id) FILTER (WHERE h.status = 'Draft' AND d.${col} IS NULL AND r.is_required)::int AS missing_draft
              FROM gl_account_dim_rule r
              JOIN gl_account a ON a.id = r.account_id
              LEFT JOIN gl_entry_detail d ON d.account_id = a.id
              LEFT JOIN gl_entry_header h ON h.id = d.header_id
              LEFT JOIN gl_posting_period p ON p.id = h.period_id
             WHERE r.type_code = $1
             GROUP BY a.id, r.is_required
             ORDER BY r.is_required DESC, a.account_code`, [t.type_code, fyId])).rows;
        const values = (await client.query(`
            SELECT v.id, v.value_code, v.value_name_thai, v.value_name_eng, v.is_active, pv.value_code AS parent_code,
                   (SELECT COUNT(*)::int FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
                      JOIN gl_posting_period p ON p.id = h.period_id
                     WHERE d.${col} = v.id AND h.status = 'Posted' AND p.fiscal_year_id = $2) AS lines_year
              FROM gl_dimension_value v LEFT JOIN gl_dimension_value pv ON pv.id = v.parent_id
             WHERE v.type_code = $1
             ORDER BY v.sort_order, v.value_code LIMIT 50`, [t.type_code, fyId])).rows;
        res.json({
            fiscal_year: fy,
            value_count: counts.value_count,
            active_values: counts.active_values,
            lines_year: lines,
            missing_draft: accounts.reduce((s, a) => s + a.missing_draft, 0),
            accounts,
            values,
        });
    } catch (err) {
        console.error('gl_dimension_type summary:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── หน้าจอค่ามิติ (ต้นไม้) ──
const slotOfType = async (client, typeCode) =>
    slotOf((await client.query(`SELECT slot_no FROM gl_dimension_type WHERE type_code = $1`, [typeCode])).rows[0]?.slot_no);

const valueSubtree = async (client, id) => (await client.query(`
    WITH RECURSIVE t AS (SELECT id FROM gl_dimension_value WHERE id = $1
                         UNION ALL SELECT v.id FROM gl_dimension_value v JOIN t ON v.parent_id = t.id)
    SELECT id FROM t`, [id])).rows.map(r => r.id);

// GET /gl_dimension_value/usage?type_code=   ต่อค่า (เฉพาะของตัวเอง): บรรทัด Posted ปีนี้ / ทั้งหมด — ต้นไม้รวมยอดลูกเอง
const fetchValueUsage = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const slot = await slotOfType(client, req.query.type_code);
        if (!slot) return res.json([]);
        const col = `dim${slot}_id`;
        const fy = await resolveFiscalYear(client, req.query.fiscal_year_id);
        const r = await client.query(`
            SELECT d.${col} AS id, COUNT(*)::int AS lines_all,
                   COUNT(*) FILTER (WHERE p.fiscal_year_id = $1)::int AS lines_year
              FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
              JOIN gl_posting_period p ON p.id = h.period_id
             WHERE d.${col} IS NOT NULL AND h.status = 'Posted'
             GROUP BY d.${col}`, [fy?.id || 0]);
        res.json(r.rows);
    } catch (err) {
        console.error('gl_dimension_value usage:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// GET /gl_dimension_value/:id/summary   ค่านี้ + ค่าย่อยทุกระดับ: บรรทัด/รายได้/ค่าใช้จ่ายปีนี้, ใช้ล่าสุด, ยอดตามบัญชี 10 อันดับ, ค่าย่อยระดับถัดไป
const fetchValueSummary = async (req, res) => {
    const id = Number(req.params.id) || 0;
    const client = await req.dbPool.connect();
    try {
        const v = (await client.query(`SELECT id, type_code FROM gl_dimension_value WHERE id = $1`, [id])).rows[0];
        if (!v) return res.status(404).json({ error: 'Not found' });
        const slot = await slotOfType(client, v.type_code);
        const fy = await resolveFiscalYear(client, req.query.fiscal_year_id);
        const ids = await valueSubtree(client, id);
        const empty = { fiscal_year: fy, lines_year: 0, revenue: 0, expense: 0, last_used: null, by_account: [], children: [] };
        if (!slot) return res.json(empty);
        const col = `dim${slot}_id`;
        const base = `FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
                      JOIN gl_posting_period p ON p.id = h.period_id JOIN gl_account a ON a.id = d.account_id
                     WHERE d.${col} = ANY($1::int[]) AND h.status = 'Posted'`;
        const tot = (await client.query(`
            SELECT COUNT(*)::int AS lines_year,
                   COALESCE(SUM(d.credit_lc - d.debit_lc) FILTER (WHERE a.account_type = 'REVENUE'), 0)::float8 AS revenue,
                   COALESCE(SUM(d.debit_lc - d.credit_lc) FILTER (WHERE a.account_type = 'EXPENSE'), 0)::float8 AS expense
              ${base} AND p.fiscal_year_id = $2`, [ids, fy?.id || 0])).rows[0];
        const last = (await client.query(`SELECT h.doc_no, h.posting_date::text AS posting_date ${base}
                                          ORDER BY h.posting_date DESC, h.id DESC LIMIT 1`, [ids])).rows[0] || null;
        const byAccount = (await client.query(`
            SELECT a.id, a.account_code, a.account_name_thai, a.account_name_eng, a.account_type,
                   SUM(d.debit_lc)::float8 AS debit, SUM(d.credit_lc)::float8 AS credit
              ${base} AND p.fiscal_year_id = $2
             GROUP BY a.id ORDER BY ABS(SUM(d.debit_lc - d.credit_lc)) DESC, a.account_code LIMIT 10`, [ids, fy?.id || 0])).rows;
        const children = (await client.query(`
            SELECT c.id, c.value_code, c.value_name_thai, c.value_name_eng, c.is_active,
                   (SELECT COUNT(*)::int FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
                      JOIN gl_posting_period p ON p.id = h.period_id
                     WHERE d.${col} = c.id AND h.status = 'Posted' AND p.fiscal_year_id = $2) AS lines_year
              FROM gl_dimension_value c WHERE c.parent_id = $1
             ORDER BY c.sort_order, c.value_code`, [id, fy?.id || 0])).rows;
        res.json({ fiscal_year: fy, lines_year: tot.lines_year, revenue: tot.revenue, expense: tot.expense, last_used: last, by_account: byAccount, children });
    } catch (err) {
        console.error('gl_dimension_value summary:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// PUT /gl_dimension_value/:id/move { parent_id }   ย้ายระดับ (ลากบนต้นไม้) — ประเภทมิติเดียวกัน ไม่ใช่ลูกหลานของตัวเอง
const moveValue = async (req, res) => {
    const id = Number(req.params.id);
    const parentId = req.body?.parent_id == null ? null : Number(req.body.parent_id);
    const client = await req.dbPool.connect();
    try {
        const v = (await client.query(`SELECT id, type_code FROM gl_dimension_value WHERE id = $1`, [id])).rows[0];
        if (!v) return res.status(404).json({ error: 'Not found' });
        if (parentId != null) {
            const p = (await client.query(`SELECT type_code FROM gl_dimension_value WHERE id = $1`, [parentId])).rows[0];
            if (!p) return res.status(400).json({ error: 'ไม่พบค่าระดับบนปลายทาง' });
            if (p.type_code !== v.type_code) return res.status(400).json({ error: 'ย้ายได้เฉพาะภายในประเภทมิติเดียวกัน' });
            if ((await valueSubtree(client, id)).includes(parentId)) return res.status(400).json({ error: 'ย้ายไปอยู่ใต้ค่าย่อยของตัวเองไม่ได้' });
        }
        await client.query(`UPDATE gl_dimension_value SET parent_id = $1, updated_by = $2, updated_at = NOW() WHERE id = $3`,
            [parentId, req.headers.username || null, id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('gl_dimension_value move:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { SLOTS, slotOf, fetchTypeUsage, fetchTypeSummary, fetchValueUsage, fetchValueSummary, moveValue };
