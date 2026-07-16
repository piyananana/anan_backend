// controllers/cm/cmPaymentController.js
'use strict';

const ensureCmPaymentTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_payment (
            id                  SERIAL PRIMARY KEY,
            payment_date        DATE          NOT NULL,
            bank_account_id     INTEGER       REFERENCES cm_bank_account(id),
            payment_method_id   INTEGER,
            payment_method_type VARCHAR(30)   NOT NULL DEFAULT 'TRANSFER',
            ap_payment_run_id   INTEGER,
            ap_doc_no           VARCHAR(50),
            payee_type          VARCHAR(10)   DEFAULT 'VENDOR',
            payee_id            INTEGER,
            payee_code          VARCHAR(50),
            payee_name_th       VARCHAR(200),
            amount_lc           NUMERIC(18,4) NOT NULL DEFAULT 0,
            amount_fc           NUMERIC(18,4) NOT NULL DEFAULT 0,
            currency_code       VARCHAR(10)   NOT NULL DEFAULT 'THB',
            exchange_rate       NUMERIC(15,6) NOT NULL DEFAULT 1,
            check_no            VARCHAR(50),
            check_date          DATE,
            checkbook_id        INTEGER       REFERENCES cm_checkbook(id),
            status              VARCHAR(20)   NOT NULL DEFAULT 'Pending',
            clearing_date       DATE,
            clearing_note       TEXT,
            gl_entry_id         INTEGER,
            remark              TEXT,
            created_by          INTEGER,
            created_at          TIMESTAMP DEFAULT NOW(),
            updated_at          TIMESTAMP DEFAULT NOW()
        )
    `);
};

const BASE_SELECT = `
    SELECT p.*,
           ba.account_code     AS bank_account_code,
           ba.account_name_th  AS bank_account_name,
           cb.bank_name_thai    AS bank_name,
           cb.short_name       AS bank_short_name,
           pm.method_code      AS payment_method_code,
           pm.method_name_th   AS payment_method_name,
           ck.checkbook_code   AS checkbook_code
    FROM cm_payment p
    LEFT JOIN cm_bank_account   ba ON ba.id = p.bank_account_id
    LEFT JOIN cd_bank           cb ON cb.id = ba.bank_id
    LEFT JOIN cm_payment_method pm ON pm.id = p.payment_method_id
    LEFT JOIN cm_checkbook      ck ON ck.id = p.checkbook_id
`;

// GET list
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureCmPaymentTable(client);
        const { bank_account_id, status, date_from, date_to, payment_method_type } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (bank_account_id)             { where += ` AND p.bank_account_id = $${pi++}`;      params.push(bank_account_id); }
        if (status && status !== 'All')  { where += ` AND p.status = $${pi++}`;               params.push(status); }
        if (date_from)                   { where += ` AND p.payment_date >= $${pi++}`;        params.push(date_from); }
        if (date_to)                     { where += ` AND p.payment_date <= $${pi++}`;        params.push(date_to); }
        if (payment_method_type)         { where += ` AND p.payment_method_type = $${pi++}`;  params.push(payment_method_type); }
        const result = await client.query(
            `${BASE_SELECT} ${where} ORDER BY p.payment_date DESC, p.id DESC`, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// GET one
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureCmPaymentTable(client);
        const result = await client.query(`${BASE_SELECT} WHERE p.id = $1`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// POST — create manual payment (check issuance or transfer)
const createPayment = async (req, res) => {
    const body = req.body;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureCmPaymentTable(client);

        let checkNo = body.check_no || null;

        // If linked to a checkbook, auto-assign check_no and advance next_check_no
        if (body.checkbook_id) {
            const cbRes = await client.query(
                `SELECT next_check_no, end_check_no FROM cm_checkbook WHERE id = $1 AND status = 'Active'`,
                [body.checkbook_id]);
            if (cbRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'ไม่พบสมุดเช็คหรือสถานะไม่ใช่ Active' });
            }
            const { next_check_no, end_check_no } = cbRes.rows[0];
            if (!checkNo) checkNo = next_check_no;

            // Advance next_check_no numerically (pad to same width)
            const nextNum = parseInt(next_check_no, 10);
            if (!isNaN(nextNum)) {
                const padLen = next_check_no.length;
                const newNext = (nextNum + 1).toString().padStart(padLen, '0');
                await client.query(
                    `UPDATE cm_checkbook SET next_check_no = $1, updated_at = NOW() WHERE id = $2`,
                    [newNext, body.checkbook_id]);

                // Mark as Used if next exceeds end
                if (parseInt(newNext, 10) > parseInt(end_check_no, 10)) {
                    await client.query(
                        `UPDATE cm_checkbook SET status = 'Used', updated_at = NOW() WHERE id = $1`,
                        [body.checkbook_id]);
                }
            }
        }

        const result = await client.query(`
            INSERT INTO cm_payment
                (payment_date, bank_account_id, payment_method_id, payment_method_type,
                 payee_type, payee_id, payee_code, payee_name_th,
                 amount_lc, amount_fc, currency_code, exchange_rate,
                 check_no, check_date, checkbook_id, remark, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            RETURNING *`,
            [
                body.payment_date,
                body.bank_account_id   || null,
                body.payment_method_id || null,
                body.payment_method_type || 'TRANSFER',
                body.payee_type   || 'VENDOR',
                body.payee_id     || null,
                body.payee_code   || null,
                body.payee_name_th || null,
                body.amount_lc    || 0,
                body.amount_fc    || 0,
                body.currency_code || 'THB',
                body.exchange_rate || 1,
                checkNo,
                body.check_date || null,
                body.checkbook_id || null,
                body.remark || null,
                userName,
            ]);

        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT /clear
const clearPayment = async (req, res) => {
    const { id } = req.params;
    const { clearing_date, clearing_note } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureCmPaymentTable(client);
        const result = await client.query(`
            UPDATE cm_payment
            SET status        = 'Cleared',
                clearing_date = $1,
                clearing_note = $2,
                updated_at    = NOW()
            WHERE id = $3 AND status = 'Pending'
            RETURNING *`,
            [clearing_date || new Date().toISOString().substring(0, 10), clearing_note || null, id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถเคลียร์ได้ หรือสถานะไม่ใช่ Pending' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT /void
const voidPayment = async (req, res) => {
    const { id } = req.params;
    const { clearing_note } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureCmPaymentTable(client);
        const result = await client.query(`
            UPDATE cm_payment
            SET status        = 'Voided',
                clearing_note = $1,
                updated_at    = NOW()
            WHERE id = $2 AND status = 'Pending'
            RETURNING *`,
            [clearing_note || null, id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถ Void ได้ หรือสถานะไม่ใช่ Pending' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

module.exports = { fetchRows, fetchRow, createPayment, clearPayment, voidPayment, ensureCmPaymentTable };
