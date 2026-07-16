// controllers/cm/cmPostDatedCheckController.js
'use strict';
const { checkCmPeriodOpen } = require('./cmPeriodCheckHelper');

const ensureTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_post_dated_check (
            id                   SERIAL PRIMARY KEY,
            direction            VARCHAR(10)  NOT NULL CHECK (direction IN ('RECEIVED','ISSUED')),
            check_no             VARCHAR(50)  NOT NULL,
            check_date           DATE         NOT NULL,
            bank_id              INTEGER      REFERENCES cm_bank(id),
            payee_payer_name     VARCHAR(200),
            amount               NUMERIC(18,4) NOT NULL DEFAULT 0,
            currency_code        VARCHAR(3)   NOT NULL DEFAULT 'THB',
            our_bank_account_id  INTEGER      REFERENCES cm_bank_account(id),
            linked_receipt_id    INTEGER      REFERENCES cm_receipt(id),
            linked_payment_id    INTEGER,
            status               VARCHAR(20)  NOT NULL DEFAULT 'Holding',
            deposit_date         DATE,
            cleared_date         DATE,
            returned_date        DATE,
            cancelled_date       DATE,
            replacement_check_no VARCHAR(50),
            notes                TEXT,
            created_by           VARCHAR(100),
            created_at           TIMESTAMPTZ  DEFAULT NOW(),
            updated_at           TIMESTAMPTZ  DEFAULT NOW()
        )
    `);
};

const fetchRows = async (req, res) => {
    const { direction, status, bank_account_id, date_from, date_to } = req.query;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const params = [];
        const wheres = [];
        if (direction)        { params.push(direction);        wheres.push(`p.direction=$${params.length}`); }
        if (status && status !== 'All') { params.push(status); wheres.push(`p.status=$${params.length}`); }
        if (bank_account_id)  { params.push(bank_account_id);  wheres.push(`p.our_bank_account_id=$${params.length}`); }
        if (date_from)        { params.push(date_from);        wheres.push(`p.check_date>=$${params.length}`); }
        if (date_to)          { params.push(date_to);          wheres.push(`p.check_date<=$${params.length}`); }

        const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const r = await client.query(`
            SELECT p.*,
                   b.bank_name_thai       AS bank_name,
                   b.short_name          AS bank_short_name,
                   ba.account_code       AS our_account_code,
                   ba.account_name_th    AS our_account_name,
                   cb.short_name         AS our_bank_name
            FROM cm_post_dated_check p
            LEFT JOIN cd_bank         b  ON b.id  = p.bank_id
            LEFT JOIN cm_bank_account ba ON ba.id = p.our_bank_account_id
            LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
            ${where}
            ORDER BY p.check_date, p.id`, params);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const createRow = async (req, res) => {
    const { direction, check_no, check_date, bank_id, payee_payer_name,
            amount, currency_code, our_bank_account_id, linked_receipt_id,
            linked_payment_id, notes } = req.body;
    if (!direction || !check_no || !check_date || !amount)
        return res.status(400).json({ error: 'ต้องระบุ direction, check_no, check_date, amount' });

    const createdBy = req.headers.username || 'system';
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);

        // Period check
        const pc = await checkCmPeriodOpen(client, check_date);
        if (!pc.allowed) return res.status(400).json({ error: pc.message });

        const r = await client.query(`
            INSERT INTO cm_post_dated_check
                (direction, check_no, check_date, bank_id, payee_payer_name,
                 amount, currency_code, our_bank_account_id, linked_receipt_id,
                 linked_payment_id, status, notes, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Holding',$11,$12)
            RETURNING *`,
            [direction, check_no, check_date, bank_id || null, payee_payer_name || null,
             amount, currency_code || 'THB', our_bank_account_id || null,
             linked_receipt_id || null, linked_payment_id || null, notes || null, createdBy]);
        res.status(201).json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const { bank_id, payee_payer_name, amount, currency_code,
            our_bank_account_id, notes } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            UPDATE cm_post_dated_check SET
                bank_id             = COALESCE($1, bank_id),
                payee_payer_name    = COALESCE($2, payee_payer_name),
                amount              = COALESCE($3, amount),
                currency_code       = COALESCE($4, currency_code),
                our_bank_account_id = COALESCE($5, our_bank_account_id),
                notes               = $6,
                updated_at          = NOW()
            WHERE id=$7 AND status='Holding' RETURNING *`,
            [bank_id || null, payee_payer_name || null, amount || null,
             currency_code || null, our_bank_account_id || null,
             notes || null, id]);
        if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล หรือสถานะไม่ใช่ Holding' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT /:id/present  — Mark as Deposited/Presented
const presentCheck = async (req, res) => {
    const { id } = req.params;
    const { deposit_date } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            UPDATE cm_post_dated_check SET
                status       = 'Deposited',
                deposit_date = COALESCE($1, NOW()::date),
                updated_at   = NOW()
            WHERE id=$2 AND status='Holding' RETURNING *`,
            [deposit_date || null, id]);
        if (!r.rows.length) return res.status(400).json({ error: 'ไม่พบรายการ หรือสถานะไม่ใช่ Holding' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT /:id/clear  — Mark as Cleared (bank confirmed)
const clearCheck = async (req, res) => {
    const { id } = req.params;
    const { cleared_date } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            UPDATE cm_post_dated_check SET
                status       = 'Cleared',
                cleared_date = COALESCE($1, NOW()::date),
                updated_at   = NOW()
            WHERE id=$2 AND status IN ('Holding','Deposited') RETURNING *`,
            [cleared_date || null, id]);
        if (!r.rows.length) return res.status(400).json({ error: 'ไม่พบรายการ หรือสถานะไม่ถูกต้อง' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT /:id/return  — Mark as Returned (bounced)
const returnCheck = async (req, res) => {
    const { id } = req.params;
    const { returned_date, notes } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            UPDATE cm_post_dated_check SET
                status        = 'Returned',
                returned_date = COALESCE($1, NOW()::date),
                notes         = COALESCE($2, notes),
                updated_at    = NOW()
            WHERE id=$3 AND status IN ('Holding','Deposited') RETURNING *`,
            [returned_date || null, notes || null, id]);
        if (!r.rows.length) return res.status(400).json({ error: 'ไม่พบรายการ หรือสถานะไม่ถูกต้อง' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT /:id/cancel  — Cancel the check
const cancelCheck = async (req, res) => {
    const { id } = req.params;
    const { notes } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            UPDATE cm_post_dated_check SET
                status          = 'Cancelled',
                cancelled_date  = NOW()::date,
                notes           = COALESCE($1, notes),
                updated_at      = NOW()
            WHERE id=$2 AND status NOT IN ('Cleared','Cancelled') RETURNING *`,
            [notes || null, id]);
        if (!r.rows.length) return res.status(400).json({ error: 'ไม่พบรายการ หรือไม่สามารถยกเลิกได้' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const r = await client.query(
            `DELETE FROM cm_post_dated_check WHERE id=$1 AND status='Holding' RETURNING id`,
            [req.params.id]);
        if (!r.rows.length) return res.status(400).json({ error: 'ลบได้เฉพาะ Holding เท่านั้น' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// GET summary counts
const getSummary = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            SELECT direction, status, COUNT(*) AS count, SUM(amount) AS total_amount
            FROM cm_post_dated_check
            GROUP BY direction, status
            ORDER BY direction, status`);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { fetchRows, createRow, updateRow, presentCheck, clearCheck, returnCheck, cancelCheck, deleteRow, getSummary };
