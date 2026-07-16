// controllers/cm/cmBankFxRevaluationController.js
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

// ── Core: calculate lines for a revaluation date + rates map ────────────────
// ratesMap: { "USD": 35.8, "EUR": 40.2, ... }  keyed by currency_code
const calcLines = async (client, revaluationDate, ratesMap, excludeRevalId = null) => {
    // Get all active non-THB BANK accounts that have a GL account
    const accRes = await client.query(`
        SELECT ba.id, ba.account_code, ba.account_name_th, ba.currency_code, ba.gl_account_id,
               cb.short_name AS bank_short_name,
               ga.account_code AS gl_account_code
        FROM cm_bank_account ba
        LEFT JOIN cm_bank     cb ON cb.id = ba.bank_id
        LEFT JOIN gl_account  ga ON ga.id = ba.gl_account_id
        WHERE ba.currency_code != 'THB' AND ba.is_active = TRUE AND ba.cm_type = 'BANK'
        ORDER BY ba.account_code`);

    const lines = [];
    for (const acc of accRes.rows) {
        const newRate = parseFloat(ratesMap[acc.currency_code]);
        if (!newRate || newRate <= 0) continue;
        if (!acc.gl_account_id) continue;

        // Find latest posted revaluation for this account (before or on revaluation_date, excluding current edit)
        let latestRevalQuery = `
            SELECT r.revaluation_date, l.balance_fc, l.balance_lc_new
            FROM cm_bank_fx_revaluation_line l
            JOIN cm_bank_fx_revaluation r ON r.id = l.revaluation_id
            WHERE l.bank_account_id = $1 AND r.status = 'Posted'
              AND r.revaluation_date <= $2`;
        const qParams = [acc.id, revaluationDate];
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
            // Movements AFTER last revaluation date up to revaluation_date
            const movRes = await client.query(`
                SELECT
                    COALESCE(SUM(net_fc), 0) AS net_fc,
                    COALESCE(SUM(net_lc), 0) AS net_lc
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
                [acc.id, lastDate, revaluationDate]);
            const m = movRes.rows[0];
            balanceFc     = parseFloat(lr.balance_fc)     + parseFloat(m.net_fc);
            balanceLcBook = parseFloat(lr.balance_lc_new) + parseFloat(m.net_lc);
        } else {
            // Sum all transactions up to revaluation_date
            const totRes = await client.query(`
                SELECT
                    COALESCE(SUM(net_fc), 0) AS balance_fc,
                    COALESCE(SUM(net_lc), 0) AS balance_lc
                FROM (
                    SELECT amount_fc AS net_fc, amount_lc AS net_lc
                    FROM cm_receipt
                    WHERE bank_account_id = $1 AND status != 'Voided'
                      AND receipt_date <= $2
                    UNION ALL
                    SELECT -amount_fc, -amount_lc
                    FROM cm_payment
                    WHERE bank_account_id = $1 AND status != 'Voided'
                      AND payment_date <= $2
                ) t`,
                [acc.id, revaluationDate]);
            const t = totRes.rows[0];
            balanceFc     = parseFloat(t.balance_fc);
            balanceLcBook = parseFloat(t.balance_lc);
        }

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

// PUT post: Draft → Posted, create GL entry
const postRow = async (req, res) => {
    const { id }   = req.params;
    const userName = req.headers['username'] || null;
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

        // 2. Load lines
        const lRes = await client.query(
            `SELECT * FROM cm_bank_fx_revaluation_line WHERE revaluation_id = $1`, [id]);
        const lines = lRes.rows.filter(l => Math.abs(parseFloat(l.fx_gain_loss)) >= 0.005);
        if (lines.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ไม่มีรายการที่มี FX Gain/Loss คุ้มค่าจะ Post' });
        }

        // 3. Find open period
        const periodRes = await client.query(`
            SELECT id FROM gl_period
            WHERE $1 BETWEEN period_start AND period_end AND is_open = true
            LIMIT 1`, [reval.revaluation_date]);
        if (!periodRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: `ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${reval.revaluation_date}`
            });
        }
        const periodId = periodRes.rows[0].id;

        // 4. Generate GL doc_no
        let glDocNo = `FXRV-${id}`;
        if (reval.gl_doc_id) {
            const gen = await generateGlDocNo(client, reval.gl_doc_id, reval.revaluation_date);
            if (gen) glDocNo = gen;
        }

        // 5. Resolve user id + currency
        const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
        const createdBy = userRes.rows[0]?.id || null;
        const currRes = await client.query(`SELECT id FROM cd_currency WHERE currency_code = 'THB' LIMIT 1`);
        const currencyId = currRes.rows[0]?.id || null;

        const totalAbs = lines.reduce((s, l) => s + Math.abs(parseFloat(l.fx_gain_loss)), 0);
        const totalAbsRounded = Math.round(totalAbs * 100) / 100;

        // 6. Insert GL header
        const glHRes = await client.query(`
            INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id,
                 ref_no, description, currency_id, exchange_rate, status,
                 total_debit, total_credit, created_by, created_at, updated_at)
            VALUES ($1,$2,$3,$3,$4,$5,$6,$7,1,'Posted',$8,$8,$9,NOW(),NOW())
            RETURNING id`,
            [reval.gl_doc_id || null, glDocNo, reval.revaluation_date,
             periodId, null,
             reval.description || `FX Revaluation ${reval.revaluation_date}`,
             currencyId, totalAbsRounded, createdBy]);
        const glEntryId = glHRes.rows[0].id;

        // 7. Insert GL lines
        let lineNo = 1;
        for (const l of lines) {
            const gainLoss = parseFloat(l.fx_gain_loss);
            const absAmt   = Math.abs(gainLoss);
            const desc     = `FX Reval ${l.currency_code} - ${reval.revaluation_date}`;

            if (gainLoss > 0) {
                // Gain: DR Bank, CR FX Gain
                await client.query(`
                    INSERT INTO gl_entry_line
                        (header_id, line_no, gl_account_id, description,
                         debit_amount_lc, credit_amount_lc, debit_amount_fc, credit_amount_fc,
                         created_by, created_at, updated_at)
                    VALUES ($1,$2,$3,$4,$5,0,$5,0,$6,NOW(),NOW())`,
                    [glEntryId, lineNo++, l.gl_account_id, desc, absAmt, createdBy]);
                await client.query(`
                    INSERT INTO gl_entry_line
                        (header_id, line_no, gl_account_id, description,
                         debit_amount_lc, credit_amount_lc, debit_amount_fc, credit_amount_fc,
                         created_by, created_at, updated_at)
                    VALUES ($1,$2,$3,$4,0,$5,0,$5,$6,NOW(),NOW())`,
                    [glEntryId, lineNo++, reval.fx_gain_account_id, desc, absAmt, createdBy]);
            } else {
                // Loss: DR FX Loss, CR Bank
                await client.query(`
                    INSERT INTO gl_entry_line
                        (header_id, line_no, gl_account_id, description,
                         debit_amount_lc, credit_amount_lc, debit_amount_fc, credit_amount_fc,
                         created_by, created_at, updated_at)
                    VALUES ($1,$2,$3,$4,$5,0,$5,0,$6,NOW(),NOW())`,
                    [glEntryId, lineNo++, reval.fx_loss_account_id, desc, absAmt, createdBy]);
                await client.query(`
                    INSERT INTO gl_entry_line
                        (header_id, line_no, gl_account_id, description,
                         debit_amount_lc, credit_amount_lc, debit_amount_fc, credit_amount_fc,
                         created_by, created_at, updated_at)
                    VALUES ($1,$2,$3,$4,0,$5,0,$5,$6,NOW(),NOW())`,
                    [glEntryId, lineNo++, l.gl_account_id, desc, absAmt, createdBy]);
            }
        }

        // 8. Update revaluation
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

// PUT void: create reversing GL entry
const voidRow = async (req, res) => {
    const { id }   = req.params;
    const userName = req.headers['username'] || null;
    const client   = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTables(client);

        const rRes = await client.query(`SELECT * FROM cm_bank_fx_revaluation WHERE id=$1 FOR UPDATE`, [id]);
        if (!rRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        const reval = rRes.rows[0];
        if (reval.status === 'Voided') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ถูก Void ไปแล้ว' }); }

        if (reval.status === 'Posted' && reval.gl_entry_id) {
            // Load original GL lines and create reversal
            const origLines = await client.query(
                `SELECT * FROM gl_entry_line WHERE header_id = $1`, [reval.gl_entry_id]);

            const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name=$1 LIMIT 1`, [userName]);
            const createdBy = userRes.rows[0]?.id || null;
            const today = new Date().toISOString().substring(0, 10);

            const periodRes = await client.query(`
                SELECT id FROM gl_period WHERE $1 BETWEEN period_start AND period_end AND is_open=true LIMIT 1`,
                [today]);
            if (!periodRes.rows.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: `ไม่พบงวดบัญชีเปิดสำหรับวันที่ ${today}` });
            }
            const periodId = periodRes.rows[0].id;

            const currRes = await client.query(`SELECT id FROM cd_currency WHERE currency_code='THB' LIMIT 1`);
            const currencyId = currRes.rows[0]?.id || null;
            const totalAbs = origLines.rows.reduce((s, l) => s + parseFloat(l.debit_amount_lc || 0), 0);
            const totalAbsRounded = Math.round(totalAbs * 100) / 100;

            const rvHRes = await client.query(`
                INSERT INTO gl_entry_header
                    (doc_id, doc_no, doc_date, posting_date, period_id,
                     ref_no, description, currency_id, exchange_rate, status,
                     total_debit, total_credit, created_by, created_at, updated_at)
                VALUES ($1,$2,$3,$3,$4,$5,$6,$7,1,'Posted',$8,$8,$9,NOW(),NOW())
                RETURNING id`,
                [reval.gl_doc_id_ref || null,
                 `RVSL-${reval.gl_doc_no || id}`,
                 today, periodId,
                 reval.gl_doc_no,
                 `ยกเลิก FX Reval ${reval.revaluation_date}`,
                 currencyId, totalAbsRounded, createdBy]);
            const rvEntryId = rvHRes.rows[0].id;

            let lineNo = 1;
            for (const l of origLines.rows) {
                await client.query(`
                    INSERT INTO gl_entry_line
                        (header_id, line_no, gl_account_id, description,
                         debit_amount_lc, credit_amount_lc, debit_amount_fc, credit_amount_fc,
                         created_by, created_at, updated_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$5,$6,$7,NOW(),NOW())`,
                    [rvEntryId, lineNo++, l.gl_account_id,
                     `ยกเลิก: ${l.description}`,
                     parseFloat(l.credit_amount_lc || 0),
                     parseFloat(l.debit_amount_lc  || 0),
                     createdBy]);
            }

            await client.query(`
                UPDATE cm_bank_fx_revaluation
                SET status = 'Voided', reversal_entry_id = $1, updated_at = NOW()
                WHERE id = $2`,
                [rvEntryId, id]);
        } else {
            await client.query(`UPDATE cm_bank_fx_revaluation SET status='Voided', updated_at=NOW() WHERE id=$1`, [id]);
        }

        await client.query('COMMIT');
        const result = await client.query(`${BASE_SELECT} WHERE r.id=$1`, [id]);
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// DELETE (Draft only)
const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const result = await client.query(
            `DELETE FROM cm_bank_fx_revaluation WHERE id=$1 AND status='Draft' RETURNING id`, [id]);
        if (!result.rows.length) return res.status(400).json({ error: 'ลบได้เฉพาะ Draft' });
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { fetchRows, fetchRow, previewLines, createRow, updateRow, postRow, voidRow, deleteRow, ensureTables };
