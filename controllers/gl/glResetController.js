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
        const [
            headerCount, detailCount, closingCount,
            accountCount, dimTypeCount, dimValueCount, dimComboCount, balanceAccumCount,
            fiscalYearCount, postingPeriodCount,
            finReportCount, closingConfigCount, adjustingTemplateCount,
        ] = await Promise.all([
            _countTable(req.dbPool, 'gl_entry_header'),
            _countTable(req.dbPool, 'gl_entry_detail'),
            _countTable(req.dbPool, 'gl_year_end_closing'),
            _countTable(req.dbPool, 'gl_account'),
            _countTable(req.dbPool, 'gl_dimension_type'),
            _countTable(req.dbPool, 'gl_dimension_value'),
            _countTable(req.dbPool, 'gl_dim_combination'),
            _countTable(req.dbPool, 'gl_balance_accum'),
            _countTable(req.dbPool, 'gl_fiscal_year'),
            _countTable(req.dbPool, 'gl_posting_period'),
            _countTable(req.dbPool, 'gl_fin_report'),
            _countTable(req.dbPool, 'gl_closing_config'),
            _countTable(req.dbPool, 'gl_adjusting_template'),
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
            gl_account:            accountCount,
            gl_dimension_type:     dimTypeCount,
            gl_dimension_value:    dimValueCount,
            gl_dim_combination:    dimComboCount,
            gl_balance_accum:      balanceAccumCount,
            gl_fiscal_year:        fiscalYearCount,
            gl_posting_period:     postingPeriodCount,
            gl_fin_report:         finReportCount,
            gl_closing_config:     closingConfigCount,
            gl_adjusting_template: adjustingTemplateCount,
        });
    } catch (error) {
        console.error('Error getting reset counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /gl_reset_transactions — ลบข้อมูลธุรกรรม และ/หรือข้อมูลหลัก GL ตามที่เลือก
const resetTransactions = async (req, res) => {
    if (!(await _checkDeveloper(req, res))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }

    const {
        deleteEntries = true,
        resetDocNumbers = false,
        resetFinancialReports = false,
        resetClosingConfig = false,
        resetDimensions = false,
        resetFiscalYears = false,
        resetChartOfAccounts = false,
    } = req.body;

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const deleted = {};
        const errors = {};

        // ดำเนินการแบบ savepoint แยกกลุ่ม เพื่อไม่ให้ FK constraint ของกลุ่มหนึ่ง
        // ทำให้ทั้ง transaction ล้มเหลว
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

        // แบบงบการเงิน (Financial Report Builder): ลบหัวรายงาน → แถว/คอลัมน์ลบตาม CASCADE
        if (resetFinancialReports) {
            await runStep('gl_fin_report', async () => {
                const r = await client.query('DELETE FROM gl_fin_report');
                deleted.gl_fin_report = r.rowCount;
            });
        }

        // ตั้งค่าปิดสิ้นปี + Adjusting Template
        if (resetClosingConfig) {
            await runStep('gl_closing_config', async () => {
                const cfgR = await client.query('DELETE FROM gl_closing_config');
                const tmplR = await client.query('DELETE FROM gl_adjusting_template');
                deleted.gl_closing_config = cfgR.rowCount;
                deleted.gl_adjusting_template = tmplR.rowCount;
            });
        }

        // Dimension Framework: ยอดสะสม → ชุดค่าผสมมิติ → กฎบังคับมิติของบัญชี → ค่ามิติ → ประเภทมิติ
        // ต้องล้างก่อน "ผังบัญชี" เพราะ gl_balance_accum อ้างอิง gl_account
        if (resetDimensions) {
            await runStep('gl_dimensions', async () => {
                const balR = await client.query('DELETE FROM gl_balance_accum');
                const comboR = await client.query('DELETE FROM gl_dim_combination');
                const ruleR = await client.query('DELETE FROM gl_account_dim_rule');
                const valR = await client.query('DELETE FROM gl_dimension_value');
                const typeR = await client.query('DELETE FROM gl_dimension_type');
                deleted.gl_balance_accum = balR.rowCount;
                deleted.gl_dim_combination = comboR.rowCount;
                deleted.gl_account_dim_rule = ruleR.rowCount;
                deleted.gl_dimension_value = valR.rowCount;
                deleted.gl_dimension_type = typeR.rowCount;
            });
        }

        // ปีบัญชี/งวดบัญชี: ลบปีบัญชี → งวดบัญชีลบตาม CASCADE
        if (resetFiscalYears) {
            await runStep('gl_fiscal_year', async () => {
                const periodCount = await client.query('SELECT COUNT(*) FROM gl_posting_period');
                const fyR = await client.query('DELETE FROM gl_fiscal_year');
                deleted.gl_fiscal_year = fyR.rowCount;
                deleted.gl_posting_period = parseInt(periodCount.rows[0].count, 10);
            });
        }

        // ผังบัญชี: ตัดความสัมพันธ์ parent_id ของตัวเองก่อน (FK RESTRICT) แล้วลบทั้งหมด
        // (gl_account_dim_rule ลบตาม CASCADE)
        if (resetChartOfAccounts) {
            await runStep('gl_account', async () => {
                await client.query('UPDATE gl_account SET parent_id = NULL WHERE parent_id IS NOT NULL');
                const r = await client.query('DELETE FROM gl_account');
                deleted.gl_account = r.rowCount;
            });
        }

        await client.query('COMMIT');
        console.log('GL reset completed:', deleted, errors);
        res.json({ message: 'ดำเนินการสำเร็จ', deleted, errors });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resetting GL transactions:', error);
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetTransactions };
