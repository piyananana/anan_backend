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

// developer ถ้า user_type = 'developer' เท่านั้น
const _isDeveloperRow = (row) => row?.user_type === 'developer';

// Injects req.isDeveloper, req.authUserId — never blocks
const injectUserRole = async (req, res, next) => {
    req.isDeveloper = false;
    req.authUserId = null;

    // 1. Try JWT token for userId
    let userId = null;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userId = decoded.id;
            req.isDeveloper = decoded.userType === 'developer'; // JWT fallback
        } catch (err) {
            console.error('injectUserRole JWT error:', err.message);
        }
    }

    // 2. Fall back to UserId header (always sent by Flutter client)
    if (!userId) {
        const headerUserId = req.headers['userid'];
        if (headerUserId) userId = parseInt(headerUserId, 10);
    }

    // 3. Verify against DB (most authoritative — role may have changed after login)
    if (userId) {
        req.authUserId = userId;
        try {
            const result = await req.dbPool.query(
                'SELECT user_type FROM sa_user WHERE id = $1', [userId]
            );
            if (result.rows.length > 0) {
                req.isDeveloper = result.rows[0].user_type === 'developer';
            }
        } catch (dbErr) {
            console.error('injectUserRole DB error:', dbErr.message);
        }
    }

    next();
};

// Blocks non-developer with 403; mirrors _checkDeveloper pattern used across controllers
const requireDeveloper = async (req, res, next) => {
    // Try JWT token first
    let userId = null;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            userId = decoded.id;
        } catch (_) {}
    }
    // Fall back to UserId header (always sent by Flutter client alongside JWT)
    if (!userId) {
        const headerUserId = req.headers['userid'];
        if (headerUserId) userId = parseInt(headerUserId, 10);
    }
    if (!userId) {
        return res.status(403).json({ message: 'ต้องการการยืนยันตัวตน' });
    }
    try {
        const result = await req.dbPool.query(
            'SELECT user_type FROM sa_user WHERE id = $1',
            [userId]
        );
        if (result.rows[0]?.user_type !== 'developer') {
            return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
        }
        req.isDeveloper = true;
        req.authUserId = userId;
        next();
    } catch (err) {
        console.error('requireDeveloper DB error:', err.message);
        return res.status(500).json({ message: 'เกิดข้อผิดพลาดภายในระบบ' });
    }
};

// ตรวจสอบและสร้างผู้ใช้คนแรกถ้ายังไม่มี
async function ensureFirstUserExists(req, res) {
    try {
        // Drop legacy columns if they still exist
        await req.dbPool.query('ALTER TABLE sa_user DROP COLUMN IF EXISTS is_developer');
        await req.dbPool.query('ALTER TABLE sa_user DROP COLUMN IF EXISTS is_admin');

        const countResult = await req.dbPool.query('SELECT COUNT(*) FROM sa_user');
        const userCount = parseInt(countResult.rows[0].count, 10);

        if (userCount === 0) {
            console.log('No user found. Creating the first administrator user...');
            const userName = 'anansoft';
            const password = 'anansoft';
            const hashedPassword = await bcrypt.hash(password, 10);
            const insertQuery = `
                INSERT INTO sa_user (user_name, password_hash, first_name, last_name, user_type, status)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *;
            `;
            await req.dbPool.query(insertQuery, [userName, hashedPassword, 'อนันต์ซอฟท์', 'บจก.', 'developer', 'active']);
            console.log('First user "anansoft" created as developer.');
        }

        // Bootstrap: ถ้าไม่มี user_type='developer' เลย ให้ผู้ใช้ที่สร้างก่อนสุดเป็น developer
        const devCheck = await req.dbPool.query("SELECT COUNT(*) FROM sa_user WHERE user_type = 'developer'");
        if (parseInt(devCheck.rows[0].count, 10) === 0) {
            await req.dbPool.query("UPDATE sa_user SET user_type = 'developer' WHERE id = (SELECT MIN(id) FROM sa_user)");
            console.log('Bootstrap: oldest user set as developer.');
        }
    } catch (err) {
        console.error('Error ensuring first user exists:', err);
        // อาจจะโยน error หรือจัดการในรูปแบบอื่น ขึ้นอยู่กับความต้องการ
        throw new Error('Failed to ensure first user exists.');
    }
}

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

        // isDeveloper: ตรวจจาก user_type เท่านั้น
        const isDeveloper = user.user_type === 'developer';
        const isAdmin = user.user_type === 'administrator';

        // Generate JWT Token with role flags
        const token = jwt.sign(
            { id: user.id, userName: user.user_name, userType: user.user_type, isDeveloper, isAdmin },
            process.env.JWT_SECRET,
            { expiresIn: 86400 } // 24 hours
        );

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

        res.status(200).json({
            token: token,
            user: user,
            passwordStatus: passwordStatus, // ส่งสถานะรหัสผ่านไปที่ Frontend
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
        const historyError = await PasswordPolicyService.checkPasswordHistory(req, userId, newPassword, policy.password_history_count);
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
    injectUserRole,
    requireDeveloper,
    ensureFirstUserExists,
    login,
    changePassword
};
