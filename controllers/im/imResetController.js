// controllers/im/imResetController.js — ล้างข้อมูลหลัก/การตั้งค่าของ IM และ MO (เครื่องมือผู้พัฒนาระบบ)
// ธุรกรรม (เอกสาร IM, สต็อกคงเหลือ, นับสต็อก, เปลี่ยนราคา, ใบสั่งผลิต ฯลฯ) ล้างที่หน้าจอ "ล้างธุรกรรมทุกโมดูล"
// (saSystemResetController) — ต้องไม่มีธุรกรรมค้างก่อนจึงจะล้างที่นี่ได้
'use strict';
const { transactionTotal, rejectIfTransactions, clearRefs } = require('../../utils/resetGuard');

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

// GET /im_reset_master/counts
const getCounts = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    try {
        const [
            transactionsTotal,
            bomHeaderCount, workCenterCount, moGlSetupCount,
            priceListCount, priceGroupCount, itemCount, itemCategoryCount, uomCount, warehouseCount,
            locationCount, glAccountSetupCount,
        ] = await Promise.all([
            transactionTotal(req.dbPool),
            _countTable(req.dbPool, 'mo_bom_header'),
            _countTable(req.dbPool, 'mo_work_center'),
            _countTable(req.dbPool, 'mo_gl_account_setup'),
            _countTable(req.dbPool, 'im_price_list'),
            _countTable(req.dbPool, 'im_price_group'),
            _countTable(req.dbPool, 'im_item'),
            _countTable(req.dbPool, 'im_item_category'),
            _countTable(req.dbPool, 'im_uom'),
            _countTable(req.dbPool, 'im_warehouse'),
            _countTable(req.dbPool, 'im_location'),
            _countTable(req.dbPool, 'im_gl_account_setup'),
        ]);

        let itemRunning = null;
        try {
            const r = await req.dbPool.query(
                `SELECT is_auto_numbering, next_running_number FROM im_item_running ORDER BY id LIMIT 1`
            );
            itemRunning = r.rows[0] || null;
        } catch (_) {}

        let accountingSettingConfigured = false;
        try {
            const r = await req.dbPool.query(`
                SELECT 1 FROM im_accounting_setting
                WHERE inventory_accounting_mode != 'PERPETUAL'
                   OR inventory_account_id IS NOT NULL OR cogs_account_id IS NOT NULL
                   OR purchases_account_id IS NOT NULL OR closing_gl_doc_id IS NOT NULL
                LIMIT 1
            `);
            accountingSettingConfigured = r.rows.length > 0;
        } catch (_) {}

        res.json({
            transactions_total:  transactionsTotal,
            mo_bom_header:       bomHeaderCount,
            mo_work_center:      workCenterCount,
            mo_gl_account_setup: moGlSetupCount,
            im_price_list:       priceListCount,
            im_price_group:      priceGroupCount,
            im_item:             itemCount,
            im_item_category:    itemCategoryCount,
            im_uom:              uomCount,
            im_warehouse:        warehouseCount,
            im_location:         locationCount,
            im_gl_account_setup: glAccountSetupCount,
            im_item_running:     itemRunning,
            im_accounting_setting_configured: accountingSettingConfigured,
        });
    } catch (error) {
        console.error('Error getting IM reset counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /im_reset_master
const resetMasterData = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    if (await rejectIfTransactions(req, res)) return;

    const {
        resetBom = false,
        resetWorkCenters = false,
        resetMoGlSetup = false,
        resetPriceList = false,
        resetPriceGroups = false,
        resetItems = false,
        resetItemCategories = false,
        resetUom = false,
        resetWarehouses = false,
        resetGlAccountSetup = false,
        resetAccountingSetting = false,
        resetItemRunning = false,
    } = req.body;

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const deleted = {};
        const errors = {};

        // savepoint แยกขั้นตอน — ขั้นตอนที่ติด FK (เช่น ลบหน่วยนับโดยไม่ลบสินค้า) ล้มเฉพาะขั้นตอนนั้น และแจ้งใน errors
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

        // สูตรการผลิต (BOM) — รายการวัตถุดิบ/ผลผลิต/ขั้นตอนลบตาม CASCADE; อ้างอิงสินค้า/หน่วยนับ/ศูนย์งาน
        // จึงต้องลบก่อนสามอย่างนั้นเสมอ
        if (resetBom) {
            await runStep('mo_bom', async () => {
                deleted.mo_bom_header = (await client.query(`DELETE FROM mo_bom_header`)).rowCount;
            });
        }

        if (resetWorkCenters) {
            await runStep('mo_work_center', async () => {
                deleted.mo_work_center = (await client.query(`DELETE FROM mo_work_center`)).rowCount;
            });
        }

        if (resetMoGlSetup) {
            await runStep('mo_gl_account_setup', async () => {
                deleted.mo_gl_account_setup = (await client.query(`DELETE FROM mo_gl_account_setup`)).rowCount;
            });
        }

        // ราคาขาย (Price List) — ลูกค้า/ผู้ขายที่ผูกราคาไว้ถูกล้างเป็นค่าว่าง, รายการราคาลบตาม CASCADE
        if (resetPriceList) {
            await runStep('im_price_list', async () => {
                Object.assign(deleted, await clearRefs(client, 'im_price_list'));
                deleted.im_price_list = (await client.query(`DELETE FROM im_price_list`)).rowCount;
            });
        }

        // กลุ่มราคา — ถ้ายังมีราคาขายอ้างอิงอยู่ (ไม่ได้เลือกราคาขายด้วย) จะล้างช่องกลุ่มราคาในราคาขายเป็นค่าว่าง
        if (resetPriceGroups) {
            await runStep('im_price_group', async () => {
                Object.assign(deleted, await clearRefs(client, 'im_price_group'));
                deleted.im_price_group = (await client.query(`DELETE FROM im_price_group`)).rowCount;
            });
        }

        // สินค้า — คลัง/หน่วยนับทางเลือกของสินค้าลบตาม CASCADE; ถ้ายังมี BOM หรือรายการราคาขายอ้างอิงจะล้มและแจ้งใน errors
        if (resetItems) {
            await runStep('im_item', async () => {
                deleted.im_item = (await client.query(`DELETE FROM im_item`)).rowCount;
            });
        }

        // หมวดหมู่สินค้า — ล้างช่องอ้างอิง (หมวดแม่, หมวดของสินค้า/ตำแหน่งจัดเก็บที่ยังเหลือ) เป็นค่าว่างก่อนลบ
        if (resetItemCategories) {
            await runStep('im_item_category', async () => {
                Object.assign(deleted, await clearRefs(client, 'im_item_category'));
                deleted.im_item_category = (await client.query(`DELETE FROM im_item_category`)).rowCount;
            });
        }

        // หน่วยนับ — สินค้าบังคับมีหน่วยนับหลัก ต้องลบสินค้าก่อน (เลือก "สินค้า" ด้วย)
        if (resetUom) {
            await runStep('im_uom', async () => {
                deleted.im_uom = (await client.query(`DELETE FROM im_uom`)).rowCount;
            });
        }

        // คลังสินค้า + ตำแหน่งจัดเก็บ (ลบตาม CASCADE) — ลบการตั้งค่าสินค้ารายคลังด้วย และล้างคลัง/ตำแหน่งเริ่มต้นของสินค้าเป็นค่าว่าง
        if (resetWarehouses) {
            await runStep('im_warehouse', async () => {
                deleted.im_item_warehouse = (await client.query(`DELETE FROM im_item_warehouse`)).rowCount;
                Object.assign(deleted, await clearRefs(client, 'im_location'));
                Object.assign(deleted, await clearRefs(client, 'im_warehouse'));
                deleted.im_warehouse = (await client.query(`DELETE FROM im_warehouse`)).rowCount;
            });
        }

        if (resetGlAccountSetup) {
            await runStep('im_gl_account_setup', async () => {
                deleted.im_gl_account_setup = (await client.query(`DELETE FROM im_gl_account_setup`)).rowCount;
            });
        }

        // ตั้งค่าโหมดบัญชีสินค้าคงคลัง — คืนค่าเป็น PERPETUAL + ล้างบัญชีที่ตั้งไว้ (ไม่มี seed row ตายตัว
        // fetchMode() ถือว่า "ไม่มีแถวเลย" = PERPETUAL อยู่แล้ว จึงแค่ UPDATE แถวที่มีอยู่ ถ้าไม่มีแถวเลยก็ไม่มีผล)
        if (resetAccountingSetting) {
            await runStep('im_accounting_setting', async () => {
                await client.query(`
                    UPDATE im_accounting_setting SET
                        inventory_accounting_mode = 'PERPETUAL',
                        mode_effective_period_id = NULL,
                        inventory_account_id = NULL,
                        cogs_account_id = NULL,
                        purchases_account_id = NULL,
                        closing_gl_doc_id = NULL,
                        updated_at = NOW()
                `);
                deleted.im_accounting_setting_reset = true;
            });
        }

        // ตั้งค่ารหัสสินค้าอัตโนมัติ — คืนค่าเป็นค่าเริ่มต้น (เลขที่ชุดนับสต็อกรีเซ็ตที่หน้าจอกลางพร้อมเลขที่เอกสาร)
        if (resetItemRunning) {
            await runStep('im_item_running', async () => {
                await client.query(`
                    UPDATE im_item_running SET
                        is_auto_numbering = false, format_prefix = 'ITEM',
                        format_separator = '-', format_suffix_date = '',
                        running_length = 4, next_running_number = 1,
                        updated_at = NOW()
                `);
                deleted.im_item_running_reset = true;
            });
        }

        await client.query('COMMIT');
        console.log('IM master reset completed:', deleted, errors);
        const failed = Object.keys(errors).length > 0;
        res.json({ message: failed ? 'ดำเนินการแล้ว แต่บางรายการล้างไม่สำเร็จ' : 'ดำเนินการสำเร็จ', deleted, errors });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resetting IM master data:', error);
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetMasterData };
