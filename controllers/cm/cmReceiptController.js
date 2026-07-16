// controllers/cm/cmReceiptController.js
'use strict';

const ensureCmReceiptTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_receipt (
            id                  SERIAL PRIMARY KEY,
            receipt_date        DATE          NOT NULL,
            bank_account_id     INTEGER       REFERENCES cm_bank_account(id),
            payment_method_id   INTEGER,
            payment_method_type VARCHAR(30)   NOT NULL DEFAULT 'CASH',
            ar_transaction_id   INTEGER,
            ar_doc_no           VARCHAR(50),
            customer_id         INTEGER,
            customer_code       VARCHAR(50),
            customer_name_th    VARCHAR(200),
            amount_lc           NUMERIC(18,4) NOT NULL DEFAULT 0,
            amount_fc           NUMERIC(18,4) NOT NULL DEFAULT 0,
            currency_code       VARCHAR(10)   NOT NULL DEFAULT 'THB',
            exchange_rate       NUMERIC(15,6) NOT NULL DEFAULT 1,
            check_no            VARCHAR(50),
            check_date          DATE,
            drawer_bank         VARCHAR(200),
            status              VARCHAR(20)   NOT NULL DEFAULT 'Pending',
            clearing_date       DATE,
            clearing_note       TEXT,
            gl_entry_id         INTEGER,
            created_by          INTEGER,
            created_at          TIMESTAMP DEFAULT NOW(),
            updated_at          TIMESTAMP DEFAULT NOW()
        )
    `);
};

const BASE_SELECT = `
    SELECT r.*,
           ba.account_code     AS bank_account_code,
           ba.account_name_th  AS bank_account_name,
           cb.bank_name_thai    AS bank_name,
           cb.short_name       AS bank_short_name,
           pm.method_code      AS payment_method_code,
           pm.method_name_th   AS payment_method_name
    FROM cm_receipt r
    LEFT JOIN cm_bank_account   ba ON ba.id = r.bank_account_id
    LEFT JOIN cd_bank           cb ON cb.id = ba.bank_id
    LEFT JOIN cm_payment_method pm ON pm.id = r.payment_method_id
`;

// GET list — filters: bank_account_id, status, date_from, date_to, payment_method_type
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureCmReceiptTable(client);
        const { bank_account_id, status, date_from, date_to, payment_method_type } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (bank_account_id)              { where += ` AND r.bank_account_id = $${pi++}`;      params.push(bank_account_id); }
        if (status && status !== 'All')   { where += ` AND r.status = $${pi++}`;               params.push(status); }
        if (date_from)                    { where += ` AND r.receipt_date >= $${pi++}`;        params.push(date_from); }
        if (date_to)                      { where += ` AND r.receipt_date <= $${pi++}`;        params.push(date_to); }
        if (payment_method_type)          { where += ` AND r.payment_method_type = $${pi++}`;  params.push(payment_method_type); }
        const result = await client.query(
            `${BASE_SELECT} ${where} ORDER BY r.receipt_date DESC, r.id DESC`, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// GET one
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureCmReceiptTable(client);
        const result = await client.query(`${BASE_SELECT} WHERE r.id = $1`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT /clear
const clearReceipt = async (req, res) => {
    const { id } = req.params;
    const { clearing_date, clearing_note } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureCmReceiptTable(client);
        const result = await client.query(`
            UPDATE cm_receipt
            SET status = 'Cleared',
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

// PUT /bounce — เช็คคืน
const bounceReceipt = async (req, res) => {
    const { id } = req.params;
    const { clearing_note } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureCmReceiptTable(client);
        const result = await client.query(`
            UPDATE cm_receipt
            SET status        = 'Bounced',
                clearing_date = NOW()::DATE,
                clearing_note = $1,
                updated_at    = NOW()
            WHERE id = $2 AND status = 'Pending'
            RETURNING *`,
            [clearing_note || null, id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถบันทึกเช็คคืนได้ หรือสถานะไม่ใช่ Pending' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT /void
const voidReceipt = async (req, res) => {
    const { id } = req.params;
    const { clearing_note } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureCmReceiptTable(client);
        const result = await client.query(`
            UPDATE cm_receipt
            SET status        = 'Voided',
                clearing_note = $1,
                updated_at    = NOW()
            WHERE id = $2 AND status != 'Voided'
            RETURNING *`,
            [clearing_note || null, id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถ Void ได้' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

module.exports = { fetchRows, fetchRow, clearReceipt, bounceReceipt, voidReceipt, ensureCmReceiptTable };
