// controllers/gl/glResetController.js — ล้างข้อมูลหลัก/การตั้งค่าของ GL (เครื่องมือผู้พัฒนาระบบ)
// รายการบัญชี/ยอดสะสม/ปิดงวด/ปิดปี ล้างที่หน้าจอ "ล้างธุรกรรมทุกโมดูล" (saSystemResetController)
// — ต้องไม่มีธุรกรรมค้างก่อนจึงจะล้างที่นี่ได้
const { transactionTotal, rejectIfTransactions, countRefs, clearRefs } = require('../../utils/resetGuard');

// ตรวจว่า requester เป็น developer (user_type = 'developer')
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

// GET /gl_reset_master/counts
const getCounts = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    try {
        const [
            transactionsTotal,
            accountCount, accountRefCount, dimTypeCount, dimValueCount, dimComboCount,
            fiscalYearCount, postingPeriodCount, periodNotDefaultCount,
            finReportCount, closingConfigCount, adjustingTemplateCount,
        ] = await Promise.all([
            transactionTotal(req.dbPool),
            _countTable(req.dbPool, 'gl_account'),
            countRefs(req.dbPool, 'gl_account').catch(() => 0),
            _countTable(req.dbPool, 'gl_dimension_type'),
            _countTable(req.dbPool, 'gl_dimension_value'),
            _countTable(req.dbPool, 'gl_dim_combination'),
            _countTable(req.dbPool, 'gl_fiscal_year'),
            _countTable(req.dbPool, 'gl_posting_period'),
            req.dbPool.query(`
                SELECT COUNT(*)::int AS n FROM gl_posting_period
                 WHERE gl_status <> 'LOCKED' OR ap_status <> 'LOCKED' OR ar_status <> 'LOCKED'
                    OR im_status <> 'LOCKED' OR cm_status <> 'OPEN'`).then(r => r.rows[0].n).catch(() => 0),
            _countTable(req.dbPool, 'gl_fin_report'),
            _countTable(req.dbPool, 'gl_closing_config'),
            _countTable(req.dbPool, 'gl_adjusting_template'),
        ]);

        res.json({
            transactions_total:    transactionsTotal,
            gl_account:            accountCount,
            gl_account_refs:       accountRefCount,
            gl_dimension_type:     dimTypeCount,
            gl_dimension_value:    dimValueCount,
            gl_dim_combination:    dimComboCount,
            gl_fiscal_year:        fiscalYearCount,
            gl_posting_period:     postingPeriodCount,
            gl_posting_period_changed: periodNotDefaultCount,
            gl_fin_report:         finReportCount,
            gl_closing_config:     closingConfigCount,
            gl_adjusting_template: adjustingTemplateCount,
        });
    } catch (error) {
        console.error('Error getting GL reset counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /gl_reset_master — ลบ/คืนค่าข้อมูลหลัก GL ตามที่เลือก
const resetMasterData = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    if (await rejectIfTransactions(req, res)) return;

    const {
        resetFinancialReports = false,
        resetClosingConfig = false,
        resetDimensions = false,
        resetPeriodStatus = false,
        resetFiscalYears = false,
        resetChartOfAccounts = false,
    } = req.body;

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const deleted = {};
        const errors = {};

        // savepoint แยกขั้นตอน — ขั้นตอนที่ติด FK ล้มเฉพาะขั้นตอนนั้น และแจ้งใน errors
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

        // แบบงบการเงิน (Financial Report Builder): ลบหัวรายงาน → แถว/คอลัมน์ลบตาม CASCADE
        if (resetFinancialReports) {
            await runStep('gl_fin_report', async () => {
                const r = await client.query('DELETE FROM gl_fin_report');
                deleted.gl_fin_report = r.rowCount;
            });
        }

        // ตั้งค่าปิดสิ้นปี + Adjusting Template — ลบก่อนผังบัญชีเพราะอ้างอิงบัญชีแบบบังคับ
        if (resetClosingConfig) {
            await runStep('gl_closing_config', async () => {
                const cfgR = await client.query('DELETE FROM gl_closing_config');
                const tmplR = await client.query('DELETE FROM gl_adjusting_template');
                deleted.gl_closing_config = cfgR.rowCount;
                deleted.gl_adjusting_template = tmplR.rowCount;
            });
        }

        // Dimension Framework: ชุดค่าผสมมิติ → กฎบังคับมิติของบัญชี → ค่ามิติ → ประเภทมิติ
        // (ยอดสะสม gl_balance_accum เป็นธุรกรรม ถูกล้างที่หน้าจอกลางแล้ว)
        if (resetDimensions) {
            await runStep('gl_dimensions', async () => {
                deleted.gl_dim_combination = (await client.query('DELETE FROM gl_dim_combination')).rowCount;
                deleted.gl_account_dim_rule = (await client.query('DELETE FROM gl_account_dim_rule')).rowCount;
                Object.assign(deleted, await clearRefs(client, 'gl_dimension_value'));
                deleted.gl_dimension_value = (await client.query('DELETE FROM gl_dimension_value')).rowCount;
                deleted.gl_dimension_type = (await client.query('DELETE FROM gl_dimension_type')).rowCount;
            });
        }

        // สถานะงวดบัญชีกลับเป็นค่าเริ่มต้นตอนสร้างงวด (ค่า DEFAULT ของคอลัมน์ — GL/AP/AR/IM ปิด, CM เปิด)
        // การล้างธุรกรรมกลางไม่เปลี่ยนสถานะงวด งวดที่เคยเปิด/ปิดไว้จึงยังคงสถานะเดิมจนกว่าจะเลือกข้อนี้
        if (resetPeriodStatus && !resetFiscalYears) {
            await runStep('gl_posting_period_status', async () => {
                const r = await client.query(`
                    UPDATE gl_posting_period SET
                        gl_status = DEFAULT, ap_status = DEFAULT, ar_status = DEFAULT,
                        im_status = DEFAULT, cm_status = DEFAULT, updated_at = NOW()`);
                deleted.gl_posting_period_status_reset = r.rowCount;
            });
        }

        // ปีบัญชี/งวดบัญชี: ล้างช่องอ้างอิงงวด (เช่น งวดที่เริ่มใช้โหมดบัญชีสินค้า) → ลบปีบัญชี → งวดลบตาม CASCADE
        if (resetFiscalYears) {
            await runStep('gl_fiscal_year', async () => {
                Object.assign(deleted, await clearRefs(client, 'gl_posting_period'));
                const periodCount = await client.query('SELECT COUNT(*) FROM gl_posting_period');
                const fyR = await client.query('DELETE FROM gl_fiscal_year');
                deleted.gl_fiscal_year = fyR.rowCount;
                deleted.gl_posting_period = parseInt(periodCount.rows[0].count, 10);
            });
        }

        // ผังบัญชี: ล้างช่องอ้างอิงบัญชีในข้อมูลหลัก/การตั้งค่าของทุกโมดูล (รวม parent_id ของผังบัญชีเอง) แล้วลบทั้งหมด
        // (gl_account_dim_rule ลบตาม CASCADE) — ช่องที่บังคับมีค่า (เช่น Adjusting Template) ทำให้ขั้นตอนนี้ล้มและแจ้งใน errors
        if (resetChartOfAccounts) {
            await runStep('gl_account', async () => {
                const cleared = await clearRefs(client, 'gl_account');
                const r = await client.query('DELETE FROM gl_account');
                deleted.gl_account = r.rowCount;
                deleted.gl_account_refs_cleared = cleared;
            });
        }

        await client.query('COMMIT');
        console.log('GL master reset completed:', deleted, errors);
        const failed = Object.keys(errors).length > 0;
        res.json({ message: failed ? 'ดำเนินการแล้ว แต่บางรายการล้างไม่สำเร็จ' : 'ดำเนินการสำเร็จ', deleted, errors });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resetting GL master data:', error);
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetMasterData };
