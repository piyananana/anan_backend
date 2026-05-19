// controllers/ar/arResetController.js

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

// GET /ar_reset_transactions/counts
const getCounts = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }
    try {
        const [headerCount, detailCount, applyCount, paymentCount, vatCount] = await Promise.all([
            _countTable(req.dbPool, 'ar_transaction'),
            _countTable(req.dbPool, 'ar_transaction_detail'),
            _countTable(req.dbPool, 'ar_transaction_apply'),
            _countTable(req.dbPool, 'ar_transaction_payment'),
            _countTable(req.dbPool, 'vt_transaction', "module_code = 'AR'"),
        ]);

        let arDocCount = 0;
        try {
            const docResult = await req.dbPool.query(`
                SELECT COUNT(*) FROM sa_doc_number_branch dnb
                JOIN sa_module_document md ON md.id = dnb.doc_id
                WHERE md.sys_module = '11' AND dnb.next_running_number > 1
            `);
            arDocCount = parseInt(docResult.rows[0].count, 10);
        } catch (_) {}

        res.json({
            ar_transaction:         headerCount,
            ar_transaction_detail:  detailCount,
            ar_transaction_apply:   applyCount,
            ar_transaction_payment: paymentCount,
            vt_transaction:         vatCount,
            ar_doc_number_rows:     arDocCount,
        });
    } catch (error) {
        console.error('Error getting AR reset counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /ar_reset_transactions
const resetTransactions = async (req, res) => {
    if (!(await _checkDeveloper(req))) {
        return res.status(403).json({ message: 'ต้องการสิทธิ์ผู้พัฒนาระบบ' });
    }

    const {
        deleteTransactions = true,
        resetDocNumbers = false,
    } = req.body;

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const deleted = {};

        if (deleteTransactions) {
            // ลบตามลำดับ FK: apply/payment/detail → vt_transaction → header
            const tables = [
                ['ar_transaction_apply',   'ar_transaction_apply'],
                ['ar_transaction_payment', 'ar_transaction_payment'],
                ['ar_transaction_detail',  'ar_transaction_detail'],
            ];
            for (const [key, table] of tables) {
                try {
                    const r = await client.query(`DELETE FROM ${table} RETURNING id`);
                    deleted[key] = r.rowCount;
                } catch (_) { deleted[key] = 0; }
            }
            // vt_transaction เฉพาะ AR
            try {
                const r = await client.query(`DELETE FROM vt_transaction WHERE module_code = 'AR' RETURNING id`);
                deleted.vt_transaction = r.rowCount;
            } catch (_) { deleted.vt_transaction = 0; }
            // header ต้องลบหลังสุด
            try {
                const r = await client.query(`DELETE FROM ar_transaction RETURNING id`);
                deleted.ar_transaction = r.rowCount;
            } catch (_) { deleted.ar_transaction = 0; }
        }

        if (resetDocNumbers) {
            try {
                await client.query(`
                    UPDATE sa_doc_number_branch SET next_running_number = 1
                    WHERE doc_id IN (SELECT id FROM sa_module_document WHERE sys_module = '11')
                `);
                await client.query(`
                    UPDATE sa_module_document SET next_running_number = 1
                    WHERE sys_module = '11'
                `);
                deleted.doc_numbers_reset = true;
            } catch (_) {
                deleted.doc_numbers_reset = false;
            }
        }

        await client.query('COMMIT');
        console.log('AR reset completed:', deleted);
        res.json({ message: 'ลบข้อมูลธุรกรรม AR สำเร็จ', deleted });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resetting AR transactions:', error);
        res.status(500).json({ message: error.message });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetTransactions };
