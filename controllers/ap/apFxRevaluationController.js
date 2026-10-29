// controllers/ap/apFxRevaluationController.js
const { today: todayYmd, ymd } = require('../../utils/dateUtil');
const { BASE_CURRENCY_CODE_SQL } = require('../../utils/baseCurrency');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
const { generateDocNo } = require('./apTransactionController');
const { describeJournalLines, fetchPostedJournalLines } = require('../../utils/glJournalPreview');
const { postedApAccountId } = require('../../utils/apAccount');
// FX Revaluation สำหรับเจ้าหนี้สกุลเงินต่างประเทศ ณ วันปิดปี
//
// ทิศทาง GL ตรงข้ามกับ AR:
//   fx_gain_loss = revalued_lc - balance_lc
//   Positive (rate rose)  → AP liability grew → FX Loss  → DR FX Loss, CR AP Control
//   Negative (rate fell)  → AP liability shrank → FX Gain → DR AP Control, CR FX Gain

// ── Helper: สร้างตารางถ้ายังไม่มี ──────────────────────────────────────────────
const ensureRevalTables = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS ap_fx_revaluation (
            id                   BIGSERIAL PRIMARY KEY,
            reval_date           DATE        NOT NULL,
            period_year          INT         NOT NULL,
            method               VARCHAR(20) NOT NULL DEFAULT 'reversing',
            status               VARCHAR(20) NOT NULL DEFAULT 'Draft',
            total_fx_gain_loss   NUMERIC(20,4) NOT NULL DEFAULT 0,
            gl_entry_id          INT,
            reversal_date        DATE,
            reversal_gl_entry_id INT,
            note                 TEXT,
            created_by           VARCHAR(100),
            updated_by           VARCHAR(100),
            created_at           TIMESTAMPTZ DEFAULT NOW(),
            updated_at           TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS ap_fx_revaluation_detail (
            id                 BIGSERIAL PRIMARY KEY,
            revaluation_id     BIGINT      NOT NULL REFERENCES ap_fx_revaluation(id),
            invoice_id         BIGINT      NOT NULL,
            vendor_id          INT,
            currency_code      VARCHAR(10) NOT NULL,
            balance_amount_fc  NUMERIC(20,4) NOT NULL DEFAULT 0,
            original_rate      NUMERIC(20,6) NOT NULL DEFAULT 1,
            balance_amount_lc  NUMERIC(20,4) NOT NULL DEFAULT 0,
            year_end_rate      NUMERIC(20,6) NOT NULL DEFAULT 1,
            revalued_amount_lc NUMERIC(20,4) NOT NULL DEFAULT 0,
            fx_gain_loss       NUMERIC(20,4) NOT NULL DEFAULT 0
        )
    `);
    await client.query(`
        ALTER TABLE ap_transaction ADD COLUMN IF NOT EXISTS revaluation_rate NUMERIC(20,6)
    `).catch(() => {});
    // ถอยเป็นร่าง / ยกเลิก (sql/ap_fx_revaluation_reverse_to_draft.sql)
    await client.query(`
        ALTER TABLE ap_fx_revaluation
            ADD COLUMN IF NOT EXISTS void_reason TEXT,
            ADD COLUMN IF NOT EXISTS voided_by VARCHAR(100),
            ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS void_gl_entry_id INT,
            ADD COLUMN IF NOT EXISTS void_reversal_gl_entry_id INT,
            ADD COLUMN IF NOT EXISTS kept_gl_doc_no VARCHAR(50),
            ADD COLUMN IF NOT EXISTS kept_reversal_doc_no VARCHAR(50)
    `).catch(() => {});
    await client.query(`
        ALTER TABLE ap_fx_revaluation_detail ADD COLUMN IF NOT EXISTS prev_revaluation_rate NUMERIC(20,6)
    `).catch(() => {});
};

// ── Helper: คำนวณ revaluation details สำหรับ outstanding FC invoices ──────────
const calcRevalDetails = async (client, revalDate, yearEndRates) => {
    const AP_TYPES = ['10', '50'];
    const rows = await client.query(`
        SELECT t.id AS invoice_id, t.vendor_id, t.currency_id,
               t.currency_code, t.balance_amount_lc, t.exchange_rate AS original_rate,
               t.doc_no,
               v.vendor_code, v.vendor_name_th, v.vendor_name_en,
               COALESCE(t.revaluation_rate, t.exchange_rate) AS current_rate,
               t.revaluation_rate AS prev_revaluation_rate,
               CASE WHEN COALESCE(t.revaluation_rate, t.exchange_rate) > 0
                    THEN t.balance_amount_lc / COALESCE(t.revaluation_rate, t.exchange_rate)
                    ELSE 0
               END AS balance_amount_fc
        FROM ap_transaction t
        JOIN sa_module_document d ON d.id = t.doc_id
        JOIN ap_vendor v ON v.id = t.vendor_id
        WHERE d.sys_doc_type = ANY($1::text[])
          AND t.status = 'Posted'
          AND t.balance_amount_lc > 0.005
          AND t.currency_code <> ${BASE_CURRENCY_CODE_SQL}
          AND t.doc_date <= $2::date
        ORDER BY v.vendor_code, t.doc_date, t.doc_no
    `, [AP_TYPES, revalDate]);

    const details = [];
    for (const row of rows.rows) {
        const yearEndRate = yearEndRates[String(row.currency_id)];
        if (!yearEndRate) continue;

        const balanceFc  = Number(row.balance_amount_fc);
        const balanceLc  = Number(row.balance_amount_lc);
        const revaluedLc = Math.round(balanceFc * yearEndRate * 100) / 100;
        const fxGainLoss = Math.round((revaluedLc - balanceLc) * 100) / 100;
        // Positive = AP grew = FX Loss; Negative = AP shrank = FX Gain

        if (Math.abs(fxGainLoss) < 0.005) continue;

        details.push({
            invoice_id:         row.invoice_id,
            vendor_id:          row.vendor_id,
            vendor_code:        row.vendor_code,
            vendor_name_th:     row.vendor_name_th,
            vendor_name_en:     row.vendor_name_en,
            doc_no:             row.doc_no,
            currency_code:      row.currency_code,
            balance_amount_fc:  balanceFc,
            original_rate:      Number(row.original_rate),
            balance_amount_lc:  balanceLc,
            year_end_rate:      yearEndRate,
            revalued_amount_lc: revaluedLc,
            fx_gain_loss:       fxGainLoss,
            prev_revaluation_rate: row.prev_revaluation_rate,
        });
    }
    return details;
};

// ── Helper: ดึง AP Control account ───────────────────────────────────────────
// เอกสารเก่าที่ไม่ได้เก็บบัญชีไว้ ใช้ลำดับเดิมตอนโพสต์ (utils/apAccount.js) — ไม่ข้ามใบตั้งหนี้เงียบ ๆ
const getApControlAccount = (client, invoiceId) => postedApAccountId(client, invoiceId);

// ── Helper: สร้าง GL Entry สำหรับ AP revaluation ─────────────────────────────
// AP accounting (opposite of AR):
//   Positive fxGL (AP grew)  → DR FX Loss, CR AP Control
//   Negative fxGL (AP shrank) → DR AP Control, CR FX Gain
// บรรทัดรายการบัญชี (ใช้ทั้ง preview และโพสต์จริง)
const buildRevalJournalLines = async (client, setup, details, isUnrealized) => {
    const gainAccountId = isUnrealized
        ? setup?.unrealized_fx_gain_account_id
        : setup?.fx_gain_account_id;
    const lossAccountId = isUnrealized
        ? setup?.unrealized_fx_loss_account_id
        : setup?.fx_loss_account_id;

    if (!gainAccountId || !lossAccountId)
        throw new Error('ยังไม่ได้ตั้งค่าบัญชี FX สำหรับปิดสิ้นปี AP');

    let totalGain = 0, totalLoss = 0;
    const apAdjMap = {}; // apAccountId → net fxGainLoss

    for (const d of details) {
        const apAccId = await getApControlAccount(client, d.invoice_id);
        if (!apAccId) continue;
        const fxGl = Number(d.fx_gain_loss); // อ่านจาก DB เป็นข้อความ (NUMERIC) — ต้องแปลงก่อนบวก
        apAdjMap[apAccId] = (apAdjMap[apAccId] || 0) + fxGl;
        // positive → AP grew → FX Loss; negative → AP shrank → FX Gain
        if (fxGl > 0) totalLoss += fxGl;
        else totalGain += Math.abs(fxGl);
    }

    // AP Control: netAdj > 0 → AP grew → CR AP; netAdj < 0 → AP shrank → DR AP
    const lines = [];
    for (const [apAccId, netAdj] of Object.entries(apAdjMap)) {
        if (Math.abs(netAdj) < 0.005) continue;
        lines.push({ account_id: parseInt(apAccId), debit: netAdj < 0 ? -netAdj : 0, credit: netAdj > 0 ? netAdj : 0 });
    }
    // FX Gain (AP shrank → CR) / FX Loss (AP grew → DR)
    if (totalGain > 0.005) lines.push({ account_id: gainAccountId, debit: 0, credit: totalGain });
    if (totalLoss > 0.005) lines.push({ account_id: lossAccountId, debit: totalLoss, credit: 0 });
    return { lines, totalGain, totalLoss };
};

// รายการบัญชีที่จะเกิด (ร่าง/preview) หรือที่โพสต์แล้ว — ตั้งค่าบัญชีไม่ครบให้ข้อความแทน ไม่ทำให้ทั้งคำขอล้ม
const revalJournal = async (db, { glEntryId, details, isUnrealized }) => {
    try {
        if (glEntryId) return { journal: await fetchPostedJournalLines(db, glEntryId), journal_posted: true };
        const setup = (await db.query('SELECT * FROM ap_year_end_setup LIMIT 1')).rows[0];
        if (!setup) return { journal: [], journal_error: 'ยังไม่ได้ตั้งค่าบัญชีปิดสิ้นปี AP' };
        const { lines } = await buildRevalJournalLines(db, setup, details, isUnrealized);
        return { journal: await describeJournalLines(db, lines), journal_posted: false };
    } catch (err) {
        return { journal: [], journal_error: err.message };
    }
};

const postRevalGlEntry = async (client, setup, details, revalDate, isUnrealized, docNo, createdBy) => {
    const { lines, totalGain, totalLoss } = await buildRevalJournalLines(client, setup, details, isUnrealized);

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
        isUnrealized ? 'ปรับมูลค่าเจ้าหนี้ต่างประเทศ (Unrealized)' : 'ปรับมูลค่าเจ้าหนี้ต่างประเทศ',
        totalDebitLc, totalCreditLc, createdBy]);
    const glEntryId = hdrRes.rows[0].id;

    // AP Control (ต่อบัญชี) แล้ว FX Gain / FX Loss
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

// ── GET /api/ap/ap_fx_revaluation/outstanding_currencies ─────────────────────
const fetchOutstandingCurrencies = async (req, res) => {
    const { reval_date } = req.query;
    if (!reval_date) return res.status(400).json({ error: 'reval_date required' });
    const AP_TYPES = ['10', '50'];
    try {
        const result = await req.dbPool.query(`
            SELECT DISTINCT t.currency_id, t.currency_code,
                   c.currency_name_th, c.currency_name_en
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            JOIN cd_currency c ON c.id = t.currency_id
            WHERE d.sys_doc_type = ANY($1::text[])
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0.005
              AND t.currency_code <> ${BASE_CURRENCY_CODE_SQL}
              AND t.doc_date <= $2::date
            ORDER BY t.currency_code
        `, [AP_TYPES, reval_date]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ── GET /api/ap/ap_fx_revaluation ────────────────────────────────────────────
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureRevalTables(client);
        const showDeleted = req.query.status === 'Deleted';
        const result = await client.query(`
            SELECT r.*, u.doc_no AS gl_doc_no, v.doc_no AS reversal_doc_no
            FROM ap_fx_revaluation r
            LEFT JOIN gl_entry_header u ON u.id = r.gl_entry_id
            LEFT JOIN gl_entry_header v ON v.id = r.reversal_gl_entry_id
            WHERE ${showDeleted ? `r.status = 'Deleted'` : `r.status <> 'Deleted'`}
            ORDER BY r.reval_date DESC, r.id DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── GET /api/ap/ap_fx_revaluation/:id ────────────────────────────────────────
const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureRevalTables(client);
        const hdr = await client.query(
            `SELECT r.*, u.doc_no AS gl_doc_no, v.doc_no AS reversal_doc_no
             FROM ap_fx_revaluation r
             LEFT JOIN gl_entry_header u ON u.id = r.gl_entry_id
             LEFT JOIN gl_entry_header v ON v.id = r.reversal_gl_entry_id
             WHERE r.id = $1`, [id]
        );
        if (!hdr.rows[0]) return res.status(404).json({ error: 'Not found' });

        const dtl = await client.query(`
            SELECT d.*, v.vendor_code, v.vendor_name_th, v.vendor_name_en,
                   t.doc_no AS invoice_doc_no, t.doc_date AS invoice_doc_date
            FROM ap_fx_revaluation_detail d
            LEFT JOIN ap_vendor v ON v.id = d.vendor_id
            LEFT JOIN ap_transaction t ON t.id = d.invoice_id
            WHERE d.revaluation_id = $1
            ORDER BY v.vendor_code, t.doc_date, t.doc_no
        `, [id]);

        res.json({
            header: hdr.rows[0], details: dtl.rows, ...(await computeRevalBlocks(client, id)),
            ...(await revalJournal(client, {
                glEntryId: hdr.rows[0].gl_entry_id, details: dtl.rows, isUnrealized: hdr.rows[0].method === 'reversing',
            })),
            reverse_history: await getReverseHistory(client, 'ap_fx_revaluation', id),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── POST /api/ap/ap_fx_revaluation/preview ───────────────────────────────────
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

// ── POST /api/ap/ap_fx_revaluation (สร้าง Draft) ─────────────────────────────
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
        await ensureRevalTables(client);

        const details = await calcRevalDetails(client, reval_date, year_end_rates);
        if (details.length === 0) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: 'ไม่มีเจ้าหนี้สกุลเงินต่างประเทศที่ค้างจ่าย' });
        }
        const totalGainLoss = Math.round(details.reduce((s, d) => s + d.fx_gain_loss, 0) * 100) / 100;

        const hdrRes = await client.query(`
            INSERT INTO ap_fx_revaluation
            (reval_date, period_year, method, status, total_fx_gain_loss,
             reversal_date, note, created_by)
            VALUES ($1,$2,$3,'Draft',$4,$5,$6,$7)
            RETURNING id
        `, [reval_date, period_year, method, totalGainLoss,
            reversal_date || null, note || null, createdBy]);
        const revalId = hdrRes.rows[0].id;

        for (const d of details) {
            await client.query(`
                INSERT INTO ap_fx_revaluation_detail
                (revaluation_id, invoice_id, vendor_id, currency_code,
                 balance_amount_fc, original_rate, balance_amount_lc,
                 year_end_rate, revalued_amount_lc, fx_gain_loss, prev_revaluation_rate)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `, [revalId, d.invoice_id, d.vendor_id, d.currency_code,
                d.balance_amount_fc, d.original_rate, d.balance_amount_lc,
                d.year_end_rate, d.revalued_amount_lc, d.fx_gain_loss, d.prev_revaluation_rate]);
        }

        await client.query('COMMIT');
        res.status(201).json({ id: revalId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ap createReval error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ===== ถอยเป็นร่าง / ยกเลิก / ลบ =====
// - ถอย (Posted → Draft): งวด GL + AP ของวันที่ปรับมูลค่า (และของรายการกลับ ถ้ามี) ยังเปิด
//   แบบ realized: ใบตั้งหนี้ต้องยังไม่เปลี่ยนตั้งแต่ปรับมูลค่า (ไม่มีจ่ายชำระ/ปรับมูลค่าครั้งถัดไป) จึงคืนยอดเดิมได้
//   ลบรายการบัญชี (และรายการกลับ) — เลขที่รายการบัญชีมาจากวันที่ (AP-FXR-YYYYMMDD) โพสต์ใหม่ได้เลขเดิม
// - ยกเลิก: ใช้เมื่อถอยไม่ได้ (เช่น งวดปิดแล้ว) ลงรายการกลับในวันที่ยกเลิก (รายการกลับเดิมลงกลับในวันที่ช้ากว่า
//   ระหว่างวันนี้กับวันที่กลับรายการ เพื่อให้ยอดสุทธิเป็นศูนย์ทุกช่วงเวลา)
// - ลบ: เฉพาะร่าง เก็บไว้ด้วยสถานะ Deleted (ไม่แสดงในรายการ เว้นแต่เลือกดูใบที่ลบ)
// ทุกการกระทำต้องมีเหตุผล และบันทึกที่ sa_document_reverse_log
const REVAL_BLOCK_MESSAGES = {
    NOT_REVERSIBLE:  'ถอยได้เฉพาะรายการที่โพสต์แล้ว',
    NOT_POSTED:      'ยกเลิกได้เฉพาะรายการที่โพสต์แล้ว (ร่างให้ลบแทน)',
    NOT_DRAFT:       'รายการที่โพสต์แล้วลบไม่ได้ กรุณาถอยเป็นร่างก่อน',
    PERIOD_CLOSED:   'งวดบัญชีของรายการนี้ปิดแล้ว ถอยไม่ได้',
    INVOICE_CHANGED: 'ใบตั้งหนี้ที่ปรับมูลค่ามีการเปลี่ยนแปลงหลังปรับมูลค่า (จ่ายชำระ/ปรับมูลค่าครั้งถัดไป/ถอย)',
    VOIDED:          'รายการนี้ถูกยกเลิกหรือลบแล้ว',
};
const packBlock = (code, ref) => code
    ? { code, ref: ref || null, message: REVAL_BLOCK_MESSAGES[code] + (ref ? ` (${ref})` : '') } : null;

const REVAL_INFO_SQL = `
    SELECT r.id, r.status, r.method, r.gl_entry_id, r.reversal_gl_entry_id,
           p.gl_status, p.ap_status,
           rp.gl_status AS rev_gl_status, rp.ap_status AS rev_ap_status, rg.doc_no AS reversal_doc_no,
           (SELECT string_agg(DISTINCT t.doc_no, ', ')
              FROM ap_fx_revaluation_detail d JOIN ap_transaction t ON t.id = d.invoice_id
             WHERE d.revaluation_id = r.id
               AND (t.status <> 'Posted' OR ABS(t.balance_amount_lc - d.revalued_amount_lc) > 0.005
                    OR t.revaluation_rate IS DISTINCT FROM d.year_end_rate)) AS changed_invoices
      FROM ap_fx_revaluation r
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
    if (r.gl_status !== 'OPEN' || r.ap_status !== 'OPEN') reverse = packBlock('PERIOD_CLOSED');
    else if (r.reversal_gl_entry_id && (r.rev_gl_status !== 'OPEN' || r.rev_ap_status !== 'OPEN')) reverse = packBlock('PERIOD_CLOSED', r.reversal_doc_no);
    else reverse = changed;
    return { reverse_block: reverse, void_block: changed, delete_block: packBlock('NOT_DRAFT') };
};

// คืนยอดใบตั้งหนี้ (realized) กลับเป็นก่อนปรับมูลค่า — รายการเก่าที่ไม่มี prev_revaluation_rate ใช้อัตราจากยอดคงค้างเดิม
const restoreInvoices = async (client, id) => {
    await client.query(`
        UPDATE ap_transaction t SET
               revaluation_rate = COALESCE(d.prev_revaluation_rate,
                   CASE WHEN d.balance_amount_fc = 0
                          OR ABS(d.balance_amount_lc / d.balance_amount_fc - t.exchange_rate) < 0.0001 THEN NULL
                        ELSE ROUND(d.balance_amount_lc / d.balance_amount_fc, 6) END),
               balance_amount_lc = d.balance_amount_lc, updated_at = NOW()
          FROM ap_fx_revaluation_detail d
         WHERE d.revaluation_id = $1 AND t.id = d.invoice_id`, [id]);
};

const reasonOf = (req) => (req.body?.reason || '').trim();
const userIdOf = (req) => req.body?.user_id || req.headers['userid'] || null;
// gl_entry_header.created_by เป็นรหัสผู้ใช้ (int)
const glUserOf = (req) => { const v = Number(req.headers['userid']); return Number.isFinite(v) && v > 0 ? v : null; };
const sendErr = (res, status, message, extra = {}) => res.status(status).json({ error: message, message, ...extra });

// เลขที่รายการบัญชี: เลขอัตโนมัติของประเภทเอกสาร GL — ถ้าประเภทเอกสารไม่ได้ตั้งเลขอัตโนมัติ ใช้รูปแบบเดิม + id
// (รูปแบบเดิม AP-FXR-YYYYMMDD ซ้ำกันเมื่อมีรายการวันเดียวกันที่ยกเลิกไปแล้ว)
const nextGlDocNo = async (client, glDocId, date, fallback) =>
    (glDocId && await generateDocNo(client, glDocId, date, null)) || fallback;
const revalLabel = (reval) => reval.kept_gl_doc_no || `AP-FXR ${ymd(reval.reval_date)}`;

// ── POST /api/ap/ap_fx_revaluation/:id/post ──────────────────────────────────
const postReval = async (req, res) => {
    const { id } = req.params;
    const updatedBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const hdr = await client.query(
            `SELECT * FROM ap_fx_revaluation WHERE id=$1 FOR UPDATE`, [id]
        );
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        if (hdr.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return sendErr(res, 422, 'Only Draft can be posted'); }

        const reval   = hdr.rows[0];
        const setup   = (await client.query('SELECT * FROM ap_year_end_setup LIMIT 1')).rows[0];
        if (!setup) { await client.query('ROLLBACK'); return sendErr(res, 422, 'ยังไม่ได้ตั้งค่าบัญชีปิดสิ้นปี AP'); }

        const details = (await client.query(
            `SELECT * FROM ap_fx_revaluation_detail WHERE revaluation_id=$1`, [id]
        )).rows;

        // ร่าง (รวมที่ถอยกลับมา) คำนวณจากยอดคงค้าง ณ ตอนสร้าง — ถ้าใบตั้งหนี้เปลี่ยนไปแล้วต้องสร้างใหม่
        const stale = (await client.query(`
            SELECT string_agg(DISTINCT t.doc_no, ', ') AS docs
              FROM ap_fx_revaluation_detail d JOIN ap_transaction t ON t.id = d.invoice_id
             WHERE d.revaluation_id = $1
               AND (t.status <> 'Posted' OR ABS(t.balance_amount_lc - d.balance_amount_lc) > 0.005)`, [id])).rows[0].docs;
        if (stale) {
            await client.query('ROLLBACK');
            return sendErr(res, 422, `ยอดคงค้างของใบตั้งหนี้เปลี่ยนไปหลังสร้างรายการนี้ (${stale}) กรุณาลบแล้วสร้างใหม่`);
        }

        const periodOk = await client.query(
            `SELECT 1 FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date
               AND gl_status = 'OPEN' AND ap_status = 'OPEN' LIMIT 1`, [reval.reval_date]);
        if (periodOk.rows.length === 0) {
            await client.query('ROLLBACK');
            return sendErr(res, 422, `งวดบัญชี/งวด AP ของวันที่ ${ymd(reval.reval_date)} ยังไม่เปิด โพสต์ไม่ได้`);
        }

        const isUnrealized = reval.method === 'reversing';
        // ถอยแล้วโพสต์ใหม่ใช้เลขเดิม
        const docNo = reval.kept_gl_doc_no || await nextGlDocNo(client, setup.fx_reval_gl_doc_id, reval.reval_date,
            `AP-FXR-${ymd(reval.reval_date).replace(/-/g, '')}-${reval.id}`);
        let revDocNo = null;

        const glEntryId = await postRevalGlEntry(
            client, setup, details, reval.reval_date, isUnrealized, docNo, glUserOf(req)
        );

        let reversalGlEntryId = null;

        if (reval.method === 'realized') {
            for (const d of details) {
                await client.query(
                    `UPDATE ap_transaction
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
                    `AP-FXR-REV-${ymd(reval.reversal_date).replace(/-/g, '')}-${reval.id}`);
                reversalGlEntryId = await insertReversingEntry(client, glEntryId, {
                    docNo: revDocNo, date: reval.reversal_date, periodId: revPeriodRes.rows[0].id,
                    description: `[กลับรายการ] ${docNo}`, createdBy: glUserOf(req),
                });
            }
        }

        await client.query(`
            UPDATE ap_fx_revaluation SET
            status='Posted', gl_entry_id=$1, reversal_gl_entry_id=$2,
            kept_gl_doc_no=$3, kept_reversal_doc_no=COALESCE($4, kept_reversal_doc_no),
            updated_by=$5, updated_at=NOW()
            WHERE id=$6
        `, [glEntryId, reversalGlEntryId, docNo, revDocNo, updatedBy, id]);

        await client.query('COMMIT');
        res.json({ success: true, gl_entry_id: glEntryId, reversal_gl_entry_id: reversalGlEntryId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ap postReval error:', err);
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

// ── PUT /api/ap/ap_fx_revaluation/:id/reverse { reason } — Posted → Draft ───
const reverseReval = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการถอยเอกสาร');
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRevalTables(client);
        const reval = (await client.query(`SELECT * FROM ap_fx_revaluation WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!reval) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeRevalBlocks(client, id)).reverse_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }

        if (reval.method === 'realized') await restoreInvoices(client, id);
        for (const glId of [reval.reversal_gl_entry_id, reval.gl_entry_id]) {
            if (glId) await client.query(`DELETE FROM gl_entry_header WHERE id=$1`, [glId]);
        }
        await client.query(`
            UPDATE ap_fx_revaluation SET status='Draft', gl_entry_id=NULL, reversal_gl_entry_id=NULL,
                   updated_by=$1, updated_at=NOW()
             WHERE id=$2`, [req.headers['username'] || null, id]);
        await logReverse(client, {
            sysModule: '21', tableName: 'ap_fx_revaluation', recordId: Number(id),
            docNo: revalLabel(reval),
            fromStatus: 'Posted', toStatus: 'Draft', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ap reverseReval error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

// ── POST /api/ap/ap_fx_revaluation/:id/void { reason } ───────────────────────
const voidReval = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการยกเลิก');
    const updatedBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRevalTables(client);

        const hdr = await client.query(
            `SELECT * FROM ap_fx_revaluation WHERE id=$1 FOR UPDATE`, [id]
        );
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const reval = hdr.rows[0];
        const b = (await computeRevalBlocks(client, id)).void_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 400, b.message, { code: b.code, ref: b.ref }); }

        const openPeriod = async (date) => (await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' AND ap_status = 'OPEN' LIMIT 1`, [date])).rows[0]?.id || null;

        const today = todayYmd();
        const todayPeriodId = await openPeriod(today);
        if (!todayPeriodId) {
            await client.query('ROLLBACK');
            return sendErr(res, 400, `ไม่พบงวดบัญชี (GL/AP) ที่เปิดอยู่ สำหรับวันที่ยกเลิก ${today}`, { code: 'PERIOD_CLOSED' });
        }

        if (reval.method === 'realized') await restoreInvoices(client, id);

        let voidGlId = null, voidRevGlId = null;
        if (reval.gl_entry_id) {
            voidGlId = await insertReversingEntry(client, reval.gl_entry_id, {
                docNo: await nextGlDocNo(client, (await client.query(`SELECT doc_id FROM gl_entry_header WHERE id=$1`, [reval.gl_entry_id])).rows[0].doc_id,
                    today, `VOID-AP-FXR-${today.replace(/-/g, '')}-${reval.id}`), date: today, periodId: todayPeriodId,
                description: `[ยกเลิก AP FX Revaluation] ${reason}`, createdBy: glUserOf(req),
            });
        }
        // รายการกลับต้นงวด: ลงกลับในวันที่ช้ากว่าระหว่างวันนี้กับวันที่กลับรายการ
        if (reval.reversal_gl_entry_id) {
            const revDate = ymd(reval.reversal_date) > today ? ymd(reval.reversal_date) : today;
            const revPeriodId = revDate === today ? todayPeriodId : await openPeriod(revDate);
            if (!revPeriodId) {
                await client.query('ROLLBACK');
                return sendErr(res, 400, `ไม่พบงวดบัญชี (GL/AP) ที่เปิดอยู่ สำหรับวันที่กลับรายการ ${revDate}`, { code: 'PERIOD_CLOSED' });
            }
            voidRevGlId = await insertReversingEntry(client, reval.reversal_gl_entry_id, {
                docNo: await nextGlDocNo(client, (await client.query(`SELECT doc_id FROM gl_entry_header WHERE id=$1`, [reval.reversal_gl_entry_id])).rows[0].doc_id,
                    revDate, `VOID-AP-FXR-REV-${revDate.replace(/-/g, '')}-${reval.id}`), date: revDate, periodId: revPeriodId,
                description: `[ยกเลิก AP FX Revaluation (รายการกลับ)] ${reason}`, createdBy: glUserOf(req),
            });
        }

        await client.query(`
            UPDATE ap_fx_revaluation SET status='Void', void_reason=$1, voided_by=$2, voided_at=NOW(),
                   void_gl_entry_id=$3, void_reversal_gl_entry_id=$4, updated_by=$2, updated_at=NOW()
            WHERE id=$5
        `, [reason, updatedBy, voidGlId, voidRevGlId, id]);
        await logReverse(client, {
            sysModule: '21', tableName: 'ap_fx_revaluation', recordId: Number(id),
            docNo: revalLabel(reval),
            fromStatus: 'Posted', toStatus: 'Void', reason, userId: userIdOf(req),
        });

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ap voidReval error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

// ── DELETE /api/ap/ap_fx_revaluation/:id { reason } — เฉพาะร่าง เก็บไว้ด้วยสถานะ Deleted ──
const deleteReval = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return sendErr(res, 400, 'กรุณาระบุเหตุผลการลบเอกสาร');
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hdr = await client.query(`SELECT status, reval_date, kept_gl_doc_no FROM ap_fx_revaluation WHERE id=$1 FOR UPDATE`, [id]);
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return sendErr(res, 404, 'Not found'); }
        const b = (await computeRevalBlocks(client, id)).delete_block;
        if (b) { await client.query('ROLLBACK'); return sendErr(res, 422, b.message, { code: b.code }); }

        await client.query(`UPDATE ap_fx_revaluation SET status='Deleted', updated_by=$1, updated_at=NOW() WHERE id=$2`,
            [req.headers['username'] || null, id]);
        await logReverse(client, {
            sysModule: '21', tableName: 'ap_fx_revaluation', recordId: Number(id),
            docNo: revalLabel(hdr.rows[0]),
            fromStatus: 'Draft', toStatus: 'Deleted', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ap deleteReval error:', err);
        sendErr(res, 500, err.message);
    } finally {
        client.release();
    }
};

module.exports = { fetchOutstandingCurrencies, fetchRows, fetchRow, previewReval, createReval, postReval, reverseReval, voidReval, deleteReval, computeRevalBlocks };
