// controllers/sa/saUserController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ฟังก์ชันสำหรับเข้ารหัสรหัสผ่าน
const hashPassword = async (password) => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};

// rank สำหรับเปรียบเทียบ hierarchy
const typeRank = (t) => ({ developer: 4, administrator: 3, user: 2, guest: 1 }[t] ?? 0);

const getAllUser = async (req, res) => {
    try {
        const userId = req.headers['userid'];
        let requesterType = 'guest';
        if (userId) {
            const roleRes = await req.dbPool.query(
                "SELECT user_type FROM sa_user WHERE id = $1", [userId]
            );
            requesterType = roleRes.rows[0]?.user_type ?? 'guest';
        }

        // เห็นเฉพาะ user ที่มี rank ≤ rank ของผู้ขอ
        const rank = typeRank(requesterType);
        const visibleTypes = ['developer', 'administrator', 'user', 'guest']
            .filter(t => typeRank(t) <= rank);

        const placeholders = visibleTypes.map((_, i) => `$${i + 1}`).join(', ');
        const result = await req.dbPool.query(
            `SELECT id, user_name, first_name, last_name, user_type, status, email, created_at, updated_at
             FROM sa_user WHERE user_type IN (${placeholders}) ORDER BY user_name ASC`,
            visibleTypes
        );
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
    try {
        const passwordHash = await hashPassword(password);
        const result = await req.dbPool.query(
            `INSERT INTO sa_user (user_name, password_hash, first_name, last_name, user_type, status, email)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, user_name, first_name, last_name, user_type, status, email, created_at, updated_at`,
            [userName, passwordHash, first_name, last_name, user_type, status, email]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error adding user:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// API สำหรับแก้ไขผู้ใช้
const updateUser = async (req, res) => {
    const { id } = req.params;
    const { userName, password, first_name, last_name, user_type, status, email } = req.body;
    try {
        // ตรวจ requester เป็น developer ไหม
        let requesterIsDeveloper = false;
        const reqUserId = req.headers['userid'];
        if (reqUserId) {
            const rr = await req.dbPool.query("SELECT user_type FROM sa_user WHERE id=$1", [reqUserId]);
            requesterIsDeveloper = rr.rows[0]?.user_type === 'developer';
        }
        const target = await req.dbPool.query('SELECT user_type FROM sa_user WHERE id = $1', [id]);
        if (target.rows.length === 0) return res.status(404).json({ message: 'User not found.' });
        if (target.rows[0].user_type === 'developer' && !requesterIsDeveloper) {
            return res.status(403).json({ message: 'ไม่มีสิทธิ์แก้ไขข้อมูลผู้พัฒนาระบบ' });
        }

        let result;
        if (password) {
            const passwordHash = await hashPassword(password);
            result = await req.dbPool.query(
                `UPDATE sa_user SET
                    user_name = $1,
                    password_hash = $2,
                    first_name = $3,
                    last_name = $4,
                    user_type = $5,
                    status = $6,
                    email = $7,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE id = $8
                 RETURNING id, user_name, first_name, last_name, user_type, status, email, created_at, updated_at`,
                [userName, passwordHash, first_name, last_name, user_type, status, email, id]
            );
        } else {
            result = await req.dbPool.query(
                `UPDATE sa_user SET
                    user_name = $1,
                    first_name = $2,
                    last_name = $3,
                    user_type = $4,
                    status = $5,
                    email = $6,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE id = $7
                 RETURNING id, user_name, first_name, last_name, user_type, status, email, created_at, updated_at`,
                [userName, first_name, last_name, user_type, status, email, id]
            );
        }
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating user:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// API สำหรับลบผู้ใช้
const deleteUser = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // ตรวจ requester เป็น developer ไหม
        let delRequesterIsDev = false;
        const delUserId = req.headers['userid'];
        if (delUserId) {
            const rr = await client.query("SELECT user_type FROM sa_user WHERE id=$1", [delUserId]);
            delRequesterIsDev = rr.rows[0]?.user_type === 'developer';
        }
        const target = await client.query('SELECT user_type FROM sa_user WHERE id = $1', [id]);
        if (target.rows.length > 0 && target.rows[0].user_type === 'developer' && !delRequesterIsDev) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'ไม่มีสิทธิ์ลบผู้พัฒนาระบบ' });
        }

        const result = await client.query('DELETE FROM sa_user WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'User not found.' });
        }
        await client.query('COMMIT');
        res.status(204).send();
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting user:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

module.exports = {
    hashPassword,
    getAllUser,
    createUser,
    updateUser,
    deleteUser
};
