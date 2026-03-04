// controllers/sa/saUserMenuController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้
// const pool = require('../../config/db');

// // API เพื่อดึงรายการเมนูทั้งหมด (สำหรับสร้าง Tree View) เพื่อใช้ edit เมนูของผู้ใช้
// // ไม่ต้องใช้ verifyToken เพราะเป็น public view
// const getAllUserMenu = async (req, res) => {
//     try {
//         const result = await req.dbPool.query('SELECT * FROM sa_menu WHERE is_active = TRUE ORDER BY parent_id ASC, sort_order ASC');
//         res.json(result.rows);
//     } catch (err) {
//         console.error('Error fetching sa_menu:', err);
//         res.status(500).json({ error: 'Internal server error' });
//     }
// };

// // API เพื่อดึงข้อมูลเมนูของผู้ใช้ตาม ID สำหรับ View
// // ไม่ต้องใช้ verifyToken เพราะเป็น public view
// const getMenuByUserId = async (req, res) => {
//     const { userId } = req.params;
//     try {
//         const result = await req.dbPool.query(
//             'SELECT m.* FROM sa_menu m INNER JOIN sa_user_menu um ON m.id = um.menu_id WHERE um.user_id = $1 AND m.is_active = TRUE ORDER BY m.parent_id ASC, m.sort_order ASC',
//             [userId]
//         );
//         if (result.rows.length > 0) {
//             res.json(result.rows);
//         } else {
//             res.status(404).json({ message: 'User menu not found' });
//         }
//     } catch (err) {
//         console.error('Error fetching User menu ${userId}:', err);
//         res.status(500).json({ error: 'Internal server error' });
//     }
// };

// *** API สำหรับ CRUD เมนู (ต้องการ authentication) ***

// API สำหรับเพิ่มเมนูใหม่
const updateUserMenu = async (req, res) => {
    const { menuIds } = req.body;
    const userId = parseInt(req.params.userId);

    if (isNaN(userId)) {
        return res.status(400).json({ message: 'Invalid User ID' });
    }
    if (!Array.isArray(menuIds) || !menuIds.every(id => typeof id === 'number')) {
        console.error('Validation Error: Invalid menuIds array received:', menuIds); // <-- เพิ่ม logging ตรงนี้
        return res.status(400).json({ message: 'Invalid menuIds array provided' });
    }

    try {
        await req.dbPool.query('BEGIN');

        // ขั้นตอนที่ 1: ลบสิทธิ์เก่าทั้งหมดของผู้ใช้คนนี้
        await req.dbPool.query(
            'DELETE FROM sa_user_menu WHERE user_id = $1',
            [userId]
        );

        // ขั้นตอนที่ 2: เพิ่มสิทธิ์ใหม่ทั้งหมด
        if (menuIds.length > 0) {
            let valuePlaceholders = [];
            let queryParamsForInsert = [userId]; // userId คือ parameter ตัวแรก ($1)
            for (let i = 0; i < menuIds.length; i++) {
                // สร้าง placeholder สำหรับแต่ละคู่ (user_id, menu_id)
                // user_id จะเป็น $1 เสมอ
                // menu_id จะเป็น $2, $3, $4, ... ตามลำดับของ menuIds
                valuePlaceholders.push('($1, $' + (i + 2).toString() + ')');
                queryParamsForInsert.push(menuIds[i]); // เพิ่ม menu_id เข้าไปใน queryParams
            }
            const insertQuery = 'INSERT INTO sa_user_menu (user_id, menu_id) VALUES ' + valuePlaceholders.join(', ');
            await req.dbPool.query(insertQuery, queryParamsForInsert);
            // console.error('insert value: ', insertQuery, queryParamsForInsert);
        }

        await req.dbPool.query('COMMIT'); // Commit Transaction

        // ต้องมั่นใจว่าส่ง Status 200 และมี body ที่เหมาะสม
        return res.status(200).json({ message: 'User menu updated successfully' });

    } catch (error) {
        await req.dbPool.query('ROLLBACK');
        console.error('Error updating user menu:', error);
        // ต้องส่ง Status 500 กลับไปเมื่อเกิดข้อผิดพลาด
        return res.status(500).json({ message: 'Failed to update user menu', error: error.message });
    }
};

const deleteUserMenu = async (req, res) => {
    const { userId } = req.params;
    try {
        await req.dbPool.query('BEGIN');
        const result = await req.dbPool.query('DELETE FROM sa_user_menu WHERE user_id = $1 RETURNING *', [userId]);

        if (result.rows.length === 0) {
            await req.dbPool.query('ROLLBACK');
            return res.status(404).json({ message: 'User menu not found.' });
        }
        await req.dbPool.query('COMMIT'); // Commit Transaction
        res.status(204).send(); // No Content
    } catch (err) {
        console.error('Error deleting user menu:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    // getAllUserMenu,
    // getUserMenuById,
    updateUserMenu,
    deleteUserMenu
};