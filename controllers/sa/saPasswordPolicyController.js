// controllers/sa/saPasswordPolicyController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้
const dbService = require('../../services/saDatabaseService');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ตรวจสอบและเพิ่มข้อมูล Policy ตั้งต้น ถ้ายังไม่มีตอนเริ่มระบบ (node index.js <database_name>)
const ensureDefaultPolicyExists = async (databaseName) =>{
    if (!databaseName) {
        throw new Error('Database name is required to check password policy.');
    }
    
    // *** ใช้ getPool เพื่อสร้าง connection pool สำหรับฐานข้อมูลที่ระบุ ***
    const pool = await dbService.getPool(databaseName);

    const alterQuery = `
        ALTER TABLE sa_password_policy
        ADD COLUMN IF NOT EXISTS session_timeout_minutes INTEGER DEFAULT 5;
        ALTER TABLE sa_password_policy
        ADD COLUMN IF NOT EXISTS single_session_mode VARCHAR(10) DEFAULT 'dialog';
    `;
    const query = `
        INSERT INTO sa_password_policy (min_length, require_uppercase, require_lowercase, require_digits, require_special_chars, password_history_count, password_expiry_days, password_notification_days, force_password_change_on_expiry, session_timeout_minutes, single_session_mode)
        VALUES (8, TRUE, TRUE, TRUE, TRUE, 5, 90, 7, TRUE, 5, 'dialog')
        ON CONFLICT (id) DO NOTHING;
    `;
    try {
        await pool.query('BEGIN');
        await pool.query(alterQuery);
        await pool.query(query);
        await pool.query('COMMIT');
        console.log('Default password policy checked/inserted successfully.');
    } catch (error) {
        console.error('Error ensuring default password policy exists:', error);
        throw error;
    }
}

const getPolicy = async (req, res) => {
    try {
        const policy = await req.dbPool.query('SELECT * FROM sa_password_policy ORDER BY id LIMIT 1');
        if (!policy.rows[0]) throw new Error('ไม่พบข้อมูล password policy');
        return policy.rows[0];
    } catch (error) {
        console.error('Error fetching policy:', error);
        throw error;
    }
};

const getPasswordPolicy = async (req, res) => {
    try {
        const policy = await req.dbPool.query('SELECT * FROM sa_password_policy ORDER BY id LIMIT 1');
        if (!policy.rows[0]) return res.status(404).json({ message: 'ไม่พบข้อมูล password policy' });
        return res.status(200).json(policy.rows[0]);
    } catch (error) {
        console.error('Error fetching password policy:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

const updatePolicy = async (req, res) => {
    const policyData = req.body;
    try {
        const {
            min_length,
            require_uppercase,
            require_lowercase,
            require_digits,
            require_special_chars,
            password_history_count,
            password_expiry_days,
            password_notification_days,
            force_password_change_on_expiry,
            session_timeout_minutes,
            single_session_mode,
        } = policyData;

        // Validate numeric fields
        const minLen = Math.min(128, Math.max(1, parseInt(min_length, 10) || 8));
        const histCount = Math.min(24, Math.max(0, parseInt(password_history_count, 10) || 0));
        const expiryDays = Math.min(3650, Math.max(1, parseInt(password_expiry_days, 10) || 90));
        const notifyDays = Math.min(expiryDays - 1, Math.max(0, parseInt(password_notification_days, 10) || 7));
        const timeout = Math.min(600, Math.max(1, parseInt(session_timeout_minutes, 10) || 5));
        const sessionMode = ['dialog', 'force'].includes(single_session_mode) ? single_session_mode : 'dialog';

        // หา id จริงของ policy row (ไม่ hardcode id=1)
        const existing = await req.dbPool.query('SELECT id FROM sa_password_policy ORDER BY id LIMIT 1');
        if (!existing.rows[0]) return res.status(404).json({ message: 'ไม่พบข้อมูล password policy' });
        const policyId = existing.rows[0].id;

        const result = await req.dbPool.query(
            `UPDATE sa_password_policy SET
             min_length = $1,
             require_uppercase = $2,
             require_lowercase = $3,
             require_digits = $4,
             require_special_chars = $5,
             password_history_count = $6,
             password_expiry_days = $7,
             password_notification_days = $8,
             force_password_change_on_expiry = $9,
             session_timeout_minutes = $10,
             single_session_mode = $11,
             updated_at = CURRENT_TIMESTAMP
             WHERE id = $12 RETURNING *`,
            [minLen, require_uppercase, require_lowercase, require_digits, require_special_chars,
             histCount, expiryDays, notifyDays, force_password_change_on_expiry, timeout, sessionMode, policyId]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'อัปเดตไม่สำเร็จ' });
        return res.status(200).json({ message: 'Password policy updated successfully', policy: result.rows[0] });
    } catch (error) {
        console.error('Error updating password policy:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = {
    // ensureFirstUserExists,
    // login,
    ensureDefaultPolicyExists,
    getPolicy,
    getPasswordPolicy,
    updatePolicy
};