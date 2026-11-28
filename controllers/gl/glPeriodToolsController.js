// controllers/gl/glPeriodToolsController.js
// เครื่องมือของหน้าจอปีบัญชีและงวดบัญชีแบบใหม่ (user 2026-11-28, IM design B):
//   - GET  /gl_fiscal_year/:id/summary   เอกสาร Draft ต่องวดต่อโมดูล (GL/AR/AP/IM/CM), รายการเอกสารค้างในงวดที่ยังไม่ปิด
//                                        (ตามประเภทเอกสาร), มีรายการลงบัญชีในปีแล้วหรือไม่, สถานะปิดบัญชีสิ้นปี
//   - POST /gl_fiscal_year/next          สร้างปีบัญชีถัดจากปีล่าสุด — โครงงวดเดิมทุกงวด (รวมงวดพิเศษ เช่น ยอดยกมา/ปิดสิ้นปี)
//                                        เลื่อนวันที่ไปตามความยาวปี, ชื่องวดเดิม, สถานะตั้งต้นของตาราง
'use strict';

const { addDays } = require('../../utils/dateUtil');

const MODULES = [
    // โมดูล, ตาราง, คอลัมน์สถานะงวดที่ใช้ตัดสินว่างวด "ยังไม่ปิด"
    ['GL', 'gl_entry_header', 'gl_status'],
    ['AR', 'ar_transaction', 'ar_status'],
    ['AP', 'ap_transaction', 'ap_status'],
    ['IM', 'im_transaction', 'im_status'],
    ['CM', 'cm_transaction', 'cm_status'],
];

const tableExists = async (client, name) =>
    !!(await client.query(`SELECT to_regclass($1) AS t`, [`public.${name}`])).rows[0].t;

// GET /gl_fiscal_year/:id/summary
const fetchYearSummary = async (req, res) => {
    const fyId = Number(req.params.id) || 0;
    const client = await req.dbPool.connect();
    try {
        const periods = (await client.query(`SELECT * FROM gl_posting_period WHERE fiscal_year_id = $1 ORDER BY period_number`, [fyId])).rows;
        const ids = periods.map(p => p.id);
        const draft = {}; // period_id → { GL: n, ... }
        const pending = [];
        for (const [mod, table, statusCol] of MODULES) {
            if (!(await tableExists(client, table))) continue;
            const r = await client.query(`
                SELECT t.period_id, d.doc_code, d.doc_name_thai, d.doc_name_eng, COUNT(*)::int AS n
                  FROM ${table} t LEFT JOIN sa_module_document d ON d.id = t.doc_id
                 WHERE t.status = 'Draft' AND t.period_id = ANY($1::int[])
                 GROUP BY t.period_id, d.doc_code, d.doc_name_thai, d.doc_name_eng`, [ids]);
            for (const x of r.rows) {
                (draft[x.period_id] ||= {})[mod] = ((draft[x.period_id] || {})[mod] || 0) + x.n;
                const p = periods.find(pp => pp.id === x.period_id);
                if (p && (p[statusCol] || 'OPEN') !== 'CLOSED') {
                    pending.push({ module: mod, period_id: x.period_id, period_number: p.period_number, period_name: p.period_name,
                        doc_code: x.doc_code, doc_name_thai: x.doc_name_thai, doc_name_eng: x.doc_name_eng, count: x.n });
                }
            }
        }
        pending.sort((a, b) => a.period_number - b.period_number || a.module.localeCompare(b.module) || String(a.doc_code).localeCompare(String(b.doc_code)));
        const hasPostings = ids.length > 0 && (await client.query(
            `SELECT EXISTS (SELECT 1 FROM gl_entry_header WHERE period_id = ANY($1::int[])) AS x`, [ids])).rows[0].x;
        let yearEnd = null;
        if (await tableExists(client, 'gl_year_end_closing')) {
            yearEnd = (await client.query(`SELECT status, updated_at FROM gl_year_end_closing WHERE fiscal_year_id = $1 ORDER BY id DESC LIMIT 1`, [fyId])).rows[0] || null;
        }
        res.json({
            draft: Object.entries(draft).map(([period_id, m]) => ({ period_id: Number(period_id), ...m })),
            pending,
            has_postings: hasPostings,
            year_end: yearEnd,
        });
    } catch (err) {
        console.error('gl_fiscal_year summary:', err);
        res.status(500).json({ message: err.message });
    } finally {
        client.release();
    }
};

// ── วันที่ (yyyy-mm-dd) ──
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
const shiftMonths = (ymdStr, months) => {
    const [y, m, d] = ymdStr.split('-').map(Number);
    const isLast = d === lastDay(y, m);
    const t = y * 12 + (m - 1) + months;
    const ny = Math.floor(t / 12), nm = (t % 12) + 1;
    const nd = isLast ? lastDay(ny, nm) : Math.min(d, lastDay(ny, nm));
    return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
};
const monthsBetween = (a, b) => { // จำนวนเดือนจาก a ถึง b (ใช้กับวันเริ่มปี)
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return (by - ay) * 12 + (bm - am);
};

// POST /gl_fiscal_year/next
const createNextYear = async (req, res) => {
    const userId = Number(req.headers.userid) || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const last = (await client.query(`
            SELECT id, fy_code, description, year_start_date::text AS s, year_end_date::text AS e, num_of_periods
              FROM gl_fiscal_year ORDER BY year_end_date DESC LIMIT 1`)).rows[0];
        if (!last) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ยังไม่มีปีบัญชี กรุณาสร้างปีแรกเอง' });
        }
        if (!/^\d+$/.test(last.fy_code)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `รหัสปีล่าสุด "${last.fy_code}" ไม่ใช่ตัวเลข กรุณาสร้างปีบัญชีถัดไปเอง` });
        }
        const code = String(Number(last.fy_code) + 1);
        const start = addDays(last.e, 1);
        const months = monthsBetween(last.s, start) || 12;
        const end = addDays(shiftMonths(addDays(last.e, 1), months), -1);
        const desc = last.description && last.description.includes(last.fy_code)
            ? last.description.split(last.fy_code).join(code)
            : `ปีบัญชี ${code}`;
        const fy = (await client.query(`
            INSERT INTO gl_fiscal_year (fy_code, description, year_start_date, year_end_date, num_of_periods, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id, fy_code`, [code, desc, start, end, last.num_of_periods, userId])).rows[0];
        const periods = (await client.query(`
            SELECT period_number, period_name, period_start_date::date::text AS s, period_end_date::date::text AS e
              FROM gl_posting_period WHERE fiscal_year_id = $1 ORDER BY period_number`, [last.id])).rows;
        for (const p of periods) {
            await client.query(`
                INSERT INTO gl_posting_period (fiscal_year_id, period_number, period_name, period_start_date, period_end_date, updated_by)
                VALUES ($1, $2, $3, $4, $5, $6)`, [fy.id, p.period_number, p.period_name, shiftMonths(p.s, months), shiftMonths(p.e, months), userId]);
        }
        await client.query('COMMIT');
        res.status(201).json({ id: fy.id, fy_code: fy.fy_code, periods: periods.length, start_date: start, end_date: end });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return res.status(400).json({ message: 'มีปีบัญชีรหัสนี้อยู่แล้ว' });
        console.error('gl_fiscal_year next:', err);
        res.status(500).json({ message: err.message });
    } finally {
        client.release();
    }
};

module.exports = { fetchYearSummary, createNextYear, shiftMonths };
