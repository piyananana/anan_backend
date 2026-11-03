// controllers/ar/arResetController.js — ล้างข้อมูลหลัก/การตั้งค่าของ AR (เครื่องมือผู้พัฒนาระบบ)
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

// GET /ar_reset_master/counts
const getCounts = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    try {
        const [
            transactionsTotal,
            customerCount, customerGroupCount, collectorCount,
            glAccountSetupCount, allowanceRuleCount,
        ] = await Promise.all([
            transactionTotal(req.dbPool),
            _countTable(req.dbPool, 'ar_customer'),
            _countTable(req.dbPool, 'ar_customer_group'),
            _countTable(req.dbPool, 'ar_collector'),
            _countTable(req.dbPool, 'ar_gl_account_setup'),
            _countTable(req.dbPool, 'ar_allowance_rule'),
        ]);

        let customerRunning = null;
        try {
            const r = await req.dbPool.query(
                `SELECT is_auto_numbering, next_running_number FROM ar_customer_running ORDER BY id LIMIT 1`
            );
            customerRunning = r.rows[0] || null;
        } catch (_) {}

        let yearEndConfigured = false;
        try {
            const r = await req.dbPool.query(`
                SELECT 1 FROM ar_year_end_setup
                WHERE fx_gain_account_id IS NOT NULL OR fx_loss_account_id IS NOT NULL
                   OR unrealized_fx_gain_account_id IS NOT NULL OR unrealized_fx_loss_account_id IS NOT NULL
                   OR allowance_expense_account_id IS NOT NULL OR allowance_contra_account_id IS NOT NULL
                   OR fx_reval_gl_doc_id IS NOT NULL OR allowance_gl_doc_id IS NOT NULL
                LIMIT 1
            `);
            yearEndConfigured = r.rows.length > 0;
        } catch (_) {}

        res.json({
            transactions_total:     transactionsTotal,
            ar_customer:            customerCount,
            ar_customer_group:      customerGroupCount,
            ar_collector:           collectorCount,
            ar_gl_account_setup:    glAccountSetupCount,
            ar_allowance_rule:      allowanceRuleCount,
            ar_customer_running:    customerRunning,
            ar_year_end_setup_configured: yearEndConfigured,
        });
    } catch (error) {
        console.error('Error getting AR reset counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /ar_reset_master
const resetMasterData = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    if (await rejectIfTransactions(req, res)) return;

    const {
        resetCustomers = false,
        resetCustomerGroups = false,
        resetCollectors = false,
        resetGlAccountSetup = false,
        resetYearEndSetup = false,
        resetCustomerRunning = false,
    } = req.body;

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const deleted = {};
        const errors = {};

        // savepoint แยกขั้นตอน — ขั้นตอนที่ติด FK (เช่น ลบกลุ่มลูกค้าโดยไม่ลบลูกค้า) ล้มเฉพาะขั้นตอนนั้น และแจ้งใน errors
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

        // ลูกค้า (และข้อมูลย่อย: ที่อยู่/ผู้ติดต่อ/บัญชีธนาคาร/เงื่อนไขวางบิล-รับชำระ/พนักงานขาย — ลบตาม CASCADE)
        // ลบก่อนกลุ่มลูกค้า/ผู้วางบิล เพื่อให้ FK customer_group_id, billing/collection_collector_id ว่างก่อน
        if (resetCustomers) {
            await runStep('ar_customer', async () => {
                const r = await client.query(`DELETE FROM ar_customer RETURNING id`);
                deleted.ar_customer = r.rowCount;
            });
        }

        // กลุ่มลูกค้า (เงื่อนไขวางบิล/รับชำระของกลุ่ม ลบตาม CASCADE)
        if (resetCustomerGroups) {
            await runStep('ar_customer_group', async () => {
                const r = await client.query(`DELETE FROM ar_customer_group RETURNING id`);
                deleted.ar_customer_group = r.rowCount;
            });
        }

        // ผู้วางบิล/รับชำระ
        if (resetCollectors) {
            await runStep('ar_collector', async () => {
                const r = await client.query(`DELETE FROM ar_collector RETURNING id`);
                deleted.ar_collector = r.rowCount;
            });
        }

        // ตั้งค่าเชื่อมต่อ GL (mapping ตามประเภทเอกสาร/วิธีชำระเงิน)
        if (resetGlAccountSetup) {
            await runStep('ar_gl_account_setup', async () => {
                const r = await client.query(`DELETE FROM ar_gl_account_setup RETURNING id`);
                deleted.ar_gl_account_setup = r.rowCount;
            });
        }

        // ตั้งค่าปิดสิ้นปี: คืนค่าบัญชี FX/Allowance เป็นค่าว่าง และคืน % สำรองหนี้สูญเป็นค่าเริ่มต้น
        if (resetYearEndSetup) {
            await runStep('ar_year_end_setup', async () => {
                await client.query(`
                    UPDATE ar_year_end_setup SET
                        fx_gain_account_id = NULL, fx_loss_account_id = NULL,
                        unrealized_fx_gain_account_id = NULL, unrealized_fx_loss_account_id = NULL,
                        allowance_expense_account_id = NULL, allowance_contra_account_id = NULL,
                        fx_reval_gl_doc_id = NULL, allowance_gl_doc_id = NULL,
                        updated_at = NOW()
                `);
                await client.query(`DELETE FROM ar_allowance_rule`);
                await client.query(`
                    INSERT INTO ar_allowance_rule (age_from_days, age_to_days, rate, sort_order)
                    VALUES (0, 90, 0.00, 1), (91, 180, 20.00, 2), (181, 365, 50.00, 3), (366, NULL, 100.00, 4)
                `);
                deleted.ar_year_end_setup_reset = true;
            });
        }

        // ตั้งค่ารหัสลูกค้าอัตโนมัติ: คืนค่าเป็นค่าเริ่มต้น
        if (resetCustomerRunning) {
            await runStep('ar_customer_running', async () => {
                await client.query(`
                    UPDATE ar_customer_running SET
                        is_auto_numbering = false, format_prefix = 'CUST',
                        format_separator = '-', format_suffix_date = '',
                        running_length = 4, next_running_number = 1,
                        updated_at = NOW()
                `);
                deleted.ar_customer_running_reset = true;
            });
        }

        await client.query('COMMIT');
        console.log('AR master reset completed:', deleted, errors);
        const failed = Object.keys(errors).length > 0;
        res.json({ message: failed ? 'ดำเนินการแล้ว แต่บางรายการล้างไม่สำเร็จ' : 'ดำเนินการสำเร็จ', deleted, errors });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resetting AR master data:', error);
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetMasterData };
