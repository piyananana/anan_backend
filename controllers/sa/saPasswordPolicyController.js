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

    const query = `
        INSERT INTO sa_password_policy (min_length, require_uppercase, require_lowercase, require_digits, require_special_chars, password_history_count, password_expiry_days, password_notification_days, force_password_change_on_expiry)
        VALUES (
            8, TRUE, TRUE, TRUE, TRUE, 5, 90, 7, TRUE)
        ON CONFLICT (id) DO NOTHING;
    `;
    try {
        await pool.query('BEGIN');
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
        await req.dbPool.query('BEGIN');
        const policy = await req.dbPool.query('SELECT * FROM sa_password_policy ORDER BY id LIMIT 1');
        await req.dbPool.query('COMMIT');
        return policy.rows[0];
    } 
    catch (error) {
        console.error('Error fetching policy:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

const getPasswordPolicy = async (req, res) => {
    try {
        await req.dbPool.query('BEGIN');
        const policy = await req.dbPool.query('SELECT * FROM sa_password_policy ORDER BY id LIMIT 1');
        await req.dbPool.query('COMMIT');
        return res.status(200).json(policy.rows[0]);
    } 
    catch (error) {
        console.error('Error fetching password policy:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

const updatePolicy = async (req, res) => {
    const policyData = req.body; // ใช้ข้อมูลจาก body ของ request
    try {
        await req.dbPool.query('BEGIN');
        const {
            min_length,
            require_uppercase,
            require_lowercase,
            require_digits,
            require_special_chars,
            password_history_count,
            password_expiry_days,
            password_notification_days,
            force_password_change_on_expiry
        } = policyData;

        // ในตัวอย่างนี้ ผมใช้ ID 1 เสมอ เพราะเราจะเก็บ Policy แค่รายการเดียว
        await req.dbPool.query(
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
             updated_at = CURRENT_TIMESTAMP
             WHERE id = 1 RETURNING *`,
            [
                min_length,
                require_uppercase,
                require_lowercase,
                require_digits,
                require_special_chars,
                password_history_count,
                password_expiry_days,
                password_notification_days,
                force_password_change_on_expiry
            ]
        );
        await req.dbPool.query('COMMIT');
        return res.status(200).json({ message: 'Password policy updated successfully' });
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