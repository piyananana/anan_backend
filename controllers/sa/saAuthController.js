// controllers/sa/saAuthController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PolicyController = require('../sa/saPasswordPolicyController');
const PasswordPolicyService = require('../../services/saPasswordPolicyService');
const auditLog = require('./saUserAuditLogController');

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

// ─── Session helpers ───────────────────────────────────────────────────────

async function _ensureSessionTable(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sa_user_session (
            id              SERIAL PRIMARY KEY,
            user_id         INT NOT NULL REFERENCES sa_user(id) ON DELETE CASCADE,
            session_token   TEXT NOT NULL,
            started_at      TIMESTAMPTZ DEFAULT NOW(),
            last_active_at  TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id)
        )
    `);
}

async function _upsertSession(pool, userId, token) {
    await pool.query(`
        INSERT INTO sa_user_session (user_id, session_token, started_at, last_active_at)
        VALUES ($1, $2, NOW(), NOW())
        ON CONFLICT (user_id) DO UPDATE
            SET session_token = EXCLUDED.session_token,
                started_at    = NOW(),
                last_active_at = NOW()
    `, [userId, token]);
}

async function _deleteSession(pool, userId) {
    await pool.query('DELETE FROM sa_user_session WHERE user_id = $1', [userId]);
}

async function _getExistingSession(pool, userId) {
    const r = await pool.query(
        'SELECT started_at FROM sa_user_session WHERE user_id = $1', [userId]
    );
    return r.rows[0] || null;
}

async function _getSingleSessionMode(pool) {
    try {
        const r = await pool.query(
            "SELECT COALESCE(single_session_mode, 'dialog') AS mode FROM sa_password_policy ORDER BY id LIMIT 1"
        );
        return r.rows[0]?.mode ?? 'dialog';
    } catch (_) {
        return 'dialog';
    }
}

// ─── First user bootstrap ──────────────────────────────────────────────────

// ตรวจสอบและสร้างผู้ใช้คนแรกถ้ายังไม่มี
async function ensureFirstUserExists(req, res) {
    try {
        // Drop legacy columns if they still exist
        await req.dbPool.query('ALTER TABLE sa_user DROP COLUMN IF EXISTS is_developer');
        await req.dbPool.query('ALTER TABLE sa_user DROP COLUMN IF EXISTS is_admin');

        const countResult = await req.dbPool.query('SELECT COUNT(*) FROM sa_user');
        const userCount = parseInt(countResult.rows[0].count, 10);

        if (userCount === 0) {
            console.log('No user found. Creating the first system user...');
            const userName = 'sys01';
            const password = 'sys01';
            const hashedPassword = await bcrypt.hash(password, 10);
            const insertQuery = `
                INSERT INTO sa_user (user_name, password_hash, first_name, last_name, user_type, status)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *;
            `;
            await req.dbPool.query(insertQuery, [userName, hashedPassword, 'System', 'Admin', 'developer', 'active']);
            console.log('First user "sys01" created as developer.');
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
    const { userName, password, databaseName, hostname: clientHostname } = req.body;
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

        // ── Single Session Check ────────────────────────────────────────────
        await _ensureSessionTable(req.dbPool);
        const sessionMode = await _getSingleSessionMode(req.dbPool);
        const existingSession = await _getExistingSession(req.dbPool, user.id);

        if (existingSession && sessionMode === 'dialog') {
            // ส่ง confirmToken (short-lived 2 min) ให้ frontend แสดง dialog
            const confirmToken = jwt.sign(
                { type: 'session_confirm', userId: user.id, dbName: databaseName },
                process.env.JWT_SECRET,
                { expiresIn: '2m' }
            );
            return res.status(200).json({
                requiresConfirmation: true,
                confirmToken,
                sessionStartedAt: existingSession.started_at,
            });
        }

        // force mode หรือไม่มี session เก่า: mark audit เก่าเป็น forced แล้วลบ session
        if (existingSession) {
            await auditLog.markForced(req.dbPool, user.id);
            await _deleteSession(req.dbPool, user.id);
        }

        // Generate JWT Token with role flags
        const token = jwt.sign(
            { id: user.id, userName: user.user_name, userType: user.user_type, isDeveloper, isAdmin },
            process.env.JWT_SECRET,
            { expiresIn: 86400 } // 24 hours
        );

        // บันทึก session ใหม่
        await _upsertSession(req.dbPool, user.id, token);

        // บันทึก audit log
        const _loginIp = (String(req.headers['x-forwarded-for'] || '')).split(',')[0].trim() || req.ip || null;
        await auditLog.logLogin(req.dbPool, {
            userId:       user.id,
            userType:     user.user_type,
            username:     user.user_name,
            fullName:     [user.first_name, user.last_name].filter(Boolean).join(' '),
            dbName:       databaseName,
            ipAddress:    _loginIp,
            hostname:     clientHostname || null,
            userAgent:    req.headers['user-agent'] || null,
            sessionToken: token,
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

// POST /auth/login/confirm — ยืนยันการ login เมื่อมี session เดิม
const confirmLogin = async (req, res) => {
    const { confirmToken, forceLogout } = req.body;
    if (!confirmToken) {
        return res.status(400).json({ message: 'confirmToken is required' });
    }

    let decoded;
    try {
        decoded = jwt.verify(confirmToken, process.env.JWT_SECRET);
    } catch (err) {
        return res.status(401).json({ message: 'confirmToken หมดอายุหรือไม่ถูกต้อง' });
    }

    if (decoded.type !== 'session_confirm') {
        return res.status(400).json({ message: 'token ไม่ถูกต้อง' });
    }

    if (!forceLogout) {
        // ผู้ใช้เลือกยกเลิก — ไม่ทำอะไร
        return res.status(200).json({ success: false });
    }

    try {
        const userRes = await req.dbPool.query(
            'SELECT * FROM sa_user WHERE id = $1 AND status = $2', [decoded.userId, 'active']
        );
        if (userRes.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        const user = userRes.rows[0];

        // ลบ session เก่า แล้วสร้างใหม่
        await _ensureSessionTable(req.dbPool);
        await auditLog.markForced(req.dbPool, user.id);
        await _deleteSession(req.dbPool, user.id);

        const isDeveloper = user.user_type === 'developer';
        const isAdmin = user.user_type === 'administrator';
        const token = jwt.sign(
            { id: user.id, userName: user.user_name, userType: user.user_type, isDeveloper, isAdmin },
            process.env.JWT_SECRET,
            { expiresIn: 86400 }
        );
        await _upsertSession(req.dbPool, user.id, token);

        // บันทึก audit log login ใหม่
        const _confirmIp = (String(req.headers['x-forwarded-for'] || '')).split(',')[0].trim() || req.ip || null;
        await auditLog.logLogin(req.dbPool, {
            userId:       user.id,
            userType:     user.user_type,
            username:     user.user_name,
            fullName:     [user.first_name, user.last_name].filter(Boolean).join(' '),
            dbName:       decoded.dbName ?? null,
            ipAddress:    _confirmIp,
            hostname:     req.body.hostname || null,
            userAgent:    req.headers['user-agent'] || null,
            sessionToken: token,
        });

        const policy = await PolicyController.getPolicy(req, res);
        return res.status(200).json({
            success: true,
            token,
            user,
            passwordStatus: { isPasswordExpired: false, daysUntilExpiration: null, forceChangePassword: false },
        });
    } catch (error) {
        console.error('confirmLogin error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST /auth/check_token — ตรวจ JWT + session validity
const checkToken = async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
        return res.status(401).json({ message: 'Invalid token' });
    }

    // ตรวจ session ใน DB
    try {
        await _ensureSessionTable(req.dbPool);
        const r = await req.dbPool.query(
            'SELECT session_token FROM sa_user_session WHERE user_id = $1', [decoded.id]
        );
        if (r.rows.length === 0 || r.rows[0].session_token !== token) {
            return res.status(401).json({ message: 'SESSION_REPLACED', code: 'SESSION_REPLACED' });
        }
        // อัปเดต last_active_at
        await req.dbPool.query(
            'UPDATE sa_user_session SET last_active_at = NOW() WHERE user_id = $1', [decoded.id]
        );
        return res.status(200).json({ message: 'Token is valid' });
    } catch (err) {
        console.error('checkToken session error:', err.message);
        // ถ้า DB error ให้ผ่านไปก่อน (session table อาจยังไม่ migrate)
        return res.status(200).json({ message: 'Token is valid' });
    }
};

// POST /auth/logout — ลบ session เฉพาะ token นี้เท่านั้น
// (ไม่ลบ session ใหม่กว่า เช่น กรณีที่เครื่องนี้ถูก kick แล้วยัง logout ทีหลัง)
const logout = async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(200).json({ message: 'Logged out' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        await _ensureSessionTable(req.dbPool);
        await auditLog.logLogout(req.dbPool, { sessionToken: token, logoutType: 'normal' });
        // ลบเฉพาะเมื่อ token ตรงกับที่เก็บไว้ — ป้องกันการลบ session ใหม่กว่า
        await req.dbPool.query(
            'DELETE FROM sa_user_session WHERE user_id = $1 AND session_token = $2',
            [decoded.id, token]
        );
    } catch (_) {}

    return res.status(200).json({ message: 'Logged out' });
};

module.exports = {
    verifyToken,
    injectUserRole,
    requireDeveloper,
    ensureFirstUserExists,
    login,
    confirmLogin,
    checkToken,
    logout,
    changePassword
};
