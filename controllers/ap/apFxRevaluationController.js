// controllers/ap/apFxRevaluationController.js
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
};

// ── Helper: คำนวณ revaluation details สำหรับ outstanding FC invoices ──────────
const calcRevalDetails = async (client, revalDate, yearEndRates) => {
    const AP_TYPES = ['10', '50'];
    const rows = await client.query(`
        SELECT t.id AS invoice_id, t.vendor_id, t.currency_id,
               t.currency_code, t.balance_amount_lc, t.exchange_rate AS original_rate,
               t.doc_no,
               v.vendor_code, v.vendor_name_th,
               COALESCE(t.revaluation_rate, t.exchange_rate) AS current_rate,
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
          AND t.currency_code <> 'THB'
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
            doc_no:             row.doc_no,
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

// ── Helper: ดึง AP Control account ───────────────────────────────────────────
const getApControlAccount = async (client, invoiceId) => {
    const r = await client.query(
        `SELECT ap_account_id FROM ap_transaction WHERE id=$1`, [invoiceId]
    );
    return r.rows[0]?.ap_account_id || null;
};

// ── Helper: สร้าง GL Entry สำหรับ AP revaluation ─────────────────────────────
// AP accounting (opposite of AR):
//   Positive fxGL (AP grew)  → DR FX Loss, CR AP Control
//   Negative fxGL (AP shrank) → DR AP Control, CR FX Gain
const postRevalGlEntry = async (client, setup, details, revalDate, isUnrealized, docNo, createdBy) => {
    const gainAccountId = isUnrealized
        ? setup.unrealized_fx_gain_account_id
        : setup.fx_gain_account_id;
    const lossAccountId = isUnrealized
        ? setup.unrealized_fx_loss_account_id
        : setup.fx_loss_account_id;

    if (!gainAccountId || !lossAccountId)
        throw new Error('ยังไม่ได้ตั้งค่าบัญชี FX สำหรับปิดสิ้นปี AP');

    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period
         WHERE $1::date BETWEEN period_start_date AND period_end_date
         AND gl_status = 'OPEN' LIMIT 1`, [revalDate]
    );
    if (periodRes.rows.length === 0)
        throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${revalDate}`);
    const periodId = periodRes.rows[0].id;

    let totalGain = 0, totalLoss = 0;
    const apAdjMap = {}; // apAccountId → net fxGainLoss

    for (const d of details) {
        const apAccId = await getApControlAccount(client, d.invoice_id);
        if (!apAccId) continue;
        apAdjMap[apAccId] = (apAdjMap[apAccId] || 0) + d.fx_gain_loss;
        // positive → AP grew → FX Loss; negative → AP shrank → FX Gain
        if (d.fx_gain_loss > 0) totalLoss += d.fx_gain_loss;
        else totalGain += Math.abs(d.fx_gain_loss);
    }

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

    let lineNo = 1;

    // AP Control lines
    // netAdj > 0 → AP grew → CR AP (credit increases liability)
    // netAdj < 0 → AP shrank → DR AP (debit decreases liability)
    for (const [apAccId, netAdj] of Object.entries(apAdjMap)) {
        if (Math.abs(netAdj) < 0.005) continue;
        const debitLc  = netAdj < 0 ? -netAdj : 0;
        const creditLc = netAdj > 0 ? netAdj  : 0;
        await client.query(`
            INSERT INTO gl_entry_detail
            (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
            VALUES ($1,$2,$3,$4,$5,$4,$5)
        `, [glEntryId, lineNo++, parseInt(apAccId), debitLc, creditLc]);
    }

    // FX Gain line (AP shrank → income → CR FX Gain)
    if (totalGain > 0.005) {
        await client.query(`
            INSERT INTO gl_entry_detail
            (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
            VALUES ($1,$2,$3,0,$4,0,$4)
        `, [glEntryId, lineNo++, gainAccountId, totalGain]);
    }

    // FX Loss line (AP grew → expense → DR FX Loss)
    if (totalLoss > 0.005) {
        await client.query(`
            INSERT INTO gl_entry_detail
            (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
            VALUES ($1,$2,$3,$4,0,$4,0)
        `, [glEntryId, lineNo++, lossAccountId, totalLoss]);
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
              AND t.currency_code <> 'THB'
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
        const result = await client.query(`
            SELECT r.*, u.doc_no AS gl_doc_no, v.doc_no AS reversal_doc_no
            FROM ap_fx_revaluation r
            LEFT JOIN gl_entry_header u ON u.id = r.gl_entry_id
            LEFT JOIN gl_entry_header v ON v.id = r.reversal_gl_entry_id
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
            SELECT d.*, v.vendor_code, v.vendor_name_th,
                   t.doc_no AS invoice_doc_no, t.doc_date AS invoice_doc_date
            FROM ap_fx_revaluation_detail d
            LEFT JOIN ap_vendor v ON v.id = d.vendor_id
            LEFT JOIN ap_transaction t ON t.id = d.invoice_id
            WHERE d.revaluation_id = $1
            ORDER BY v.vendor_code, t.doc_date, t.doc_no
        `, [id]);

        res.json({ header: hdr.rows[0], details: dtl.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── POST /api/ap/ap_fx_revaluation/preview ───────────────────────────────────
const previewReval = async (req, res) => {
    const { reval_date, year_end_rates } = req.body;
    if (!reval_date || !year_end_rates)
        return res.status(400).json({ error: 'reval_date and year_end_rates required' });
    const client = await req.dbPool.connect();
    try {
        const details = await calcRevalDetails(client, reval_date, year_end_rates);
        const totalGainLoss = details.reduce((s, d) => s + d.fx_gain_loss, 0);
        res.json({ details, total_fx_gain_loss: Math.round(totalGainLoss * 100) / 100 });
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
                 year_end_rate, revalued_amount_lc, fx_gain_loss)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            `, [revalId, d.invoice_id, d.vendor_id, d.currency_code,
                d.balance_amount_fc, d.original_rate, d.balance_amount_lc,
                d.year_end_rate, d.revalued_amount_lc, d.fx_gain_loss]);
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
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        if (hdr.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Only Draft can be posted' }); }

        const reval   = hdr.rows[0];
        const setup   = (await client.query('SELECT * FROM ap_year_end_setup LIMIT 1')).rows[0];
        if (!setup) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'ยังไม่ได้ตั้งค่าบัญชีปิดสิ้นปี AP' }); }

        const details = (await client.query(
            `SELECT * FROM ap_fx_revaluation_detail WHERE revaluation_id=$1`, [id]
        )).rows;

        const isUnrealized = reval.method === 'reversing';
        const docNo = `AP-FXR-${reval.reval_date.toISOString().slice(0, 10).replace(/-/g, '')}`;

        const glEntryId = await postRevalGlEntry(
            client, setup, details, reval.reval_date, isUnrealized, docNo, updatedBy
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
            const revDocNo = `AP-FXR-REV-${reval.reversal_date.toISOString().slice(0, 10).replace(/-/g, '')}`;
            const revPeriodRes = await client.query(
                `SELECT id FROM gl_posting_period
                 WHERE $1::date BETWEEN period_start_date AND period_end_date
                 AND gl_status = 'OPEN' LIMIT 1`, [reval.reversal_date]
            );

            if (revPeriodRes.rows.length > 0) {
                const origDtl = await client.query(
                    `SELECT * FROM gl_entry_detail WHERE header_id=$1`, [glEntryId]
                );
                const revPeriodId = revPeriodRes.rows[0].id;
                const origHdr = (await client.query(
                    `SELECT * FROM gl_entry_header WHERE id=$1`, [glEntryId]
                )).rows[0];

                const revHdrRes = await client.query(`
                    INSERT INTO gl_entry_header
                    (doc_id, doc_no, doc_date, posting_date, period_id, description,
                     currency_id, exchange_rate, status,
                     total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
                     created_by, ref_doc_id, ref_doc_no)
                    VALUES ($1,$2,$3::date,$3::date,$4,$5,$6,1,'Posted',$7,$8,$7,$8,$9,$10,$11)
                    RETURNING id
                `, [origHdr.doc_id, revDocNo, reval.reversal_date, revPeriodId,
                    `[กลับรายการ] ${docNo}`,
                    origHdr.currency_id, origHdr.total_credit_lc, origHdr.total_debit_lc,
                    updatedBy, glEntryId, docNo]);
                reversalGlEntryId = revHdrRes.rows[0].id;

                for (const d of origDtl.rows) {
                    await client.query(`
                        INSERT INTO gl_entry_detail
                        (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
                        VALUES ($1,$2,$3,$4,$5,$4,$5)
                    `, [reversalGlEntryId, d.line_no, d.account_id, d.credit_lc, d.debit_lc]);
                }
            }
        }

        await client.query(`
            UPDATE ap_fx_revaluation SET
            status='Posted', gl_entry_id=$1, reversal_gl_entry_id=$2,
            updated_by=$3, updated_at=NOW()
            WHERE id=$4
        `, [glEntryId, reversalGlEntryId, updatedBy, id]);

        await client.query('COMMIT');
        res.json({ success: true, gl_entry_id: glEntryId, reversal_gl_entry_id: reversalGlEntryId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ap postReval error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── POST /api/ap/ap_fx_revaluation/:id/void ──────────────────────────────────
const voidReval = async (req, res) => {
    const { id } = req.params;
    const updatedBy = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const hdr = await client.query(
            `SELECT * FROM ap_fx_revaluation WHERE id=$1 FOR UPDATE`, [id]
        );
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        const reval = hdr.rows[0];
        if (reval.status !== 'Posted') { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Only Posted can be voided' }); }

        const today = new Date().toISOString().slice(0, 10);
        const todayPeriod = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`, [today]
        );
        if (todayPeriod.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ยกเลิก ${today}`);
        const todayPeriodId = todayPeriod.rows[0].id;

        if (reval.method === 'realized') {
            const details = (await client.query(
                `SELECT invoice_id, balance_amount_lc FROM ap_fx_revaluation_detail WHERE revaluation_id=$1`, [id]
            )).rows;
            for (const d of details) {
                await client.query(
                    `UPDATE ap_transaction
                     SET revaluation_rate=NULL, balance_amount_lc=$1, updated_at=NOW()
                     WHERE id=$2`,
                    [d.balance_amount_lc, d.invoice_id]
                );
            }
        }

        if (reval.gl_entry_id) {
            const origHdr = (await client.query(
                `SELECT * FROM gl_entry_header WHERE id=$1`, [reval.gl_entry_id]
            )).rows[0];
            const origDtl = (await client.query(
                `SELECT * FROM gl_entry_detail WHERE header_id=$1 ORDER BY line_no`, [reval.gl_entry_id]
            )).rows;

            const revDocNo = `VOID-AP-FXR-${today.replace(/-/g, '')}`;
            const revHdrRes = await client.query(`
                INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id, description,
                 currency_id, exchange_rate, status,
                 total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
                 created_by, ref_doc_id, ref_doc_no)
                VALUES ($1,$2,$3::date,$3::date,$4,$5,$6,1,'Posted',$7,$8,$7,$8,$9,$10,$11)
                RETURNING id
            `, [origHdr.doc_id, revDocNo, today, todayPeriodId,
                `[ยกเลิก AP FX Revaluation] ${origHdr.doc_no}`,
                origHdr.currency_id, origHdr.total_credit_lc, origHdr.total_debit_lc,
                updatedBy, reval.gl_entry_id, origHdr.doc_no]);
            const voidGlId = revHdrRes.rows[0].id;

            for (const d of origDtl) {
                await client.query(`
                    INSERT INTO gl_entry_detail
                    (header_id, line_no, account_id, debit_lc, credit_lc, debit_fc, credit_fc)
                    VALUES ($1,$2,$3,$4,$5,$4,$5)
                `, [voidGlId, d.line_no, d.account_id, d.credit_lc, d.debit_lc]);
            }
        }

        if (reval.reversal_gl_entry_id) {
            await client.query(
                `UPDATE gl_entry_header SET status='Void' WHERE id=$1`,
                [reval.reversal_gl_entry_id]
            );
        }

        await client.query(`
            UPDATE ap_fx_revaluation SET status='Void', updated_by=$1, updated_at=NOW()
            WHERE id=$2
        `, [updatedBy, id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ap voidReval error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ── DELETE /api/ap/ap_fx_revaluation/:id ─────────────────────────────────────
const deleteReval = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hdr = await client.query(`SELECT status FROM ap_fx_revaluation WHERE id=$1`, [id]);
        if (!hdr.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        if (hdr.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Only Draft can be deleted' }); }

        await client.query(`DELETE FROM ap_fx_revaluation_detail WHERE revaluation_id=$1`, [id]);
        await client.query(`DELETE FROM ap_fx_revaluation WHERE id=$1`, [id]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('ap deleteReval error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { fetchOutstandingCurrencies, fetchRows, fetchRow, previewReval, createReval, postReval, voidReval, deleteReval };
