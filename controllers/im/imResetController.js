// controllers/im/imResetController.js — มิเรอร์ arResetController.js/apResetController.js
'use strict';

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

// GET /im_reset_transactions/counts
const getCounts = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    try {
        const [
            txCount, txDetailCount, stockLayerCount, stockLayerConsCount, stockBalanceCount,
            stockCountCount, stockCountDetailCount, periodClosingCount, openingBalanceBatchCount,
            bomHeaderCount, priceListCount, itemCount, itemCategoryCount, uomCount, warehouseCount,
            locationCount, glAccountSetupCount,
        ] = await Promise.all([
            _countTable(req.dbPool, 'im_transaction'),
            _countTable(req.dbPool, 'im_transaction_detail'),
            _countTable(req.dbPool, 'im_stock_layer'),
            _countTable(req.dbPool, 'im_stock_layer_consumption'),
            _countTable(req.dbPool, 'im_stock_balance'),
            _countTable(req.dbPool, 'im_stock_count'),
            _countTable(req.dbPool, 'im_stock_count_detail'),
            _countTable(req.dbPool, 'im_period_closing'),
            _countTable(req.dbPool, 'im_opening_balance_batch'),
            _countTable(req.dbPool, 'im_bom_header'),
            _countTable(req.dbPool, 'im_price_list'),
            _countTable(req.dbPool, 'im_item'),
            _countTable(req.dbPool, 'im_item_category'),
            _countTable(req.dbPool, 'im_uom'),
            _countTable(req.dbPool, 'im_warehouse'),
            _countTable(req.dbPool, 'im_location'),
            _countTable(req.dbPool, 'im_gl_account_setup'),
        ]);

        let imDocCount = 0;
        try {
            const r = await req.dbPool.query(`
                SELECT COUNT(*) FROM sa_doc_number_branch dnb
                JOIN sa_module_document md ON md.id = dnb.doc_id
                WHERE md.sys_module = '31' AND dnb.next_running_number > 1
            `);
            imDocCount = parseInt(r.rows[0].count, 10);
        } catch (_) {}

        let itemRunning = null;
        try {
            const r = await req.dbPool.query(
                `SELECT is_auto_numbering, next_running_number FROM im_item_running ORDER BY id LIMIT 1`
            );
            itemRunning = r.rows[0] || null;
        } catch (_) {}

        let stockCountRunning = null;
        try {
            const r = await req.dbPool.query(
                `SELECT is_auto_numbering, next_running_number FROM im_stock_count_running ORDER BY id LIMIT 1`
            );
            stockCountRunning = r.rows[0] || null;
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
            im_transaction:             txCount,
            im_transaction_detail:      txDetailCount,
            im_stock_layer:             stockLayerCount,
            im_stock_layer_consumption: stockLayerConsCount,
            im_stock_balance:           stockBalanceCount,
            im_stock_count:             stockCountCount,
            im_stock_count_detail:      stockCountDetailCount,
            im_period_closing:          periodClosingCount,
            im_opening_balance_batch:   openingBalanceBatchCount,
            im_doc_number_rows:         imDocCount,
            im_bom_header:              bomHeaderCount,
            im_price_list:              priceListCount,
            im_item:                    itemCount,
            im_item_category:           itemCategoryCount,
            im_uom:                     uomCount,
            im_warehouse:               warehouseCount,
            im_location:                locationCount,
            im_gl_account_setup:        glAccountSetupCount,
            im_item_running:            itemRunning,
            im_stock_count_running:     stockCountRunning,
            im_accounting_setting_configured: accountingSettingConfigured,
        });
    } catch (error) {
        console.error('Error getting IM reset counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /im_reset_transactions
const resetTransactions = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }

    const {
        deleteTransactions = true,
        resetDocNumbers = false,
        resetBom = false,
        resetPriceList = false,
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

        // ดำเนินการแบบ savepoint แยกทุกขั้นตอน (ไม่ใช่แค่กลุ่ม master data เหมือน AR/AP เดิม) เพราะ IM มี FK
        // graph ซับซ้อนกว่า (item/warehouse/location/bom/price_list/transaction/stock_count เชื่อมกันหลายทาง)
        // — ถ้าขั้นตอนไหน error โดยไม่คาดคิด จะไม่ทำให้ transaction ทั้งหมด abort จนขั้นตอนอื่นพลอยล้มเหลวไปด้วย
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

        if (deleteTransactions) {
            // im_stock_count.im_transaction_id อ้างอิง im_transaction แบบไม่มี CASCADE — ต้องลบชุดนับสต็อกก่อนเสมอ
            await runStep('im_stock_count', async () => {
                const d = await client.query(`DELETE FROM im_stock_count_detail RETURNING id`);
                const h = await client.query(`DELETE FROM im_stock_count RETURNING id`);
                deleted.im_stock_count_detail = d.rowCount;
                deleted.im_stock_count = h.rowCount;
            });
            // ประวัติปิดงวดสินค้าคงคลัง (คำนวณจากธุรกรรมในงวดนั้นๆ) — ล้างทิ้งเพื่อไม่ให้ค้างเป็นข้อมูลเก่า
            await runStep('im_period_closing', async () => {
                const r = await client.query(`DELETE FROM im_period_closing RETURNING period_id`);
                deleted.im_period_closing = r.rowCount;
            });
            // consumption อ้างอิง layer แบบไม่มี CASCADE — ลบก่อน layer เสมอ
            await runStep('im_stock_layer', async () => {
                const c = await client.query(`DELETE FROM im_stock_layer_consumption RETURNING id`);
                const l = await client.query(`DELETE FROM im_stock_layer RETURNING id`);
                deleted.im_stock_layer_consumption = c.rowCount;
                deleted.im_stock_layer = l.rowCount;
            });
            await runStep('im_stock_balance', async () => {
                const r = await client.query(`DELETE FROM im_stock_balance RETURNING item_id`);
                deleted.im_stock_balance = r.rowCount;
            });
            await runStep('im_transaction', async () => {
                const d = await client.query(`DELETE FROM im_transaction_detail RETURNING id`);
                const h = await client.query(`DELETE FROM im_transaction RETURNING id`);
                deleted.im_transaction_detail = d.rowCount;
                deleted.im_transaction = h.rowCount;
            });
            await runStep('im_opening_balance_batch', async () => {
                const r = await client.query(`DELETE FROM im_opening_balance_batch RETURNING id`);
                deleted.im_opening_balance_batch = r.rowCount;
            });
        }

        if (resetDocNumbers) {
            await runStep('im_doc_numbers', async () => {
                await client.query(`
                    UPDATE sa_doc_number_branch SET next_running_number = 1
                    WHERE doc_id IN (SELECT id FROM sa_module_document WHERE sys_module = '31')
                `);
                await client.query(`
                    UPDATE sa_module_document SET next_running_number = 1
                    WHERE sys_module = '31'
                `);
                deleted.doc_numbers_reset = true;
            });
        }

        // สูตรการผลิต (BOM) — im_bom_header.parent_item_id / im_bom_detail.component_item_id อ้างอิง im_item
        // แบบไม่มี CASCADE จึงต้องลบก่อน "สินค้า" เสมอ ถ้ายังมี BOM ค้างอยู่ การลบสินค้าจะถูกบล็อก
        if (resetBom) {
            await runStep('im_bom', async () => {
                const d = await client.query(`DELETE FROM im_bom_detail RETURNING id`);
                const h = await client.query(`DELETE FROM im_bom_header RETURNING id`);
                deleted.im_bom_detail = d.rowCount;
                deleted.im_bom_header = h.rowCount;
            });
        }

        // ราคาขาย (Price List) — im_price_list_detail.item_id อ้างอิง im_item แบบไม่มี CASCADE เช่นกัน
        if (resetPriceList) {
            await runStep('im_price_list', async () => {
                const d = await client.query(`DELETE FROM im_price_list_detail RETURNING id`);
                const h = await client.query(`DELETE FROM im_price_list RETURNING id`);
                deleted.im_price_list_detail = d.rowCount;
                deleted.im_price_list = h.rowCount;
            });
        }

        // สินค้า — im_uom_conversion/im_item_warehouse มี ON DELETE CASCADE จาก im_item อยู่แล้ว ไม่ต้องลบแยก
        if (resetItems) {
            await runStep('im_item', async () => {
                const r = await client.query(`DELETE FROM im_item RETURNING id`);
                deleted.im_item = r.rowCount;
            });
        }

        // หมวดหมู่สินค้า — ต้องลบสินค้าที่อ้างอิง category_id ก่อน (เลือก "สินค้า" ด้วย) ไม่เช่นนั้นจะลบไม่ได้
        if (resetItemCategories) {
            await runStep('im_item_category', async () => {
                const r = await client.query(`DELETE FROM im_item_category RETURNING id`);
                deleted.im_item_category = r.rowCount;
            });
        }

        // หน่วยนับ — ต้องลบสินค้า (base_uom_id) และหน่วยนับทางเลือกก่อน (เลือก "สินค้า" ด้วย)
        if (resetUom) {
            await runStep('im_uom', async () => {
                const r = await client.query(`DELETE FROM im_uom RETURNING id`);
                deleted.im_uom = r.rowCount;
            });
        }

        // คลังสินค้า+ตำแหน่งจัดเก็บ — im_location มี ON DELETE CASCADE จาก im_warehouse อยู่แล้ว ลบคลังพอ
        // ต้องเคลียร์สินค้า/ธุรกรรม/สต็อกคงเหลือ/ชุดนับสต็อกที่อ้างอิงคลัง-ตำแหน่งนี้ก่อน ไม่เช่นนั้นจะลบไม่ได้
        if (resetWarehouses) {
            await runStep('im_warehouse', async () => {
                const r = await client.query(`DELETE FROM im_warehouse RETURNING id`);
                deleted.im_warehouse = r.rowCount;
            });
        }

        if (resetGlAccountSetup) {
            await runStep('im_gl_account_setup', async () => {
                const r = await client.query(`DELETE FROM im_gl_account_setup RETURNING id`);
                deleted.im_gl_account_setup = r.rowCount;
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

        // ตั้งค่ารหัสอัตโนมัติ (สินค้า + ชุดนับสต็อก) — คืนค่าเป็นค่าเริ่มต้นของแต่ละตาราง
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
            await runStep('im_stock_count_running', async () => {
                await client.query(`
                    UPDATE im_stock_count_running SET
                        is_auto_numbering = true, format_prefix = 'CNT',
                        format_separator = '-', format_suffix_date = '',
                        running_length = 6, next_running_number = 1,
                        updated_at = NOW()
                `);
                deleted.im_stock_count_running_reset = true;
            });
        }

        await client.query('COMMIT');
        console.log('IM reset completed:', deleted, errors);
        res.json({ message: 'ดำเนินการสำเร็จ', deleted, errors });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resetting IM transactions:', error);
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetTransactions };
