// controllers/sa/saAuthController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PolicyController = require('../sa/saPasswordPolicyController');
const PasswordPolicyService = require('../../services/saPasswordPolicyService');

const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(403).json({ message: 'No token provided!' });
    }
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).json({ message: 'Unauthorized!' });
        }
        req.userId = decoded.id; // เก็บ userId ไว้ใน req object
        next();
    });
}

// ตรวจสอบและสร้างผู้ใช้คนแรกถ้ายังไม่มี
async function ensureFirstUserExists(req, res) {
    try {
        const countResult = await req.dbPool.query('SELECT COUNT(*) FROM sa_user');
        const userCount = parseInt(countResult.rows[0].count, 10);

        if (userCount === 0) {
            console.log('No user found. Creating the first administrator user...');
            const userName = 'anansoft';
            const password = 'anansoft'; // รหัสผ่านเริ่มต้น
            const hashedPassword = await bcrypt.hash(password, 10); // Hash รหัสผ่าน

            const insertQuery = `
                INSERT INTO sa_user (user_name, password_hash, first_name, last_name, user_type, status)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *;
            `;
            const values = [userName, hashedPassword, 'อนันต์ซอฟท์', 'บจก.', 'administrator', 'active'];
            await req.dbPool.query(insertQuery, values);
            console.log('First user "anansoft" created successfully.');
        }
    } catch (err) {
        console.error('Error ensuring first user exists:', err);
        // อาจจะโยน error หรือจัดการในรูปแบบอื่น ขึ้นอยู่กับความต้องการ
        throw new Error('Failed to ensure first user exists.');
    }
}
// API สำหรับ Login
// const login = async (req, res) => {
//     const { userName, password } = req.body;

//     try {
//         // ตรวจสอบและสร้างผู้ใช้คนแรกก่อนพยายาม Login
//         await ensureFirstUserExists();

//         const userResult = await req.dbPool.query('SELECT * FROM sa_user WHERE user_name = $1 AND status = \'active\'', [userName]);

//         if (userResult.rows.length === 0) {
//             return res.status(401).json({ message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
//         }

//         const user = userResult.rows[0];
//         const isPasswordValid = await bcrypt.compare(password, user.password_hash);

//         if (!isPasswordValid) {
//             return res.status(401).json({ message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
//         }

//         // สร้าง JWT Token
//         const token = jwt.sign(
//             { id: user.id, userName: user.userName, userType: user.user_type },
//             process.env.JWT_SECRET || 'your_super_secret_jwt_key',
//             { expiresIn: '1h' }
//         );

//         res.json({ token, user });
//     } catch (err) {
//         console.error('Login error:', err);
//         res.status(500).json({ message: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ' });
//     }
// }

const login = async (req, res) => {
    const { userName, password, databaseName } = req.body;
    console.log(`Login attempt for user: ${userName} in database: ${databaseName}`);

    if (!userName || !password || !databaseName) { 
        return res.status(400).json({ message: 'Username, password, and database name are required.' });
    }

    try {
        await ensureFirstUserExists(req, res);

        const userRes = await req.dbPool.query('SELECT * FROM sa_user WHERE user_name = $1 AND status = \'active\'', [userName]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const user = userRes.rows[0];
        const passwordIsValid = await PasswordPolicyService.comparePassword(password, user.password_hash);

        if (!passwordIsValid) {
            return res.status(401).json({ message: 'Invalid Password!' });
        }

        // Generate JWT Token
        const token = jwt.sign({ id: user.id, userName: user.userName }, process.env.JWT_SECRET, {
            expiresIn: 86400, // 24 hours
        });

        // ตรวจสอบ Password Policy สำหรับการแจ้งเตือนและการบังคับเปลี่ยน
        const policy = await PolicyController.getPolicy(req, res);
        let passwordStatus = {
            isPasswordExpired: false,
            daysUntilExpiration: null,
            forceChangePassword: false,
        };

        if (user.password_last_changed_at) {
            const lastChanged = new Date(user.password_last_changed_at);
            const expiryDate = new Date(lastChanged.getTime() + policy.password_expiry_days * 24 * 60 * 60 * 1000);
            const today = new Date();

            const daysDiff = Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

            if (daysDiff <= 0) { // รหัสผ่านหมดอายุแล้ว
                passwordStatus.isPasswordExpired = true;
                if (policy.force_password_change_on_expiry) {
                    passwordStatus.forceChangePassword = true;
                }
            } else if (daysDiff <= policy.password_notification_days) { // ใกล้หมดอายุ
                passwordStatus.daysUntilExpiration = daysDiff;
            }
        } else {
            // กรณีที่ password_last_changed_at เป็น NULL (ผู้ใช้ใหม่หรือยังไม่เคยเปลี่ยน)
            // อาจจะถือว่ารหัสผ่านหมดอายุและบังคับเปลี่ยนเลย หรือตั้งค่าเริ่มต้นให้
            passwordStatus.isPasswordExpired = true; // Assume expired to force initial change or set a default
            passwordStatus.forceChangePassword = true; // Force change for initial login
        }

        // const compRes = await req.dbPool.query('SELECT * FROM sa_company WHERE is_active = TRUE LIMIT 1');
        // if (compRes.rows.length === 0) {
        //     return res.status(404).json({ message: 'company not found.' });
        // }
        // company = compRes.rows[0];

        res.status(200).json({
            token: token,
            user: user,
            passwordStatus: passwordStatus, // ส่งสถานะรหัสผ่านไปที่ Frontend
            // company: company,
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
}

const changePassword = async (req, res) => {
    const { userId, oldPassword, newPassword, confirmNewPassword } = req.body;
    if (newPassword !== confirmNewPassword) {
        return res.status(400).json({ message: 'รหัสผ่านใหม่ไม่ตรงกับที่ยืนยัน' });
    }

    try {
        const userRes = await req.dbPool.query('SELECT password_hash FROM sa_user WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const user = userRes.rows[0];
        const oldPasswordIsValid = await PasswordPolicyService.comparePassword(oldPassword, user.password_hash);

        if (!oldPasswordIsValid) {
            return res.status(401).json({ message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
        }

        const policy = await PolicyController.getPolicy(req, res);

        // 1. ตรวจสอบความซับซ้อนของรหัสผ่านใหม่
        const complexityError = PasswordPolicyService.validatePasswordComplexity(newPassword, policy);
        if (complexityError) {
            return res.status(400).json({ message: complexityError });
        }

        const newPasswordHash = await PasswordPolicyService.hashPassword(newPassword);

        // 2. ตรวจสอบว่ารหัสผ่านใหม่ซ้ำกับประวัติหรือไม่
        const historyError = await PasswordPolicyService.checkPasswordHistory(req, userId, newPasswordHash, policy.password_history_count);
        if (historyError) {
            return res.status(400).json({ message: historyError });
        }

        // อัปเดตรหัสผ่านใหม่และวันที่มีการเปลี่ยน
        await req.dbPool.query(
            'UPDATE sa_user SET password_hash = $1, password_last_changed_at = CURRENT_TIMESTAMP WHERE id = $2',
            [newPasswordHash, userId]
        );

        // บันทึกรหัสผ่านเก่าลงในประวัติ
        await PasswordPolicyService.addPasswordToHistory(req, userId, user.password_hash);

        res.status(200).json({ message: 'Password changed successfully.' });

    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = {
    verifyToken,
    ensureFirstUserExists,
    login,
    changePassword
};