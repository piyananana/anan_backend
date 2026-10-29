// utils/glJournalPreview.js
// แสดงรายการบัญชี (ก่อนโพสต์ / ที่โพสต์แล้ว) ให้หน้าจอธุรกรรม — ใช้รูปแบบเดียวกันทุกโมดูล:
//   { account_id, account_code, account_name_th, account_name_en, description, debit, credit }
// บรรทัดก่อนโพสต์ต้องสร้างจากฟังก์ชันเดียวกับที่โพสต์จริง เพื่อให้ preview ตรงกับรายการบัญชีที่จะเกิด

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// เติมรหัส/ชื่อบัญชีให้บรรทัด { account_id, description, debit, credit }
const describeJournalLines = async (db, lines) => {
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
        };
    });
};

// รายการบัญชีที่โพสต์แล้ว (บรรทัดตามลำดับ line_no)
const fetchPostedJournalLines = async (db, glEntryId) => {
    if (!glEntryId) return [];
    const r = await db.query(`
        SELECT d.account_id, d.description, d.debit_lc AS debit, d.credit_lc AS credit
          FROM gl_entry_detail d WHERE d.header_id = $1 ORDER BY d.line_no`, [glEntryId]);
    return describeJournalLines(db, r.rows);
};

module.exports = { describeJournalLines, fetchPostedJournalLines };
