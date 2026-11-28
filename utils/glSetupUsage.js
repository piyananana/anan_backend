// utils/glSetupUsage.js
// ข้อมูลประกอบหน้าตั้งค่าบัญชีของประเภทเอกสาร (redesign แบบ IM 2026-11-26) — ใช้ร่วม AR / AP / CM / MO
// GET /<module>_gl_account_setup/:doc_code/summary → { usage: { total, by_status, last_doc } }
//   นับเอกสารของประเภทเอกสารนี้ตามสถานะ + เอกสารล่าสุด (ตารางเอกสารผูก sa_module_document ด้วย doc_id)
'use strict';

const makeUsageSummary = (table, label) => async (req, res) => {
    const { doc_code } = req.params;
    const client = await req.dbPool.connect();
    try {
        const usage = { total: 0, by_status: {}, last_doc: null };
        const cols = (await client.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table])).rows.map((r) => r.column_name);
        if (cols.includes('doc_id')) {
            const hasStatus = cols.includes('status');
            const docIds = `(SELECT id FROM sa_module_document WHERE doc_code = $1 AND is_doc_type = true)`;
            if (hasStatus) {
                const r = await client.query(
                    `SELECT status, COUNT(*)::int AS n FROM ${table} WHERE doc_id IN ${docIds} GROUP BY status`, [doc_code]);
                for (const x of r.rows) { usage.by_status[x.status || '-'] = x.n; usage.total += x.n; }
            } else {
                usage.total = (await client.query(
                    `SELECT COUNT(*)::int AS n FROM ${table} WHERE doc_id IN ${docIds}`, [doc_code])).rows[0].n;
            }
            const l = await client.query(`
                SELECT doc_no, doc_date::text AS doc_date${hasStatus ? ', status' : ''} FROM ${table}
                 WHERE doc_id IN ${docIds} ORDER BY doc_date DESC, id DESC LIMIT 1`, [doc_code]);
            usage.last_doc = l.rows[0] || null;
        }
        res.status(200).json({ usage });
    } catch (error) {
        console.error(`Error fetching ${label} summary:`, error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { makeUsageSummary };
