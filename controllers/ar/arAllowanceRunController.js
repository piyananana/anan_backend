// controllers/ar/arAllowanceRunController.js
// Allowance for Doubtful Accounts — คำนวณค่าเผื่อหนี้สงสัยจะสูญ

// ── Helper: คำนวณ allowance details ─────────────────────────────────────────
const calcAllowanceDetails = async (client, runDate) => {
    const rules = (await client.query(
        `SELECT * FROM ar_allowance_rule WHERE is_active=true ORDER BY sort_order, age_from_days`
    )).rows;
    if (rules.length === 0) throw new Error('ยังไม่ได้ตั้งค่ากฎ % สำรองหนี้สงสัยจะสูญ');

    // ดึง invoice ที่ค้างชำระทั้งหมด พร้อมข้อมูลลูกหนี้
    const invoices = (await client.query(`
        SELECT t.id AS invoice_id, t.customer_id, t.doc_no, t.ref_doc_no, t.doc_date,
               t.due_date, t.balance_amount_lc,
               c.customer_code, c.customer_name_th,
               $1::date - COALESCE(t.due_date, t.doc_date) AS age_days
        FROM ar_transaction t
        JOIN sa_module_document d ON d.id = t.doc_id
        JOIN ar_customer c ON c.id = t.customer_id
        WHERE d.sys_doc_type IN ('10','30','35')
          AND t.status = 'Posted'
          AND t.balance_amount_lc > 0.005
          AND COALESCE(t.due_date, t.doc_date) <= $1::date
        ORDER BY c.customer_code, t.doc_date
    `, [runDate])).rows;

    const details = [];
    for (const inv of invoices) {
        const ageDays = Math.max(0, parseInt(inv.age_days) || 0);
        const rule = rules.find(r =>
            ageDays >= r.age_from_days &&
            (r.age_to_days === null || ageDays <= r.age_to_days)
        );
        if (!rule || Number(rule.rate) === 0) continue;

        const balanceLc      = Number(inv.balance_amount_lc);
        const allowanceAmt   = Math.round(balanceLc * Number(rule.rate) / 100 * 100) / 100;

        details.push({
            invoice_id:        inv.invoice_id,
            customer_id:       inv.customer_id,
            customer_code:     inv.customer_code,
            customer_name_th:  inv.customer_name_th,
            doc_no:            inv.doc_no,
            ref_doc_no:        inv.ref_doc_no || '',
            doc_date:          inv.doc_date,
            due_date:          inv.due_date,
            age_days:          ageDays,
            balance_amount_lc: balanceLc,
            rate:              Number(rule.rate),
            allowance_amount:  allowanceAmt,
        });
    }
    return details;
};

// ── Helper: ยอดค่าเผื่อสะสมที่มีอยู่แล้ว ─────────────────────────────────────
const getPriorAllowance = async (client, setup) => {
    if (!setup?.allowance_contra_account_id) return 0;
    const r = await client.query(`
        SELECT COALESCE(SUM(credit_lc - debit_lc), 0) AS balance
        FROM gl_entry_detail ged
        JOIN gl_entry_header geh ON geh.id = ged.header_id
        WHERE ged.account_id = $1 AND geh.status = 'Posted'
    `, [setup.allowance_contra_account_id]);
    return Math.abs(Number(r.rows[0].balance || 0));
};

// ── GET /api/ar/ar_allowance_run ─────────────────────────────────────────────
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            `SELECT r.*, g.doc_no AS gl_doc_no
             FROM ar_allowance_run r
             LEFT JOIN gl_entry_header g ON g.id = r.gl_entry_id
             ORDER BY r.run_date DESC, r.id DESC`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ── GET /api/ar/ar_allowance_run/:id ─────────────────────────────────────────
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        const hdr = await req.dbPool.query(
            `SELECT r.*, g.doc_no AS gl_doc_no
             FROM ar_allowance_run r
             LEFT JOIN gl_entry_header g ON g.id = r.gl_entry_id
             WHERE r.id=$1`, [id]
        );
        if (!hdr.rows[0]) return res.status(404).json({ error: 'Not found' });

        const dtl = await req.dbPool.query(`
            SELECT d.*, c.customer_code, c.customer_name_th,
                   t.ref_doc_no
            FROM ar_allowance_run_detail d
            LEFT JOIN ar_customer c ON c.id = d.customer_id
            LEFT JOIN ar_transaction t ON t.id = d.invoice_id
            WHERE d.run_id=$1
            ORDER BY c.customer_code, d.doc_date
        `, [id]);

        res.json({ header: hdr.rows[0], details: dtl.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ── POST /api/ar/ar_allowance_run/preview ────────────────────────────────────
const previewRun = async (req, res) => {
    const { run_date } = req.body;
    if (!run_date) return res.status(400).json({ error: 'run_date required' });
    const client = await req.dbPool.connect();
    try {
        const setup   = (await client.query('SELECT * FROM ar_year_end_setup LIMIT 1')).rows[0];
        const details = await calcAllowanceDetails(client, run_date);
        const totalAllowance = Math.round(details.reduce((s, d) => s + d.allowance_amount, 0) * 100) / 100;
        const priorAllowance = await getPriorAllowance(client, setup);
        const adjustmentAmount = Math.round((totalAllowance - priorAllowance) * 100) / 100;
        res.json({ details, total_allowance: totalAllowance, prior_allowance: priorAllowance, adjustment_amount: adjustmentAmount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── POST /api/ar/ar_allowance_run (สร้าง Draft) ──────────────────────────────
const createRun = async (req, res) => {
    const { run_date, period_year, note } = req.body;
    if (!run_date || !period_year) return res.status(400).json({ error: 'run_date, period_year required' });
    const createdBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const setup   = (await client.query('SELECT * FROM ar_year_end_setup LIMIT 1')).rows[0];
        const details = await calcAllowanceDetails(client, run_date);
        if (details.length === 0) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: 'ไม่มีลูกหนี้ค้างชำระที่เข้าเกณฑ์สำรอง' });
        }

        const totalAllowance   = Math.round(details.reduce((s, d) => s + d.allowance_amount, 0) * 100) / 100;
        const priorAllowance   = await getPriorAllowance(client, setup);
        const adjustmentAmount = Math.round((totalAllowance - priorAllowance) * 100) / 100;

        const hdrRes = await client.query(`
            INSERT INTO ar_allowance_run
            (run_date, period_year, status, total_allowance, prior_allowance, adjustment_amount, note, created_by)
            VALUES ($1,$2,'Draft',$3,$4,$5,$6,$7)
            RETURNING id
        `, [run_date, period_year, totalAllowance, priorAllowance, adjustmentAmount, note || null, createdBy]);
        const runId = hdrRes.rows[0].id;

        for (const d of details) {
            await client.query(`
                INSERT INTO ar_allowance_run_detail
                (run_id, invoice_id, customer_id, doc_no, doc_date, due_date,
                 age_days, balance_amount_lc, rate, allowance_amount)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            `, [runId, d.invoice_id, d.customer_id, d.doc_no, d.doc_date, d.due_date,
                d.age_days, d.balance_amount_lc, d.rate, d.allowance_amount]);
        }

        await client.query('COMMIT');
        res.status(201).json({ id: runId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('createRun error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── POST /api/ar/ar_allowance_run/:id/post ───────────────────────────────────
const postRun = async (req, res) => {
    const { id } = req.params;
    const updatedBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const hdr = await client.query(
            `SELECT * FROM ar_allowance_run WHERE id=$1 FOR UPDATE`, [id]
        );
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        if (hdr.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Only Draft can be posted' }); }

        const run   = hdr.rows[0];
        const setup = (await client.query('SELECT * FROM ar_year_end_setup LIMIT 1')).rows[0];
        if (!setup?.allowance_expense_account_id || !setup?.allowance_contra_account_id)
            throw new Error('ยังไม่ได้ตั้งค่าบัญชีค่าเผื่อหนี้สงสัยจะสูญ');
        if (Math.abs(Number(run.adjustment_amount)) < 0.005) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: 'ยอดปรับ adjustment_amount เป็น 0 ไม่ต้องบันทึก GL' });
        }

        // หา period
        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`, [run.run_date]
        );
        if (periodRes.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${run.run_date}`);
        const periodId = periodRes.rows[0].id;

        const adj    = Number(run.adjustment_amount);
        const isInc  = adj > 0;   // เพิ่มค่าเผื่อ: DR expense, CR contra
        const absAdj = Math.abs(adj);

        const docNo = `ALLOW-${run.run_date.toISOString().slice(0, 10).replace(/-/g, '')}`;

        const glRes = await client.query(`
            INSERT INTO gl_entry_header
            (doc_id, doc_no, doc_date, posting_date, period_id, description,
             currency_id, exchange_rate, status,
             total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc, created_by)
            SELECT $1,$2,$3::date,$3::date,$4,$5,
                   (SELECT id FROM cd_currency WHERE base_currency_flag=true LIMIT 1),
                   1,'Posted',$6,$6,$6,$6,$7
            RETURNING id
        `, [setup.allowance_gl_doc_id, docNo, run.run_date, periodId,
            `ค่าเผื่อหนี้สงสัยจะสูญ ปี ${run.period_year}`,
            absAdj, updatedBy]);
        const glEntryId = glRes.rows[0].id;

        // DR Expense (เพิ่ม) หรือ CR Expense (ลด)
        await client.query(`
            INSERT INTO gl_entry_detail (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
            VALUES ($1,1,$2,$3,$4,$3,$4)
        `, [glEntryId, setup.allowance_expense_account_id,
            isInc ? absAdj : 0, isInc ? 0 : absAdj]);

        // CR Contra (เพิ่ม) หรือ DR Contra (ลด)
        await client.query(`
            INSERT INTO gl_entry_detail (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
            VALUES ($1,2,$2,$3,$4,$3,$4)
        `, [glEntryId, setup.allowance_contra_account_id,
            isInc ? 0 : absAdj, isInc ? absAdj : 0]);

        await client.query(`
            UPDATE ar_allowance_run SET status='Posted', gl_entry_id=$1, updated_by=$2, updated_at=NOW()
            WHERE id=$3
        `, [glEntryId, updatedBy, id]);

        await client.query('COMMIT');
        res.json({ success: true, gl_entry_id: glEntryId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('postRun error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── POST /api/ar/ar_allowance_run/:id/void ───────────────────────────────────
const voidRun = async (req, res) => {
    const { id } = req.params;
    const updatedBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const hdr = await client.query(
            `SELECT * FROM ar_allowance_run WHERE id=$1 FOR UPDATE`, [id]
        );
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        if (hdr.rows[0].status !== 'Posted') { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Only Posted can be voided' }); }

        const run   = hdr.rows[0];
        const today = new Date().toISOString().slice(0, 10);

        const todayPeriod = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`, [today]
        );
        if (todayPeriod.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ยกเลิก ${today}`);
        const todayPeriodId = todayPeriod.rows[0].id;

        if (run.gl_entry_id) {
            const origHdr = (await client.query(
                `SELECT * FROM gl_entry_header WHERE id=$1`, [run.gl_entry_id]
            )).rows[0];
            const origDtl = (await client.query(
                `SELECT * FROM gl_entry_detail WHERE header_id=$1 ORDER BY line_no`, [run.gl_entry_id]
            )).rows;

            const revDocNo = `VOID-ALLOW-${today.replace(/-/g, '')}`;
            const revRes = await client.query(`
                INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id, description,
                 currency_id, exchange_rate, status,
                 total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
                 created_by, ref_doc_id, ref_doc_no)
                VALUES ($1,$2,$3::date,$3::date,$4,$5,$6,1,'Posted',$7,$8,$7,$8,$9,$10,$11)
                RETURNING id
            `, [origHdr.doc_id, revDocNo, today, todayPeriodId,
                `[ยกเลิก] ${origHdr.doc_no}`, origHdr.currency_id,
                origHdr.total_credit_lc, origHdr.total_debit_lc,
                updatedBy, run.gl_entry_id, origHdr.doc_no]);
            const voidGlId = revRes.rows[0].id;

            for (const d of origDtl) {
                await client.query(`
                    INSERT INTO gl_entry_detail
                    (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
                    VALUES ($1,$2,$3,$4,$5,$4,$5)
                `, [voidGlId, d.line_no, d.account_id, d.credit_lc, d.debit_lc]);
            }
        }

        await client.query(`
            UPDATE ar_allowance_run SET status='Void', updated_by=$1, updated_at=NOW()
            WHERE id=$2
        `, [updatedBy, id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('voidRun error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── DELETE /api/ar/ar_allowance_run/:id ──────────────────────────────────────
const deleteRun = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hdr = await client.query(`SELECT status FROM ar_allowance_run WHERE id=$1`, [id]);
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        if (hdr.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Only Draft can be deleted' }); }
        await client.query(`DELETE FROM ar_allowance_run_detail WHERE run_id=$1`, [id]);
        await client.query(`DELETE FROM ar_allowance_run WHERE id=$1`, [id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('deleteRun error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { fetchRows, fetchRow, previewRun, createRun, postRun, voidRun, deleteRun };
