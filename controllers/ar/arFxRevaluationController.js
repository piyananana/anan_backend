// controllers/ar/arFxRevaluationController.js
const { today: todayYmd, ymd } = require('../../utils/dateUtil');
const { BASE_CURRENCY_CODE_SQL } = require('../../utils/baseCurrency');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
const { generateDocNo } = require('./arTransactionController');
const { describeJournalLines, fetchPostedJournalLines } = require('../../utils/glJournalPreview');

// คอลัมน์สำหรับถอยเป็นร่าง / ยกเลิก (sql/ar_fx_revaluation_reverse_to_draft.sql) — ตารางหลักสร้างจาก sql/ar_year_end_closing.sql
const ensureRevalColumns = async (db) => {
    await db.query(`
        ALTER TABLE ar_fx_revaluation
            ADD COLUMN IF NOT EXISTS void_reason TEXT,
            ADD COLUMN IF NOT EXISTS voided_by VARCHAR(100),
            ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS void_gl_entry_id INT,
            ADD COLUMN IF NOT EXISTS void_reversal_gl_entry_id INT,
            ADD COLUMN IF NOT EXISTS kept_gl_doc_no VARCHAR(50),
            ADD COLUMN IF NOT EXISTS kept_reversal_doc_no VARCHAR(50)
    `).catch(() => {});
    await db.query(`
        ALTER TABLE ar_fx_revaluation_detail ADD COLUMN IF NOT EXISTS prev_revaluation_rate NUMERIC(20,6)
    `).catch(() => {});
    // สถานะ Deleted (ลบแบบเก็บไว้)
    await db.query(`
        ALTER TABLE ar_fx_revaluation DROP CONSTRAINT IF EXISTS ar_fx_revaluation_status_check;
        ALTER TABLE ar_fx_revaluation ADD CONSTRAINT ar_fx_revaluation_status_check
            CHECK (status IN ('Draft', 'Posted', 'Void', 'Deleted'))
    `).catch(() => {});
};
// FX Revaluation สำหรับลูกหนี้สกุลเงินต่างประเทศ ณ วันปิดปี

// ── Helper: คำนวณ revaluation details สำหรับ outstanding FC invoices ──────────
const calcRevalDetails = async (client, revalDate, yearEndRates) => {
    // yearEndRates: { currency_id: rate } e.g. { "3": 38.50, "5": 35.20 }
    const DR_TYPES = ['10', '30', '35'];
    const rows = await client.query(`
        SELECT t.id AS invoice_id, t.customer_id, t.currency_id,
               t.currency_code, t.balance_amount_lc, t.exchange_rate AS original_rate,
               t.doc_no, t.ref_doc_no, t.revaluation_rate AS prev_revaluation_rate,
               c.customer_code, c.customer_name_th, c.customer_name_en,
               -- ใช้ revaluation_rate ถ้ามี (realized method ปีก่อน) มิฉะนั้นใช้ original rate
               COALESCE(t.revaluation_rate, t.exchange_rate) AS current_rate,
               CASE WHEN COALESCE(t.revaluation_rate, t.exchange_rate) > 0
                    THEN t.balance_amount_lc / COALESCE(t.revaluation_rate, t.exchange_rate)
                    ELSE 0
               END AS balance_amount_fc
        FROM ar_transaction t
        JOIN sa_module_document d ON d.id = t.doc_id
        JOIN ar_customer c ON c.id = t.customer_id
        WHERE d.sys_doc_type = ANY($1::text[])
          AND t.status = 'Posted'
          AND t.balance_amount_lc > 0.005
          AND t.currency_code <> ${BASE_CURRENCY_CODE_SQL}
          AND t.doc_date <= $2::date
        ORDER BY c.customer_code, t.doc_date, t.doc_no
    `, [DR_TYPES, revalDate]);

    const details = [];
    for (const row of rows.rows) {
        const yearEndRate = yearEndRates[String(row.currency_id)];
        if (!yearEndRate) continue; // ข้าม currency ที่ไม่ได้ระบุ rate

        const balanceFc       = Number(row.balance_amount_fc);
        const balanceLc       = Number(row.balance_amount_lc);
        const revaluedLc      = Math.round(balanceFc * yearEndRate * 100) / 100;
        const fxGainLoss      = Math.round((revaluedLc - balanceLc) * 100) / 100;

        if (Math.abs(fxGainLoss) < 0.005) continue; // ผลต่างน้อยมาก ข้ามได้

        details.push({
            invoice_id:         row.invoice_id,
            customer_id:        row.customer_id,
            customer_code:      row.customer_code,
            customer_name_th:   row.customer_name_th,
            customer_name_en:   row.customer_name_en,
            doc_no:             row.doc_no,
            ref_doc_no:         row.ref_doc_no || '',
            prev_revaluation_rate: row.prev_revaluation_rate,
            currency_code:      row.currency_code,
            balance_amount_fc:  balanceFc,
            original_rate:      Number(row.original_rate),
            balance_amount_lc:  balanceLc,
            year_end_rate:      yearEndRate,
            revalued_amount_lc: revaluedLc,
            fx_gain_loss:       fxGainLoss,
        });
    }
    return details;
};

// ── Helper: ดึง AR Control account สำหรับแต่ละ invoice ────────────────────────
const getArControlAccount = async (client, invoiceId) => {
    const r = await client.query(
        `SELECT ar_account_id FROM ar_transaction WHERE id=$1`, [invoiceId]
    );
    return r.rows[0]?.ar_account_id || null;
};

// ── Helper: บรรทัดรายการบัญชีของ revaluation (ใช้ทั้ง preview และโพสต์จริง) ──
// รวม gain/loss ตามบัญชี AR ของแต่ละ invoice
// DR: AR Control (ถ้า gain) / CR: FX Gain
// DR: FX Loss / CR: AR Control (ถ้า loss)
const buildRevalJournalLines = async (client, setup, details, isUnrealized) => {
    const gainAccountId = isUnrealized
        ? setup?.unrealized_fx_gain_account_id
        : setup?.fx_gain_account_id;
    const lossAccountId = isUnrealized
        ? setup?.unrealized_fx_loss_account_id
        : setup?.fx_loss_account_id;

    if (!gainAccountId || !lossAccountId)
        throw new Error('ยังไม่ได้ตั้งค่าบัญชี FX สำหรับปิดสิ้นปี');

    let totalGain = 0, totalLoss = 0;
    const arAdjMap = {}; // arAccountId → net adjustment (+ = DR, - = CR)

    for (const d of details) {
        const arAccId = await getArControlAccount(client, d.invoice_id);
        if (!arAccId) continue;
        const fxGl = Number(d.fx_gain_loss); // อ่านจาก DB เป็นข้อความ (NUMERIC) — ต้องแปลงก่อนบวก
        arAdjMap[arAccId] = (arAdjMap[arAccId] || 0) + fxGl;
        if (fxGl > 0) totalGain += fxGl;
        else totalLoss += Math.abs(fxGl);
    }

    const lines = [];
    for (const [arAccId, netAdj] of Object.entries(arAdjMap)) {
        if (Math.abs(netAdj) < 0.005) continue;
        lines.push({ account_id: parseInt(arAccId), debit: netAdj > 0 ? netAdj : 0, credit: netAdj < 0 ? -netAdj : 0 });
    }
    if (totalGain > 0.005) lines.push({ account_id: gainAccountId, debit: 0, credit: totalGain });
    if (totalLoss > 0.005) lines.push({ account_id: lossAccountId, debit: totalLoss, credit: 0 });
    return { lines, totalGain, totalLoss };
};

// รายการบัญชีที่จะเกิด (ร่าง/preview) หรือที่โพสต์แล้ว — ตั้งค่าบัญชีไม่ครบให้ข้อความแทน ไม่ทำให้ทั้งคำขอล้ม
const revalJournal = async (db, { glEntryId, details, isUnrealized }) => {
    try {
        if (glEntryId) return { journal: await fetchPostedJournalLines(db, glEntryId), journal_posted: true };
        const setup = (await db.query('SELECT * FROM ar_year_end_setup LIMIT 1')).rows[0];
        if (!setup) return { journal: [], journal_error: 'ยังไม่ได้ตั้งค่าบัญชีปิดสิ้นปี AR' };
        const { lines } = await buildRevalJournalLines(db, setup, details, isUnrealized);
        return { journal: await describeJournalLines(db, lines), journal_posted: false };
    } catch (err) {
        return { journal: [], journal_error: err.message };
    }
};

// ── Helper: สร้าง GL Entry สำหรับ revaluation ────────────────────────────────
const postRevalGlEntry = async (client, setup, details, revalDate, isUnrealized, docNo, createdBy) => {
    const { lines, totalGain, totalLoss } = await buildRevalJournalLines(client, setup, details, isUnrealized);

    // หา period
    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period
         WHERE $1::date BETWEEN period_start_date AND period_end_date
         AND gl_status = 'OPEN' LIMIT 1`, [revalDate]
    );
    if (periodRes.rows.length === 0)
        throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${revalDate}`);
    const periodId = periodRes.rows[0].id;

    const totalDebitLc  = Math.round((totalGain + totalLoss) * 100) / 100;
    const totalCreditLc = totalDebitLc;

    // Insert GL header
    const hdrRes = await client.query(`
        INSERT INTO gl_entry_header
        (doc_id, doc_no, doc_date, posting_date, period_id, description,
         currency_id, exchange_rate, status,
         total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
         created_by)
        SELECT $1, $2, $3::date, $3::date, $4,
               $5,
               (SELECT id FROM cd_currency WHERE base_currency_flag=true LIMIT 1),
               1, 'Posted',
               $6, $7, $6, $7,
               $8
        RETURNING id
    `, [setup.fx_reval_gl_doc_id, docNo, revalDate, periodId,
        isUnrealized ? 'ปรับมูลค่าลูกหนี้ต่างประเทศ (Unrealized)' : 'ปรับมูลค่าลูกหนี้ต่างประเทศ',
        totalDebitLc, totalCreditLc, createdBy]);
    const glEntryId = hdrRes.rows[0].id;

    // AR Control (ต่อบัญชี) แล้ว FX Gain / FX Loss
    let lineNo = 1;
    for (const l of lines) {
        await client.query(`
            INSERT INTO gl_entry_detail
            (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
            VALUES ($1,$2,$3,$4,$5,$4,$5)
        `, [glEntryId, lineNo++, l.account_id, l.debit, l.credit]);
    }

    return glEntryId;
};

// ── GET /api/ar/ar_fx_revaluation/outstanding_currencies?reval_date=YYYY-MM-DD ─
const fetchOutstandingCurrencies = async (req, res) => {
    const { reval_date } = req.query;
    if (!reval_date) return res.status(400).json({ error: 'reval_date required' });
    const DR_TYPES = ['10', '30', '35'];
    try {
        const result = await req.dbPool.query(`
            SELECT DISTINCT t.currency_id, t.currency_code,
                   c.currency_name_th, c.currency_name_en
            FROM ar_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            JOIN cd_currency c ON c.id = t.currency_id
            WHERE d.sys_doc_type = ANY($1::text[])
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0.005
              AND t.currency_code <> ${BASE_CURRENCY_CODE_SQL}
              AND t.doc_date <= $2::date
            ORDER BY t.currency_code
        `, [DR_TYPES, reval_date]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ── GET /api/ar/ar_fx_revaluation ─────────────────────────────────────────────
const fetchRows = async (req, res) => {
    try {
        await ensureRevalColumns(req.dbPool);
        // ใบที่ลบซ่อนไว้ เว้นแต่ ?status=Deleted
        const showDeleted = req.query.status === 'Deleted';
        const result = await req.dbPool.query(`
            SELECT r.*, u.doc_no AS gl_doc_no, v.doc_no AS reversal_doc_no
            FROM ar_fx_revaluation r
            LEFT JOIN gl_entry_header u ON u.id = r.gl_entry_id
            LEFT JOIN gl_entry_header v ON v.id = r.reversal_gl_entry_id
            WHERE ${showDeleted ? `r.status = 'Deleted'` : `r.status <> 'Deleted'`}
            ORDER BY r.reval_date DESC, r.id DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ── GET /api/ar/ar_fx_revaluation/:id ────────────────────────────────────────
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        await ensureRevalColumns(req.dbPool);
        const hdr = await req.dbPool.query(
            `SELECT r.*, u.doc_no AS gl_doc_no, v.doc_no AS reversal_doc_no
             FROM ar_fx_revaluation r
             LEFT JOIN gl_entry_header u ON u.id = r.gl_entry_id
             LEFT JOIN gl_entry_header v ON v.id = r.reversal_gl_entry_id
             WHERE r.id = $1`, [id]
        );
        if (!hdr.rows[0]) return res.status(404).json({ error: 'Not found' });

        const dtl = await req.dbPool.query(`
            SELECT d.*, c.customer_code, c.customer_name_th, c.customer_name_en,
                   t.doc_no AS invoice_doc_no, t.doc_date AS invoice_doc_date
            FROM ar_fx_revaluation_detail d
            LEFT JOIN ar_customer c ON c.id = d.customer_id
            LEFT JOIN ar_transaction t ON t.id = d.invoice_id
            WHERE d.revaluation_id = $1
            ORDER BY c.customer_code, t.doc_date, t.doc_no
        `, [id]);

        res.json({
            header: hdr.rows[0], details: dtl.rows, ...(await computeRevalBlocks(req.dbPool, id)),
            ...(await revalJournal(req.dbPool, {
                glEntryId: hdr.rows[0].gl_entry_id, details: dtl.rows, isUnrealized: hdr.rows[0].method === 'reversing',
            })),
            reverse_history: await getReverseHistory(req.dbPool, 'ar_fx_revaluation', id),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ── POST /api/ar/ar_fx_revaluation/preview ───────────────────────────────────
const previewReval = async (req, res) => {
    const { reval_date, year_end_rates, method } = req.body;
    if (!reval_date || !year_end_rates)
        return res.status(400).json({ error: 'reval_date and year_end_rates required' });
    const client = await req.dbPool.connect();
    try {
        const details = await calcRevalDetails(client, reval_date, year_end_rates);
        const totalGainLoss = details.reduce((s, d) => s + d.fx_gain_loss, 0);
        res.json({
            details, total_fx_gain_loss: Math.round(totalGainLoss * 100) / 100,
            ...(await revalJournal(client, { details, isUnrealized: method !== 'realized' })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── POST /api/ar/ar_fx_revaluation (สร้าง Draft) ─────────────────────────────
const createReval = async (req, res) => {
    const { reval_date, period_year, method, reversal_date, note, year_end_rates } = req.body;
    if (!reval_date || !period_year || !method || !year_end_rates)
        return res.status(400).json({ error: 'reval_date, period_year, method, year_end_rates required' });
    if (!['realized', 'reversing'].includes(method))
        return res.status(400).json({ error: 'method must be realized or reversing' });
    if (method === 'reversing' && !reversal_date)
        return res.status(400).json({ error: 'reversal_date required for reversing method' });

    const createdBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRevalColumns(client);
        const details = await calcRevalDetails(client, reval_date, year_end_rates);
        if (details.length === 0) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: 'ไม่มีลูกหนี้สกุลเงินต่างประเทศที่ค้างชำระ' });
        }
        const totalGainLoss = Math.round(details.reduce((s, d) => s + d.fx_gain_loss, 0) * 100) / 100;

        const hdrRes = await client.query(`
            INSERT INTO ar_fx_revaluation
            (reval_date, period_year, method, status, total_fx_gain_loss,
             reversal_date, note, created_by)
            VALUES ($1,$2,$3,'Draft',$4,$5,$6,$7)
            RETURNING id
        `, [reval_date, period_year, method, totalGainLoss,
            reversal_date || null, note || null, createdBy]);
        const revalId = hdrRes.rows[0].id;

        for (const d of details) {
            await client.query(`
                INSERT INTO ar_fx_revaluation_detail
                (revaluation_id, invoice_id, customer_id, currency_code,
                 balance_amount_fc, original_rate, balance_amount_lc,
                 year_end_rate, revalued_amount_lc, fx_gain_loss, prev_revaluation_rate)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `, [revalId, d.invoice_id, d.customer_id, d.currency_code,
                d.balance_amount_fc, d.original_rate, d.balance_amount_lc,
                d.year_end_rate, d.revalued_amount_lc, d.fx_gain_loss, d.prev_revaluation_rate]);
        }

        await client.query('COMMIT');
        res.status(201).json({ id: revalId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('createReval error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ===== ถอยเป็นร่าง / ยกเลิก / ลบ =====
// - ถอย (Posted → Draft): งวด GL + AR ของวันที่ปรับมูลค่า (และของรายการกลับ ถ้ามี) ยังเปิด
//   แบบ realized: ใบแจ้งหนี้ต้องยังไม่เปลี่ยนตั้งแต่ปรับมูลค่า (ไม่มีจ่ายชำระ/ปรับมูลค่าครั้งถัดไป) จึงคืนยอดเดิมได้
//   ลบรายการบัญชี (และรายการกลับ) — เลขที่รายการบัญชีมาจากวันที่ (FXR-YYYYMMDD) โพสต์ใหม่ได้เลขเดิม
// - ยกเลิก: ใช้เมื่อถอยไม่ได้ (เช่น งวดปิดแล้ว) ลงรายการกลับในวันที่ยกเลิก (รายการกลับเดิมลงกลับในวันที่ช้ากว่า
//   ระหว่างวันนี้กับวันที่กลับรายการ เพื่อให้ยอดสุทธิเป็นศูนย์ทุกช่วงเวลา)
// - ลบ: เฉพาะร่าง เก็บไว้ด้วยสถานะ Deleted (ไม่แสดงในรายการ เว้นแต่เลือกดูใบที่ลบ)
// ทุกการกระทำต้องมีเหตุผล และบันทึกที่ sa_document_reverse_log
const REVAL_BLOCK_MESSAGES = {
    NOT_REVERSIBLE:  'ถอยได้เฉพาะรายการที่โพสต์แล้ว',
    NOT_POSTED:      'ยกเลิกได้เฉพาะรายการที่โพสต์แล้ว (ร่างให้ลบแทน)',
    NOT_DRAFT:       'รายการที่โพสต์แล้วลบไม่ได้ กรุณาถอยเป็นร่างก่อน',
    PERIOD_CLOSED:   'งวดบัญชีของรายการนี้ปิดแล้ว ถอยไม่ได้',
    INVOICE_CHANGED: 'ใบแจ้งหนี้ที่ปรับมูลค่ามีการเปลี่ยนแปลงหลังปรับมูลค่า (จ่ายชำระ/ปรับมูลค่าครั้งถัดไป/ถอย)',
    VOIDED:          'รายการนี้ถูกยกเลิกหรือลบแล้ว',
};
const packBlock = (code, ref) => code
    ? { code, ref: ref || null, message: REVAL_BLOCK_MESSAGES[code] + (ref ? ` (${ref})` : '') } : null;

const REVAL_INFO_SQL = `
    SELECT r.id, r.status, r.method, r.gl_entry_id, r.reversal_gl_entry_id,
           p.gl_status, p.ar_status,
           rp.gl_status AS rev_gl_status, rp.ar_status AS rev_ar_status, rg.doc_no AS reversal_doc_no,
           (SELECT string_agg(DISTINCT t.doc_no, ', ')
              FROM ar_fx_revaluation_detail d JOIN ar_transaction t ON t.id = d.invoice_id
             WHERE d.revaluation_id = r.id
               AND (t.status <> 'Posted' OR ABS(t.balance_amount_lc - d.revalued_amount_lc) > 0.005
                    OR t.revaluation_rate IS DISTINCT FROM d.year_end_rate)) AS changed_invoices
      FROM ar_fx_revaluation r
      LEFT JOIN gl_posting_period p  ON r.reval_date BETWEEN p.period_start_date AND p.period_end_date
      LEFT JOIN gl_entry_header   rg ON rg.id = r.reversal_gl_entry_id
      LEFT JOIN gl_posting_period rp ON rp.id = rg.period_id
     WHERE r.id = $1`;

const computeRevalBlocks = async (db, id) => {
    const r = (await db.query(REVAL_INFO_SQL, [id])).rows[0];
    if (!r) return {};
    if (['Void', 'Deleted'].includes(r.status)) {
        const v = packBlock('VOIDED');
        return { reverse_block: v, void_block: v, delete_block: v };
    }
    if (r.status !== 'Posted') {
        return { reverse_block: packBlock('NOT_REVERSIBLE'), void_block: packBlock('NOT_POSTED'), delete_block: null };
    }
    const changed = r.method === 'realized' && r.changed_invoices ? packBlock('INVOICE_CHANGED', r.changed_invoices) : null;
    let reverse = null;
    if (r.gl_status !== 'OPEN' || r.ar_status !== 'OPEN') reverse = packBlock('PERIOD_CLOSED');
    else if (r.reversal_gl_entry_id && (r.rev_gl_status !== 'OPEN' || r.rev_ar_status !== 'OPEN')) reverse = packBlock('PERIOD_CLOSED', r.reversal_doc_no);
    else reverse = changed;
    return { reverse_block: reverse, void_block: changed, delete_block: packBlock('NOT_DRAFT') };
};

// คืนยอดใบแจ้งหนี้ (realized) กลับเป็นก่อนปรับมูลค่า — รายการเก่าที่ไม่มี prev_revaluation_rate ใช้อัตราจากยอดคงค้างเดิม
const restoreInvoices = async (client, id) => {
    await client.query(`
        UPDATE ar_transaction t SET
               revaluation_rate = COALESCE(d.prev_revaluation_rate,
                   CASE WHEN d.balance_amount_fc = 0
                          OR ABS(d.balance_amount_lc / d.balance_amount_fc - t.exchange_rate) < 0.0001 THEN NULL
                        ELSE ROUND(d.balance_amount_lc / d.balance_amount_fc, 6) END),
               balance_amount_lc = d.balance_amount_lc, updated_at = NOW()
          FROM ar_fx_revaluation_detail d
         WHERE d.revaluation_id = $1 AND t.id = d.invoice_id`, [id]);
};

const reasonOf = (req) => (req.body?.reason || '').trim();
const userIdOf = (req) => req.body?.user_id || req.headers['userid'] || null;
// gl_entry_header.created_by เป็นรหัสผู้ใช้ (int)
const glUserOf = (req) => { const v = Number(req.headers['userid']); return Number.isFinite(v) && v > 0 ? v : null; };
const sendErr = (res, status, message, extra = {}) => res.status(status).json({ error: message, message, ...extra });

// เลขที่รายการบัญชี: เลขอัตโนมัติของประเภทเอกสาร GL — ถ้าประเภทเอกสารไม่ได้ตั้งเลขอัตโนมัติ ใช้รูปแบบเดิม + id
// (รูปแบบเดิม FXR-YYYYMMDD ซ้ำกันเมื่อมีรายการวันเดียวกันที่ยกเลิกไปแล้ว)
const nextGlDocNo = async (client, glDocId, date, fallback) =>
    (glDocId && await generateDocNo(client, glDocId, date, null)) || fallback;
const revalLabel = (reval) => reval.kept_gl_doc_no || `FXR ${ymd(reval.reval_date)}`;

// ── POST /api/ar/ar_fx_revaluation/:id/post ──────────────────────────────────
const postReval = async (req, res) => {
    const { id } = req.params;
    const updatedBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const hdr = await client.query(
            `SELECT * FROM ar_fx_revaluation WHERE id=$1 FOR UPDATE`, [id]
        );
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        if (hdr.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return sendErr(res, 422, 'Only Draft can be posted'); }

        const reval   = hdr.rows[0];
        const setup   = (await client.query('SELECT * FROM ar_year_end_setup LIMIT 1')).rows[0];
        if (!setup) { await client.query('ROLLBACK'); return sendErr(res, 422, 'ยังไม่ได้ตั้งค่าบัญชีปิดสิ้นปี AR'); }

        const details = (await client.query(
            `SELECT * FROM ar_fx_revaluation_detail WHERE revaluation_id=$1`, [id]
        )).rows;

        // ร่าง (รวมที่ถอยกลับมา) คำนวณจากยอดคงค้าง ณ ตอนสร้าง — ถ้าใบแจ้งหนี้เปลี่ยนไปแล้วต้องสร้างใหม่
        const stale = (await client.query(`
            SELECT string_agg(DISTINCT t.doc_no, ', ') AS docs
              FROM ar_fx_revaluation_detail d JOIN ar_transaction t ON t.id = d.invoice_id
             WHERE d.revaluation_id = $1
               AND (t.status <> 'Posted' OR ABS(t.balance_amount_lc - d.balance_amount_lc) > 0.005)`, [id])).rows[0].docs;
        if (stale) {
            await client.query('ROLLBACK');
            return sendErr(res, 422, `ยอดคงค้างของใบแจ้งหนี้เปลี่ยนไปหลังสร้างรายการนี้ (${stale}) กรุณาลบแล้วสร้างใหม่`);
        }

        const periodOk = await client.query(
            `SELECT 1 FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date
               AND gl_status = 'OPEN' AND ar_status = 'OPEN' LIMIT 1`, [reval.reval_date]);
        if (periodOk.rows.length === 0) {
            await client.query('ROLLBACK');
            return sendErr(res, 422, `งวดบัญชี/งวด AR ของวันที่ ${ymd(reval.reval_date)} ยังไม่เปิด โพสต์ไม่ได้`);
        }

        const isUnrealized = reval.method === 'reversing';
        // ถอยแล้วโพสต์ใหม่ใช้เลขเดิม
        const docNo = reval.kept_gl_doc_no || await nextGlDocNo(client, setup.fx_reval_gl_doc_id, reval.reval_date,
            `FXR-${ymd(reval.reval_date).replace(/-/g, '')}-${reval.id}`);
        let revDocNo = null;

        const glEntryId = await postRevalGlEntry(
            client, setup, details, reval.reval_date, isUnrealized, docNo, glUserOf(req)
        );

        let reversalGlEntryId = null;

        if (reval.method === 'realized') {
            for (const d of details) {
                await client.query(
                    `UPDATE ar_transaction
                     SET revaluation_rate=$1, balance_amount_lc=$2, updated_at=NOW()
                     WHERE id=$3`,
                    [d.year_end_rate, d.revalued_amount_lc, d.invoice_id]
                );
            }
        } else {
            const revPeriodRes = await client.query(
                `SELECT id FROM gl_posting_period
                 WHERE $1::date BETWEEN period_start_date AND period_end_date
                 AND gl_status = 'OPEN' LIMIT 1`, [reval.reversal_date]
            );

            if (revPeriodRes.rows.length > 0) {
                revDocNo = reval.kept_reversal_doc_no || await nextGlDocNo(client, setup.fx_reval_gl_doc_id, reval.reversal_date,
                    `FXR-REV-${ymd(reval.reversal_date).replace(/-/g, '')}-${reval.id}`);
                reversalGlEntryId = await insertReversingEntry(client, glEntryId, {
                    docNo: revDocNo, date: reval.reversal_date, periodId: revPeriodRes.rows[0].id,
                    description: `[กลับรายการ] ${docNo}`, createdBy: glUserOf(req),
                });
            }
        }

        await client.query(`
            UPDATE ar_fx_revaluation SET
            status='Posted', gl_entry_id=$1, reversal_gl_entry_id=$2,
            kept_gl_doc_no=$3, kept_reversal_doc_no=COALESCE($4, kept_reversal_doc_no),
            updated_by=$5, updated_at=NOW()
            WHERE id=$6
        `, [glEntryId, reversalGlEntryId, docNo, revDocNo, updatedBy, id]);

        await client.query('COMMIT');
        res.json({ success: true, gl_entry_id: glEntryId, reversal_gl_entry_id: reversalGlEntryId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ar postReval error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

// รายการบัญชีกลับด้านของ glEntryId (Dr ↔ Cr) — ใช้ทั้งรายการกลับต้นงวดและการยกเลิก
// ref_doc_id อ้างอิงประเภทเอกสาร (FK sa_module_document) จึงใช้ doc_id ของรายการเดิม ไม่ใช่ id ของรายการบัญชี
const insertReversingEntry = async (client, glEntryId, { docNo, date, periodId, description, createdBy }) => {
    const origHdr = (await client.query(`SELECT * FROM gl_entry_header WHERE id=$1`, [glEntryId])).rows[0];
    const revHdrRes = await client.query(`
        INSERT INTO gl_entry_header
        (doc_id, doc_no, doc_date, posting_date, period_id, description,
         currency_id, exchange_rate, status,
         total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
         created_by, ref_doc_id, ref_doc_no, ref_doc_date)
        VALUES ($1,$2,$3::date,$3::date,$4,$5,$6,1,'Posted',$7,$8,$7,$8,$9,$10,$11,$12)
        RETURNING id
    `, [origHdr.doc_id, docNo, date, periodId, description,
        origHdr.currency_id, origHdr.total_credit_lc, origHdr.total_debit_lc,
        createdBy, origHdr.doc_id, origHdr.doc_no, origHdr.doc_date]);
    const revId = revHdrRes.rows[0].id;
    await client.query(`
        INSERT INTO gl_entry_detail
        (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
        SELECT $1, line_no, account_id, credit_lc, debit_lc, credit_lc, debit_lc
          FROM gl_entry_detail WHERE header_id = $2 ORDER BY line_no
    `, [revId, glEntryId]);
    return revId;
};

// ── PUT /api/ar/ar_fx_revaluation/:id/reverse { reason } — Posted → Draft ───
const reverseReval = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการถอยเอกสาร');
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRevalColumns(client);
        const reval = (await client.query(`SELECT * FROM ar_fx_revaluation WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!reval) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeRevalBlocks(client, id)).reverse_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }

        if (reval.method === 'realized') await restoreInvoices(client, id);
        for (const glId of [reval.reversal_gl_entry_id, reval.gl_entry_id]) {
            if (glId) await client.query(`DELETE FROM gl_entry_header WHERE id=$1`, [glId]);
        }
        await client.query(`
            UPDATE ar_fx_revaluation SET status='Draft', gl_entry_id=NULL, reversal_gl_entry_id=NULL,
                   updated_by=$1, updated_at=NOW()
             WHERE id=$2`, [req.headers['username'] || null, id]);
        await logReverse(client, {
            sysModule: '11', tableName: 'ar_fx_revaluation', recordId: Number(id),
            docNo: revalLabel(reval),
            fromStatus: 'Posted', toStatus: 'Draft', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ar reverseReval error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

// ── POST /api/ar/ar_fx_revaluation/:id/void { reason } ───────────────────────
const voidReval = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการยกเลิก');
    const updatedBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRevalColumns(client);

        const hdr = await client.query(
            `SELECT * FROM ar_fx_revaluation WHERE id=$1 FOR UPDATE`, [id]
        );
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const reval = hdr.rows[0];
        const b = (await computeRevalBlocks(client, id)).void_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }

        const openPeriod = async (date) => (await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' AND ar_status = 'OPEN' LIMIT 1`, [date])).rows[0]?.id || null;

        const today = todayYmd();
        const todayPeriodId = await openPeriod(today);
        if (!todayPeriodId) {
            await client.query('ROLLBACK');
            return sendErr(res, 400, `ไม่พบงวดบัญชี (GL/AR) ที่เปิดอยู่ สำหรับวันที่ยกเลิก ${today}`, { code: 'PERIOD_CLOSED' });
        }

        if (reval.method === 'realized') await restoreInvoices(client, id);

        let voidGlId = null, voidRevGlId = null;
        if (reval.gl_entry_id) {
            voidGlId = await insertReversingEntry(client, reval.gl_entry_id, {
                docNo: await nextGlDocNo(client, (await client.query(`SELECT doc_id FROM gl_entry_header WHERE id=$1`, [reval.gl_entry_id])).rows[0].doc_id,
                    today, `VOID-FXR-${today.replace(/-/g, '')}-${reval.id}`), date: today, periodId: todayPeriodId,
                description: `[ยกเลิก AR FX Revaluation] ${reason}`, createdBy: glUserOf(req),
            });
        }
        // รายการกลับต้นงวด: ลงกลับในวันที่ช้ากว่าระหว่างวันนี้กับวันที่กลับรายการ
        if (reval.reversal_gl_entry_id) {
            const revDate = ymd(reval.reversal_date) > today ? ymd(reval.reversal_date) : today;
            const revPeriodId = revDate === today ? todayPeriodId : await openPeriod(revDate);
            if (!revPeriodId) {
                await client.query('ROLLBACK');
                return sendErr(res, 400, `ไม่พบงวดบัญชี (GL/AR) ที่เปิดอยู่ สำหรับวันที่กลับรายการ ${revDate}`, { code: 'PERIOD_CLOSED' });
            }
            voidRevGlId = await insertReversingEntry(client, reval.reversal_gl_entry_id, {
                docNo: await nextGlDocNo(client, (await client.query(`SELECT doc_id FROM gl_entry_header WHERE id=$1`, [reval.reversal_gl_entry_id])).rows[0].doc_id,
                    revDate, `VOID-FXR-REV-${revDate.replace(/-/g, '')}-${reval.id}`), date: revDate, periodId: revPeriodId,
                description: `[ยกเลิก AR FX Revaluation (รายการกลับ)] ${reason}`, createdBy: glUserOf(req),
            });
        }

        await client.query(`
            UPDATE ar_fx_revaluation SET status='Void', void_reason=$1, voided_by=$2, voided_at=NOW(),
                   void_gl_entry_id=$3, void_reversal_gl_entry_id=$4, updated_by=$2, updated_at=NOW()
            WHERE id=$5
        `, [reason, updatedBy, voidGlId, voidRevGlId, id]);
        await logReverse(client, {
            sysModule: '11', tableName: 'ar_fx_revaluation', recordId: Number(id),
            docNo: revalLabel(reval),
            fromStatus: 'Posted', toStatus: 'Void', reason, userId: userIdOf(req),
        });

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ar voidReval error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

// ── DELETE /api/ar/ar_fx_revaluation/:id { reason } — เฉพาะร่าง เก็บไว้ด้วยสถานะ Deleted ──
const deleteReval = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการลบเอกสาร');
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hdr = await client.query(`SELECT status, reval_date, kept_gl_doc_no FROM ar_fx_revaluation WHERE id=$1 FOR UPDATE`, [id]);
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeRevalBlocks(client, id)).delete_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 422, b.message, { code: b.code }); }

        await client.query(`UPDATE ar_fx_revaluation SET status='Deleted', updated_by=$1, updated_at=NOW() WHERE id=$2`,
            [req.headers['username'] || null, id]);
        await logReverse(client, {
            sysModule: '11', tableName: 'ar_fx_revaluation', recordId: Number(id),
            docNo: revalLabel(hdr.rows[0]),
            fromStatus: 'Draft', toStatus: 'Deleted', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ar deleteReval error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

module.exports = { fetchOutstandingCurrencies, fetchRows, fetchRow, previewReval, createReval, postReval, reverseReval, voidReval, deleteReval, computeRevalBlocks };
