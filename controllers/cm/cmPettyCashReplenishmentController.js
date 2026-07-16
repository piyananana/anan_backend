// controllers/cm/cmPettyCashReplenishmentController.js
'use strict';

const ensureRplTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_petty_cash_replenishment (
            id                     SERIAL PRIMARY KEY,
            replenishment_no       VARCHAR(50)   NOT NULL,
            replenishment_date     DATE          NOT NULL,
            petty_cash_account_id  INTEGER       REFERENCES cm_bank_account(id),
            source_bank_account_id INTEGER       REFERENCES cm_bank_account(id),
            total_amount           NUMERIC(18,4) NOT NULL DEFAULT 0,
            description            TEXT,
            status                 VARCHAR(20)   NOT NULL DEFAULT 'Draft',
            gl_entry_id            INTEGER,
            gl_doc_id              INTEGER,
            gl_doc_no              VARCHAR(50),
            created_by             INTEGER,
            created_at             TIMESTAMP DEFAULT NOW(),
            updated_at             TIMESTAMP DEFAULT NOW()
        )
    `);
};

const generateReplenishmentNo = async (client, date, pettyCashAccountId) => {
    const d = new Date(date);
    const ym = d.getFullYear().toString() + (d.getMonth() + 1).toString().padStart(2, '0');
    const prefix = `RPL-${ym}-`;
    const res = await client.query(
        `SELECT replenishment_no FROM cm_petty_cash_replenishment
         WHERE petty_cash_account_id = $1 AND replenishment_no LIKE $2
         ORDER BY replenishment_no DESC LIMIT 1`,
        [pettyCashAccountId, prefix + '%']);
    let seq = 1;
    if (res.rows.length > 0) {
        const lastSeq = parseInt(res.rows[0].replenishment_no.substring(prefix.length), 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    return prefix + seq.toString().padStart(3, '0');
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

const BASE_SELECT = `
    SELECT r.*,
           pca.account_code       AS petty_cash_account_code,
           pca.account_name_th    AS petty_cash_account_name,
           sba.account_code       AS source_bank_account_code,
           sba.account_name_th    AS source_bank_account_name,
           cb.short_name          AS source_bank_short_name
    FROM cm_petty_cash_replenishment r
    LEFT JOIN cm_bank_account pca ON pca.id = r.petty_cash_account_id
    LEFT JOIN cm_bank_account sba ON sba.id = r.source_bank_account_id
    LEFT JOIN cd_bank         cb  ON cb.id  = sba.bank_id
`;

const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureRplTable(client);
        const { petty_cash_account_id, status, date_from, date_to } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (petty_cash_account_id)        { where += ` AND r.petty_cash_account_id = $${pi++}`; params.push(petty_cash_account_id); }
        if (status && status !== 'All')   { where += ` AND r.status = $${pi++}`;                params.push(status); }
        if (date_from)                    { where += ` AND r.replenishment_date >= $${pi++}`;   params.push(date_from); }
        if (date_to)                      { where += ` AND r.replenishment_date <= $${pi++}`;   params.push(date_to); }
        const result = await client.query(
            `${BASE_SELECT} ${where} ORDER BY r.replenishment_date DESC, r.id DESC`, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureRplTable(client);
        const result = await client.query(`${BASE_SELECT} WHERE r.id = $1`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// GET pending approved vouchers for a petty cash account (not yet replenished)
const fetchPendingVouchers = async (req, res) => {
    const { petty_cash_account_id } = req.query;
    if (!petty_cash_account_id) return res.status(400).json({ error: 'petty_cash_account_id required' });
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`
            SELECT v.*,
                   ga.account_code      AS expense_gl_account_code,
                   ga.account_name_thai AS expense_gl_account_name
            FROM cm_petty_cash_voucher v
            LEFT JOIN gl_account ga ON ga.id = v.expense_gl_account_id
            WHERE v.petty_cash_account_id = $1
              AND v.status = 'Approved'
              AND v.replenishment_id IS NULL
            ORDER BY v.voucher_date, v.id`,
            [petty_cash_account_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// GET vouchers for a specific replenishment (Replenished)
const fetchReplenishedVouchers = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`
            SELECT v.*,
                   ga.account_code      AS expense_gl_account_code,
                   ga.account_name_thai AS expense_gl_account_name
            FROM cm_petty_cash_voucher v
            LEFT JOIN gl_account ga ON ga.id = v.expense_gl_account_id
            WHERE v.replenishment_id = $1
            ORDER BY v.voucher_date, v.id`,
            [id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const createRow = async (req, res) => {
    const body = req.body;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRplTable(client);
        const replenishment_no = await generateReplenishmentNo(
            client, body.replenishment_date, body.petty_cash_account_id);
        const userRes = await client.query(
            `SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
        const createdByUserId = userRes.rows[0]?.id || null;
        const result = await client.query(`
            INSERT INTO cm_petty_cash_replenishment
                (replenishment_no, replenishment_date, petty_cash_account_id,
                 source_bank_account_id, total_amount, description, gl_doc_id, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            RETURNING *`,
            [
                replenishment_no,
                body.replenishment_date,
                body.petty_cash_account_id    || null,
                body.source_bank_account_id   || null,
                body.total_amount || 0,
                body.description || null,
                body.gl_doc_id   || null,
                createdByUserId,
            ]);
        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const body = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureRplTable(client);
        const result = await client.query(`
            UPDATE cm_petty_cash_replenishment
            SET replenishment_date     = $1,
                source_bank_account_id = $2,
                total_amount           = $3,
                description            = $4,
                gl_doc_id              = $5,
                updated_at             = NOW()
            WHERE id = $6 AND status = 'Draft'
            RETURNING *`,
            [
                body.replenishment_date,
                body.source_bank_account_id || null,
                body.total_amount || 0,
                body.description  || null,
                body.gl_doc_id    || null,
                id,
            ]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถแก้ไขได้ หรือสถานะไม่ใช่ Draft' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const postReplenishment = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureRplTable(client);

        // 1. Fetch replenishment
        const rplRes = await client.query(
            `SELECT * FROM cm_petty_cash_replenishment WHERE id = $1`, [id]);
        if (rplRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Not found' });
        }
        const rpl = rplRes.rows[0];
        if (rpl.status !== 'Draft') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'บันทึก GL ได้เฉพาะ Draft เท่านั้น' });
        }
        if (!rpl.source_bank_account_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'กรุณาระบุบัญชีธนาคารต้นทาง' });
        }

        // 2. Fetch Approved vouchers (not yet replenished) for this petty cash account
        const vouchersRes = await client.query(`
            SELECT v.*, ga.account_name_thai AS gl_account_name
            FROM cm_petty_cash_voucher v
            LEFT JOIN gl_account ga ON ga.id = v.expense_gl_account_id
            WHERE v.petty_cash_account_id = $1
              AND v.status = 'Approved'
              AND v.replenishment_id IS NULL
            ORDER BY v.voucher_date, v.id`,
            [rpl.petty_cash_account_id]);
        const vouchers = vouchersRes.rows;
        if (vouchers.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ไม่พบใบสำคัญที่ Approved สำหรับการเบิกจ่าย' });
        }

        // 3. Get source bank account's GL account
        const srcRes = await client.query(
            `SELECT ba.gl_account_id, ga.account_name_thai AS account_name
             FROM cm_bank_account ba
             LEFT JOIN gl_account ga ON ga.id = ba.gl_account_id
             WHERE ba.id = $1`,
            [rpl.source_bank_account_id]);
        if (srcRes.rows.length === 0 || !srcRes.rows[0].gl_account_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า GL Account สำหรับบัญชีธนาคารต้นทาง' });
        }
        const srcBankGlAccountId = srcRes.rows[0].gl_account_id;
        const srcBankAccountName = srcRes.rows[0].account_name || 'ธนาคาร';

        // 4. Find open period
        const periodRes = await client.query(`
            SELECT id FROM gl_period
            WHERE $1 BETWEEN period_start AND period_end
              AND is_open = true
            LIMIT 1`, [rpl.replenishment_date]);
        if (periodRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: `ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${rpl.replenishment_date}`
            });
        }
        const periodId = periodRes.rows[0].id;

        // 5. Generate GL doc_no
        let glDocNo = null;
        if (rpl.gl_doc_id) {
            glDocNo = await generateGlDocNo(client, rpl.gl_doc_id, rpl.replenishment_date);
        }
        if (!glDocNo) glDocNo = rpl.replenishment_no;

        // 6. Group vouchers by expense_gl_account_id → validate all have a GL account
        const expenseGroups = {};
        let totalAmount = 0;
        for (const v of vouchers) {
            if (!v.expense_gl_account_id) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    error: `ใบสำคัญ ${v.voucher_no} ยังไม่ได้ระบุรหัสบัญชีค่าใช้จ่าย`
                });
            }
            const key = v.expense_gl_account_id;
            if (!expenseGroups[key]) {
                expenseGroups[key] = {
                    gl_account_id: v.expense_gl_account_id,
                    account_name:  v.gl_account_name || 'ค่าใช้จ่าย',
                    amount: 0,
                };
            }
            expenseGroups[key].amount += parseFloat(v.amount || 0);
            totalAmount += parseFloat(v.amount || 0);
        }

        // 7. Resolve user id
        const userRes = await client.query(
            `SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
        const createdByUserId = userRes.rows[0]?.id || null;

        // 8. Get currency id for THB
        const currRes = await client.query(
            `SELECT id FROM cd_currency WHERE currency_code = 'THB' LIMIT 1`);
        const currencyId = currRes.rows[0]?.id || null;

        // 9. Insert GL header
        const glHeaderRes = await client.query(`
            INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id,
                 ref_no, description, currency_id, exchange_rate, status,
                 total_debit, total_credit, created_by, created_at, updated_at)
            VALUES ($1,$2,$3,$3,$4,$5,$6,$7,1,'Posted',$8,$8,$9,NOW(),NOW())
            RETURNING id`,
            [
                rpl.gl_doc_id || null,
                glDocNo,
                rpl.replenishment_date,
                periodId,
                rpl.replenishment_no,
                rpl.description || `เบิกจ่ายเงินสดย่อย ${rpl.replenishment_no}`,
                currencyId,
                totalAmount,
                createdByUserId,
            ]);
        const glEntryId = glHeaderRes.rows[0].id;

        // 10. Insert GL lines: DR each expense account group
        let lineNo = 1;
        for (const grp of Object.values(expenseGroups)) {
            await client.query(`
                INSERT INTO gl_entry_line
                    (header_id, line_no, gl_account_id, description,
                     debit_amount_lc, credit_amount_lc, debit_amount_fc, credit_amount_fc,
                     created_by, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,0,$5,0,$6,NOW(),NOW())`,
                [glEntryId, lineNo++, grp.gl_account_id, grp.account_name,
                 grp.amount, createdByUserId]);
        }

        // 11. CR: source bank account
        await client.query(`
            INSERT INTO gl_entry_line
                (header_id, line_no, gl_account_id, description,
                 debit_amount_lc, credit_amount_lc, debit_amount_fc, credit_amount_fc,
                 created_by, created_at, updated_at)
            VALUES ($1,$2,$3,$4,0,$5,0,$5,$6,NOW(),NOW())`,
            [glEntryId, lineNo, srcBankGlAccountId,
             `เบิกจ่ายเงินสดย่อย ${rpl.replenishment_no}`, totalAmount, createdByUserId]);

        // 12. Update replenishment: status=Posted, gl_entry_id, gl_doc_no, total_amount
        await client.query(`
            UPDATE cm_petty_cash_replenishment
            SET status       = 'Posted',
                gl_entry_id  = $1,
                gl_doc_no    = $2,
                total_amount = $3,
                updated_at   = NOW()
            WHERE id = $4`,
            [glEntryId, glDocNo, totalAmount, id]);

        // 13. Mark vouchers as Replenished, link to this replenishment
        const voucherIds = vouchers.map(v => v.id);
        await client.query(`
            UPDATE cm_petty_cash_voucher
            SET status           = 'Replenished',
                replenishment_id = $1,
                updated_at       = NOW()
            WHERE id = ANY($2::int[])`,
            [id, voucherIds]);

        await client.query('COMMIT');
        res.json({ message: 'บันทึก GL สำเร็จ', gl_entry_id: glEntryId, gl_doc_no: glDocNo, total_amount: totalAmount });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const voidRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureRplTable(client);
        const result = await client.query(`
            UPDATE cm_petty_cash_replenishment
            SET status     = 'Voided',
                updated_at = NOW()
            WHERE id = $1 AND status = 'Draft'
            RETURNING *`, [id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถ Void ได้ หรือสถานะไม่ใช่ Draft' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

module.exports = {
    fetchRows, fetchRow, fetchPendingVouchers, fetchReplenishedVouchers,
    createRow, updateRow, postReplenishment, voidRow, ensureRplTable,
};
