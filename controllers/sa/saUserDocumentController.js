// controllers/sa/saUserDocumentController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้
// const pool = require('../../config/db');


// *** API สำหรับ CRUD เมนู (ต้องการ authentication) ***

// API สำหรับเพิ่มเมนูใหม่
const updateRowsByUserId = async (req, res) => {
    const { docIds } = req.body;
    const userId = parseInt(req.params.userId);

    if (isNaN(userId)) {
        return res.status(400).json({ message: 'Invalid User ID' });
    }
    // if (!Array.isArray(docIds) || !docIds.every(id => typeof id === 'number')) {
    if (!Array.isArray(docIds)) {
        console.error('Validation Error: Invalid docIds array received:', docIds); // <-- เพิ่ม logging ตรงนี้
        return res.status(400).json({ message: 'Invalid docIds array provided' });
    }

    try {
        await req.dbPool.query('BEGIN');

        // ขั้นตอนที่ 1: ลบสิทธิ์เก่าทั้งหมดของผู้ใช้คนนี้
        await req.dbPool.query(
            'DELETE FROM sa_user_document WHERE user_id = $1',
            [userId]
        );

        // ขั้นตอนที่ 2: เพิ่มสิทธิ์ใหม่ทั้งหมด
        if (docIds.length > 0) {
            let valuePlaceholders = [];
            let queryParamsForInsert = [userId]; // userId คือ parameter ตัวแรก ($1)
            for (let i = 0; i < docIds.length; i++) {
                // สร้าง placeholder สำหรับแต่ละคู่ (user_id, doc_id)
                // user_id จะเป็น $1 เสมอ
                // doc_id จะเป็น $2, $3, $4, ... ตามลำดับของ docIds
                valuePlaceholders.push('($1, $' + (i + 2).toString() + ')');
                queryParamsForInsert.push(docIds[i]); // เพิ่ม doc_id เข้าไปใน queryParams
            }
            const insertQuery = 'INSERT INTO sa_user_document (user_id, doc_id) VALUES ' + valuePlaceholders.join(', ');
            await req.dbPool.query(insertQuery, queryParamsForInsert);
            // console.error('insert value: ', insertQuery, queryParamsForInsert);
        }

        await req.dbPool.query('COMMIT'); // Commit Transaction

        // ต้องมั่นใจว่าส่ง Status 200 และมี body ที่เหมาะสม
        return res.status(200).json({ message: 'User doc updated successfully' });

    } catch (error) {
        await req.dbPool.query('ROLLBACK');
        console.error('Error updating user doc:', error);
        // ต้องส่ง Status 500 กลับไปเมื่อเกิดข้อผิดพลาด
        return res.status(500).json({ message: 'Failed to update user doc', error: error.message });
    }
};

const deleteRowsByUserId = async (req, res) => {
    const { userId } = req.params;
    try {
        await req.dbPool.query('BEGIN');
        const result = await req.dbPool.query('DELETE FROM sa_user_document WHERE user_id = $1 RETURNING *', [userId]);

        if (result.rows.length === 0) {
            await req.dbPool.query('ROLLBACK');
            return res.status(404).json({ message: 'User doc not found.' });
        }
        await req.dbPool.query('COMMIT'); // Commit Transaction
        res.status(204).send(); // No Content
    } catch (err) {
        console.error('Error deleting user doc:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = {
    // getAllUserMenu,
    // getUserMenuById,
    updateRowsByUserId,
    deleteRowsByUserId
};