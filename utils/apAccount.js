// utils/apAccount.js
// บัญชีเจ้าหนี้ของเอกสาร AP — ใช้ร่วมทุกจุดที่ลงบัญชีเจ้าหนี้ (AP เอง, payment run, bulk payment, IM ที่สร้างเอกสาร AP อัตโนมัติ)
// ลำดับ (user-mandated 2026-10-29, มิเรอร์ utils/arAccount.js): เจ้าหนี้ > กลุ่มเจ้าหนี้ > ประเภทเอกสาร (ap_gl_account_setup)
// เอกสารที่โพสต์แล้วเก็บบัญชีที่ใช้จริงไว้ที่ ap_transaction.ap_account_id

const resolveApAccountId = async (client, { vendorId, docId }) => {
    if (vendorId) {
        const r = await client.query(`
            SELECT v.ap_account_id, g.ap_account_id AS group_ap_account_id
              FROM ap_vendor v LEFT JOIN ap_vendor_group g ON g.id = v.vendor_group_id
             WHERE v.id = $1`, [vendorId]);
        const row = r.rows[0];
        if (row?.ap_account_id) return Number(row.ap_account_id);
        if (row?.group_ap_account_id) return Number(row.group_ap_account_id);
    }
    if (docId) {
        const r = await client.query(`
            SELECT s.ap_account_id FROM ap_gl_account_setup s
              JOIN sa_module_document d ON d.doc_code = s.doc_code
             WHERE d.id = $1 LIMIT 1`, [docId]);
        if (r.rows[0]?.ap_account_id) return Number(r.rows[0].ap_account_id);
    }
    return null;
};

// นิพจน์ SQL ของบัญชีเจ้าหนี้ที่เอกสารโพสต์แล้วลงไว้ (t = ap_transaction) — ใช้ใน SELECT รายการเอกสารค้างจ่าย
// เอกสารเก่าก่อน 2026-10-29 ที่ไม่ได้เก็บบัญชีไว้ ใช้ลำดับเดิมตอนโพสต์ (ประเภทเอกสาร > เจ้าหนี้)
const postedApAccountSql = (t = 't') => `COALESCE(${t}.ap_account_id,
    (SELECT s.ap_account_id FROM ap_gl_account_setup s JOIN sa_module_document sd ON sd.doc_code = s.doc_code WHERE sd.id = ${t}.doc_id LIMIT 1),
    (SELECT v.ap_account_id FROM ap_vendor v WHERE v.id = ${t}.vendor_id))`;

// บัญชีเจ้าหนี้ที่ใบตั้งหนี้ที่โพสต์แล้วลงไว้ — ใช้ล้างยอดตอนจ่ายชำระและปรับมูลค่า FX
const postedApAccountId = async (client, transactionId) => {
    const r = await client.query(`SELECT ${postedApAccountSql('t')} AS acc FROM ap_transaction t WHERE t.id = $1`, [transactionId]);
    return Number(r.rows[0]?.acc) || null;
};

module.exports = { resolveApAccountId, postedApAccountId, postedApAccountSql };
