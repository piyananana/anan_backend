// utils/finReportAccounts.js
// เลือกบัญชีของบรรทัดงบการเงินจากเงื่อนไขใน gl_fin_report_row_acct
// บัญชีอยู่ในบรรทัด = ตรงเงื่อนไข "รวม" อย่างน้อย 1 เงื่อนไข และไม่ตรงเงื่อนไข "ยกเว้น" ใดเลย

const SEL_TYPES = ['RANGE', 'UNDER_HEADER', 'ACCOUNT_TYPE'];
const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

// ดึงผังบัญชีที่ใช้เลือก (ทั้งหัวบัญชีและบัญชีลงรายการ)
const loadAccounts = async (client) => {
    const res = await client.query(
        `SELECT id, account_code, account_name_thai, account_name_eng, parent_id, account_type, is_normal_account, is_active
           FROM gl_account ORDER BY account_code`);
    return res.rows;
};

// ดัชนีผังบัญชี: รหัส → บัญชี, id → บัญชีลูก
const buildAccountIndex = (accounts) => {
    const byCode = new Map(accounts.map(a => [a.account_code, a]));
    const childrenById = new Map();
    for (const a of accounts) {
        if (a.parent_id == null) continue;
        if (!childrenById.has(a.parent_id)) childrenById.set(a.parent_id, []);
        childrenById.get(a.parent_id).push(a);
    }
    return { accounts, byCode, childrenById };
};

// account_to รวมบัญชีลูกที่ขึ้นต้นด้วยรหัสนั้นด้วย (เช่น ถึง '1199' รวม '11991')
const inRange = (code, from, to) => code >= from && (code <= to || code.startsWith(to));

// บัญชีทั้งหมดใต้หัวบัญชี (ตาม parent_id) รวมตัวมันเอง
const descendantCodes = (index, headerCode) => {
    const out = new Set();
    const root = index.byCode.get(headerCode);
    if (!root) return out;
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
        const a = stack.pop();
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        out.add(a.account_code);
        for (const c of index.childrenById.get(a.id) || []) stack.push(c);
    }
    return out;
};

const matchSelection = (index, sel) => {
    if (sel.sel_type === 'UNDER_HEADER') return descendantCodes(index, sel.header_account_code);
    const out = new Set();
    for (const a of index.accounts) {
        if (sel.sel_type === 'ACCOUNT_TYPE' ? a.account_type === sel.account_type
            : inRange(a.account_code, sel.account_from, sel.account_to)) out.add(a.account_code);
    }
    return out;
};

// เงื่อนไขของบรรทัด — ถ้ายังไม่มีในตารางใหม่ ใช้ช่วงเดิม account_from/account_to ของบรรทัด
const rowSelections = (row, selections) => {
    if (selections && selections.length > 0) return selections;
    if (row.account_from && row.account_to) {
        return [{ sel_type: 'RANGE', is_exclude: false, account_from: row.account_from, account_to: row.account_to }];
    }
    return [];
};

// คืน Set ของรหัสบัญชีในบรรทัด หรือ null ถ้าบรรทัดไม่มีเงื่อนไข "รวม" เลย
const resolveRowAccounts = (index, selections) => {
    const includes = selections.filter(s => !s.is_exclude);
    if (includes.length === 0) return null;
    const out = new Set();
    for (const s of includes) for (const c of matchSelection(index, s)) out.add(c);
    for (const s of selections.filter(x => x.is_exclude)) for (const c of matchSelection(index, s)) out.delete(c);
    return out;
};

module.exports = { SEL_TYPES, ACCOUNT_TYPES, loadAccounts, buildAccountIndex, rowSelections, resolveRowAccounts };
