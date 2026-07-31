// utils/menuApproverSync.js
// sa_module_approver ผูกกับ menu_id (แทน module_code+doc_category เดิม)
// คิวผู้อนุมัติของแต่ละเมนู sync มาจากสิทธิ์ "อนุมัติ" (can_approve) ที่ให้ไว้ใน sa_user_menu โดยตรง —
// ใครถูกให้สิทธิ์ก็เข้าคิวอัตโนมัติ (ต่อท้ายลำดับ), ใครถูกถอนสิทธิ์ก็ถูกถอนออกจากคิวอัตโนมัติ
//
// เมนูที่ "ใช้ประเภทเอกสาร" (sa_menu.uses_doc_type) สามารถมีคิวผู้อนุมัติแยกต่อประเภทเอกสารได้
// (doc_type = รหัสประเภทเอกสาร เช่น '50'=ลดหนี้), โดย doc_type = NULL คือคิวระดับเมนู (ค่าเริ่มต้น
// สำหรับเมนูที่ไม่ได้ใช้ประเภทเอกสาร หรือประเภทเอกสารที่ยังไม่มีคิวเฉพาะ)
// ไม่ว่าจะระดับเมนูหรือระดับประเภทเอกสาร ผู้มีสิทธิ์เป็นผู้อนุมัติต้องมี can_approve=true บนเมนูนั้นเสมอ

const ensureMenuApproverSchema = async (pool) => {
    try {
        await pool.query(`ALTER TABLE sa_module_approver ADD COLUMN IF NOT EXISTS menu_id INTEGER REFERENCES sa_menu(id) ON DELETE CASCADE`);
    } catch (_) { /* ignore */ }
    try {
        await pool.query(`ALTER TABLE sa_module_approver ADD COLUMN IF NOT EXISTS doc_type VARCHAR(10)`);
    } catch (_) { /* ignore */ }
    try {
        await pool.query(`ALTER TABLE sa_module_approver DROP CONSTRAINT IF EXISTS sa_module_approver_module_code_doc_category_approval_level_key`);
    } catch (_) { /* ignore */ }
    try {
        await pool.query(`ALTER TABLE sa_module_approver ALTER COLUMN module_code DROP NOT NULL`);
    } catch (_) { /* ignore */ }
    try {
        await pool.query(`ALTER TABLE sa_module_approver ALTER COLUMN doc_category DROP NOT NULL`);
    } catch (_) { /* ignore */ }
    try {
        await pool.query(`DROP INDEX IF EXISTS sa_module_approver_menu_level_uq`);
    } catch (_) { /* ignore */ }
    try {
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS sa_module_approver_menu_doctype_level_uq
            ON sa_module_approver(menu_id, COALESCE(doc_type, ''), approval_level)`);
    } catch (_) { /* ignore */ }
};

// ซิงค์คิวผู้อนุมัติของ (menuId, docType) ให้ตรงกับ sa_user_menu.can_approve ปัจจุบัน
// docType = null คือคิวระดับเมนู (ค่าเริ่มต้น) — ต้องเรียกภายใน transaction (client ต้อง BEGIN ไว้แล้ว)
const syncMenuApprovers = async (client, menuId, docType = null) => {
    const eligible = await client.query(
        `SELECT um.user_id FROM sa_user_menu um WHERE um.menu_id = $1 AND um.can_approve = true`,
        [menuId]
    );
    const eligibleIds = new Set(eligible.rows.map(r => r.user_id));

    const existing = await client.query(
        `SELECT id, approver_user_id, approval_level FROM sa_module_approver
         WHERE menu_id = $1 AND doc_type IS NOT DISTINCT FROM $2`,
        [menuId, docType]
    );

    for (const row of existing.rows) {
        if (!eligibleIds.has(row.approver_user_id)) {
            await client.query(`DELETE FROM sa_module_approver WHERE id=$1`, [row.id]);
        }
    }

    const stillThere = existing.rows.filter(r => eligibleIds.has(r.approver_user_id));
    const existingIds = new Set(stillThere.map(r => r.approver_user_id));
    let maxLevel = stillThere.reduce((m, r) => Math.max(m, r.approval_level), 0);

    for (const userId of eligibleIds) {
        if (!existingIds.has(userId)) {
            maxLevel += 1;
            await client.query(
                `INSERT INTO sa_module_approver (menu_id, doc_type, approval_level, approver_user_id, is_active)
                 VALUES ($1,$2,$3,$4,true)`,
                [menuId, docType, maxLevel, userId]
            );
        }
    }
};

module.exports = { ensureMenuApproverSchema, syncMenuApprovers };
