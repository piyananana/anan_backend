// controllers/sa/saGroupUserController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้
// const pool = require('../../config/db');

// API เพื่อดึงข้อมูลเมนูของกลุ่มตาม ID สำหรับ View
// ไม่ต้องใช้ verifyToken เพราะเป็น public view
const typeRank = (t) => ({ developer: 4, administrator: 3, user: 2, guest: 1 }[t] ?? 0);

const getGroupUsers = async (req, res) => {
    const groupId = req.params.groupId;
    try {
        // หา type ของผู้ขอ เพื่อกรอง user_type ที่มี rank ≤ ตัวเอง
        const userId = req.headers['userid'];
        let requesterType = 'guest';
        if (userId) {
            const roleRes = await req.dbPool.query(
                'SELECT user_type FROM sa_user WHERE id = $1', [userId]
            );
            requesterType = roleRes.rows[0]?.user_type ?? 'guest';
        }
        const rank = typeRank(requesterType);
        const visibleTypes = ['developer', 'administrator', 'user', 'guest']
            .filter(t => typeRank(t) <= rank);
        const typePlaceholders = visibleTypes.map((_, i) => `$${i + 2}`).join(', ');

        const result = await req.dbPool.query(
            `SELECT u.*, CASE WHEN gu.group_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_member
             FROM sa_user u
             LEFT JOIN sa_group_user gu ON u.id = gu.user_id AND gu.group_id = $1
             WHERE u.status = 'active' AND u.user_type IN (${typePlaceholders})
             ORDER BY u.user_name`,
            [groupId, ...visibleTypes]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching group user:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// API เพื่อดึงข้อมูลเมนูของกลุ่มตาม ID สำหรับ View
// ไม่ต้องใช้ verifyToken เพราะเป็น public view
const getGroupOnlyUsers = async (req, res) => {
    const groupId = req.params.groupId;
    // console.log('Received groupId:', groupId);
    try {
        // ดึงข้อมูลเมนูของกลุ่มจากฐานข้อมูล
        const userId = req.headers['userid'];
        let requesterType = 'guest';
        if (userId) {
            const roleRes = await req.dbPool.query(
                'SELECT user_type FROM sa_user WHERE id = $1', [userId]
            );
            requesterType = roleRes.rows[0]?.user_type ?? 'guest';
        }
        const rank = typeRank(requesterType);
        const visibleTypes = ['developer', 'administrator', 'user', 'guest']
            .filter(t => typeRank(t) <= rank);
        const typePlaceholders = visibleTypes.map((_, i) => `$${i + 2}`).join(', ');

        const result = await req.dbPool.query(
            `SELECT u.*
             FROM sa_user u
             JOIN sa_group_user gu ON u.id = gu.user_id AND gu.group_id = $1
             WHERE u.status = 'active' AND u.user_type IN (${typePlaceholders})
             ORDER BY u.user_name`,
            [groupId, ...visibleTypes]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching group only users:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const createGroupUserByUserId = async (req, res) => {
    const { groupId, userId } = req.params;
    const client = await req.dbPool.connect();

    try {
        await client.query('BEGIN');

        // ขั้นตอนที่ 1: ลบสิทธิ์เก่าทั้งหมดของผู้ใช้คนนี้ ==> ใช้ front end ลบก่อน
        // await deleteGroupUserByUserId(req, res); // Call to deleteGroupUserByUserId to ensure no duplicates

        // ขั้นตอนที่ 2: เพิ่มผู้ใช้ใหม่เข้าไปในกลุ่ม
        await client.query(
            'INSERT INTO sa_group_user (group_id, user_id) VALUES ($1, $2) ON CONFLICT (group_id, user_id) DO NOTHING',
            [groupId, userId]
        );

        // ขั้นตอนที่ 3: เพิ่มสิทธิ์เมนูของกลุ่มไปยังผู้ใช้ใหม่ (ไม่ลบเมนูที่มีอยู่แล้ว)
        await client.query(
            `INSERT INTO sa_user_menu (user_id, menu_id)
            SELECT $1, menu_id
            FROM sa_group_menu
            WHERE group_id = $2
            ON CONFLICT (user_id, menu_id) DO NOTHING`,
            [userId, groupId]
        );

        await client.query('COMMIT'); // Commit Transaction

        // ต้องมั่นใจว่าส่ง Status 200 และมี body ที่เหมาะสม
        return res.status(200).json({ message: 'Group user updated successfully' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating group user:', error);
        // ต้องส่ง Status 500 กลับไปเมื่อเกิดข้อผิดพลาด
        return res.status(500).json({ message: 'Failed to update group user', error: error.message });
    } finally {
        client.release();
    }
};

// // คัดลอกสิทธิ์จาก group_menus ไปที่ menu ของ user
// const copyGroupMenuToUser = async (req, res) => {
//     const { groupId, userId } = req.params;
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // 1. ลบสิทธิ์เมนูเดิมของ user ออกก่อน
//       await client.query(
//         `DELETE FROM sa_user_menu WHERE user_id = $1`,
//         [userId]
//       );

//       // 2. คัดลอกสิทธิ์จาก group_menus ไปยัง user menus
//       await client.query(
//         `INSERT INTO sa_user_menu (user_id, menu_id)
//          SELECT $1, menu_id
//          FROM sa_group_menu
//          WHERE group_id = $2`,
//         [userId, groupId]
//       );

//       await client.query('COMMIT');
//       return true;
//     } catch (e) {
//       await client.query('ROLLBACK');
//       throw e;
//     } finally {
//       client.release();
//     }
//   };

// const updateGroupUser = async (req, res) => {
//     const { userIds } = req.body;
//     const groupId = req.params.groupId;

//     // console.log('Received groupId:', groupId);
//     // console.log('Received menuIds:', menuIds);
//     // if (isNaN(groupId)) {
//     //     return res.status(400).json({ message: 'Invalid Group ID' });
//     // }
//     if (!Array.isArray(userIds) || !userIds.every(id => typeof id === 'number')) {
//         console.error('Validation Error: Invalid userIds array received:', userIds); // <-- เพิ่ม logging ตรงนี้
//         return res.status(400).json({ message: 'Invalid userIds array provided' });
//     }

//     const client = await pool.connect();

//     try {
//         await client.query('BEGIN');

//         // ขั้นตอนที่ 1: ลบสิทธิ์เก่าทั้งหมดของผู้ใช้คนนี้
//         await client.query(
//             'DELETE FROM sa_group_user WHERE group_id = $1',
//             [groupId]
//         );

//         // ขั้นตอนที่ 2: เพิ่มสิทธิ์ใหม่ทั้งหมด
//         if (userIds.length > 0) {
//             let valuePlaceholders = [];
//             let queryParamsForInsert = [groupId]; // groupId คือ parameter ตัวแรก ($1)
//             for (let i = 0; i < userIds.length; i++) {
//                 // สร้าง placeholder สำหรับแต่ละคู่ (user_id, menu_id)
//                 // user_id จะเป็น $1 เสมอ
//                 // menu_id จะเป็น $2, $3, $4, ... ตามลำดับของ menuIds
//                 valuePlaceholders.push('($1, $' + (i + 2).toString() + ')');
//                 queryParamsForInsert.push(userIds[i]); // เพิ่ม user_id เข้าไปใน queryParams
//             }
//             const insertQuery = 'INSERT INTO sa_group_user (group_id, user_id) VALUES ' + valuePlaceholders.join(', ');
//             // console.log('INSERT INTO sa_group_user (group_id, user_id) VALUES ' + valuePlaceholders.join(', '));
//             await client.query(insertQuery, queryParamsForInsert);
//             // console.error('insert value: ', insertQuery, queryParamsForInsert);
//         }

//         await client.query('COMMIT'); // Commit Transaction

//         // VVVV ตรวจสอบบรรทัดนี้ VVVV
//         // ต้องมั่นใจว่าส่ง Status 200 และมี body ที่เหมาะสม
//         return res.status(200).json({ message: 'Group user updated successfully' });
//         // ^^^^ ตรวจสอบบรรทัดนี้ ^^^^

//     } catch (error) {
//         await client.query('ROLLBACK');
//         console.error('Error updating group user:', error);
//         // VVVV ตรวจสอบบรรทัดนี้เช่นกัน VVVV
//         // ต้องส่ง Status 500 กลับไปเมื่อเกิดข้อผิดพลาด
//         return res.status(500).json({ message: 'Failed to update group user', error: error.message });
//         // ^^^^ ตรวจสอบบรรทัดนี้เช่นกัน ^^^^
//     } finally {
//         client.release();
//     }
// };

const deleteGroupUsers = async (req, res) => {
    const { groupId } = req.params;
    const client = await req.dbPool.connect(); // ใช้ transaction เพื่อความปลอดภัย
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM sa_group_user WHERE group_id = $1 RETURNING *', [groupId]);
        await client.query('COMMIT');
        return res.status(200).json({ message: 'All user in group deleted successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
        // console.error('Error deleting Group user:', err);
        // res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

const deleteGroupUserByUserId = async (req, res) => {
    const { groupId, userId } = req.params;
    try {
        await req.dbPool.query(
            'DELETE FROM sa_group_user WHERE group_id = $1 AND user_id = $2',
            [groupId, userId]
        );
        return res.status(200).json({ message: 'Group user deleted successfully' });
    } catch (err) {
        console.error('Error deleting group user:', err);
        return res.status(500).json({ message: 'Failed to delete group user', error: err.message });
    }
};

module.exports = {
    // getAllGroupMenu,
    getGroupUsers,
    getGroupOnlyUsers,
    createGroupUserByUserId,
    // getGroupUserById,
    // copyGroupMenuToUser,
    // updateGroupUser,
    deleteGroupUsers,
    deleteGroupUserByUserId,
};