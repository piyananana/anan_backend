// utils/glJournalPreview.js
// แสดงรายการบัญชี (ก่อนโพสต์ / ที่โพสต์แล้ว) ให้หน้าจอธุรกรรม — ใช้รูปแบบเดียวกันทุกโมดูล:
//   { account_id, account_code, account_name_th, account_name_en, description, debit, credit, branch_id, branch_code }
// สาขา = สาขาของบรรทัด (งานประมวลผลที่แยกตามสาขาของเอกสารต้นทาง) ถ้าว่างใช้ของหัวรายการ
// บรรทัดก่อนโพสต์ต้องสร้างจากฟังก์ชันเดียวกับที่โพสต์จริง เพื่อให้ preview ตรงกับรายการบัญชีที่จะเกิด

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// เติมรหัส/ชื่อบัญชี (และรหัสสาขา) ให้บรรทัด { account_id, description, debit, credit, branch_id? }
const describeJournalLines = async (db, lines) => {
    const brIds = [...new Set(lines.map(l => Number(l.branch_id)).filter(Boolean))];
    const brById = new Map(brIds.length
        ? (await db.query(`SELECT id, branch_code FROM cd_branch WHERE id = ANY($1::int[])`, [brIds])).rows.map(b => [Number(b.id), b.branch_code])
        : []);
    const ids = [...new Set(lines.map(l => Number(l.account_id)).filter(Boolean))];
    const accts = ids.length
        ? (await db.query(
            `SELECT id, account_code, account_name_thai, account_name_eng FROM gl_account WHERE id = ANY($1::int[])`, [ids])).rows
        : [];
    const byId = new Map(accts.map(a => [Number(a.id), a]));
    return lines.map(l => {
        const a = byId.get(Number(l.account_id)) || {};
        return {
            account_id:      l.account_id ? Number(l.account_id) : null,
            account_code:    a.account_code || '',
            account_name_th: a.account_name_thai || '',
            account_name_en: a.account_name_eng || '',
            description:     l.description || '',
            debit:           round2(l.debit),
            credit:          round2(l.credit),
            branch_id:       Number(l.branch_id) || null,
            branch_code:     brById.get(Number(l.branch_id)) || '',
        };
    });
};

// รายการบัญชีที่โพสต์แล้ว (บรรทัดตามลำดับ line_no)
const fetchPostedJournalLines = async (db, glEntryId) => {
    if (!glEntryId) return [];
    const r = await db.query(`
        SELECT d.account_id, d.description, d.debit_lc AS debit, d.credit_lc AS credit,
               COALESCE(d.branch_id, h.branch_id) AS branch_id
          FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
         WHERE d.header_id = $1 ORDER BY d.line_no`, [glEntryId]);
    return describeJournalLines(db, r.rows);
};

module.exports = { describeJournalLines, fetchPostedJournalLines };
