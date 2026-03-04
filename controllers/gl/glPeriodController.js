// File: controllers/gl/glPeriodController.js
// const { Pool } = require('pg');

// // *** ตัวอย่าง Pool Connection (คุณอาจต้องแก้ไขให้ถูกต้องตาม config ของคุณ) ***
// const pool = new Pool({
//   user: 'your_user', host: 'localhost', database: 'your_db', password: 'your_password', port: 5432,
// });
// // *************************************************************************

// --- Helper: สร้างรอบบัญชีเริ่มต้น (Standard N periods) ---
const createStandardPeriods = (fyId, yearStartDate, yearEndDate, numPeriods = 12) => {
    const periods = [];
    let currentDate = new Date(yearStartDate);
    const fyEndDate = new Date(yearEndDate); // วันที่สิ้นสุดปีงบประมาณจริง

    for (let i = 1; i <= numPeriods; i++) {
        let periodStartDate = new Date(currentDate);
        let periodEndDate;
        let monthName;

        if (i <= 12) {
            // คำนวณวันสิ้นสุด: ไปเดือนถัดไป แล้วลบ 1 วัน
            periodEndDate = new Date(currentDate.setMonth(currentDate.getMonth() + 1));
            periodEndDate.setDate(periodEndDate.getDate() - 1);
            monthName = periodStartDate.toLocaleString('default', { month: 'long' });
            // // เลื่อนไปวันเริ่มต้นของรอบถัดไป
            // currentDate = new Date(periodEndDate);
            // currentDate.setDate(currentDate.getDate() + 1);
        } else {
            // รอบสุดท้าย: วันสิ้นสุดคือวันสิ้นสุดปีงบประมาณ
            periodStartDate = new Date(currentDate.setMonth(currentDate.getMonth() - 1));
            periodEndDate = fyEndDate;
            monthName = periodStartDate.toLocaleString('default', { month: 'long' });
        }

        periods.push({
            fiscal_year_id: fyId,
            // period_number: i,
            period_number: i * 10,
            // period_name: `${monthName} ${periodStartDate.getFullYear()}`,
            period_name: `${monthName}`,
            // period_start_date: periodStartDate.toISOString().split('T')[0],
            period_start_date: periodStartDate.getFullYear().toString() +
                              '/' + (periodStartDate.getMonth() + 1).toString().padStart(2, '0') +
                              '/' + periodStartDate.getDate().toString().padStart(2, '0') +
                              ' 00:00:00',
            // period_end_date: periodEndDate.toISOString().split('T')[0],
            period_end_date: periodEndDate.getFullYear().toString() +
                              '/' + (periodEndDate.getMonth() + 1).toString().padStart(2, '0') +
                              '/' + periodEndDate.getDate().toString().padStart(2, '0') +
                              ' 23:59:59',
        });
        
        // เลื่อนไปวันเริ่มต้นของรอบถัดไป
        if (i <= 12) {
            currentDate = new Date(periodEndDate);
            currentDate.setDate(currentDate.getDate() + 1);
        }
    }
    return periods;
};

// -----------------------------------------------------------------
// A. GL FISCAL YEAR CRUD
// -----------------------------------------------------------------

// 1. GET All Fiscal Years (พร้อมรวมข้อมูล Period)
const fetchHeaderRows = async (req, res) => {
    try {
        const query = `
            SELECT 
                fy.*, 
                COUNT(p.id) AS total_periods,
                SUM(CASE WHEN p.gl_status = 'HARD_CLOSE' THEN 1 ELSE 0 END) AS closed_periods
            FROM gl_fiscal_year fy
            LEFT JOIN gl_posting_period p ON fy.id = p.fiscal_year_id
            GROUP BY fy.id
            ORDER BY fy.fy_code DESC;
        `;
        const result = await req.dbPool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching fiscal years:', error);
        res.status(500).json({ message: 'Error fetching fiscal years.', error: error.message });
    }
};

// 2. GET Fiscal Year By ID
const fetchHeaderRowById = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query('SELECT * FROM gl_fiscal_year WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Fiscal Year not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching fiscal year by ID:', error);
        res.status(500).json({ message: 'Error fetching fiscal year details.', error: error.message });
    }
};

// 3. POST Create New Fiscal Year (พร้อมสร้างรอบบัญชีอัตโนมัติ) - ปรับปรุงการเรียก Helper
const addHeaderRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const { fy_code, description, year_start_date, year_end_date, num_of_periods } = req.body;
    const userId = req.headers.userid;
    const userName = req.headers.username;
    
    // แปลงวันที่ให้อยู่ในรูปแบบ Date Object
    const startDate = new Date(year_start_date);
    const endDate = new Date(year_end_date);
    
    try {
        await client.query('BEGIN');

        // 3.1. สร้างปีงบประมาณ
        const yearSql = `
            INSERT INTO gl_fiscal_year (
                fy_code, description, year_start_date, year_end_date, num_of_periods, created_by, updated_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id, year_start_date, year_end_date, num_of_periods`;
            
        const yearValues = [
            fy_code, description, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0], 
            num_of_periods || 12, userId
        ];
        
        const yearResult = await client.query(yearSql, yearValues);
        const newFy = yearResult.rows[0];

        // 3.2. สร้างรอบบัญชี gl_posting_period โดยใช้ year_start_date และ year_end_date
        const periods = createStandardPeriods(
            newFy.id, 
            newFy.year_start_date, 
            newFy.year_end_date, 
            newFy.num_of_periods
        );
        
        const periodSql = `
            INSERT INTO gl_posting_period (
                fiscal_year_id, period_number, period_name, period_start_date, period_end_date, updated_by
            ) VALUES ($1, $2, $3, $4, $5, $6)`;
            
        for (const p of periods) {
            await client.query(periodSql, [
                p.fiscal_year_id, p.period_number, p.period_name, p.period_start_date, p.period_end_date, userId
            ]);
        }
        
        await client.query('COMMIT');
        res.status(201).json({ 
            message: 'Fiscal Year and Periods created successfully.', 
            fiscalYear: newFy,
            periodsCount: periods.length
        });

    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') { 
            return res.status(400).json({ message: 'Fiscal Year Code already exists.', error: error.message });
        }
        console.error('Error creating Fiscal Year:', error);
        res.status(500).json({ message: 'Error creating new Fiscal Year.', error: error.message });
    } finally {
        client.release();
    }
};

// 4. PUT Update Fiscal Year
const updateHeaderRow = async (req, res) => {
    const { id } = req.params;
    const { description, year_start_date, year_end_date, is_active } = req.body;
    const userId = req.headers.userid;
    const userName = req.headers.username;
    
    // หมายเหตุ: การเปลี่ยน num_of_periods/วันที่เริ่มต้น/สิ้นสุด หลังจากสร้างรอบบัญชีแล้ว
    // อาจต้องใช้ตรรกะที่ซับซ้อนในการจัดการรอบบัญชีลูกที่สร้างไปแล้ว (จึงอนุญาตให้อัปเดตเฉพาะข้อมูลทั่วไป)

    try {
        const sql = `
            UPDATE gl_fiscal_year SET 
                description = $1, 
                year_start_date = $2, 
                year_end_date = $3, 
                is_active = $4,
                updated_by = $5,
                updated_at = NOW()
            WHERE id = $6
            RETURNING *`;
            
        const values = [
            description, year_start_date, year_end_date, is_active, userId, id
        ];
        
        const result = await req.dbPool.query(sql, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Fiscal Year not found for update.' });
        }

        res.status(200).json(result.rows[0]);

    } catch (error) {
        if (error.code === '23505') { 
            return res.status(400).json({ message: 'Fiscal Year Code already exists.', error: error.message });
        }
        console.error('Error updating Fiscal Year:', error);
        res.status(500).json({ message: 'Error updating Fiscal Year.', error: error.message });
    }
};

// 5. DELETE Fiscal Year
const deleteHeaderRow = async (req, res) => {
    const { id } = req.params;
    try {
        // เนื่องจาก gl_posting_period มี ON DELETE CASCADE หากลบปีงบประมาณ 
        // รอบบัญชีที่เกี่ยวข้องจะถูกลบตามไปด้วย
        const result = await req.dbPool.query('DELETE FROM gl_fiscal_year WHERE id = $1 RETURNING id', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Fiscal Year not found for deletion.' });
        }
        
        res.status(200).json({ message: 'Fiscal Year and related periods successfully deleted.', id: id });
    } catch (error) {
        console.error('Error deleting Fiscal Year:', error);
        res.status(500).json({ message: 'Error deleting Fiscal Year.', error: error.message });
    }
};


// -----------------------------------------------------------------
// B. GL POSTING PERIOD CRUD (เน้นการอัปเดตสถานะ)
// -----------------------------------------------------------------

// 1. GET All Periods by Fiscal Year ID
const fetchDetailRows = async (req, res) => {
    const { fyId } = req.params;
    try {
        const query = `
            SELECT * FROM gl_posting_period 
            WHERE fiscal_year_id = $1
            ORDER BY period_number;
        `;
        const result = await req.dbPool.query(query, [fyId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching posting periods:', error);
        res.status(500).json({ message: 'Error fetching posting periods.', error: error.message });
    }
};

// 2. PUT Update Period Status (เช่น ปิดรอบบัญชี GL)
const updateStatusDetailRow = async (req, res) => {
    const { id } = req.params;
    const { gl_status, ap_status, ar_status, im_status } = req.body;
    const userId = req.headers.userid;
    const userName = req.headers.username;
    
    try {
        // SQL: อนุญาตให้อัปเดตสถานะ GL, AP, AR พร้อมกัน
        const sql = `
            UPDATE gl_posting_period SET 
                gl_status = COALESCE($1, gl_status),
                ap_status = COALESCE($2, ap_status),
                ar_status = COALESCE($3, ar_status),
                im_status = COALESCE($4, im_status),
                updated_by = $5,
                updated_at = NOW()
            WHERE id = $6
            RETURNING *`;
            
        const values = [
            gl_status, ap_status, ar_status, im_status, userId, id
        ];
        
        const result = await req.dbPool.query(sql, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Posting Period not found for update.' });
        }

        res.status(200).json(result.rows[0]);

    } catch (error) {
        console.error('Error updating period status:', error);
        res.status(500).json({ message: 'Error updating period status.', error: error.message });
    }
};

// 3. POST Create Single Period (สำหรับรอบพิเศษ เช่น รอบที่ 13)
const addDetailRow = async (req, res) => {
    const { 
        fiscal_year_id, period_number, period_name, period_start_date, 
        period_end_date, gl_status, ap_status, ar_status, im_status 
    } = req.body;
    const userId = req.headers.userid;
    const userName = req.headers.username;
    
    try {
        const sql = `
            INSERT INTO gl_posting_period (
                fiscal_year_id, period_number, period_name, period_start_date, period_end_date, 
                gl_status, ap_status, ar_status, im_status, updated_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`;
            
        const values = [
            fiscal_year_id, period_number, period_name, period_start_date, 
            period_end_date, gl_status || 'OPEN', ap_status || 'OPEN', ar_status || 'OPEN', im_status || 'OPEN', userId
        ];
        
        const result = await req.dbPool.query(sql, values);
        res.status(201).json(result.rows[0]);

    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ message: 'Period number already exists for this Fiscal Year.', error: error.message });
        }
        console.error('Error creating period:', error);
        res.status(500).json({ message: 'Error creating new period.', error: error.message });
    }
};

// 4. PUT Update Single Period (เพื่อแก้ไขวันที่เริ่มต้น-สิ้นสุด)
const updateDetailRow = async (req, res) => {
    const { id } = req.params;
    const { 
        period_name, period_start_date, period_end_date 
    } = req.body; // ไม่อนุญาตให้แก้ไข ID, FY_ID, Period_Number ผ่านฟังก์ชันนี้
    const userId = req.headers.userid;
    const userName = req.headers.username;
    
    try {
        const sql = `
            UPDATE gl_posting_period SET 
                period_name = $1, 
                period_start_date = $2, 
                period_end_date = $3, 
                updated_by = $4,
                updated_at = NOW()
            WHERE id = $5 AND gl_status = 'OPEN' -- อนุญาตให้อัปเดตเฉพาะ Period ที่ยังไม่ปิด
            RETURNING *`;
            
        const values = [
            period_name, period_start_date, period_end_date, userId, id
        ];
        
        const result = await req.dbPool.query(sql, values);

        if (result.rows.length === 0) {
            // ตรวจสอบว่าไม่พบ ID หรือ Period ถูกปิดแล้ว
            const checkClosed = await req.dbPool.query('SELECT gl_status FROM gl_posting_period WHERE id = $1', [id]);
            if (checkClosed.rows.length > 0 && checkClosed.rows[0].gl_status !== 'OPEN') {
                return res.status(403).json({ message: 'Cannot modify period dates. Period is already closed or soft-closed.' });
            }
            return res.status(404).json({ message: 'Posting Period not found for update.' });
        }

        res.status(200).json(result.rows[0]);

    } catch (error) {
        console.error('Error updating period:', error);
        res.status(500).json({ message: 'Error updating period details.', error: error.message });
    }
};

// 5. DELETE Single Period (สำหรับลบ Period ที่สร้างผิดพลาด หรือ Period พิเศษที่ยังไม่ถูกใช้)
const deleteDetailRow = async (req, res) => {
    const { id } = req.params;
    try {
        // จำกัดการลบเฉพาะ Period ที่ยังไม่ถูกใช้ลงบัญชี (gl_status = OPEN)
        const result = await req.dbPool.query('DELETE FROM gl_posting_period WHERE id = $1 AND gl_status = $2 RETURNING id', [id, 'OPEN']);
        
        if (result.rows.length === 0) {
            // ตรวจสอบว่า Period ถูกปิดแล้วหรือไม่
            const checkClosed = await req.dbPool.query('SELECT gl_status FROM gl_posting_period WHERE id = $1', [id]);
            if (checkClosed.rows.length > 0 && checkClosed.rows[0].gl_status !== 'OPEN') {
                return res.status(403).json({ message: 'Cannot delete period. Period is already closed or soft-closed.' });
            }
            return res.status(404).json({ message: 'Posting Period not found or cannot be deleted.' });
        }
        
        res.status(200).json({ message: 'Period successfully deleted.', id: id });
    } catch (error) {
        // ตรวจสอบ Foreign Key Violation (ถ้ามีรายการบัญชีลงใน Period นี้แล้ว)
        if (error.code === '23503') { 
            return res.status(400).json({ message: 'Cannot delete period. Transactions have been posted to this period.', error: error.message });
        }
        console.error('Error deleting period:', error);
        res.status(500).json({ message: 'Error deleting period.', error: error.message });
    }
};

module.exports = {
    fetchHeaderRows,
    fetchHeaderRowById,
    addHeaderRow,
    updateHeaderRow,
    deleteHeaderRow,
    fetchDetailRows,
    addDetailRow,
    updateDetailRow,
    updateStatusDetailRow,
    deleteDetailRow,
};
//     fetchRows,
//     addRow,
//     updateRow,
//     deleteRow,
//     deleteRows,
//     importDataExcel,
//     exportDataExcel,
// };