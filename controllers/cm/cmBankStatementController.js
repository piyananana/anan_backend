// controllers/cm/cmBankStatementController.js
'use strict';

const ensureTables = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_bank_statement (
            id                  SERIAL PRIMARY KEY,
            bank_account_id     INTEGER       REFERENCES cm_bank_account(id),
            statement_date_from DATE          NOT NULL,
            statement_date_to   DATE          NOT NULL,
            opening_balance     NUMERIC(18,4) NOT NULL DEFAULT 0,
            closing_balance     NUMERIC(18,4) NOT NULL DEFAULT 0,
            currency_code       VARCHAR(10)   NOT NULL DEFAULT 'THB',
            status              VARCHAR(20)   NOT NULL DEFAULT 'Draft',
            file_name           VARCHAR(200),
            notes               TEXT,
            created_by          INTEGER,
            created_at          TIMESTAMP DEFAULT NOW(),
            updated_at          TIMESTAMP DEFAULT NOW()
        )`);
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_bank_statement_line (
            id                  SERIAL PRIMARY KEY,
            statement_id        INTEGER       NOT NULL REFERENCES cm_bank_statement(id) ON DELETE CASCADE,
            line_date           DATE          NOT NULL,
            description         TEXT,
            withdrawal_amount   NUMERIC(18,4) NOT NULL DEFAULT 0,
            deposit_amount      NUMERIC(18,4) NOT NULL DEFAULT 0,
            balance             NUMERIC(18,4) NOT NULL DEFAULT 0,
            reference           VARCHAR(200),
            is_reconciled       BOOLEAN       NOT NULL DEFAULT FALSE,
            reconcile_date      DATE,
            cm_record_type      VARCHAR(20),
            cm_record_id        INTEGER,
            created_at          TIMESTAMP DEFAULT NOW()
        )`);
};

const BASE_SELECT = `
    SELECT s.*,
           ba.account_code    AS bank_account_code,
           ba.account_name_th AS bank_account_name,
           cb.bank_name_thai   AS bank_name,
           cb.short_name      AS bank_short_name
    FROM cm_bank_statement s
    LEFT JOIN cm_bank_account ba ON ba.id = s.bank_account_id
    LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
`;

// GET list
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const { bank_account_id, status, date_from, date_to } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (bank_account_id)             { where += ` AND s.bank_account_id = $${pi++}`;    params.push(bank_account_id); }
        if (status && status !== 'All')  { where += ` AND s.status = $${pi++}`;             params.push(status); }
        if (date_from)                   { where += ` AND s.statement_date_to >= $${pi++}`; params.push(date_from); }
        if (date_to)                     { where += ` AND s.statement_date_from <= $${pi++}`; params.push(date_to); }
        const result = await client.query(
            `${BASE_SELECT} ${where} ORDER BY s.statement_date_from DESC, s.id DESC`, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// GET one
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const result = await client.query(`${BASE_SELECT} WHERE s.id = $1`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// GET lines for a statement
const fetchLines = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const result = await client.query(
            `SELECT * FROM cm_bank_statement_line WHERE statement_id = $1 ORDER BY line_date, id`,
            [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// POST create statement header
const createRow = async (req, res) => {
    const body = req.body;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTables(client);
        const userRes = await client.query(
            `SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
        const createdBy = userRes.rows[0]?.id || null;
        const result = await client.query(`
            INSERT INTO cm_bank_statement
                (bank_account_id, statement_date_from, statement_date_to,
                 opening_balance, closing_balance, currency_code, file_name, notes, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING *`,
            [
                body.bank_account_id || null,
                body.statement_date_from,
                body.statement_date_to,
                body.opening_balance || 0,
                body.closing_balance || 0,
                body.currency_code  || 'THB',
                body.file_name      || null,
                body.notes          || null,
                createdBy,
            ]);
        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT update header (Draft only)
const updateRow = async (req, res) => {
    const { id } = req.params;
    const body = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const result = await client.query(`
            UPDATE cm_bank_statement
            SET statement_date_from = $1, statement_date_to = $2,
                opening_balance     = $3, closing_balance   = $4,
                notes               = $5, updated_at        = NOW()
            WHERE id = $6 AND status = 'Draft'
            RETURNING *`,
            [
                body.statement_date_from, body.statement_date_to,
                body.opening_balance || 0, body.closing_balance || 0,
                body.notes || null, id,
            ]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถแก้ไขได้ หรือสถานะไม่ใช่ Draft' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT confirm: Draft → Confirmed
const confirmRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const result = await client.query(`
            UPDATE cm_bank_statement SET status = 'Confirmed', updated_at = NOW()
            WHERE id = $1 AND status = 'Draft' RETURNING *`, [id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถยืนยันได้ หรือสถานะไม่ใช่ Draft' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT void
const voidRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const result = await client.query(`
            UPDATE cm_bank_statement SET status = 'Voided', updated_at = NOW()
            WHERE id = $1 AND status != 'Voided' RETURNING *`, [id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถ Void ได้' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// DELETE statement + cascade lines
const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const result = await client.query(
            `DELETE FROM cm_bank_statement WHERE id = $1 AND status = 'Draft' RETURNING id`, [id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ลบได้เฉพาะ Draft เท่านั้น' });
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// POST add one line
const addLine = async (req, res) => {
    const { id } = req.params;
    const body = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        // Only Draft/Confirmed statements can have lines added
        const sRes = await client.query(`SELECT status FROM cm_bank_statement WHERE id = $1`, [id]);
        if (sRes.rows.length === 0) return res.status(404).json({ error: 'Statement not found' });
        if (sRes.rows[0].status === 'Voided')
            return res.status(400).json({ error: 'ไม่สามารถเพิ่มรายการใน Statement ที่ Voided' });
        const result = await client.query(`
            INSERT INTO cm_bank_statement_line
                (statement_id, line_date, description, withdrawal_amount, deposit_amount, balance, reference)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING *`,
            [
                id,
                body.line_date,
                body.description       || null,
                body.withdrawal_amount || 0,
                body.deposit_amount    || 0,
                body.balance           || 0,
                body.reference         || null,
            ]);
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// POST bulk insert lines (CSV import)
const bulkInsertLines = async (req, res) => {
    const { id } = req.params;
    const { lines, file_name } = req.body;
    if (!Array.isArray(lines) || lines.length === 0)
        return res.status(400).json({ error: 'ไม่พบข้อมูลรายการ' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTables(client);
        const sRes = await client.query(
            `SELECT status FROM cm_bank_statement WHERE id = $1 FOR UPDATE`, [id]);
        if (sRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        if (sRes.rows[0].status === 'Voided') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Statement ถูก Void แล้ว' }); }

        // Optionally update file_name on the statement
        if (file_name) {
            await client.query(`UPDATE cm_bank_statement SET file_name = $1, updated_at = NOW() WHERE id = $2`, [file_name, id]);
        }

        let inserted = 0;
        for (const line of lines) {
            await client.query(`
                INSERT INTO cm_bank_statement_line
                    (statement_id, line_date, description, withdrawal_amount, deposit_amount, balance, reference)
                VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [
                    id,
                    line.line_date,
                    line.description       || null,
                    parseFloat(line.withdrawal_amount) || 0,
                    parseFloat(line.deposit_amount)    || 0,
                    parseFloat(line.balance)           || 0,
                    line.reference || null,
                ]);
            inserted++;
        }

        // Update closing_balance from last line if balance provided
        const lastBalance = lines[lines.length - 1]?.balance;
        if (lastBalance !== undefined && lastBalance !== null && parseFloat(lastBalance) !== 0) {
            await client.query(
                `UPDATE cm_bank_statement SET closing_balance = $1, updated_at = NOW() WHERE id = $2`,
                [parseFloat(lastBalance), id]);
        }

        await client.query('COMMIT');
        res.json({ message: `นำเข้าสำเร็จ ${inserted} รายการ`, inserted });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT update one line (statement must be Draft)
const updateLine = async (req, res) => {
    const { lineId } = req.params;
    const body = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const result = await client.query(`
            UPDATE cm_bank_statement_line l
            SET line_date         = $1, description       = $2,
                withdrawal_amount = $3, deposit_amount    = $4,
                balance           = $5, reference         = $6
            FROM cm_bank_statement s
            WHERE l.id = $7 AND l.statement_id = s.id AND s.status = 'Draft'
            RETURNING l.*`,
            [
                body.line_date,
                body.description       || null,
                body.withdrawal_amount || 0,
                body.deposit_amount    || 0,
                body.balance           || 0,
                body.reference         || null,
                lineId,
            ]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถแก้ไขได้ หรือ Statement ไม่ใช่ Draft' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// DELETE one line (statement must be Draft)
const deleteLine = async (req, res) => {
    const { lineId } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const result = await client.query(`
            DELETE FROM cm_bank_statement_line l
            USING cm_bank_statement s
            WHERE l.id = $1 AND l.statement_id = s.id AND s.status = 'Draft'
            RETURNING l.id`, [lineId]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ลบได้เฉพาะ Draft เท่านั้น' });
        res.json({ message: 'Deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = {
    fetchRows, fetchRow, fetchLines,
    createRow, updateRow, confirmRow, voidRow, deleteRow,
    addLine, bulkInsertLines, updateLine, deleteLine,
    ensureTables,
};
