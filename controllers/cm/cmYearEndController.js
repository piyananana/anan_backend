// controllers/cm/cmYearEndController.js
'use strict';

const tableExists = async (client, name) => {
    const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
    return r.rows.length > 0;
};

const ensureTables = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_year_end (
            id             SERIAL PRIMARY KEY,
            fiscal_year    INTEGER UNIQUE NOT NULL,
            close_date     DATE,
            status         VARCHAR(20) DEFAULT 'Open',
            notes          TEXT,
            closed_by      VARCHAR(100),
            bank_balances  JSONB,
            created_at     TIMESTAMP DEFAULT NOW(),
            updated_at     TIMESTAMP DEFAULT NOW()
        )
    `);
};

// Check readiness for closing a fiscal year
const checkReadiness = async (req, res) => {
    const { fiscal_year } = req.query;
    if (!fiscal_year) return res.status(400).json({ error: 'ต้องระบุ fiscal_year' });

    const yearStart = `${fiscal_year}-01-01`;
    const yearEnd   = `${fiscal_year}-12-31`;

    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const issues = [];

        const hasStmt     = await tableExists(client, 'cm_bank_statement');
        const hasReceipt  = await tableExists(client, 'cm_receipt');
        const hasPayment  = await tableExists(client, 'cm_payment');
        const hasFxReval  = await tableExists(client, 'cm_bank_fx_revaluation');
        const hasTransfer = await tableExists(client, 'cm_inter_bank_transfer');
        const hasPCV      = await tableExists(client, 'cm_petty_cash_voucher');

        if (hasStmt) {
            let r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_bank_statement WHERE status='Draft' AND statement_date_to BETWEEN $1 AND $2`,
                [yearStart, yearEnd]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ severity: 'WARNING', title: 'Bank Statement ยังไม่ยืนยัน', count: parseInt(r.rows[0].cnt) });

            r = await client.query(`
                SELECT COUNT(*) AS cnt FROM cm_bank_statement_line l
                JOIN cm_bank_statement s ON s.id = l.statement_id
                WHERE s.status='Confirmed' AND l.is_reconciled=FALSE
                  AND s.statement_date_to BETWEEN $1 AND $2`, [yearStart, yearEnd]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ severity: 'WARNING', title: 'รายการ Reconcile ที่ยังค้าง', count: parseInt(r.rows[0].cnt) });
        }
        if (hasReceipt) {
            const r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_receipt WHERE check_no IS NOT NULL AND check_no!='' AND status='Pending' AND receipt_date BETWEEN $1 AND $2`,
                [yearStart, yearEnd]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ severity: 'WARNING', title: 'เช็คที่รับยังไม่ผ่านเรียกเก็บ', count: parseInt(r.rows[0].cnt) });
        }
        if (hasPayment) {
            const r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_payment WHERE check_no IS NOT NULL AND check_no!='' AND status='Pending' AND payment_date BETWEEN $1 AND $2`,
                [yearStart, yearEnd]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ severity: 'WARNING', title: 'เช็คที่จ่ายยังไม่ผ่าน', count: parseInt(r.rows[0].cnt) });
        }
        if (hasFxReval) {
            const r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_bank_fx_revaluation WHERE status='Draft' AND revaluation_date BETWEEN $1 AND $2`,
                [yearStart, yearEnd]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ severity: 'ERROR', title: 'FX Revaluation ยังไม่ Post GL', count: parseInt(r.rows[0].cnt) });
        }
        if (hasTransfer) {
            const r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_inter_bank_transfer WHERE status='Draft' AND transfer_date BETWEEN $1 AND $2`,
                [yearStart, yearEnd]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ severity: 'ERROR', title: 'Inter-bank Transfer ยังไม่ Post GL', count: parseInt(r.rows[0].cnt) });
        }
        if (hasPCV) {
            const r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_petty_cash_voucher WHERE status='Approved' AND voucher_date BETWEEN $1 AND $2`,
                [yearStart, yearEnd]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ severity: 'INFO', title: 'ใบสำคัญเงินสดย่อยรอเบิก', count: parseInt(r.rows[0].cnt) });
        }

        // Check if already closed
        const yr = await client.query(`SELECT * FROM cm_year_end WHERE fiscal_year=$1`, [fiscal_year]);
        const alreadyClosed = yr.rows.length > 0 && yr.rows[0].status === 'Closed';

        res.json({
            fiscal_year: parseInt(fiscal_year),
            year_start: yearStart,
            year_end:   yearEnd,
            issues,
            has_errors:    issues.some(i => i.severity === 'ERROR'),
            already_closed: alreadyClosed,
            year_end_record: yr.rows[0] || null,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// Fetch all year-end records
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const r = await client.query(`SELECT * FROM cm_year_end ORDER BY fiscal_year DESC`);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// Close the year — take bank balance snapshot and mark as Closed
const closeYear = async (req, res) => {
    const { fiscal_year, notes } = req.body;
    if (!fiscal_year) return res.status(400).json({ error: 'ต้องระบุ fiscal_year' });

    const closedBy = req.headers.username || 'system';
    const yearEnd  = `${fiscal_year}-12-31`;

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTables(client);

        // Check if already closed
        const chk = await client.query(`SELECT status FROM cm_year_end WHERE fiscal_year=$1`, [fiscal_year]);
        if (chk.rows.length > 0 && chk.rows[0].status === 'Closed') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `ปี ${fiscal_year} ถูกปิดไปแล้ว` });
        }

        // Take bank balance snapshot as of Dec 31
        const accsRes = await client.query(`
            SELECT ba.id, ba.account_code, ba.account_name_th, ba.currency_code,
                   cb.short_name AS bank_short_name
            FROM cm_bank_account ba
            LEFT JOIN cd_bank cb ON cb.id = ba.bank_id
            WHERE ba.cm_type='BANK' AND ba.is_active=TRUE ORDER BY ba.account_code`);

        const hasReceipt  = await tableExists(client, 'cm_receipt');
        const hasPayment  = await tableExists(client, 'cm_payment');
        const hasTransfer = await tableExists(client, 'cm_inter_bank_transfer');
        const hasFxReval  = await tableExists(client, 'cm_bank_fx_revaluation');

        const bankSnapshots = [];
        for (const acc of accsRes.rows) {
            let balance = 0;
            if (hasReceipt) {
                const r = await client.query(`SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_receipt WHERE bank_account_id=$1 AND status!='Voided' AND receipt_date<=$2`, [acc.id, yearEnd]);
                balance += parseFloat(r.rows[0].amt);
            }
            if (hasPayment) {
                const r = await client.query(`SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_payment WHERE bank_account_id=$1 AND status!='Voided' AND payment_date<=$2`, [acc.id, yearEnd]);
                balance -= parseFloat(r.rows[0].amt);
            }
            if (hasTransfer) {
                const rIn  = await client.query(`SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_inter_bank_transfer WHERE to_bank_account_id=$1   AND status='Posted' AND transfer_date<=$2`, [acc.id, yearEnd]);
                const rOut = await client.query(`SELECT COALESCE(SUM(amount_lc),0) AS amt FROM cm_inter_bank_transfer WHERE from_bank_account_id=$1 AND status='Posted' AND transfer_date<=$2`, [acc.id, yearEnd]);
                balance += parseFloat(rIn.rows[0].amt) - parseFloat(rOut.rows[0].amt);
            }
            if (hasFxReval) {
                const r = await client.query(`
                    SELECT COALESCE(SUM(rl.fx_gain_loss),0) AS adj
                    FROM cm_bank_fx_revaluation_line rl
                    JOIN cm_bank_fx_revaluation rv ON rv.id=rl.revaluation_id
                    WHERE rl.bank_account_id=$1 AND rv.status='Posted' AND rv.revaluation_date<=$2`,
                    [acc.id, yearEnd]);
                balance += parseFloat(r.rows[0].adj);
            }
            bankSnapshots.push({
                bank_account_id: acc.id, bank_account_code: acc.account_code,
                bank_account_name: acc.account_name_th, currency_code: acc.currency_code,
                bank_short_name: acc.bank_short_name,
                balance: Math.round(balance * 100) / 100,
            });
        }

        await client.query(`
            INSERT INTO cm_year_end (fiscal_year, close_date, status, notes, closed_by, bank_balances)
            VALUES ($1, $2, 'Closed', $3, $4, $5)
            ON CONFLICT (fiscal_year) DO UPDATE SET
                close_date=$2, status='Closed', notes=$3, closed_by=$4, bank_balances=$5, updated_at=NOW()`,
            [fiscal_year, yearEnd, notes || null, closedBy, JSON.stringify(bankSnapshots)]);

        await client.query('COMMIT');
        res.json({ success: true, fiscal_year: parseInt(fiscal_year), bank_balances: bankSnapshots });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// Reopen a closed year (admin action)
const reopenYear = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const r = await client.query(`UPDATE cm_year_end SET status='Open', updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { fetchRows, checkReadiness, closeYear, reopenYear };
