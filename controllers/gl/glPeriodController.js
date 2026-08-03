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
                SUM(CASE WHEN p.gl_status = 'CLOSED' THEN 1 ELSE 0 END) AS closed_periods
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
        await ensureCloseRequestTable(req.dbPool);
        const query = `
            SELECT p.*,
                   cr.id AS close_request_id,
                   cr.requested_by AS close_requested_by,
                   cr.requested_by_name AS close_requested_by_name,
                   (SELECT json_agg(json_build_object(
                        'approver_user_id', ca.approver_user_id,
                        'approver_user_name', ca.approver_user_name,
                        'sequence_no', ca.sequence_no,
                        'status', ca.status
                    ) ORDER BY ca.sequence_no)
                    FROM gl_period_close_approval ca WHERE ca.request_id = cr.id) AS close_approvals
            FROM gl_posting_period p
            LEFT JOIN gl_period_close_request cr ON cr.period_id = p.id AND cr.status = 'Pending'
            WHERE p.fiscal_year_id = $1
            ORDER BY p.period_number;
        `;
        const result = await req.dbPool.query(query, [fyId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching posting periods:', error);
        res.status(500).json({ message: 'Error fetching posting periods.', error: error.message });
    }
};

// Helper: ensure cm_status column exists on gl_posting_period
const ensureCmStatusColumn = async (pool) => {
    try {
        await pool.query(`
            ALTER TABLE gl_posting_period
            ADD COLUMN IF NOT EXISTS cm_status VARCHAR(10) NOT NULL DEFAULT 'OPEN'`);
    } catch (_) { /* ignore if table doesn't exist yet */ }
};

// Helper: ensure gl_period_close_request(+approval) tables exist (approval workflow for closing a GL period)
// และขยาย gl_status ให้รองรับค่า 'PENDING_CLOSE' (13 ตัวอักษร)
const ensureCloseRequestTable = async (pool) => {
    try {
        await pool.query(`ALTER TABLE gl_posting_period ALTER COLUMN gl_status TYPE VARCHAR(20)`);
    } catch (_) { /* ignore */ }
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS gl_period_close_request (
                id                  SERIAL PRIMARY KEY,
                period_id           INTEGER NOT NULL REFERENCES gl_posting_period(id) ON DELETE CASCADE,
                previous_status     VARCHAR(20) NOT NULL,
                requested_by        INTEGER,
                requested_by_name   VARCHAR(100),
                requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                approver_user_id    INTEGER,
                approver_user_name  VARCHAR(100),
                status              VARCHAR(20) NOT NULL DEFAULT 'Pending',
                remarks             TEXT,
                approved_at         TIMESTAMPTZ
            )`);
    } catch (_) { /* ignore if table doesn't exist yet */ }
    // เดิม approver_user_id เป็น NOT NULL (ผู้อนุมัติเดี่ยว) — ตอนนี้เปลี่ยนเป็นผู้อนุมัติหลายคนแบบมีลำดับ
    // ผ่านตาราง gl_period_close_approval แทน คอลัมน์นี้เก็บไว้เฉยๆ เพื่อความเข้ากันได้ย้อนหลัง
    try {
        await pool.query(`ALTER TABLE gl_period_close_request ALTER COLUMN approver_user_id DROP NOT NULL`);
    } catch (_) { /* ignore */ }
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS gl_period_close_approval (
                id                  SERIAL PRIMARY KEY,
                request_id          INTEGER NOT NULL REFERENCES gl_period_close_request(id) ON DELETE CASCADE,
                approver_user_id    INTEGER NOT NULL,
                approver_user_name  VARCHAR(100),
                sequence_no         INTEGER NOT NULL,
                status              VARCHAR(20) NOT NULL DEFAULT 'Pending',
                remarks             TEXT,
                approved_at         TIMESTAMPTZ
            )`);
    } catch (_) { /* ignore */ }
};

// GET period cm_status for a given date (used by Flutter CM period check)
const getCmStatusForDate = async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'ต้องระบุ date' });
    try {
        await ensureCmStatusColumn(req.dbPool);
        const result = await req.dbPool.query(`
            SELECT p.id, p.period_name, p.period_start_date, p.period_end_date,
                   COALESCE(p.cm_status,'OPEN') AS cm_status
            FROM gl_posting_period p
            JOIN gl_fiscal_year fy ON fy.id=p.fiscal_year_id
            WHERE fy.is_active=true
              AND p.period_start_date::date <= $1::date
              AND p.period_end_date::date   >= $1::date
            ORDER BY p.period_start_date DESC LIMIT 1`, [date]);
        if (!result.rows.length) return res.json({ cm_status: null, message: 'ไม่พบงวดบัญชี' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// 2. PUT Update Period Status (เช่น ปิดรอบบัญชี GL)
const updateStatusDetailRow = async (req, res) => {
    const { id } = req.params;
    const { gl_status, ap_status, ar_status, im_status, cm_status } = req.body;
    const userId = req.headers.userid;
    const userName = req.headers.username;

    if (gl_status === 'CLOSED' || gl_status === 'PENDING_CLOSE') {
        return res.status(400).json({
            error: 'การปิดงวดบัญชี GL ต้องดำเนินการผ่านขั้นตอนขออนุมัติปิดงวด (request_close) เท่านั้น ไม่สามารถเปลี่ยนสถานะโดยตรงได้'
        });
    }

    try {
        await ensureCmStatusColumn(req.dbPool);
        // ตรวจสอบรายการ Draft ก่อน CLOSED
        const hasClose = [gl_status, ap_status, ar_status, im_status, cm_status].some(s => s === 'CLOSED');
        if (hasClose) {
            const draftCheck = await req.dbPool.query(
                `SELECT COUNT(*) FROM gl_entry_header WHERE period_id = $1 AND status = 'Draft'`,
                [id]
            );
            const draftCount = parseInt(draftCheck.rows[0].count);
            if (draftCount > 0) {
                return res.status(400).json({
                    error: `มีรายการบัญชีที่ยังอยู่ในสถานะ Draft จำนวน ${draftCount} รายการ ไม่สามารถเปลี่ยนสถานะเป็น CLOSED ได้`
                });
            }
        }

        // SQL: อนุญาตให้อัปเดตสถานะ GL, AP, AR, IM, CM พร้อมกัน
        const sql = `
            UPDATE gl_posting_period SET
                gl_status = COALESCE($1, gl_status),
                ap_status = COALESCE($2, ap_status),
                ar_status = COALESCE($3, ar_status),
                im_status = COALESCE($4, im_status),
                cm_status = COALESCE($5, cm_status),
                updated_by = $6,
                updated_at = NOW()
            WHERE id = $7
            RETURNING *`;

        const values = [
            gl_status, ap_status, ar_status, im_status, cm_status, userId, id
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
                gl_status, ap_status, ar_status, im_status, cm_status, updated_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`;

        const values = [
            fiscal_year_id, period_number, period_name, period_start_date,
            period_end_date, gl_status || 'LOCKED', ap_status || 'LOCKED',
            ar_status || 'LOCKED', im_status || 'LOCKED',
            (req.body.cm_status) || 'LOCKED', userId
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

// GET All Posting Periods where gl_status = 'OPEN' and fiscal year is_active = true
const fetchOpenGlPeriods = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            `SELECT p.* FROM gl_posting_period p
             JOIN gl_fiscal_year fy ON fy.id = p.fiscal_year_id
             WHERE p.gl_status = 'OPEN' AND fy.is_active = true
             ORDER BY p.period_start_date`
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching open GL periods:', error);
        res.status(500).json({ message: 'Error fetching open GL periods.', error: error.message });
    }
};

// ตรวจสอบ credentials + สิทธิ์อนุมัติการปิดงวดบัญชี
const verifyCloseApprover = async (req, res) => {
    const bcrypt = require('bcrypt');
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อผู้ใช้และรหัสผ่าน' });
    }
    try {
        const userResult = await req.dbPool.query(
            `SELECT id, password_hash, full_name, status FROM sa_user WHERE user_name = $1`,
            [username.trim()]
        );
        if (userResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }
        const user = userResult.rows[0];

        if (user.status !== 'active') {
            return res.status(403).json({ success: false, message: 'ผู้ใช้ถูกระงับการใช้งาน' });
        }

        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
        }

        const permResult = await req.dbPool.query(
            `SELECT 1 FROM sa_group_user gu
             JOIN sa_group g ON g.id = gu.group_id
             WHERE gu.user_id = $1 AND g.can_close_period = true
             LIMIT 1`,
            [user.id]
        );
        if (permResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'ผู้ใช้ไม่มีสิทธิ์อนุมัติการปิดงวดบัญชี' });
        }

        return res.json({ success: true, approverName: user.full_name });
    } catch (error) {
        console.error('Error verifying close approver:', error);
        return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดภายในระบบ' });
    }
};

// ── GL Period Close Approval Workflow ─────────────────────────────────────
// ขอปิดงวดบัญชี GL (ต้องผ่านผู้อนุมัติที่ตั้งค่าไว้ใน sa_module_approver ก่อนจึงจะ CLOSED จริง)
// รองรับผู้อนุมัติหลายคนแบบมีลำดับ เหมือน AP Payment Run
const requestClose = async (req, res) => {
    const { id } = req.params;
    const { menu_id } = req.body || {};
    const userId = req.headers.userid;
    const userName = req.headers.username;
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    if (!menu_id) return res.status(400).json({ message: 'ต้องระบุ menu_id' });
    const client = await req.dbPool.connect();
    try {
        await ensureCloseRequestTable(client);
        const { ensureMenuApproverSchema, syncMenuApprovers } = require('../../utils/menuApproverSync');
        await ensureMenuApproverSchema(client);
        try { await client.query(`ALTER TABLE gl_period_close_request ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(10) DEFAULT 'ALL'`); } catch (_) {}
        await client.query('BEGIN');
        await syncMenuApprovers(client, menu_id);

        const periodRes = await client.query(`SELECT * FROM gl_posting_period WHERE id=$1 FOR UPDATE`, [id]);
        if (periodRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบงวดบัญชี' }); }
        const period = periodRes.rows[0];

        if (period.gl_status === 'CLOSED') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'งวดบัญชีนี้ปิดแล้ว' }); }
        if (period.gl_status === 'PENDING_CLOSE') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'งวดบัญชีนี้มีคำขอปิดงวดที่รออนุมัติอยู่แล้ว' }); }

        const notClosed = [];
        if (period.ap_status !== 'CLOSED') notClosed.push('AP');
        if (period.ar_status !== 'CLOSED') notClosed.push('AR');
        if (period.cm_status !== 'CLOSED') notClosed.push('CM');
        if (period.im_status !== 'CLOSED') notClosed.push('IM');
        if (notClosed.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `ต้องปิดงวดบัญชีของโมดูล ${notClosed.join(', ')} ให้ครบก่อน จึงจะขอปิดงวด GL ได้` });
        }

        const draftCheck = await client.query(
            `SELECT COUNT(*) FROM gl_entry_header WHERE period_id = $1 AND status = 'Draft'`, [id]);
        const draftCount = parseInt(draftCheck.rows[0].count);
        if (draftCount > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `มีรายการบัญชีที่ยังอยู่ในสถานะ Draft จำนวน ${draftCount} รายการ ไม่สามารถขอปิดงวดได้` });
        }

        const menuRes = await client.query(`SELECT approval_mode FROM sa_menu WHERE id=$1`, [menu_id]);
        const approvalMode = menuRes.rows[0]?.approval_mode === 'ANY' ? 'ANY' : 'ALL';

        const approvers = await client.query(`
            SELECT a.approval_level, a.approver_user_id, u.user_name
            FROM sa_module_approver a
            JOIN sa_user u ON u.id = a.approver_user_id
            WHERE a.menu_id=$1 AND a.is_active=true
            ORDER BY a.approval_level`, [menu_id]);

        if (approvers.rows.length === 0) {
            // ไม่มีผู้มีสิทธิ์อนุมัติเลย หรือถูกงดอนุมัติหมดทุกคน — admin ไม่ต้องการอนุมัติสำหรับเมนูนี้
            // ข้ามขั้นตอนอนุมัติไปเลยโดยไม่ต้องแจ้งเตือน ปิดงวดตรงทันที
            await client.query(
                `UPDATE gl_posting_period SET gl_status='CLOSED', updated_by=$1, updated_at=NOW() WHERE id=$2`,
                [userId, id]);
            await client.query('COMMIT');
            return res.status(200).json({ message: 'ปิดงวดบัญชีสำเร็จ' });
        }

        const insertRes = await client.query(`
            INSERT INTO gl_period_close_request
                (period_id, previous_status, requested_by, requested_by_name, status, approval_mode)
            VALUES ($1,$2,$3,$4,'Pending',$5)
            RETURNING id`,
            [id, period.gl_status, userId, userName, approvalMode]);
        const requestId = insertRes.rows[0].id;

        for (const apr of approvers.rows) {
            await client.query(`
                INSERT INTO gl_period_close_approval (request_id, approver_user_id, approver_user_name, sequence_no, status)
                VALUES ($1,$2,$3,$4,'Pending')`,
                [requestId, apr.approver_user_id, apr.user_name, apr.approval_level]);
        }

        await client.query(
            `UPDATE gl_posting_period SET gl_status='PENDING_CLOSE', updated_by=$1, updated_at=NOW() WHERE id=$2`,
            [userId, id]);

        await client.query('COMMIT');
        res.status(200).json({
            message: `ส่งคำขอปิดงวดบัญชีสำเร็จ รอการอนุมัติจาก ${approvers.rows.map(a => a.user_name).join(', ')}`,
            requestId,
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error requesting period close:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

// อนุมัติคำขอปิดงวด (ต้องเป็นผู้อนุมัติลำดับที่รอดำเนินการอยู่ในคิว — ลำดับก่อนหน้าต้องอนุมัติครบก่อน)
const approveCloseRequest = async (req, res) => {
    const { id } = req.params;
    const { remarks } = req.body || {};
    const userId = req.headers.userid;
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const reqRes = await client.query(`SELECT * FROM gl_period_close_request WHERE id=$1 FOR UPDATE`, [id]);
        if (reqRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบคำขอ' }); }
        const request = reqRes.rows[0];
        if (request.status !== 'Pending') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }); }
        const isAnyMode = request.approval_mode === 'ANY';

        // โหมด ALL: ต้องไม่มีลำดับก่อนหน้ายัง Pending อยู่ / โหมด ANY: ใครอนุมัติก่อนก็จบเลย ไม่ต้องรอลำดับ
        const myRecord = await client.query(`
            SELECT a.id FROM gl_period_close_approval a
            WHERE a.request_id=$1 AND a.approver_user_id=$2 AND a.status='Pending'
              AND ($3::boolean OR NOT EXISTS (
                SELECT 1 FROM gl_period_close_approval a2
                WHERE a2.request_id=$1 AND a2.sequence_no < a.sequence_no AND a2.status='Pending'
              ))`, [id, userId, isAnyMode]);
        if (myRecord.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'ไม่มีสิทธิ์อนุมัติ หรือยังรอการอนุมัติจากลำดับก่อนหน้า' });
        }

        // ตรวจซ้ำก่อนอนุมัติจริง (กันกรณีสถานะโมดูลอื่นเปลี่ยนไปหลังจากขอ)
        const periodRes = await client.query(`SELECT * FROM gl_posting_period WHERE id=$1`, [request.period_id]);
        const period = periodRes.rows[0];
        const notClosed = [];
        if (period.ap_status !== 'CLOSED') notClosed.push('AP');
        if (period.ar_status !== 'CLOSED') notClosed.push('AR');
        if (period.cm_status !== 'CLOSED') notClosed.push('CM');
        if (period.im_status !== 'CLOSED') notClosed.push('IM');
        if (notClosed.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `ไม่สามารถอนุมัติได้ เนื่องจากโมดูล ${notClosed.join(', ')} ยังไม่ได้ปิดงวด` });
        }
        const draftCheck = await client.query(
            `SELECT COUNT(*) FROM gl_entry_header WHERE period_id=$1 AND status='Draft'`, [request.period_id]);
        if (parseInt(draftCheck.rows[0].count) > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ไม่สามารถอนุมัติได้ เนื่องจากมีรายการบัญชีที่ยังอยู่ในสถานะ Draft' });
        }

        await client.query(
            `UPDATE gl_period_close_approval SET status='Approved', remarks=$1, approved_at=NOW() WHERE id=$2`,
            [remarks || null, myRecord.rows[0].id]);

        if (isAnyMode) {
            // คนใดคนหนึ่งอนุมัติก็พอ — แถวที่เหลือของคนอื่นเปลี่ยนเป็น Skipped แล้วปิดงวดทันที
            await client.query(
                `UPDATE gl_period_close_approval SET status='Skipped' WHERE request_id=$1 AND status='Pending'`, [id]);
            await client.query(
                `UPDATE gl_period_close_request SET status='Approved', approved_at=NOW() WHERE id=$1`, [id]);
            await client.query(
                `UPDATE gl_posting_period SET gl_status='CLOSED', updated_by=$1, updated_at=NOW() WHERE id=$2`,
                [userId, request.period_id]);
        } else {
            const remaining = await client.query(
                `SELECT COUNT(*) FROM gl_period_close_approval WHERE request_id=$1 AND status='Pending'`, [id]);
            if (parseInt(remaining.rows[0].count) === 0) {
                await client.query(
                    `UPDATE gl_period_close_request SET status='Approved', approved_at=NOW() WHERE id=$1`, [id]);
                await client.query(
                    `UPDATE gl_posting_period SET gl_status='CLOSED', updated_by=$1, updated_at=NOW() WHERE id=$2`,
                    [userId, request.period_id]);
            }
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'อนุมัติสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error approving close request:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

// ปฏิเสธคำขอปิดงวด (ผู้อนุมัติคนใดก็ได้ในคิวที่ยัง Pending) — คืนสถานะ gl_status กลับเป็นค่าก่อนขอ
const rejectCloseRequest = async (req, res) => {
    const { id } = req.params;
    const { remarks } = req.body || {};
    const userId = req.headers.userid;
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    if (!remarks || !String(remarks).trim()) return res.status(400).json({ message: 'กรุณาระบุเหตุผลที่ปฏิเสธ' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const reqRes = await client.query(`SELECT * FROM gl_period_close_request WHERE id=$1 FOR UPDATE`, [id]);
        if (reqRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบคำขอ' }); }
        const request = reqRes.rows[0];
        if (request.status !== 'Pending') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }); }

        const myRecord = await client.query(`
            SELECT id FROM gl_period_close_approval
            WHERE request_id=$1 AND approver_user_id=$2 AND status='Pending'`, [id, userId]);
        if (myRecord.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'ไม่มีสิทธิ์ปฏิเสธหรืออนุมัติไปแล้ว' });
        }

        await client.query(
            `UPDATE gl_period_close_approval SET status='Rejected', remarks=$1, approved_at=NOW() WHERE id=$2`,
            [remarks, myRecord.rows[0].id]);
        await client.query(
            `UPDATE gl_period_close_request SET status='Rejected', remarks=$1, approved_at=NOW() WHERE id=$2`,
            [remarks, id]);
        await client.query(
            `UPDATE gl_posting_period SET gl_status=$1, updated_by=$2, updated_at=NOW() WHERE id=$3`,
            [request.previous_status, userId, request.period_id]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'ปฏิเสธคำขอปิดงวดบัญชีสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error rejecting close request:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

// ยกเลิกคำขอปิดงวด (เฉพาะผู้ที่ส่งคำขอ) — คืนสถานะ gl_status กลับเป็นค่าก่อนขอ
const cancelCloseRequest = async (req, res) => {
    const { id } = req.params;
    const userId = req.headers.userid;
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const reqRes = await client.query(`SELECT * FROM gl_period_close_request WHERE id=$1 FOR UPDATE`, [id]);
        if (reqRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบคำขอ' }); }
        const request = reqRes.rows[0];
        if (request.status !== 'Pending') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'คำขอนี้ถูกดำเนินการไปแล้ว' }); }
        if (String(request.requested_by) !== String(userId)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'ยกเลิกได้เฉพาะผู้ที่ส่งคำขอเท่านั้น' });
        }

        await client.query(`UPDATE gl_period_close_request SET status='Cancelled', approved_at=NOW() WHERE id=$1`, [id]);
        await client.query(
            `UPDATE gl_posting_period SET gl_status=$1, updated_by=$2, updated_at=NOW() WHERE id=$3`,
            [request.previous_status, userId, request.period_id]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'ยกเลิกคำขอปิดงวดบัญชีสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error cancelling close request:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
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
    fetchOpenGlPeriods,
    verifyCloseApprover,
    getCmStatusForDate,
    requestClose,
    approveCloseRequest,
    rejectCloseRequest,
    cancelCloseRequest,
};
//     fetchRows,
//     addRow,
//     updateRow,
//     deleteRow,
//     deleteRows,
//     importDataExcel,
//     exportDataExcel,
// };