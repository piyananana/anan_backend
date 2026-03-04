// middlewares/dbMiddleware.js
const dbService = require('../services/saDatabaseService');

const dbMiddleware = async (req, res, next) => {
    const databaseName = req.header('X-Database-Name');     // ดึงชื่อฐานข้อมูลจาก HTTP Header 'X-Database-Name'
    if (!databaseName) {
        return next();      // สำหรับบาง API เช่น login หรือ get databases ที่ยังไม่มี database name
    }
    try {
        const pool = await dbService.getPool(databaseName);     // ใช้ getPool เพื่อดึง connection pool ที่ถูกต้องและเก็บไว้ใน req object
        req.dbPool = pool;
        next();     // ส่งต่อ request ไปยัง Controller
    } catch (error) {
        console.error('Database connection error:', error);
        res.status(500).json({ message: 'Internal server error: Cannot connect to database.' });
    }
};

module.exports = dbMiddleware;