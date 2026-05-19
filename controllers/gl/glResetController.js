// controllers/gl/glResetController.js
const jwt = require('jsonwebtoken');

// ตรวจว่า requester เป็น developer (user_type = 'developer')
async function _checkDeveloper(req, res) {
    const userId = req.headers['userid'];
    if (!userId) return false;
    try {
        const result = await req.dbPool.query(
            "SELECT user_type FROM sa_user WHERE id = $1", [userId]
        );
        return result.rows[0]?.user_type === 'developer';
    } catch (_) {
        return false;
    }
}

// helper: count rows in a table, returns 0 if table doesn't exist
async function _countTable(pool, tableName) {
    try {
        const exists = await pool.query(
            "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
            [tableName]
        );
        if (exists.rowCount === 0) return 0;
        const r = await pool.query(`SELECT COUNT(*) FROM ${tableName}`);
        return parseInt(r.rows[0].count, 10);
    } catch (_) {
        return 0;
    }
}

// GET /gl_reset_transactions/counts — จำนวน record ที่จะถูกลบ
const getCounts = async (req, res) => {
    if (!(await _checkDeveloper(req, res))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    try {
        const [headerCount, detailCount, closingCount] = await Promise.all([
            _countTable(req.dbPool, 'gl_entry_header'),
            _countTable(req.dbPool, 'gl_entry_detail'),
            _countTable(req.dbPool, 'gl_year_end_closing'),
        ]);

        let glDocCount = 0;
        try {
            const docResult = await req.dbPool.query(`
                SELECT COUNT(*) FROM sa_doc_number_branch dnb
                JOIN sa_module_document md ON md.id = dnb.doc_id
                WHERE md.sys_module = '01' AND dnb.next_running_number > 1
            `);
            glDocCount = parseInt(docResult.rows[0].count, 10);
        } catch (_) {}

        res.json({
            gl_entry_header:    headerCount,
            gl_entry_detail:    detailCount,
            gl_year_end_closing: closingCount,
            gl_doc_number_rows: glDocCount,
        });
    } catch (error) {
        console.error('Error getting reset counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /gl_reset_transactions — ลบข้อมูลธุรกรรมตามที่เลือก
const resetTransactions = async (req, res) => {
    if (!(await _checkDeveloper(req, res))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }

    const {
        deleteEntries = true,
        resetDocNumbers = false,
    } = req.body;

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const deleted = {};

        if (deleteEntries) {
            // 1. ลบ gl_year_end_closing ก่อน (FK → gl_entry_header)
            //    ใช้ SAVEPOINT เพราะถ้าตารางยังไม่มีจะไม่ abort transaction หลัก
            await client.query('SAVEPOINT sp_closing');
            try {
                const r = await client.query('DELETE FROM gl_year_end_closing');
                deleted.gl_year_end_closing = r.rowCount;
                await client.query('RELEASE SAVEPOINT sp_closing');
            } catch (_) {
                await client.query('ROLLBACK TO SAVEPOINT sp_closing');
                deleted.gl_year_end_closing = 0;
            }

            // 2. ลบ gl_entry_detail (FK → gl_entry_header)
            const detailRes = await client.query('DELETE FROM gl_entry_detail');
            deleted.gl_entry_detail = detailRes.rowCount;

            // 3. ลบ gl_entry_header
            const headerRes = await client.query('DELETE FROM gl_entry_header');
            deleted.gl_entry_header = headerRes.rowCount;
        }

        if (resetDocNumbers) {
            await client.query('SAVEPOINT sp_docnum');
            try {
                await client.query(`
                    UPDATE sa_doc_number_branch SET next_running_number = 1
                    WHERE doc_id IN (SELECT id FROM sa_module_document WHERE sys_module = '01')
                `);
                await client.query(`
                    UPDATE sa_module_document SET next_running_number = 1
                    WHERE sys_module = '01'
                `);
                await client.query('RELEASE SAVEPOINT sp_docnum');
                deleted.doc_numbers_reset = true;
            } catch (e) {
                await client.query('ROLLBACK TO SAVEPOINT sp_docnum');
                deleted.doc_numbers_reset = false;
                console.error('Error resetting GL doc numbers:', e.message);
            }
        }

        await client.query('COMMIT');
        console.log('GL reset completed:', deleted);
        res.json({ message: 'ลบข้อมูลธุรกรรมสำเร็จ', deleted });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resetting GL transactions:', error);
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetTransactions };
