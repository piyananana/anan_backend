// controllers/ap/apResetController.js

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

// GET /ap_reset_transactions/counts
const getCounts = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    try {
        const [
            headerCount, detailCount, applyCount, paymentCount, vatCount,
            vendorCount, vendorGroupCount, glAccountSetupCount,
        ] = await Promise.all([
            _countTable(req.dbPool, 'ap_transaction'),
            _countTable(req.dbPool, 'ap_transaction_detail'),
            _countTable(req.dbPool, 'ap_transaction_apply'),
            _countTable(req.dbPool, 'ap_transaction_payment'),
            _countTable(req.dbPool, 'vt_transaction', "module_code = 'AP'"),
            _countTable(req.dbPool, 'ap_vendor'),
            _countTable(req.dbPool, 'ap_vendor_group'),
            _countTable(req.dbPool, 'ap_gl_account_setup'),
        ]);

        let apDocCount = 0;
        try {
            const docResult = await req.dbPool.query(`
                SELECT COUNT(*) FROM sa_doc_number_branch dnb
                JOIN sa_module_document md ON md.id = dnb.doc_id
                WHERE md.sys_module = '21' AND dnb.next_running_number > 1
            `);
            apDocCount = parseInt(docResult.rows[0].count, 10);
        } catch (_) {}

        let vendorRunning = null;
        try {
            const r = await req.dbPool.query(
                `SELECT is_auto_numbering, next_running_number FROM ap_vendor_running ORDER BY id LIMIT 1`
            );
            vendorRunning = r.rows[0] || null;
        } catch (_) {}

        res.json({
            ap_transaction:         headerCount,
            ap_transaction_detail:  detailCount,
            ap_transaction_apply:   applyCount,
            ap_transaction_payment: paymentCount,
            vt_transaction:         vatCount,
            ap_doc_number_rows:     apDocCount,
            ap_vendor:              vendorCount,
            ap_vendor_group:        vendorGroupCount,
            ap_gl_account_setup:    glAccountSetupCount,
            ap_vendor_running:      vendorRunning,
        });
    } catch (error) {
        console.error('Error getting AP reset counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /ap_reset_transactions
const resetTransactions = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }

    const {
        deleteTransactions = true,
        resetDocNumbers    = false,
        resetVendors       = false,
        resetVendorGroups  = false,
        resetGlAccountSetup = false,
        resetVendorRunning  = false,
    } = req.body;

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const deleted = {};
        const errors  = {};

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
            // ลบตามลำดับ FK: apply/payment/detail → vt_transaction → header
            const tables = [
                ['ap_transaction_apply',   'ap_transaction_apply'],
                ['ap_transaction_payment', 'ap_transaction_payment'],
                ['ap_transaction_detail',  'ap_transaction_detail'],
            ];
            for (const [key, table] of tables) {
                try {
                    const r = await client.query(`DELETE FROM ${table} RETURNING id`);
                    deleted[key] = r.rowCount;
                } catch (_) { deleted[key] = 0; }
            }
            try {
                const r = await client.query(`DELETE FROM vt_transaction WHERE module_code = 'AP' RETURNING id`);
                deleted.vt_transaction = r.rowCount;
            } catch (_) { deleted.vt_transaction = 0; }
            try {
                const r = await client.query(`DELETE FROM ap_transaction RETURNING id`);
                deleted.ap_transaction = r.rowCount;
            } catch (_) { deleted.ap_transaction = 0; }
        }

        if (resetDocNumbers) {
            try {
                await client.query(`
                    UPDATE sa_doc_number_branch SET next_running_number = 1
                    WHERE doc_id IN (SELECT id FROM sa_module_document WHERE sys_module = '21')
                `);
                await client.query(`
                    UPDATE sa_module_document SET next_running_number = 1
                    WHERE sys_module = '21'
                `);
                deleted.doc_numbers_reset = true;
            } catch (_) {
                deleted.doc_numbers_reset = false;
            }
        }

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

        if (resetGlAccountSetup) {
            await runStep('ap_gl_account_setup', async () => {
                const r = await client.query(`DELETE FROM ap_gl_account_setup RETURNING id`);
                deleted.ap_gl_account_setup = r.rowCount;
            });
        }

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
        console.log('AP reset completed:', deleted, errors);
        res.json({ message: 'ดำเนินการสำเร็จ', deleted, errors });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resetting AP transactions:', error);
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetTransactions };
