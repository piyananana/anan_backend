// controllers/sa/saModuleApproverController.js
//
// sa_module_approver ผูกกับ "เมนู" (menu_id) โดยตรง — คิวผู้อนุมัติ sync มาจากสิทธิ์ "อนุมัติ"
// (can_approve) ที่ให้ไว้ใน sa_user_menu อัตโนมัติ (ใช้โดย sa_module_approver_screen.dart
// และเป็นแหล่งข้อมูลผู้อนุมัติของ AP Payment Run / GL Period Close)
// ดูรายละเอียดการ sync ที่ utils/menuApproverSync.js
//
// หมายเหตุ: เดิมมีรูปแบบ module_code+doc_category (ผูกกับ sa_module_document แยกอิสระ, ใช้โดย
// sa_module_document_detail_widget.dart) แต่ไม่เคยมีการตรวจสิทธิ์จริงใช้งานคิวนั้น — ลบทิ้งแล้ว

const { ensureMenuApproverSchema, syncMenuApprovers } = require('../../utils/menuApproverSync');

// ── menu_id — ใช้โดย sa_module_approver_screen.dart ─────────────────────────────

// GET /sa_module_approver/by_menu/:menuId?doc_type=xx
// ซิงค์คิวผู้อนุมัติให้ตรงกับสิทธิ์ปัจจุบันก่อน แล้วคืนลำดับที่ตั้งไว้
// doc_type ไม่ระบุ = คิวระดับเมนู (ค่าเริ่มต้น); ระบุ = คิวเฉพาะประเภทเอกสารนั้น (สำหรับเมนูที่ uses_doc_type)
const fetchByMenu = async (req, res) => {
    const { menuId } = req.params;
    const docType = req.query.doc_type || null;
    const client = await req.dbPool.connect();
    try {
        await ensureMenuApproverSchema(client);
        await client.query('BEGIN');
        await syncMenuApprovers(client, menuId, docType);
        await client.query('COMMIT');

        const result = await client.query(`
            SELECT a.id, a.approval_level, a.approver_user_id, a.is_active, a.doc_type,
                   u.user_name  AS approver_username,
                   u.first_name AS approver_first_name,
                   u.last_name  AS approver_last_name,
                   u.email      AS approver_email
            FROM sa_module_approver a
            JOIN sa_user u ON u.id = a.approver_user_id
            WHERE a.menu_id = $1 AND a.doc_type IS NOT DISTINCT FROM $2
            ORDER BY a.approval_level`, [menuId, docType]);
        res.status(200).json(result.rows);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error fetching approvers by menu:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

// PUT /sa_module_approver/reorder  { menu_id, doc_type, items: [{approver_user_id, is_active}, ...] }
// ลำดับใน items[] คือลำดับการอนุมัติใหม่ (index 0 = ลำดับที่ 1); is_active ใช้ "งดอนุมัติ" คนนั้นชั่วคราว
// doc_type ไม่ระบุ = แก้ไขคิวระดับเมนู
const reorder = async (req, res) => {
    const { menu_id, items } = req.body;
    const docType = req.body.doc_type || null;
    if (!menu_id || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: 'ต้องระบุ menu_id และรายชื่อผู้อนุมัติ' });
    }
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        // เซ็ตเป็นค่าลบชั่วคราวก่อน เพื่อเลี่ยงชนกับ unique constraint (menu_id, doc_type, approval_level)
        // ระหว่างสลับลำดับ (เช่น สลับตำแหน่ง 1 กับ 2)
        for (let i = 0; i < items.length; i++) {
            await client.query(
                `UPDATE sa_module_approver SET approval_level = $1
                 WHERE menu_id=$2 AND doc_type IS NOT DISTINCT FROM $3 AND approver_user_id=$4`,
                [-(i + 1), menu_id, docType, items[i].approver_user_id]);
        }
        for (let i = 0; i < items.length; i++) {
            await client.query(
                `UPDATE sa_module_approver SET approval_level = $1, is_active = $2
                 WHERE menu_id=$3 AND doc_type IS NOT DISTINCT FROM $4 AND approver_user_id=$5`,
                [i + 1, items[i].is_active ?? true, menu_id, docType, items[i].approver_user_id]);
        }
        await client.query('COMMIT');
        res.status(200).json({ message: 'บันทึกลำดับผู้อนุมัติสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error reordering approvers:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

module.exports = {
    fetchByMenu, reorder,
};
