// controllers/sa/saGroupMenuController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้

// // API เพื่อดึงรายการทั้งหมด (สำหรับสร้าง Tree View) เพื่อใช้ edit
// // ไม่ต้องใช้ verifyToken เพราะเป็น public view
// const getAllGroupMenu = async (req, res) => {
//     try {
//         const result = await pool.query('SELECT * FROM sa_menu WHERE is_active = TRUE ORDER BY parent_id ASC, sort_order ASC');
//         res.json(result.rows);
//     } catch (err) {
//         console.error('Error fetching sa_menu:', err);
//         res.status(500).json({ error: 'Internal server error' });
//     }
// };

// // API เพื่อดึงข้อมูลเมนูของกลุ่มตาม ID สำหรับ View
// // ไม่ต้องใช้ verifyToken เพราะเป็น public view
// const getGroupMenuById = async (req, res) => {
//     const groupId = req.params.groupId;
//     // console.log('Received groupId:', groupId);
//     try {
//         // ดึงข้อมูลเมนูของกลุ่มจากฐานข้อมูล
//         const result = await pool.query(
//             // 'SELECT m.menu_name, m.menu_type, m.target_path, m.sort_order FROM sa_menu m INNER JOIN sa_users_menus um ON m.id = um.menu_id WHERE um.user_id = $1',
//             'SELECT m.* FROM sa_menu m INNER JOIN sa_group_menu gm ON m.id = gm.menu_id WHERE gm.group_id = $1 AND m.is_active = TRUE ORDER BY m.parent_id ASC, m.sort_order ASC',
//             [groupId]
//         );
//         if (result.rows.length > 0) {
//             res.json(result.rows);
//         } else {
//             res.status(404).json({ message: 'Group menu not found' });
//         }
//     } catch (err) {
//         console.error('Error fetching group menu ${groupId}:', err);
//         res.status(500).json({ error: 'Internal server error' });
//     }
// };

// *** API สำหรับ CRUD เมนู (ต้องการ authentication) ***

// API สำหรับเพิ่มเมนูใหม่
const updateGroupMenu = async (req, res) => {
    const { menuIds } = req.body;
    const groupId = req.params.groupId;

    // if (isNaN(groupId)) {
    //     return res.status(400).json({ message: 'Invalid Group ID' });
    // }
    if (!Array.isArray(menuIds) || !menuIds.every(id => typeof id === 'number')) {
        console.error('Validation Error: Invalid menuIds array received:', menuIds); // <-- เพิ่ม logging ตรงนี้
        return res.status(400).json({ message: 'Invalid menuIds array provided' });
    }

    try {
        await req.dbPool.query('BEGIN');

        // ขั้นตอนที่ 1: ลบสิทธิ์เก่าทั้งหมดของกลุ่มนี้
        await req.dbPool.query(
            'DELETE FROM sa_group_menu WHERE group_id = $1',
            [groupId]
        );

        // ขั้นตอนที่ 2: เพิ่มสิทธิ์ใหม่ทั้งหมด
        if (menuIds.length > 0) {
            let valuePlaceholders = [];
            let queryParamsForInsert = [groupId]; // groupId คือ parameter ตัวแรก ($1)
            for (let i = 0; i < menuIds.length; i++) {
                // สร้าง placeholder สำหรับแต่ละคู่ (user_id, menu_id)
                // user_id จะเป็น $1 เสมอ
                // menu_id จะเป็น $2, $3, $4, ... ตามลำดับของ menuIds
                valuePlaceholders.push('($1, $' + (i + 2).toString() + ')');
                queryParamsForInsert.push(menuIds[i]); // เพิ่ม menu_id เข้าไปใน queryParams
            }
            const insertQuery = 'INSERT INTO sa_group_menu (group_id, menu_id) VALUES ' + valuePlaceholders.join(', ');
            await req.dbPool.query(insertQuery, queryParamsForInsert);
        }

        await req.dbPool.query('COMMIT'); // Commit Transaction
        // ต้องมั่นใจว่าส่ง Status 200 และมี body ที่เหมาะสม
        return res.status(200).json({ message: 'Group menu updated successfully' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating group menu:', error);
        // ต้องส่ง Status 500 กลับไปเมื่อเกิดข้อผิดพลาด
        return res.status(500).json({ message: 'Failed to update group menu', error: error.message });
    }
};

const deleteGroupMenu = async (req, res) => {
    const { groupId } = req.params;
    try {
        await req.dbPool.query('BEGIN');
        const result = await req.dbPool.query('DELETE FROM sa_group_menu WHERE group_id = $1 RETURNING *', [groupId]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Group menu not found.' });
        }
        await req.dbPool.query('COMMIT'); // Commit Transaction
        res.status(204).send(); // No Content
    } catch (err) {
        console.error('Error deleting Group menu:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    // getAllGroupMenu,
    // getGroupMenuById,
    updateGroupMenu,
    deleteGroupMenu
};