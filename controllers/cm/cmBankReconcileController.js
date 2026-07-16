// controllers/cm/cmBankReconcileController.js
'use strict';

// Add reconciliation columns to cm_receipt and cm_payment if not present
const ensureReconcileColumns = async (client) => {
    await client.query(`ALTER TABLE IF EXISTS cm_receipt    ADD COLUMN IF NOT EXISTS is_reconciled    BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE IF EXISTS cm_receipt    ADD COLUMN IF NOT EXISTS reconcile_date   DATE`);
    await client.query(`ALTER TABLE IF EXISTS cm_receipt    ADD COLUMN IF NOT EXISTS statement_line_id INTEGER`);
    await client.query(`ALTER TABLE IF EXISTS cm_payment    ADD COLUMN IF NOT EXISTS is_reconciled    BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE IF EXISTS cm_payment    ADD COLUMN IF NOT EXISTS reconcile_date   DATE`);
    await client.query(`ALTER TABLE IF EXISTS cm_payment    ADD COLUMN IF NOT EXISTS statement_line_id INTEGER`);
};

// GET unreconciled/all items for a bank account and date range
// Returns { statement_lines: [], cm_records: [] }
const fetchItems = async (req, res) => {
    const { bank_account_id, date_from, date_to, unreconciled_only } = req.query;
    if (!bank_account_id || !date_from || !date_to)
        return res.status(400).json({ error: 'ต้องระบุ bank_account_id, date_from, date_to' });

    const client = await req.dbPool.connect();
    try {
        await ensureReconcileColumns(client);

        // Check tables exist
        const tbCheck = await client.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name IN ('cm_bank_statement_line','cm_receipt','cm_payment')`);
        const existing = tbCheck.rows.map(r => r.table_name);

        let stmtLines = [];
        if (existing.includes('cm_bank_statement_line')) {
            const reconFilter = unreconciled_only === 'true' ? 'AND l.is_reconciled = FALSE' : '';
            const slRes = await client.query(`
                SELECT l.*,
                       s.bank_account_id
                FROM cm_bank_statement_line l
                JOIN cm_bank_statement s ON s.id = l.statement_id
                WHERE s.bank_account_id = $1
                  AND s.status = 'Confirmed'
                  AND l.line_date >= $2
                  AND l.line_date <= $3
                  ${reconFilter}
                ORDER BY l.line_date, l.id`,
                [bank_account_id, date_from, date_to]);
            stmtLines = slRes.rows;
        }

        let cmRecords = [];
        const reconFilter2 = unreconciled_only === 'true' ? 'AND is_reconciled = FALSE' : '';

        if (existing.includes('cm_receipt')) {
            const rRes = await client.query(`
                SELECT 'RECEIPT'       AS record_type,
                       r.id,
                       r.receipt_date  AS record_date,
                       r.ar_doc_no     AS doc_no,
                       COALESCE(r.customer_name_th, r.drawer_bank) AS description,
                       r.amount_lc     AS amount,
                       r.is_reconciled,
                       r.reconcile_date,
                       r.statement_line_id,
                       r.status
                FROM cm_receipt r
                WHERE r.bank_account_id = $1
                  AND r.receipt_date >= $2
                  AND r.receipt_date <= $3
                  AND r.status != 'Voided'
                  ${reconFilter2}
                ORDER BY r.receipt_date, r.id`,
                [bank_account_id, date_from, date_to]);
            cmRecords.push(...rRes.rows);
        }

        if (existing.includes('cm_payment')) {
            const pRes = await client.query(`
                SELECT 'PAYMENT'          AS record_type,
                       p.id,
                       p.payment_date     AS record_date,
                       p.ap_doc_no        AS doc_no,
                       p.payee_name_th    AS description,
                       p.amount_lc        AS amount,
                       p.is_reconciled,
                       p.reconcile_date,
                       p.statement_line_id,
                       p.status
                FROM cm_payment p
                WHERE p.bank_account_id = $1
                  AND p.payment_date >= $2
                  AND p.payment_date <= $3
                  AND p.status != 'Voided'
                  ${reconFilter2}
                ORDER BY p.payment_date, p.id`,
                [bank_account_id, date_from, date_to]);
            cmRecords.push(...pRes.rows);
        }

        // Sort combined cm_records by date
        cmRecords.sort((a, b) => new Date(a.record_date) - new Date(b.record_date));

        res.json({ statement_lines: stmtLines, cm_records: cmRecords });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT reconcile a statement line with a CM record
// Body: { cm_record_type: 'RECEIPT'|'PAYMENT', cm_record_id: number, reconcile_date: string }
const reconcilePair = async (req, res) => {
    const { id } = req.params; // statement_line id
    const { cm_record_type, cm_record_id, reconcile_date } = req.body;
    if (!cm_record_type || !cm_record_id)
        return res.status(400).json({ error: 'ต้องระบุ cm_record_type และ cm_record_id' });
    if (!['RECEIPT', 'PAYMENT'].includes(cm_record_type))
        return res.status(400).json({ error: 'cm_record_type ต้องเป็น RECEIPT หรือ PAYMENT' });

    const table = cm_record_type === 'RECEIPT' ? 'cm_receipt' : 'cm_payment';
    const dateCol = cm_record_type === 'RECEIPT' ? 'receipt_date' : 'payment_date';
    const rDate = reconcile_date || new Date().toISOString().substring(0, 10);

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureReconcileColumns(client);

        // Update statement line
        const lineRes = await client.query(`
            UPDATE cm_bank_statement_line
            SET is_reconciled = TRUE, reconcile_date = $1,
                cm_record_type = $2, cm_record_id = $3
            WHERE id = $4
            RETURNING *`,
            [rDate, cm_record_type, cm_record_id, id]);
        if (lineRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Statement line not found' });
        }

        // Update CM record
        await client.query(`
            UPDATE ${table}
            SET is_reconciled = TRUE, reconcile_date = $1, statement_line_id = $2
            WHERE id = $3`,
            [rDate, id, cm_record_id]);

        await client.query('COMMIT');
        res.json({ message: 'จับคู่สำเร็จ', statement_line: lineRes.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT unreconcile a statement line (also clears CM record link)
const unreconcileStatementLine = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureReconcileColumns(client);

        const lineRes = await client.query(`
            SELECT cm_record_type, cm_record_id FROM cm_bank_statement_line WHERE id = $1`, [id]);
        if (lineRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Not found' });
        }

        const { cm_record_type, cm_record_id } = lineRes.rows[0];

        // Clear the CM record if linked
        if (cm_record_type && cm_record_id) {
            const table = cm_record_type === 'RECEIPT' ? 'cm_receipt' : 'cm_payment';
            await client.query(`
                UPDATE ${table}
                SET is_reconciled = FALSE, reconcile_date = NULL, statement_line_id = NULL
                WHERE id = $1`, [cm_record_id]);
        }

        await client.query(`
            UPDATE cm_bank_statement_line
            SET is_reconciled = FALSE, reconcile_date = NULL,
                cm_record_type = NULL, cm_record_id = NULL
            WHERE id = $1`, [id]);

        await client.query('COMMIT');
        res.json({ message: 'ยกเลิกการจับคู่สำเร็จ' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// GET reconciliation summary for a bank account + date range
const getSummary = async (req, res) => {
    const { bank_account_id, date_from, date_to } = req.query;
    if (!bank_account_id || !date_from || !date_to)
        return res.status(400).json({ error: 'ต้องระบุ bank_account_id, date_from, date_to' });

    const client = await req.dbPool.connect();
    try {
        await ensureReconcileColumns(client);

        const tbCheck = await client.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name IN ('cm_bank_statement_line','cm_receipt','cm_payment')`);
        const existing = tbCheck.rows.map(r => r.table_name);

        let stmtTotals = { total_deposit: 0, total_withdrawal: 0, reconciled_count: 0, unreconciled_count: 0 };
        if (existing.includes('cm_bank_statement_line')) {
            const r = await client.query(`
                SELECT
                    COALESCE(SUM(l.deposit_amount),0)    AS total_deposit,
                    COALESCE(SUM(l.withdrawal_amount),0) AS total_withdrawal,
                    COUNT(*) FILTER (WHERE l.is_reconciled = TRUE)  AS reconciled_count,
                    COUNT(*) FILTER (WHERE l.is_reconciled = FALSE) AS unreconciled_count
                FROM cm_bank_statement_line l
                JOIN cm_bank_statement s ON s.id = l.statement_id
                WHERE s.bank_account_id = $1 AND s.status = 'Confirmed'
                  AND l.line_date >= $2 AND l.line_date <= $3`,
                [bank_account_id, date_from, date_to]);
            stmtTotals = r.rows[0];
        }

        let receiptTotals = { total: 0, reconciled_count: 0, unreconciled_count: 0 };
        if (existing.includes('cm_receipt')) {
            const r = await client.query(`
                SELECT
                    COALESCE(SUM(amount_lc),0) AS total,
                    COUNT(*) FILTER (WHERE is_reconciled = TRUE)  AS reconciled_count,
                    COUNT(*) FILTER (WHERE is_reconciled = FALSE) AS unreconciled_count
                FROM cm_receipt
                WHERE bank_account_id = $1 AND receipt_date >= $2 AND receipt_date <= $3 AND status != 'Voided'`,
                [bank_account_id, date_from, date_to]);
            receiptTotals = r.rows[0];
        }

        let paymentTotals = { total: 0, reconciled_count: 0, unreconciled_count: 0 };
        if (existing.includes('cm_payment')) {
            const r = await client.query(`
                SELECT
                    COALESCE(SUM(amount_lc),0) AS total,
                    COUNT(*) FILTER (WHERE is_reconciled = TRUE)  AS reconciled_count,
                    COUNT(*) FILTER (WHERE is_reconciled = FALSE) AS unreconciled_count
                FROM cm_payment
                WHERE bank_account_id = $1 AND payment_date >= $2 AND payment_date <= $3 AND status != 'Voided'`,
                [bank_account_id, date_from, date_to]);
            paymentTotals = r.rows[0];
        }

        res.json({
            statement:  stmtTotals,
            receipts:   receiptTotals,
            payments:   paymentTotals,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { fetchItems, reconcilePair, unreconcileStatementLine, getSummary };
