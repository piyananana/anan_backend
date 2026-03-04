// controllers/sa/saUserController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้
const bcrypt = require('bcryptjs');

// ฟังก์ชันสำหรับเข้ารหัสรหัสผ่าน
const hashPassword = async (password) => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};

// API เพื่อดึงรายการผู้ใช้ทั้งหมด
// ไม่ต้องใช้ verifyToken เพราะเป็น public view
const getAllUser = async (req, res) => {
    try {
        const result = await req.dbPool.query('SELECT * FROM sa_user ORDER BY user_name ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching sa_user:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// *** API สำหรับ CRUD ผู้ใช้ (ต้องการ authentication) ***

// API สำหรับเพิ่มผู้ใช้ใหม่
const createUser = async (req, res) => {
    const { userName, password, first_name, last_name, user_type, status, email } = req.body;
    // console.error('Creating user with data:', req.body);
    try {
        const passwordHash = await hashPassword(password);
        const result = await req.dbPool.query(
            `INSERT INTO sa_user (user_name, password_hash, first_name, last_name, user_type, status, email)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [userName, passwordHash, first_name, last_name, user_type, status, email]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error adding user:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// // API สำหรับแก้ไขรหัสผ่านผู้ใช้
// const changePassword = async (req, res) => {
//     // const { id } = req.params;
//     const { id, currentPassword, newPassword } = req.body;
//     // console.error('Updating user with ID:', id, 'with data:', req.body);
//     try {
//         // ตรวจสอบว่าผู้ใช้มีอยู่ในฐานข้อมูล
//         const userResult = await req.dbPool.query('SELECT * FROM sa_user WHERE id = $1 AND status = \'active\'', [id]);
//         if (userResult.rows.length === 0) {
//             return res.status(401).json({ message: 'ไม่พบชื่อผู้ใช้ id = $1'}, [id]);
//         }
//         // ตรวจสอบรหัสผ่านปัจจุบัน
//         const user = userResult.rows[0];
//         const isPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);
//         if (!isPasswordValid) {
//             return res.status(401).json({ message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
//         }
//         if (currentPassword) {
//             const passwordHash = await hashPassword(newPassword);
//             const result = await req.dbPool.query(
//                 'UPDATE sa_user SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
//                 [passwordHash, id]
//             );
//             res.json(result.rows[0]);
//         } else {
//             return res.status(400).json({ message: 'กรุณากรอกรหัสผ่านใหม่' });
//         }
//         // if (result.rows.length === 0) {
//         //     return res.status(404).json({ message: 'User not found.' });
//         // };
//         // res.json(result.rows[0]);
//     } catch (err) {
//         console.error('Error updating user:', err);
//         res.status(500).json({ error: 'Internal server error' });
//     }
// };

// API สำหรับแก้ไขผู้ใช้
const updateUser = async (req, res) => {
    const { id } = req.params;
    const { userName, password, first_name, last_name, user_type, status, email } = req.body;
    try {
        if (password) {
            const passwordHash = await hashPassword(password);
            const result = await req.dbPool.query(
                `UPDATE sa_user SET
                    user_name = $1,
                    password_hash = $2,
                    first_name = $3,
                    last_name = $4,
                    user_type = $5,
                    status = $6,
                    email = $7,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE id = $8 RETURNING *`,
                [userName, passwordHash, first_name, last_name, user_type, status, email, id]
            );
            res.json(result.rows[0]);
        } else {
            // ถ้าไม่เปลี่ยนรหัสผ่าน ให้ใช้รหัสเดิม
            const result = await req.dbPool.query(
                `UPDATE sa_user SET
                    user_name = $1,
                    first_name = $2,
                    last_name = $3,
                    user_type = $4,
                    status = $5,
                    email = $6,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE id = $7 RETURNING *`,
                [userName, first_name, last_name, user_type, status, email, id]
            );
            res.json(result.rows[0]);
        }
        // if (result.rows.length === 0) {
        //     return res.status(404).json({ message: 'User not found.' });
        // };
        // res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating user:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// API สำหรับลบผู้ใช้
const deleteUser = async (req, res) => {
    const { id } = req.params;
    try {
        await req.dbPool.query('BEGIN');
        const result = await req.dbPool.query('DELETE FROM sa_user WHERE id = $1 RETURNING *', [id]);

        if (result.rows.length === 0) {
            await req.dbPool.query('ROLLBACK');
            return res.status(404).json({ message: 'User not found.' });
        }
        res.status(204).send(); // No Content
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    hashPassword,
    getAllUser,
    createUser,
    // changePassword,
    updateUser,
    deleteUser
};