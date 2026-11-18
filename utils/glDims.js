// มิติของบรรทัดรายการบัญชี (user-approved 2026-11-02):
//   - มิติหัวเอกสารใช้กับทุกบรรทัดของรายการบัญชี
//   - บรรทัดรายการของเอกสาร (AR/AP/IM) เลือกบัญชีที่ใช้ลงบัญชีและมิติของบรรทัดเองได้ — มิติของบรรทัดที่ว่างใช้ของหัวเอกสาร (รายช่อง)
//   - บรรทัดรายการบัญชีที่ตั้ง row.dims ไว้ใช้มิตินั้น ไม่ตั้ง = มิติหัวเอกสาร
//   - ตรวจมิติที่บัญชีบังคับ (gl_account_dim_rule) ต่อบรรทัดรายการบัญชี
const { makeEnsureOnce } = require('./schemaOnce');

const SLOTS = [1, 2, 3, 4, 5];

// [dim1..dim5] ของหัวเอกสาร
const headerDims = (h) => SLOTS.map(i => Number(h?.[`dim${i}_id`]) || null);

// [dim1..dim5] ของบรรทัด: ช่องที่ว่างใช้ของหัวเอกสาร
const lineDims = (d, hDims) => SLOTS.map(i => Number(d?.[`dim${i}_id`]) || hDims[i - 1] || null);

// คอลัมน์ dim1_id..dim5_id ของตารางบรรทัด (+ คอลัมน์อื่นของบรรทัดที่ตารางนั้นต้องใช้) — ทีละตาราง
const ensurers = {};
const ensureDetailDimColumns = (db, table, extra = []) => {
    if (!ensurers[table]) {
        ensurers[table] = makeEnsureOnce([[table, 'dim1_id'], ...extra.map(([c]) => [table, c])], async (q) => {
            for (const i of SLOTS) await q.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS dim${i}_id INTEGER`);
            for (const [c, type] of extra) await q.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${c} ${type}`);
        });
    }
    return ensurers[table](db);
};

// ค่าพารามิเตอร์ dim1..dim5 ของบรรทัดสำหรับ INSERT
const detailDimParams = (d) => SLOTS.map(i => Number(d?.[`dim${i}_id`]) || null);

// ตรวจมิติที่บัญชีบังคับ — rows = บรรทัดรายการบัญชี { account_id, dims? }
const assertRequiredDims = async (client, rows, hDims) => {
    const ids = [...new Set(rows.map(r => Number(r.account_id)).filter(Boolean))];
    if (!ids.length) return;
    const rules = (await client.query(`
        SELECT r.account_id, r.type_code, t.slot_no, t.name_thai, a.account_code
          FROM gl_account_dim_rule r
          JOIN gl_dimension_type t ON t.type_code = r.type_code AND t.is_active = true
          JOIN gl_account a ON a.id = r.account_id
         WHERE r.is_required = true AND r.account_id = ANY($1::int[])`, [ids])).rows;
    if (!rules.length) return;
    const errors = new Set();
    for (const row of rows) {
        const dims = row.dims || hDims;
        for (const r of rules) {
            if (Number(r.account_id) !== Number(row.account_id)) continue;
            if (!dims[r.slot_no - 1]) errors.add(`บัญชี ${r.account_code}: ต้องระบุ${r.name_thai || r.type_code}`);
        }
    }
    if (errors.size) throw new Error(`Dimension ไม่ครบ:\n${[...errors].join('\n')}`);
};

// ตรวจสาขาที่บัญชีบังคับ (gl_account.branch_required, user-approved 2026-11-18)
// สาขาของบรรทัด = row.branch_id ถ้าว่างใช้ branchId ของหัวรายการ (วิธี 1: งานประมวลผลใส่สาขาที่บรรทัด)
// บังคับเฉพาะเมื่อบัญชีที่ลงรายการเปิด "ต้องระบุสาขา" — rows = บรรทัดรายการบัญชี { account_id }
const assertRequiredBranch = async (client, rows, branchId) => {
    if (Number(branchId)) return;
    const ids = [...new Set(rows.filter(r => !Number(r.branch_id)).map(r => Number(r.account_id)).filter(Boolean))];
    if (!ids.length) return;
    const codes = (await client.query(
        `SELECT account_code FROM gl_account WHERE branch_required = true AND id = ANY($1::int[]) ORDER BY account_code`, [ids])).rows;
    if (codes.length) throw new Error(`ต้องระบุสาขา: บัญชี ${codes.map(r => r.account_code).join(', ')} บังคับระบุสาขา`);
};

module.exports = { SLOTS, headerDims, lineDims, ensureDetailDimColumns, detailDimParams, assertRequiredDims, assertRequiredBranch };
