// controllers/ar/arAllowanceRunController.js
const { today: todayYmd, ymd } = require('../../utils/dateUtil');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
const { generateDocNo } = require('./arTransactionController');

// คอลัมน์สำหรับถอยเป็นร่าง / ยกเลิก / ลบ (sql/ar_allowance_run_reverse_to_draft.sql)
const ensureRunColumns = async (db) => {
    await db.query(`
        ALTER TABLE ar_allowance_run
            ADD COLUMN IF NOT EXISTS void_reason TEXT,
            ADD COLUMN IF NOT EXISTS voided_by VARCHAR(100),
            ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS void_gl_entry_id INT,
            ADD COLUMN IF NOT EXISTS kept_gl_doc_no VARCHAR(50)
    `).catch(() => {});
    await db.query(`
        ALTER TABLE ar_allowance_run DROP CONSTRAINT IF EXISTS ar_allowance_run_status_check;
        ALTER TABLE ar_allowance_run ADD CONSTRAINT ar_allowance_run_status_check
            CHECK (status IN ('Draft', 'Posted', 'Void', 'Deleted'))
    `).catch(() => {});
};
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
               c.customer_code, c.customer_name_th, c.customer_name_en,
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
            customer_name_en:  inv.customer_name_en,
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
        await ensureRunColumns(req.dbPool);
        // ใบที่ลบซ่อนไว้ เว้นแต่ ?status=Deleted
        const showDeleted = req.query.status === 'Deleted';
        const result = await req.dbPool.query(
            `SELECT r.*, g.doc_no AS gl_doc_no
             FROM ar_allowance_run r
             LEFT JOIN gl_entry_header g ON g.id = r.gl_entry_id
             WHERE ${showDeleted ? `r.status = 'Deleted'` : `r.status <> 'Deleted'`}
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
        await ensureRunColumns(req.dbPool);
        const hdr = await req.dbPool.query(
            `SELECT r.*, g.doc_no AS gl_doc_no
             FROM ar_allowance_run r
             LEFT JOIN gl_entry_header g ON g.id = r.gl_entry_id
             WHERE r.id=$1`, [id]
        );
        if (!hdr.rows[0]) return res.status(404).json({ error: 'Not found' });

        const dtl = await req.dbPool.query(`
            SELECT d.*, c.customer_code, c.customer_name_th, c.customer_name_en,
                   t.ref_doc_no
            FROM ar_allowance_run_detail d
            LEFT JOIN ar_customer c ON c.id = d.customer_id
            LEFT JOIN ar_transaction t ON t.id = d.invoice_id
            WHERE d.run_id=$1
            ORDER BY c.customer_code, d.doc_date
        `, [id]);

        res.json({
            header: hdr.rows[0], details: dtl.rows, ...(await computeRunBlocks(req.dbPool, id)),
            reverse_history: await getReverseHistory(req.dbPool, 'ar_allowance_run', id),
        });
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

// ===== ถอยเป็นร่าง / ยกเลิก / ลบ =====
// - ถอย (Posted → Draft): งวด GL + AR ของวันที่คำนวณยังเปิด และไม่มีการคำนวณครั้งถัดไปที่โพสต์แล้ว
//   (ครั้งถัดไปคำนวณยอดสะสมเดิม (prior_allowance) จากรายการบัญชีของครั้งนี้) — ลบรายการบัญชี เก็บเลขที่ไว้ใช้ซ้ำ
// - ยกเลิก: ใช้เมื่อถอยไม่ได้ (เช่น งวดปิดแล้ว) ลงรายการกลับในวันที่ยกเลิก — ติดเงื่อนไขครั้งถัดไปเหมือนกัน
// - ลบ: เฉพาะร่าง เก็บไว้ด้วยสถานะ Deleted
// ทุกการกระทำต้องมีเหตุผล และบันทึกที่ sa_document_reverse_log
const RUN_BLOCK_MESSAGES = {
    NOT_REVERSIBLE: 'ถอยได้เฉพาะรายการที่โพสต์แล้ว',
    NOT_POSTED:     'ยกเลิกได้เฉพาะรายการที่โพสต์แล้ว (ร่างให้ลบแทน)',
    NOT_DRAFT:      'รายการที่โพสต์แล้วลบไม่ได้ กรุณาถอยเป็นร่างก่อน',
    PERIOD_CLOSED:  'งวดบัญชีของรายการนี้ปิดแล้ว ถอยไม่ได้',
    LATER_RUN:      'มีการคำนวณค่าเผื่อครั้งถัดไปที่โพสต์แล้ว (คำนวณจากยอดสะสมที่รวมครั้งนี้)',
    VOIDED:         'รายการนี้ถูกยกเลิกหรือลบแล้ว',
};
const packBlock = (code, ref) => code
    ? { code, ref: ref || null, message: RUN_BLOCK_MESSAGES[code] + (ref ? ` (${ref})` : '') } : null;

const RUN_INFO_SQL = `
    SELECT r.id, r.status, p.gl_status, p.ar_status,
           (SELECT string_agg(to_char(n.run_date, 'DD/MM/YYYY'), ', ' ORDER BY n.run_date)
              FROM ar_allowance_run n
             WHERE n.id <> r.id AND n.status = 'Posted'
               AND (n.run_date > r.run_date OR (n.run_date = r.run_date AND n.id > r.id))) AS later_runs
      FROM ar_allowance_run r
      LEFT JOIN gl_posting_period p ON r.run_date BETWEEN p.period_start_date AND p.period_end_date
     WHERE r.id = $1`;

const computeRunBlocks = async (db, id) => {
    const r = (await db.query(RUN_INFO_SQL, [id])).rows[0];
    if (!r) return {};
    if (['Void', 'Deleted'].includes(r.status)) {
        const v = packBlock('VOIDED');
        return { reverse_block: v, void_block: v, delete_block: v };
    }
    if (r.status !== 'Posted') {
        return { reverse_block: packBlock('NOT_REVERSIBLE'), void_block: packBlock('NOT_POSTED'), delete_block: null };
    }
    const later = r.later_runs ? packBlock('LATER_RUN', r.later_runs) : null;
    const reverse = (r.gl_status !== 'OPEN' || r.ar_status !== 'OPEN') ? packBlock('PERIOD_CLOSED') : later;
    return { reverse_block: reverse, void_block: later, delete_block: packBlock('NOT_DRAFT') };
};

const reasonOf = (req) => (req.body?.reason || '').trim();
const userIdOf = (req) => req.body?.user_id || req.headers['userid'] || null;
// gl_entry_header.created_by เป็นรหัสผู้ใช้ (int)
const glUserOf = (req) => { const v = Number(req.headers['userid']); return Number.isFinite(v) && v > 0 ? v : null; };
const sendErr = (res, status, message, extra = {}) => res.status(status).json({ error: message, message, ...extra });
// เลขที่รายการบัญชี: เลขอัตโนมัติของประเภทเอกสาร GL — ถ้าไม่ได้ตั้งเลขอัตโนมัติ ใช้รูปแบบเดิม + id
// (รูปแบบเดิม ALLOW-YYYYMMDD ซ้ำกันเมื่อมีรายการวันเดียวกันที่ยกเลิกไปแล้ว)
const nextGlDocNo = async (client, glDocId, date, fallback) =>
    (glDocId && await generateDocNo(client, glDocId, date, null)) || fallback;
const runLabel = (run) => run.kept_gl_doc_no || `ALLOW ${ymd(run.run_date)}`;

// ── POST /api/ar/ar_allowance_run/:id/post ───────────────────────────────────
const postRun = async (req, res) => {
    const { id } = req.params;
    const updatedBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRunColumns(client);

        const hdr = await client.query(
            `SELECT * FROM ar_allowance_run WHERE id=$1 FOR UPDATE`, [id]
        );
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        if (hdr.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return sendErr(res, 422, 'Only Draft can be posted'); }

        const run   = hdr.rows[0];
        const setup = (await client.query('SELECT * FROM ar_year_end_setup LIMIT 1')).rows[0];
        if (!setup?.allowance_expense_account_id || !setup?.allowance_contra_account_id)
            throw new Error('ยังไม่ได้ตั้งค่าบัญชีค่าเผื่อหนี้สงสัยจะสูญ');
        if (Math.abs(Number(run.adjustment_amount)) < 0.005) {
            await client.query('ROLLBACK');
            return sendErr(res, 422, 'ยอดปรับ adjustment_amount เป็น 0 ไม่ต้องบันทึก GL');
        }
        // ยอดปรับ = ยอดที่ควรเป็น − ยอดสะสม ณ ตอนสร้าง — ถ้ายอดสะสมเปลี่ยนไปแล้ว (มีการโพสต์/ยกเลิกครั้งอื่น) ต้องสร้างใหม่
        const priorNow = await getPriorAllowance(client, setup);
        if (Math.abs(priorNow - Number(run.prior_allowance)) > 0.005) {
            await client.query('ROLLBACK');
            return sendErr(res, 422, `ยอดค่าเผื่อสะสมเปลี่ยนไปหลังสร้างรายการนี้ (เดิม ${Number(run.prior_allowance).toFixed(2)} ปัจจุบัน ${priorNow.toFixed(2)}) กรุณาลบแล้วสร้างใหม่`);
        }

        // หา period (GL + AR ต้องเปิด)
        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' AND ar_status = 'OPEN' LIMIT 1`, [run.run_date]
        );
        if (periodRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return sendErr(res, 422, `งวดบัญชี/งวด AR ของวันที่ ${ymd(run.run_date)} ยังไม่เปิด โพสต์ไม่ได้`);
        }
        const periodId = periodRes.rows[0].id;

        const adj    = Number(run.adjustment_amount);
        const isInc  = adj > 0;   // เพิ่มค่าเผื่อ: DR expense, CR contra
        const absAdj = Math.abs(adj);

        // ถอยแล้วโพสต์ใหม่ใช้เลขเดิม
        const docNo = run.kept_gl_doc_no || await nextGlDocNo(client, setup.allowance_gl_doc_id, run.run_date,
            `ALLOW-${ymd(run.run_date).replace(/-/g, '')}-${run.id}`);

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
            absAdj, glUserOf(req)]);
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
            UPDATE ar_allowance_run SET status='Posted', gl_entry_id=$1, kept_gl_doc_no=$2, updated_by=$3, updated_at=NOW()
            WHERE id=$4
        `, [glEntryId, docNo, updatedBy, id]);

        await client.query('COMMIT');
        res.json({ success: true, gl_entry_id: glEntryId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('postRun error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

// ── PUT /api/ar/ar_allowance_run/:id/reverse { reason } — Posted → Draft ─────
const reverseRun = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการถอยเอกสาร');
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRunColumns(client);
        const run = (await client.query(`SELECT * FROM ar_allowance_run WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!run) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeRunBlocks(client, id)).reverse_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }

        await client.query(`
            UPDATE ar_allowance_run SET status='Draft', gl_entry_id=NULL, updated_by=$1, updated_at=NOW()
             WHERE id=$2`, [req.headers['username'] || null, id]);
        if (run.gl_entry_id) await client.query(`DELETE FROM gl_entry_header WHERE id=$1`, [run.gl_entry_id]);
        await logReverse(client, {
            sysModule: '11', tableName: 'ar_allowance_run', recordId: Number(id), docNo: runLabel(run),
            fromStatus: 'Posted', toStatus: 'Draft', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('reverseRun error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

// ── POST /api/ar/ar_allowance_run/:id/void { reason } ────────────────────────
const voidRun = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการยกเลิก');
    const updatedBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRunColumns(client);

        const hdr = await client.query(
            `SELECT * FROM ar_allowance_run WHERE id=$1 FOR UPDATE`, [id]
        );
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const run   = hdr.rows[0];
        const b = (await computeRunBlocks(client, id)).void_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }

        const today = todayYmd();
        const todayPeriod = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' AND ar_status = 'OPEN' LIMIT 1`, [today]
        );
        if (todayPeriod.rows.length === 0) {
            await client.query('ROLLBACK');
            return sendErr(res, 400, `ไม่พบงวดบัญชี (GL/AR) ที่เปิดอยู่ สำหรับวันที่ยกเลิก ${today}`, { code: 'PERIOD_CLOSED' });
        }
        const todayPeriodId = todayPeriod.rows[0].id;

        let voidGlId = null;
        if (run.gl_entry_id) {
            const origHdr = (await client.query(
                `SELECT * FROM gl_entry_header WHERE id=$1`, [run.gl_entry_id]
            )).rows[0];
            const revDocNo = await nextGlDocNo(client, origHdr.doc_id, today, `VOID-ALLOW-${today.replace(/-/g, '')}-${run.id}`);
            // ref_doc_id อ้างอิงประเภทเอกสาร (FK sa_module_document) จึงใช้ doc_id ของรายการเดิม
            const revRes = await client.query(`
                INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id, description,
                 currency_id, exchange_rate, status,
                 total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
                 created_by, ref_doc_id, ref_doc_no, ref_doc_date)
                VALUES ($1,$2,$3::date,$3::date,$4,$5,$6,1,'Posted',$7,$8,$7,$8,$9,$10,$11,$12)
                RETURNING id
            `, [origHdr.doc_id, revDocNo, today, todayPeriodId,
                `[ยกเลิก ${origHdr.doc_no}] ${reason}`, origHdr.currency_id,
                origHdr.total_credit_lc, origHdr.total_debit_lc,
                glUserOf(req), origHdr.doc_id, origHdr.doc_no, origHdr.doc_date]);
            voidGlId = revRes.rows[0].id;
            await client.query(`
                INSERT INTO gl_entry_detail
                (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
                SELECT $1, line_no, account_id, credit_lc, debit_lc, credit_lc, debit_lc
                  FROM gl_entry_detail WHERE header_id = $2 ORDER BY line_no
            `, [voidGlId, run.gl_entry_id]);
        }

        await client.query(`
            UPDATE ar_allowance_run SET status='Void', void_reason=$1, voided_by=$2, voided_at=NOW(),
                   void_gl_entry_id=$3, updated_by=$2, updated_at=NOW()
            WHERE id=$4
        `, [reason, updatedBy, voidGlId, id]);
        await logReverse(client, {
            sysModule: '11', tableName: 'ar_allowance_run', recordId: Number(id), docNo: runLabel(run),
            fromStatus: 'Posted', toStatus: 'Void', reason, userId: userIdOf(req),
        });

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('voidRun error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

// ── DELETE /api/ar/ar_allowance_run/:id { reason } — เฉพาะร่าง เก็บไว้ด้วยสถานะ Deleted ──
const deleteRun = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการลบเอกสาร');
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRunColumns(client);
        const hdr = await client.query(`SELECT * FROM ar_allowance_run WHERE id=$1 FOR UPDATE`, [id]);
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeRunBlocks(client, id)).delete_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 422, b.message, { code: b.code }); }
        await client.query(`UPDATE ar_allowance_run SET status='Deleted', updated_by=$1, updated_at=NOW() WHERE id=$2`,
            [req.headers['username'] || null, id]);
        await logReverse(client, {
            sysModule: '11', tableName: 'ar_allowance_run', recordId: Number(id), docNo: runLabel(hdr.rows[0]),
            fromStatus: 'Draft', toStatus: 'Deleted', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('deleteRun error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

module.exports = { fetchRows, fetchRow, previewRun, createRun, postRun, reverseRun, voidRun, deleteRun, computeRunBlocks };
