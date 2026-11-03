// controllers/ap/apResetController.js — ล้างข้อมูลหลัก/การตั้งค่าของ AP (เครื่องมือผู้พัฒนาระบบ)
// ธุรกรรมล้างที่หน้าจอ "ล้างธุรกรรมทุกโมดูล" (saSystemResetController) — ต้องไม่มีธุรกรรมค้างก่อนจึงจะล้างที่นี่ได้
const { transactionTotal, rejectIfTransactions } = require('../../utils/resetGuard');

async function _checkDeveloper(req) {
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

async function _countTable(pool, tableName, whereClause = '') {
    try {
        const exists = await pool.query(
            "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
            [tableName]
        );
        if (exists.rowCount === 0) return 0;
        const sql = `SELECT COUNT(*) FROM ${tableName}${whereClause ? ' WHERE ' + whereClause : ''}`;
        const r = await pool.query(sql);
        return parseInt(r.rows[0].count, 10);
    } catch (_) {
        return 0;
    }
}

// GET /ap_reset_master/counts
const getCounts = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    try {
        const [
            transactionsTotal, vendorCount, vendorGroupCount, glAccountSetupCount,
        ] = await Promise.all([
            transactionTotal(req.dbPool),
            _countTable(req.dbPool, 'ap_vendor'),
            _countTable(req.dbPool, 'ap_vendor_group'),
            _countTable(req.dbPool, 'ap_gl_account_setup'),
        ]);

        let vendorRunning = null;
        try {
            const r = await req.dbPool.query(
                `SELECT is_auto_numbering, next_running_number FROM ap_vendor_running ORDER BY id LIMIT 1`
            );
            vendorRunning = r.rows[0] || null;
        } catch (_) {}

        let yearEndConfigured = false;
        try {
            const r = await req.dbPool.query(`
                SELECT 1 FROM ap_year_end_setup
                WHERE fx_gain_account_id IS NOT NULL OR fx_loss_account_id IS NOT NULL
                   OR unrealized_fx_gain_account_id IS NOT NULL OR unrealized_fx_loss_account_id IS NOT NULL
                   OR fx_reval_gl_doc_id IS NOT NULL
                LIMIT 1
            `);
            yearEndConfigured = r.rows.length > 0;
        } catch (_) {}

        res.json({
            transactions_total:     transactionsTotal,
            ap_vendor:              vendorCount,
            ap_vendor_group:        vendorGroupCount,
            ap_gl_account_setup:    glAccountSetupCount,
            ap_vendor_running:      vendorRunning,
            ap_year_end_setup_configured: yearEndConfigured,
        });
    } catch (error) {
        console.error('Error getting AP reset counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /ap_reset_master
const resetMasterData = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    if (await rejectIfTransactions(req, res)) return;

    const {
        resetVendors        = false,
        resetVendorGroups   = false,
        resetGlAccountSetup = false,
        resetYearEndSetup   = false,
        resetVendorRunning  = false,
    } = req.body;

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const deleted = {};
        const errors  = {};

        // savepoint แยกขั้นตอน — ขั้นตอนที่ติด FK (เช่น ลบกลุ่มผู้ขายโดยไม่ลบผู้ขาย) ล้มเฉพาะขั้นตอนนั้น และแจ้งใน errors
        const runStep = async (key, fn) => {
            await client.query(`SAVEPOINT sp_${key}`);
            try {
                await fn();
                await client.query(`RELEASE SAVEPOINT sp_${key}`);
            } catch (err) {
                await client.query(`ROLLBACK TO SAVEPOINT sp_${key}`);
                await client.query(`RELEASE SAVEPOINT sp_${key}`);
                errors[key] = err.message;
            }
        };

        // ผู้ขาย (ที่อยู่/ผู้ติดต่อ/บัญชีธนาคาร ลบตาม CASCADE) — ลบก่อนกลุ่มผู้ขายเพื่อให้ FK vendor_group_id ว่างก่อน
        if (resetVendors) {
            await runStep('ap_vendor', async () => {
                const r = await client.query(`DELETE FROM ap_vendor RETURNING id`);
                deleted.ap_vendor = r.rowCount;
            });
        }

        if (resetVendorGroups) {
            await runStep('ap_vendor_group', async () => {
                const r = await client.query(`DELETE FROM ap_vendor_group RETURNING id`);
                deleted.ap_vendor_group = r.rowCount;
            });
        }

        // ตั้งค่าเชื่อมต่อ GL (mapping ตามประเภทเอกสาร/วิธีชำระเงิน)
        if (resetGlAccountSetup) {
            await runStep('ap_gl_account_setup', async () => {
                const r = await client.query(`DELETE FROM ap_gl_account_setup RETURNING id`);
                deleted.ap_gl_account_setup = r.rowCount;
            });
        }

        // ตั้งค่าปิดสิ้นปี: คืนค่าบัญชี FX และประเภทเอกสาร GL ของการตีราคาเป็นค่าว่าง
        if (resetYearEndSetup) {
            await runStep('ap_year_end_setup', async () => {
                await client.query(`
                    UPDATE ap_year_end_setup SET
                        fx_gain_account_id = NULL, fx_loss_account_id = NULL,
                        unrealized_fx_gain_account_id = NULL, unrealized_fx_loss_account_id = NULL,
                        fx_reval_gl_doc_id = NULL,
                        updated_at = NOW()
                `);
                deleted.ap_year_end_setup_reset = true;
            });
        }

        // ตั้งค่ารหัสผู้ขายอัตโนมัติ: คืนค่าเป็นค่าเริ่มต้น
        if (resetVendorRunning) {
            await runStep('ap_vendor_running', async () => {
                await client.query(`
                    UPDATE ap_vendor_running SET
                        is_auto_numbering = false, format_prefix = 'VENDOR',
                        format_separator = '-', format_suffix_date = '',
                        running_length = 4, next_running_number = 1,
                        updated_at = NOW()
                `);
                deleted.ap_vendor_running_reset = true;
            });
        }

        await client.query('COMMIT');
        console.log('AP master reset completed:', deleted, errors);
        const failed = Object.keys(errors).length > 0;
        res.json({ message: failed ? 'ดำเนินการแล้ว แต่บางรายการล้างไม่สำเร็จ' : 'ดำเนินการสำเร็จ', deleted, errors });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resetting AP master data:', error);
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetMasterData };
