// services/saPasswordPolicyService.js
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10; // จำนวนรอบในการ Hash

class PasswordPolicyService {
    // Hash รหัสผ่าน
    static async hashPassword(password) {
        return bcrypt.hash(password, SALT_ROUNDS);
    }

    // ตรวจสอบรหัสผ่าน
    static async comparePassword(plainPassword, hashedPassword) {
        return bcrypt.compare(plainPassword, hashedPassword);
    }

    // ตรวจสอบความซับซ้อนของรหัสผ่านตาม Policy

    static validatePasswordComplexity(password, policy) {
        if (password.length < policy.min_length) {
            return `รหัสผ่านต้องมีความยาวอย่างน้อย ${policy.min_length} ตัวอักษร`;
        }
        if (policy.require_uppercase && !/[A-Z]/.test(password)) {
            return 'รหัสผ่านต้องมีตัวอักษรพิมพ์ใหญ่อย่างน้อย 1 ตัว';
        }
        if (policy.require_lowercase && !/[a-z]/.test(password)) {
            return 'รหัสผ่านต้องมีตัวอักษรพิมพ์เล็กอย่างน้อย 1 ตัว';
        }
        if (policy.require_digits && !/[0-9]/.test(password)) {
            return 'รหัสผ่านต้องมีตัวเลขอย่างน้อย 1 ตัว';
        }
        // ตรวจสอบอักขระพิเศษ (ไม่ใช่อักขระตัวอักษรหรือตัวเลข)
        // Note: คุณอาจต้องการกำหนดชุดอักขระพิเศษที่ชัดเจนกว่านี้ เช่น !@#$%^&*()
        if (policy.require_special_chars && !/[^A-Za-z0-9]/.test(password)) {
            return 'รหัสผ่านต้องมีตัวอักษรพิเศษอย่างน้อย 1 ตัว';
        }
        return null; // รหัสผ่านถูกต้องตาม Policy
    }

    // ตรวจสอบประวัติรหัสผ่าน
    static async checkPasswordHistory(req, userId, newPassword, historyCount) {
        if (historyCount <= 0) return null; // ไม่ต้องตรวจสอบประวัติ

        const res = await req.dbPool.query(
            'SELECT password_hash FROM sa_password_history WHERE user_id = $1 ORDER BY changed_at DESC LIMIT $2',
            [userId, historyCount]
        );

        for (const row of res.rows) {
            if (await bcrypt.compare(newPassword, row.password_hash)) {
                return `รหัสผ่านใหม่ซ้ำกับ ${historyCount} ครั้งที่ผ่านมา`;
            }
        }
        return null; // รหัสผ่านไม่ซ้ำ
    }

    // บันทึกประวัติรหัสผ่าน
    static async addPasswordToHistory(req, userId, passwordHash) {
        await req.dbPool.query(
            'INSERT INTO sa_password_history (user_id, password_hash) VALUES ($1, $2)',
            [userId, passwordHash]
        );
    }
}

module.exports = PasswordPolicyService;
