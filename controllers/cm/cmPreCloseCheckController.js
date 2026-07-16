// controllers/cm/cmPreCloseCheckController.js
'use strict';

const tableExists = async (client, name) => {
    const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [name]);
    return r.rows.length > 0;
};

const runChecks = async (req, res) => {
    const { period_date } = req.query;
    if (!period_date) return res.status(400).json({ error: 'ต้องระบุ period_date' });

    const client = await req.dbPool.connect();
    try {
        const issues = [];

        const hasStmt     = await tableExists(client, 'cm_bank_statement');
        const hasReceipt  = await tableExists(client, 'cm_receipt');
        const hasPayment  = await tableExists(client, 'cm_payment');
        const hasFxReval  = await tableExists(client, 'cm_bank_fx_revaluation');
        const hasPCV      = await tableExists(client, 'cm_petty_cash_voucher');
        const hasTransfer = await tableExists(client, 'cm_inter_bank_transfer');

        // 1. Unconfirmed bank statements
        if (hasStmt) {
            let r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_bank_statement WHERE status='Draft' AND statement_date_to<=$1`,
                [period_date]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ check_key: 'UNCONFIRMED_STATEMENTS', severity: 'WARNING',
                    title: 'Bank Statement ที่ยังไม่ยืนยัน', count: parseInt(r.rows[0].cnt),
                    message: `มี Bank Statement ${r.rows[0].cnt} รายการที่ยังไม่ได้ Confirm` });

            // 2. Unreconciled lines in confirmed statements
            r = await client.query(`
                SELECT COUNT(*) AS cnt FROM cm_bank_statement_line l
                JOIN cm_bank_statement s ON s.id = l.statement_id
                WHERE s.status='Confirmed' AND l.is_reconciled=FALSE AND s.statement_date_to<=$1`,
                [period_date]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ check_key: 'UNRECONCILED_LINES', severity: 'WARNING',
                    title: 'รายการที่ยังไม่ได้ Reconcile', count: parseInt(r.rows[0].cnt),
                    message: `มีรายการใน Bank Statement ${r.rows[0].cnt} รายการที่ยังไม่ได้จับคู่` });
        }

        // 3. Pending received checks
        if (hasReceipt) {
            const r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_receipt WHERE check_no IS NOT NULL AND check_no!='' AND status='Pending' AND receipt_date<=$1`,
                [period_date]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ check_key: 'PENDING_CHECKS_RECEIVED', severity: 'WARNING',
                    title: 'เช็คที่รับยังไม่ผ่านเรียกเก็บ', count: parseInt(r.rows[0].cnt),
                    message: `มีเช็คที่รับ ${r.rows[0].cnt} ฉบับที่ยังอยู่ในสถานะ Pending` });
        }

        // 4. Pending issued checks
        if (hasPayment) {
            const r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_payment WHERE check_no IS NOT NULL AND check_no!='' AND status='Pending' AND payment_date<=$1`,
                [period_date]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ check_key: 'PENDING_CHECKS_ISSUED', severity: 'WARNING',
                    title: 'เช็คที่จ่ายยังไม่ผ่าน', count: parseInt(r.rows[0].cnt),
                    message: `มีเช็คที่จ่าย ${r.rows[0].cnt} ฉบับที่ยังอยู่ในสถานะ Pending` });
        }

        // 5. Draft FX revaluations
        if (hasFxReval) {
            const r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_bank_fx_revaluation WHERE status='Draft' AND revaluation_date<=$1`,
                [period_date]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ check_key: 'DRAFT_FX_REVALUATIONS', severity: 'ERROR',
                    title: 'FX Revaluation ที่ยังไม่ได้ Post GL', count: parseInt(r.rows[0].cnt),
                    message: `มี FX Revaluation ${r.rows[0].cnt} รายการที่ยังเป็น Draft — ต้อง Post GL ก่อนปิดงวด` });
        }

        // 6. Approved petty cash vouchers not replenished
        if (hasPCV) {
            const r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_petty_cash_voucher WHERE status='Approved' AND voucher_date<=$1`,
                [period_date]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ check_key: 'PENDING_PETTY_CASH', severity: 'INFO',
                    title: 'ใบสำคัญเงินสดย่อยที่ยังไม่เบิก', count: parseInt(r.rows[0].cnt),
                    message: `มีใบสำคัญเงินสดย่อย ${r.rows[0].cnt} รายการที่ยังไม่ได้เบิกชำระ` });
        }

        // 7. Draft inter-bank transfers
        if (hasTransfer) {
            const r = await client.query(
                `SELECT COUNT(*) AS cnt FROM cm_inter_bank_transfer WHERE status='Draft' AND transfer_date<=$1`,
                [period_date]);
            if (parseInt(r.rows[0].cnt) > 0)
                issues.push({ check_key: 'DRAFT_TRANSFERS', severity: 'ERROR',
                    title: 'Inter-bank Transfer ที่ยังไม่ได้ Post GL', count: parseInt(r.rows[0].cnt),
                    message: `มี Inter-bank Transfer ${r.rows[0].cnt} รายการที่ยังเป็น Draft — ต้อง Post GL ก่อนปิดงวด` });
        }

        res.json({
            period_date,
            issues,
            total_issues: issues.length,
            has_errors:   issues.some(i => i.severity === 'ERROR'),
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { runChecks };
