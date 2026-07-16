// controllers/cm/cmPettyCashVoucherController.js
'use strict';

const ensurePcvTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_petty_cash_voucher (
            id                    SERIAL PRIMARY KEY,
            voucher_no            VARCHAR(50)   NOT NULL,
            voucher_date          DATE          NOT NULL,
            petty_cash_account_id INTEGER       REFERENCES cm_bank_account(id),
            payee_name            VARCHAR(200),
            description           TEXT,
            expense_gl_account_id INTEGER,
            amount                NUMERIC(18,4) NOT NULL DEFAULT 0,
            status                VARCHAR(20)   NOT NULL DEFAULT 'Draft',
            replenishment_id      INTEGER,
            created_by            INTEGER,
            created_at            TIMESTAMP DEFAULT NOW(),
            updated_at            TIMESTAMP DEFAULT NOW()
        )
    `);
};

const generateVoucherNo = async (client, date, pettyCashAccountId) => {
    const d = new Date(date);
    const ym = d.getFullYear().toString() + (d.getMonth() + 1).toString().padStart(2, '0');
    const prefix = `PCV-${ym}-`;
    const res = await client.query(
        `SELECT voucher_no FROM cm_petty_cash_voucher
         WHERE petty_cash_account_id = $1 AND voucher_no LIKE $2
         ORDER BY voucher_no DESC LIMIT 1`,
        [pettyCashAccountId, prefix + '%']);
    let seq = 1;
    if (res.rows.length > 0) {
        const lastSeq = parseInt(res.rows[0].voucher_no.substring(prefix.length), 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    return prefix + seq.toString().padStart(3, '0');
};

const BASE_SELECT = `
    SELECT v.*,
           ba.account_code        AS petty_cash_account_code,
           ba.account_name_th     AS petty_cash_account_name,
           ga.account_code        AS expense_gl_account_code,
           ga.account_name_thai   AS expense_gl_account_name
    FROM cm_petty_cash_voucher v
    LEFT JOIN cm_bank_account ba ON ba.id = v.petty_cash_account_id
    LEFT JOIN gl_account       ga ON ga.id = v.expense_gl_account_id
`;

const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensurePcvTable(client);
        const { petty_cash_account_id, status, date_from, date_to } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (petty_cash_account_id)        { where += ` AND v.petty_cash_account_id = $${pi++}`; params.push(petty_cash_account_id); }
        if (status && status !== 'All')   { where += ` AND v.status = $${pi++}`;                params.push(status); }
        if (date_from)                    { where += ` AND v.voucher_date >= $${pi++}`;         params.push(date_from); }
        if (date_to)                      { where += ` AND v.voucher_date <= $${pi++}`;         params.push(date_to); }
        const result = await client.query(
            `${BASE_SELECT} ${where} ORDER BY v.voucher_date DESC, v.id DESC`, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensurePcvTable(client);
        const result = await client.query(`${BASE_SELECT} WHERE v.id = $1`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
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
        await ensurePcvTable(client);
        const voucher_no = await generateVoucherNo(client, body.voucher_date, body.petty_cash_account_id);
        const userRes = await client.query(
            `SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
        const createdByUserId = userRes.rows[0]?.id || null;
        const result = await client.query(`
            INSERT INTO cm_petty_cash_voucher
                (voucher_no, voucher_date, petty_cash_account_id, payee_name,
                 description, expense_gl_account_id, amount, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            RETURNING *`,
            [
                voucher_no,
                body.voucher_date,
                body.petty_cash_account_id || null,
                body.payee_name           || null,
                body.description          || null,
                body.expense_gl_account_id || null,
                body.amount || 0,
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
        await ensurePcvTable(client);
        const result = await client.query(`
            UPDATE cm_petty_cash_voucher
            SET voucher_date          = $1,
                payee_name            = $2,
                description           = $3,
                expense_gl_account_id = $4,
                amount                = $5,
                updated_at            = NOW()
            WHERE id = $6 AND status = 'Draft'
            RETURNING *`,
            [
                body.voucher_date,
                body.payee_name            || null,
                body.description           || null,
                body.expense_gl_account_id || null,
                body.amount || 0,
                id,
            ]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถแก้ไขได้ หรือสถานะไม่ใช่ Draft' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const approveRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensurePcvTable(client);
        const result = await client.query(`
            UPDATE cm_petty_cash_voucher
            SET status     = 'Approved',
                updated_at = NOW()
            WHERE id = $1 AND status = 'Draft'
            RETURNING *`, [id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถอนุมัติได้ หรือสถานะไม่ใช่ Draft' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const voidRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensurePcvTable(client);
        const result = await client.query(`
            UPDATE cm_petty_cash_voucher
            SET status     = 'Voided',
                updated_at = NOW()
            WHERE id = $1 AND status IN ('Draft', 'Approved')
            RETURNING *`, [id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถ Void ได้' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensurePcvTable(client);
        const result = await client.query(
            `DELETE FROM cm_petty_cash_voucher WHERE id = $1 AND status = 'Draft' RETURNING id`, [id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ลบได้เฉพาะ Draft เท่านั้น' });
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

module.exports = { fetchRows, fetchRow, createRow, updateRow, approveRow, voidRow, deleteRow, ensurePcvTable };
