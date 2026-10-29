// utils/arAccount.js
// บัญชีลูกหนี้ของเอกสาร AR — ใช้ร่วมทุกจุดที่ลงบัญชีลูกหนี้ (AR เอง และ IM ที่สร้างเอกสาร AR อัตโนมัติ)
// ลำดับ (user-mandated 2026-10-29): ลูกค้า > กลุ่มลูกค้า > ประเภทเอกสาร (ar_gl_account_setup) — พบที่ใดก่อนใช้ที่นั้น
// เอกสารที่โพสต์แล้วเก็บบัญชีที่ใช้จริงไว้ที่ ar_transaction.ar_account_id

const resolveArAccountId = async (client, { customerId, docId }) => {
    if (customerId) {
        const r = await client.query(`
            SELECT c.ar_account_id, g.gl_account_id AS group_ar_account_id
              FROM ar_customer c LEFT JOIN ar_customer_group g ON g.id = c.customer_group_id
             WHERE c.id = $1`, [customerId]);
        const row = r.rows[0];
        if (row?.ar_account_id) return Number(row.ar_account_id);
        if (row?.group_ar_account_id) return Number(row.group_ar_account_id);
    }
    if (docId) {
        const r = await client.query(`
            SELECT s.ar_account_id FROM ar_gl_account_setup s
              JOIN sa_module_document d ON d.doc_code = s.doc_code
             WHERE d.id = $1 LIMIT 1`, [docId]);
        if (r.rows[0]?.ar_account_id) return Number(r.rows[0].ar_account_id);
    }
    return null;
};

// นิพจน์ SQL ของบัญชีลูกหนี้ที่เอกสารโพสต์แล้วลงไว้ (t = ar_transaction) — ใช้ใน SELECT รายการเอกสารค้างชำระ
// เอกสารเก่าก่อน 2026-10-29 ที่ไม่ได้เก็บบัญชีไว้ ใช้ลำดับเดิมตอนโพสต์ (ประเภทเอกสาร > กลุ่มลูกค้า > ลูกค้า)
const postedArAccountSql = (t = 't') => `COALESCE(${t}.ar_account_id,
    (SELECT s.ar_account_id FROM ar_gl_account_setup s JOIN sa_module_document sd ON sd.doc_code = s.doc_code WHERE sd.id = ${t}.doc_id LIMIT 1),
    (SELECT g.gl_account_id FROM ar_customer c JOIN ar_customer_group g ON g.id = c.customer_group_id WHERE c.id = ${t}.customer_id),
    (SELECT c.ar_account_id FROM ar_customer c WHERE c.id = ${t}.customer_id))`;

// บัญชีลูกหนี้ที่ใบแจ้งหนี้/ใบลดหนี้ที่โพสต์แล้วลงไว้ — ใช้ล้างยอดตอนรับชำระและปรับมูลค่า FX
const postedArAccountId = async (client, transactionId) => {
    const r = await client.query(`SELECT ${postedArAccountSql('t')} AS acc FROM ar_transaction t WHERE t.id = $1`, [transactionId]);
    return Number(r.rows[0]?.acc) || null;
};

module.exports = { resolveArAccountId, postedArAccountId, postedArAccountSql };
