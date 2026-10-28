// controllers/cm/cmBankFxRevaluationController.js
const { today: todayYmd, ymd } = require('../../utils/dateUtil');
const { BASE_CURRENCY_CODE_SQL, getBaseCurrency } = require('../../utils/baseCurrency');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
'use strict';

const ensureTables = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_bank_fx_revaluation (
            id                    SERIAL PRIMARY KEY,
            revaluation_date      DATE          NOT NULL,
            description           TEXT,
            gl_doc_id             INTEGER,
            fx_gain_account_id    INTEGER,
            fx_loss_account_id    INTEGER,
            total_gain_loss       NUMERIC(18,4) NOT NULL DEFAULT 0,
            status                VARCHAR(20)   NOT NULL DEFAULT 'Draft',
            gl_entry_id           INTEGER,
            gl_doc_id_ref         INTEGER,
            gl_doc_no             VARCHAR(50),
            reversal_entry_id     INTEGER,
            created_by            INTEGER,
            created_at            TIMESTAMP DEFAULT NOW(),
            updated_at            TIMESTAMP DEFAULT NOW()
        )`);
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_bank_fx_revaluation_line (
            id                 SERIAL PRIMARY KEY,
            revaluation_id     INTEGER NOT NULL REFERENCES cm_bank_fx_revaluation(id) ON DELETE CASCADE,
            bank_account_id    INTEGER,
            currency_code      VARCHAR(10) NOT NULL DEFAULT 'USD',
            gl_account_id      INTEGER,
            balance_fc         NUMERIC(18,4) NOT NULL DEFAULT 0,
            balance_lc_book    NUMERIC(18,4) NOT NULL DEFAULT 0,
            new_rate           NUMERIC(15,6) NOT NULL DEFAULT 1,
            balance_lc_new     NUMERIC(18,4) NOT NULL DEFAULT 0,
            fx_gain_loss       NUMERIC(18,4) NOT NULL DEFAULT 0,
            created_at         TIMESTAMP DEFAULT NOW()
        )`);
    // ยกเลิกแบบมีเหตุผล (sql/cm_bank_fx_revaluation_reverse_to_draft.sql)
    await client.query(`
        ALTER TABLE cm_bank_fx_revaluation
            ADD COLUMN IF NOT EXISTS void_reason TEXT,
            ADD COLUMN IF NOT EXISTS voided_by VARCHAR(100),
            ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP`);
};

const generateGlDocNo = async (client, glDocId, date) => {
    const docRes = await client.query(
        `SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [glDocId]);
    const doc = docRes.rows[0];
    if (!doc || !doc.is_auto_numbering) return null;
    const d = new Date(date);
    const year  = d.getFullYear().toString();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day   = d.getDate().toString().padStart(2, '0');
    let docNo = doc.format_prefix || '';
    const sfx = doc.format_suffix_date || '';
    if      (sfx === 'YY')       docNo += year.substring(2);
    else if (sfx === 'YYYY')     docNo += year;
    else if (sfx === 'YYMM')     docNo += year.substring(2) + month;
    else if (sfx === 'YYYYMM')   docNo += year + month;
    else if (sfx === 'YYYYMMDD') docNo += year + month + day;
    if (doc.format_separator) docNo += doc.format_separator;
    docNo += doc.next_running_number.toString().padStart(doc.running_length || 4, '0');
    await client.query(
        `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
        [glDocId]);
    return docNo;
};

// ── Core: balance (FC + LC per book) for one bank account as of a date ──────
// Reuses the latest Posted revaluation (if any) as a checkpoint, then adds
// movements after that checkpoint up to asOfDate — same logic used by calcLines.
const calcAccountBalance = async (client, accountId, asOfDate, excludeRevalId = null) => {
    let latestRevalQuery = `
        SELECT r.revaluation_date, l.balance_fc, l.balance_lc_new
        FROM cm_bank_fx_revaluation_line l
        JOIN cm_bank_fx_revaluation r ON r.id = l.revaluation_id
        WHERE l.bank_account_id = $1 AND r.status = 'Posted'
          AND r.revaluation_date <= $2`;
    const qParams = [accountId, asOfDate];
    if (excludeRevalId) {
        latestRevalQuery += ` AND r.id != $3`;
        qParams.push(excludeRevalId);
    }
    latestRevalQuery += ` ORDER BY r.revaluation_date DESC, r.id DESC LIMIT 1`;
    const lastReval = await client.query(latestRevalQuery, qParams);

    let balanceFc, balanceLcBook;
    if (lastReval.rows.length > 0) {
        const lr = lastReval.rows[0];
        const lastDate = lr.revaluation_date;
        const movRes = await client.query(`
            SELECT COALESCE(SUM(net_fc), 0) AS net_fc, COALESCE(SUM(net_lc), 0) AS net_lc
            FROM (
                SELECT amount_fc AS net_fc, amount_lc AS net_lc
                FROM cm_receipt
                WHERE bank_account_id = $1 AND status != 'Voided'
                  AND receipt_date > $2 AND receipt_date <= $3
                UNION ALL
                SELECT -amount_fc, -amount_lc
                FROM cm_payment
                WHERE bank_account_id = $1 AND status != 'Voided'
                  AND payment_date > $2 AND payment_date <= $3
            ) t`,
            [accountId, lastDate, asOfDate]);
        const m = movRes.rows[0];
        balanceFc     = parseFloat(lr.balance_fc)     + parseFloat(m.net_fc);
        balanceLcBook = parseFloat(lr.balance_lc_new) + parseFloat(m.net_lc);
    } else {
        const totRes = await client.query(`
            SELECT COALESCE(SUM(net_fc), 0) AS balance_fc, COALESCE(SUM(net_lc), 0) AS balance_lc
            FROM (
                SELECT amount_fc AS net_fc, amount_lc AS net_lc
                FROM cm_receipt
                WHERE bank_account_id = $1 AND status != 'Voided' AND receipt_date <= $2
                UNION ALL
                SELECT -amount_fc, -amount_lc
                FROM cm_payment
                WHERE bank_account_id = $1 AND status != 'Voided' AND payment_date <= $2
            ) t`,
            [accountId, asOfDate]);
        const t = totRes.rows[0];
        balanceFc     = parseFloat(t.balance_fc);
        balanceLcBook = parseFloat(t.balance_lc);
    }
    return { balanceFc, balanceLcBook };
};

// GET distinct currencies with an outstanding FC bank balance as of a date
// (mirrors AR's fetchOutstandingCurrencies — used to auto-populate the rate entry fields)
const getOutstandingCurrencies = async (req, res) => {
    const { as_of_date } = req.query;
    if (!as_of_date) return res.status(400).json({ error: 'ต้องระบุ as_of_date' });
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const accRes = await client.query(`
            SELECT ba.id, ba.currency_code
            FROM cm_bank_account ba
            WHERE ba.currency_code != ${BASE_CURRENCY_CODE_SQL} AND ba.is_active = TRUE AND ba.cm_type = 'BANK'
              AND ba.gl_account_id IS NOT NULL
            ORDER BY ba.currency_code`);

        const codesWithBalance = new Set();
        for (const acc of accRes.rows) {
            const { balanceFc } = await calcAccountBalance(client, acc.id, as_of_date);
            if (Math.abs(balanceFc) >= 0.0001) codesWithBalance.add(acc.currency_code);
        }

        if (codesWithBalance.size === 0) return res.json([]);
        const curRes = await client.query(
            `SELECT currency_code, currency_name_th, currency_name_en FROM cd_currency
             WHERE currency_code = ANY($1::text[]) ORDER BY currency_code`,
            [Array.from(codesWithBalance)]);
        res.json(curRes.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// ── Core: calculate lines for a revaluation date + rates map ────────────────
// ratesMap: { "USD": 35.8, "EUR": 40.2, ... }  keyed by currency_code
const calcLines = async (client, revaluationDate, ratesMap, excludeRevalId = null) => {
    // Get all active non-THB BANK accounts that have a GL account
    const accRes = await client.query(`
        SELECT ba.id, ba.account_code, ba.account_name_th, ba.currency_code, ba.gl_account_id,
               cb.short_name AS bank_short_name,
               ga.account_code AS gl_account_code
        FROM cm_bank_account ba
        LEFT JOIN cd_bank     cb ON cb.id = ba.bank_id
        LEFT JOIN gl_account  ga ON ga.id = ba.gl_account_id
        WHERE ba.currency_code != ${BASE_CURRENCY_CODE_SQL} AND ba.is_active = TRUE AND ba.cm_type = 'BANK'
        ORDER BY ba.account_code`);

    const lines = [];
    for (const acc of accRes.rows) {
        const newRate = parseFloat(ratesMap[acc.currency_code]);
        if (!newRate || newRate <= 0) continue;
        if (!acc.gl_account_id) continue;

        const { balanceFc, balanceLcBook } = await calcAccountBalance(client, acc.id, revaluationDate, excludeRevalId);

        if (Math.abs(balanceFc) < 0.0001) continue;

        const balanceLcNew = Math.round(balanceFc * newRate * 100) / 100;
        const fxGainLoss   = Math.round((balanceLcNew - balanceLcBook) * 100) / 100;

        lines.push({
            bank_account_id:   acc.id,
            bank_account_code: acc.account_code,
            bank_account_name: acc.account_name_th,
            bank_short_name:   acc.bank_short_name,
            gl_account_id:     acc.gl_account_id,
            gl_account_code:   acc.gl_account_code,
            currency_code:     acc.currency_code,
            balance_fc:        Math.round(balanceFc     * 10000) / 10000,
            balance_lc_book:   Math.round(balanceLcBook * 100)   / 100,
            new_rate:          newRate,
            balance_lc_new:    balanceLcNew,
            fx_gain_loss:      fxGainLoss,
        });
    }
    return lines;
};

const BASE_SELECT = `
    SELECT r.*,
           fga.account_code    AS fx_gain_account_code,
           fga.account_name_thai AS fx_gain_account_name,
           fla.account_code    AS fx_loss_account_code,
           fla.account_name_thai AS fx_loss_account_name,
           md.doc_code         AS gl_doc_code,
           md.doc_name_thai    AS gl_doc_name
    FROM cm_bank_fx_revaluation r
    LEFT JOIN gl_account fga ON fga.id = r.fx_gain_account_id
    LEFT JOIN gl_account fla ON fla.id = r.fx_loss_account_id
    LEFT JOIN sa_module_document md ON md.id = r.gl_doc_id
`;

// GET list
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const { status, date_from, date_to } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (status && status !== 'All') { where += ` AND r.status = $${pi++}`; params.push(status); }
        else where += ` AND r.status <> 'Deleted'`;
        if (date_from)                  { where += ` AND r.revaluation_date >= $${pi++}`; params.push(date_from); }
        if (date_to)                    { where += ` AND r.revaluation_date <= $${pi++}`; params.push(date_to); }
        const result = await client.query(
            `${BASE_SELECT} ${where} ORDER BY r.revaluation_date DESC, r.id DESC`, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// GET one + lines
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const rRes = await client.query(`${BASE_SELECT} WHERE r.id = $1`, [req.params.id]);
        if (rRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const row = rRes.rows[0];
        const lRes = await client.query(`
            SELECT l.*, ba.account_code AS bank_account_code, ba.account_name_th AS bank_account_name,
                   cb.short_name AS bank_short_name, ga.account_code AS gl_account_code
            FROM cm_bank_fx_revaluation_line l
            LEFT JOIN cm_bank_account ba ON ba.id = l.bank_account_id
            LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
            LEFT JOIN gl_account      ga ON ga.id = l.gl_account_id
            WHERE l.revaluation_id = $1
            ORDER BY l.id`,
            [req.params.id]);
        row.lines = lRes.rows;
        Object.assign(row, await computeRevalBlocks(client, req.params.id));
        row.reverse_history = await getReverseHistory(client, 'cm_bank_fx_revaluation', req.params.id);
        res.json(row);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// POST preview (no DB save)
const previewLines = async (req, res) => {
    const { revaluation_date, rates } = req.body;
    if (!revaluation_date || !rates)
        return res.status(400).json({ error: 'ต้องระบุ revaluation_date และ rates' });
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const lines = await calcLines(client, revaluation_date, rates);
        res.json({ lines });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// POST create (Draft) with lines
const createRow = async (req, res) => {
    const body = req.body;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTables(client);
        const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
        const createdBy = userRes.rows[0]?.id || null;

        // Insert header
        const hRes = await client.query(`
            INSERT INTO cm_bank_fx_revaluation
                (revaluation_date, description, gl_doc_id, fx_gain_account_id, fx_loss_account_id,
                 total_gain_loss, status, created_by)
            VALUES ($1,$2,$3,$4,$5,0,'Draft',$6)
            RETURNING *`,
            [
                body.revaluation_date,
                body.description || null,
                body.gl_doc_id   || null,
                body.fx_gain_account_id || null,
                body.fx_loss_account_id || null,
                createdBy,
            ]);
        const revalId = hRes.rows[0].id;

        // Calculate lines
        const lines = await calcLines(client, body.revaluation_date, body.rates || {});
        if (lines.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ไม่พบบัญชีธนาคาร FC ที่มียอดคงเหลือ หรือยังไม่ได้ระบุ Exchange Rate' });
        }
        let totalGainLoss = 0;
        for (const l of lines) {
            await client.query(`
                INSERT INTO cm_bank_fx_revaluation_line
                    (revaluation_id, bank_account_id, currency_code, gl_account_id,
                     balance_fc, balance_lc_book, new_rate, balance_lc_new, fx_gain_loss)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [revalId, l.bank_account_id, l.currency_code, l.gl_account_id,
                 l.balance_fc, l.balance_lc_book, l.new_rate, l.balance_lc_new, l.fx_gain_loss]);
            totalGainLoss += l.fx_gain_loss;
        }
        await client.query(`UPDATE cm_bank_fx_revaluation SET total_gain_loss=$1 WHERE id=$2`,
            [Math.round(totalGainLoss * 100) / 100, revalId]);

        await client.query('COMMIT');
        const result = await client.query(`${BASE_SELECT} WHERE r.id = $1`, [revalId]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT update header + recalculate lines (Draft only)
const updateRow = async (req, res) => {
    const { id } = req.params;
    const body    = req.body;
    const client  = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTables(client);
        const chk = await client.query(`SELECT status FROM cm_bank_fx_revaluation WHERE id=$1 FOR UPDATE`, [id]);
        if (!chk.rows.length || chk.rows[0].status !== 'Draft') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'แก้ไขได้เฉพาะ Draft' });
        }

        await client.query(`
            UPDATE cm_bank_fx_revaluation
            SET revaluation_date     = $1, description          = $2,
                gl_doc_id            = $3, fx_gain_account_id   = $4,
                fx_loss_account_id   = $5, updated_at           = NOW()
            WHERE id = $6`,
            [body.revaluation_date, body.description || null,
             body.gl_doc_id || null, body.fx_gain_account_id || null,
             body.fx_loss_account_id || null, id]);

        // Recalculate lines
        await client.query(`DELETE FROM cm_bank_fx_revaluation_line WHERE revaluation_id = $1`, [id]);
        const lines = await calcLines(client, body.revaluation_date, body.rates || {}, parseInt(id));
        if (lines.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ไม่พบบัญชีธนาคาร FC ที่มียอดคงเหลือ' });
        }
        let totalGainLoss = 0;
        for (const l of lines) {
            await client.query(`
                INSERT INTO cm_bank_fx_revaluation_line
                    (revaluation_id, bank_account_id, currency_code, gl_account_id,
                     balance_fc, balance_lc_book, new_rate, balance_lc_new, fx_gain_loss)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [id, l.bank_account_id, l.currency_code, l.gl_account_id,
                 l.balance_fc, l.balance_lc_book, l.new_rate, l.balance_lc_new, l.fx_gain_loss]);
            totalGainLoss += l.fx_gain_loss;
        }
        await client.query(`UPDATE cm_bank_fx_revaluation SET total_gain_loss=$1 WHERE id=$2`,
            [Math.round(totalGainLoss * 100) / 100, id]);

        await client.query('COMMIT');
        const result = await client.query(`${BASE_SELECT} WHERE r.id = $1`, [id]);
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// ===== ถอยเป็นร่าง / ยกเลิก / ลบ =====
// - ถอย (Posted → Draft): งวด GL + CM ของวันที่ปรับมูลค่ายังเปิด และไม่มีการปรับมูลค่าครั้งถัดไปที่โพสต์แล้วของบัญชีเดียวกัน
//   (ครั้งถัดไปใช้ยอดหลังปรับมูลค่าของครั้งนี้เป็นจุดตั้งต้น — calcAccountBalance) — ลบรายการบัญชี เก็บเลขที่ (gl_doc_no) ไว้ใช้ซ้ำ
//   ร่างแก้ไขได้ (คำนวณบรรทัดใหม่) แล้วโพสต์ใหม่ด้วยเลขที่เดิม
// - ยกเลิก (Voided): ใช้เมื่อถอยไม่ได้ (เช่น งวดปิดแล้ว) ลงรายการกลับในวันที่ยกเลิก — ติดเงื่อนไขครั้งถัดไปเหมือนกัน
// - ลบ: เฉพาะร่าง เก็บไว้ด้วยสถานะ Deleted
// ทุกการกระทำต้องมีเหตุผล และบันทึกที่ sa_document_reverse_log
const REVAL_BLOCK_MESSAGES = {
    NOT_REVERSIBLE: 'ถอยได้เฉพาะรายการที่โพสต์แล้ว',
    NOT_POSTED:     'ยกเลิกได้เฉพาะรายการที่โพสต์แล้ว (ร่างให้ลบแทน)',
    NOT_DRAFT:      'รายการที่โพสต์แล้วลบไม่ได้ กรุณาถอยเป็นร่างก่อน',
    PERIOD_CLOSED:  'งวดบัญชีของรายการนี้ปิดแล้ว ถอยไม่ได้',
    LATER_REVAL:    'มีการปรับมูลค่าครั้งถัดไปของบัญชีธนาคารเดียวกันที่โพสต์แล้ว (ใช้ยอดหลังปรับมูลค่าครั้งนี้เป็นจุดตั้งต้น)',
    VOIDED:         'รายการนี้ถูกยกเลิกหรือลบแล้ว',
};
const packBlock = (code, ref) => code
    ? { code, ref: ref || null, message: REVAL_BLOCK_MESSAGES[code] + (ref ? ` (${ref})` : '') } : null;

const REVAL_INFO_SQL = `
    SELECT r.id, r.status, p.gl_status, COALESCE(p.cm_status, 'OPEN') AS cm_status,
           (SELECT string_agg(DISTINCT COALESCE(n.gl_doc_no, to_char(n.revaluation_date, 'DD/MM/YYYY')), ', ')
              FROM cm_bank_fx_revaluation n
              JOIN cm_bank_fx_revaluation_line nl ON nl.revaluation_id = n.id
             WHERE n.id <> r.id AND n.status = 'Posted'
               AND (n.revaluation_date > r.revaluation_date OR (n.revaluation_date = r.revaluation_date AND n.id > r.id))
               AND nl.bank_account_id IN (SELECT bank_account_id FROM cm_bank_fx_revaluation_line WHERE revaluation_id = r.id)) AS later_revals
      FROM cm_bank_fx_revaluation r
      LEFT JOIN gl_posting_period p ON r.revaluation_date BETWEEN p.period_start_date AND p.period_end_date
     WHERE r.id = $1`;

const computeRevalBlocks = async (db, id) => {
    const r = (await db.query(REVAL_INFO_SQL, [id])).rows[0];
    if (!r) return {};
    if (['Voided', 'Deleted'].includes(r.status)) {
        const v = packBlock('VOIDED');
        return { reverse_block: v, void_block: v, delete_block: v };
    }
    if (r.status !== 'Posted') {
        return { reverse_block: packBlock('NOT_REVERSIBLE'), void_block: packBlock('NOT_POSTED'), delete_block: null };
    }
    const later = r.later_revals ? packBlock('LATER_REVAL', r.later_revals) : null;
    const reverse = (r.gl_status !== 'OPEN' || r.cm_status !== 'OPEN') ? packBlock('PERIOD_CLOSED') : later;
    return { reverse_block: reverse, void_block: later, delete_block: packBlock('NOT_DRAFT') };
};

const reasonOf = (req) => (req.body?.reason || '').trim();
const userIdOf = (req) => req.body?.user_id || req.headers['userid'] || null;
// gl_entry_header.created_by เป็นรหัสผู้ใช้ (int)
const glUserOf = (req) => { const v = Number(req.headers['userid']); return Number.isFinite(v) && v > 0 ? v : null; };
const openPeriodId = async (client, date) => (await client.query(`
    SELECT id FROM gl_posting_period
     WHERE $1::date BETWEEN period_start_date AND period_end_date
       AND gl_status = 'OPEN' AND COALESCE(cm_status, 'OPEN') = 'OPEN' LIMIT 1`, [date])).rows[0]?.id || null;

// PUT post: Draft → Posted, create GL entry
const postRow = async (req, res) => {
    const { id }   = req.params;
    const client   = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTables(client);

        // 1. Load revaluation
        const rRes = await client.query(
            `SELECT * FROM cm_bank_fx_revaluation WHERE id = $1 FOR UPDATE`, [id]);
        if (!rRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Not found' });
        }
        const reval = rRes.rows[0];
        if (reval.status !== 'Draft') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'สถานะต้องเป็น Draft จึงจะ Post GL ได้' });
        }
        if (!reval.fx_gain_account_id || !reval.fx_loss_account_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ต้องระบุบัญชี FX Gain และ FX Loss ก่อน Post GL' });
        }
        if (!reval.gl_doc_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ต้องระบุประเภทเอกสาร GL ก่อน Post' });
        }

        // 2. Load lines
        const lRes = await client.query(
            `SELECT * FROM cm_bank_fx_revaluation_line WHERE revaluation_id = $1`, [id]);
        const lines = lRes.rows.filter(l => Math.abs(parseFloat(l.fx_gain_loss)) >= 0.005);
        if (lines.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ไม่มีรายการที่มี FX Gain/Loss คุ้มค่าจะ Post' });
        }

        // 3. งวด GL + CM ต้องเปิด
        const periodId = await openPeriodId(client, reval.revaluation_date);
        if (!periodId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `งวดบัญชี/งวด CM ของวันที่ ${ymd(reval.revaluation_date)} ยังไม่เปิด โพสต์ไม่ได้` });
        }

        // 4. GL doc_no — ถอยแล้วโพสต์ใหม่ใช้เลขเดิม (gl_doc_no เก็บไว้ตอนถอย)
        let glDocNo = reval.gl_doc_no || await generateGlDocNo(client, reval.gl_doc_id, reval.revaluation_date);
        if (!glDocNo) glDocNo = `FXRV-${id}`;

        // 5. Resolve base currency
        const currencyId = (await getBaseCurrency(client)).id;

        // 6. Build GL detail lines (Gain: DR Bank / CR FX Gain — Loss: DR FX Loss / CR Bank)
        const glDetails = [];
        for (const l of lines) {
            const gainLoss = parseFloat(l.fx_gain_loss);
            const absAmt   = Math.abs(gainLoss);
            const desc     = `FX Reval ${l.currency_code} - ${ymd(reval.revaluation_date)}`;
            if (gainLoss > 0) {
                glDetails.push({ account_id: l.gl_account_id, description: desc, debit_lc: absAmt, credit_lc: 0 });
                glDetails.push({ account_id: reval.fx_gain_account_id, description: desc, debit_lc: 0, credit_lc: absAmt });
            } else {
                glDetails.push({ account_id: reval.fx_loss_account_id, description: desc, debit_lc: absAmt, credit_lc: 0 });
                glDetails.push({ account_id: l.gl_account_id, description: desc, debit_lc: 0, credit_lc: absAmt });
            }
        }
        const totalDebitLc  = Math.round(glDetails.reduce((s, d) => s + d.debit_lc, 0) * 100) / 100;
        const totalCreditLc = Math.round(glDetails.reduce((s, d) => s + d.credit_lc, 0) * 100) / 100;

        // 7. Insert GL header — gl_entry_header (real columns, ไม่ใช่ total_debit/total_credit ที่ไม่มีจริง)
        const glHRes = await client.query(`
            INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id,
                 description, currency_id, exchange_rate, status,
                 total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc, created_by)
            VALUES ($1,$2,$3,$3,$4,$5,$6,1,'Posted',$7,$8,$7,$8,$9)
            RETURNING id`,
            [reval.gl_doc_id, glDocNo, reval.revaluation_date,
             periodId,
             reval.description || `FX Revaluation ${ymd(reval.revaluation_date)}`,
             currencyId, totalDebitLc, totalCreditLc, glUserOf(req)]);
        const glEntryId = glHRes.rows[0].id;

        // 8. Insert GL detail lines — gl_entry_detail (real table, ไม่ใช่ gl_entry_line ที่ไม่มีจริง)
        let lineNo = 1;
        for (const d of glDetails) {
            await client.query(`
                INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                VALUES ($1,$2,$3,$4,$5,$6,$5,$6)`,
                [glEntryId, lineNo++, d.account_id, d.description, d.debit_lc, d.credit_lc]);
        }

        // 9. Update revaluation
        await client.query(`
            UPDATE cm_bank_fx_revaluation
            SET status = 'Posted', gl_entry_id = $1, gl_doc_no = $2,
                gl_doc_id_ref = $3, updated_at = NOW()
            WHERE id = $4`,
            [glEntryId, glDocNo, reval.gl_doc_id || null, id]);

        await client.query('COMMIT');
        const result = await client.query(`${BASE_SELECT} WHERE r.id = $1`, [id]);
        res.json({ ...result.rows[0], message: `Post GL สำเร็จ (${glDocNo})` });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// ดำเนินการกับรายการปรับมูลค่าใน transaction เดียว: fn คืน { status, message, code, ref } เมื่อทำไม่ได้
const runAction = async (req, res, label, fn) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTables(client);
        const reval = (await client.query(`SELECT * FROM cm_bank_fx_revaluation WHERE id=$1 FOR UPDATE`, [id])).rows[0];
        if (!reval) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        const err = await fn(client, reval, reasonOf(req));
        if (err) {
            await client.query('ROLLBACK');
            return res.status(err.status || 400).json({ error: err.message, message: err.message, code: err.code || null, ref: err.ref || null });
        }
        await client.query('COMMIT');
        const result = await client.query(`${BASE_SELECT} WHERE r.id=$1`, [id]);
        res.json(result.rows[0]);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(`cm bank fx ${label} error:`, e);
        res.status(500).json({ error: e.message });
    } finally { client.release(); }
};
const blockErr = (b) => ({ message: b.message, code: b.code, ref: b.ref });
const revalLabel = (reval) => reval.gl_doc_no || `FX Reval ${ymd(reval.revaluation_date)}`;

// PUT reverse { reason }: Posted → Draft
const reverseRow = (req, res) => runAction(req, res, 'reverse', async (client, reval, reason) => {
    if (!reason) return { message: 'กรุณาระบุเหตุผลการถอยเอกสาร' };
    const b = (await computeRevalBlocks(client, reval.id)).reverse_block;
    if (b) return blockErr(b);
    await client.query(`UPDATE cm_bank_fx_revaluation SET status='Draft', gl_entry_id=NULL, updated_at=NOW() WHERE id=$1`, [reval.id]);
    if (reval.gl_entry_id) await client.query(`DELETE FROM gl_entry_header WHERE id=$1`, [reval.gl_entry_id]);
    await logReverse(client, {
        sysModule: '81', tableName: 'cm_bank_fx_revaluation', recordId: Number(reval.id), docNo: revalLabel(reval),
        fromStatus: 'Posted', toStatus: 'Draft', reason, userId: userIdOf(req),
    });
    return null;
});

// PUT void { reason }: create reversing GL entry dated today
const voidRow = (req, res) => runAction(req, res, 'void', async (client, reval, reason) => {
    if (!reason) return { message: 'กรุณาระบุเหตุผลการยกเลิก' };
    const b = (await computeRevalBlocks(client, reval.id)).void_block;
    if (b) return blockErr(b);

    const today = todayYmd();
    const periodId = await openPeriodId(client, today);
    if (!periodId) return { message: `ไม่พบงวดบัญชี (GL/CM) ที่เปิดอยู่ สำหรับวันที่ยกเลิก ${today}`, code: 'PERIOD_CLOSED' };

    let rvEntryId = null;
    if (reval.gl_entry_id) {
        const orig = (await client.query(`SELECT * FROM gl_entry_header WHERE id=$1`, [reval.gl_entry_id])).rows[0];
        const rvDocNo = (orig.doc_id && await generateGlDocNo(client, orig.doc_id, today)) || `RVSL-${reval.gl_doc_no || reval.id}`;
        const rvHRes = await client.query(`
            INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id,
                 ref_no, description, currency_id, exchange_rate, status,
                 total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc, created_by)
            VALUES ($1,$2,$3,$3,$4,$5,$6,$7,1,'Posted',$8,$9,$8,$9,$10)
            RETURNING id`,
            [orig.doc_id, rvDocNo, today, periodId, reval.gl_doc_no,
             `[ยกเลิก FX Reval ${ymd(reval.revaluation_date)}] ${reason}`,
             orig.currency_id, orig.total_credit_lc, orig.total_debit_lc, glUserOf(req)]);
        rvEntryId = rvHRes.rows[0].id;
        await client.query(`
            INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
            SELECT $1, line_no, account_id, 'ยกเลิก: ' || COALESCE(description, ''), credit_lc, debit_lc, credit_lc, debit_lc
              FROM gl_entry_detail WHERE header_id = $2 ORDER BY line_no`,
            [rvEntryId, reval.gl_entry_id]);
    }
    await client.query(`
        UPDATE cm_bank_fx_revaluation
           SET status = 'Voided', reversal_entry_id = $1, void_reason = $2, voided_by = $3, voided_at = NOW(), updated_at = NOW()
         WHERE id = $4`, [rvEntryId, reason, req.headers['username'] || null, reval.id]);
    await logReverse(client, {
        sysModule: '81', tableName: 'cm_bank_fx_revaluation', recordId: Number(reval.id), docNo: revalLabel(reval),
        fromStatus: 'Posted', toStatus: 'Void', reason, userId: userIdOf(req),
    });
    return null;
});

// DELETE { reason } (Draft only): เก็บไว้ด้วยสถานะ Deleted
const deleteRow = (req, res) => runAction(req, res, 'delete', async (client, reval, reason) => {
    if (!reason) return { message: 'กรุณาระบุเหตุผลการลบเอกสาร' };
    const b = (await computeRevalBlocks(client, reval.id)).delete_block;
    if (b) return blockErr(b);
    await client.query(`UPDATE cm_bank_fx_revaluation SET status='Deleted', updated_at=NOW() WHERE id=$1`, [reval.id]);
    await logReverse(client, {
        sysModule: '81', tableName: 'cm_bank_fx_revaluation', recordId: Number(reval.id), docNo: revalLabel(reval),
        fromStatus: 'Draft', toStatus: 'Deleted', reason, userId: userIdOf(req),
    });
    return null;
});

module.exports = { fetchRows, fetchRow, previewLines, createRow, updateRow, postRow, reverseRow, voidRow, deleteRow, ensureTables, getOutstandingCurrencies, computeRevalBlocks };
