// controllers/cm/cmResetController.js — ล้างข้อมูลหลัก/การตั้งค่าของ CM (เครื่องมือผู้พัฒนาระบบ)
// ธุรกรรม (รวมยอดยกมาธนาคาร, เช็คลงวันที่ล่วงหน้า, ปิดปี CM) ล้างที่หน้าจอ "ล้างธุรกรรมทุกโมดูล"
// (saSystemResetController) — ต้องไม่มีธุรกรรมค้างก่อนจึงจะล้างที่นี่ได้
'use strict';
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

// GET /cm_reset_master/counts
const getCounts = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    try {
        const [
            transactionsTotal, bankAccountCount, checkbookCount, checkPrintConfigCount,
            paymentMethodCount, bankFileFormatCount, glSetupCount,
        ] = await Promise.all([
            transactionTotal(req.dbPool),
            _countTable(req.dbPool, 'cm_bank_account'),
            _countTable(req.dbPool, 'cm_checkbook'),
            _countTable(req.dbPool, 'cm_check_print_config'),
            _countTable(req.dbPool, 'cm_payment_method'),
            _countTable(req.dbPool, 'cm_bank_file_format'),
            _countTable(req.dbPool, 'cm_transaction_gl_setup'),
        ]);
        res.json({
            transactions_total:      transactionsTotal,
            cm_bank_account:         bankAccountCount,
            cm_checkbook:            checkbookCount,
            cm_check_print_config:   checkPrintConfigCount,
            cm_payment_method:       paymentMethodCount,
            cm_bank_file_format:     bankFileFormatCount,
            cm_transaction_gl_setup: glSetupCount,
        });
    } catch (error) {
        console.error('Error getting CM reset counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /cm_reset_master
const resetMasterData = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    if (await rejectIfTransactions(req, res)) return;

    const {
        resetBankAccounts     = false,
        resetCheckbooks       = false,
        resetCheckPrintConfig = false,
        resetPaymentMethods   = false,
        resetBankFileFormats  = false,
        resetGlAccountSetup   = false,
    } = req.body;

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const deleted = {};
        const errors  = {};

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

        // สมุดเช็ค/รูปแบบพิมพ์เช็คเป็นของบัญชีธนาคาร — ลบบัญชีธนาคารจึงลบสองอย่างนี้ไปด้วย
        if (resetCheckbooks || resetBankAccounts) {
            await runStep('cm_checkbook', async () => {
                deleted.cm_checkbook = (await client.query(`DELETE FROM cm_checkbook`)).rowCount;
            });
        }
        if (resetCheckPrintConfig || resetBankAccounts) {
            await runStep('cm_check_print_config', async () => {
                deleted.cm_check_print_config = (await client.query(`DELETE FROM cm_check_print_config`)).rowCount;
            });
        }

        // ช่องทางชำระเงินอ้างอิงบัญชีธนาคาร (cm_bank_account_id) — ลบก่อนบัญชีธนาคาร
        // ถ้าเลือกลบบัญชีธนาคารแต่ไม่ลบช่องทางที่ผูกบัญชีไว้ ขั้นตอนบัญชีธนาคารจะติด FK และแจ้งใน errors
        if (resetPaymentMethods) {
            await runStep('cm_payment_method', async () => {
                deleted.cm_payment_method = (await client.query(`DELETE FROM cm_payment_method`)).rowCount;
            });
        }

        if (resetBankAccounts) {
            await runStep('cm_bank_account', async () => {
                deleted.cm_bank_account = (await client.query(`DELETE FROM cm_bank_account`)).rowCount;
            });
        }

        if (resetBankFileFormats) {
            await runStep('cm_bank_file_format', async () => {
                deleted.cm_bank_file_format = (await client.query(`DELETE FROM cm_bank_file_format`)).rowCount;
            });
        }

        // ตั้งค่าบัญชีตามประเภทเอกสาร CM (รายได้/ค่าใช้จ่าย/VAT/WHT/FX ฯลฯ)
        if (resetGlAccountSetup) {
            await runStep('cm_transaction_gl_setup', async () => {
                deleted.cm_transaction_gl_setup = (await client.query(`DELETE FROM cm_transaction_gl_setup`)).rowCount;
            });
        }

        await client.query('COMMIT');
        console.log('CM master reset completed:', deleted, errors);
        const failed = Object.keys(errors).length > 0;
        res.json({ message: failed ? 'ดำเนินการแล้ว แต่บางรายการล้างไม่สำเร็จ' : 'ดำเนินการสำเร็จ', deleted, errors });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resetting CM master data:', error);
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetMasterData };
