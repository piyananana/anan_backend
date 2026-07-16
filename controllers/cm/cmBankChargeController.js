// controllers/cm/cmBankChargeController.js
'use strict';
const { checkCmPeriodOpen } = require('./cmPeriodCheckHelper');

const ensureTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_bank_charge (
            id               SERIAL PRIMARY KEY,
            bank_account_id  INTEGER      NOT NULL REFERENCES cm_bank_account(id),
            charge_date      DATE         NOT NULL,
            charge_type      VARCHAR(30)  NOT NULL DEFAULT 'BANK_CHARGE',
            amount           NUMERIC(18,4) NOT NULL,
            currency_code    VARCHAR(3)   NOT NULL DEFAULT 'THB',
            description      TEXT,
            gl_account_id    INTEGER,
            gl_doc_type_id   INTEGER,
            reference_no     VARCHAR(100),
            status           VARCHAR(20)  NOT NULL DEFAULT 'Draft',
            gl_entry_id      INTEGER,
            gl_doc_no        VARCHAR(50),
            created_by       VARCHAR(100),
            created_at       TIMESTAMPTZ  DEFAULT NOW(),
            updated_at       TIMESTAMPTZ  DEFAULT NOW()
        )
    `);
};

const fetchRows = async (req, res) => {
    const { bank_account_id, date_from, date_to, status } = req.query;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const params = [];
        const wheres = [];
        if (bank_account_id) { params.push(bank_account_id); wheres.push(`c.bank_account_id=$${params.length}`); }
        if (date_from)       { params.push(date_from);       wheres.push(`c.charge_date>=$${params.length}`); }
        if (date_to)         { params.push(date_to);         wheres.push(`c.charge_date<=$${params.length}`); }
        if (status && status !== 'All') { params.push(status); wheres.push(`c.status=$${params.length}`); }
        const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const r = await client.query(`
            SELECT c.*,
                   ba.account_code    AS bank_account_code,
                   ba.account_name_th AS bank_account_name,
                   cb.short_name      AS bank_short_name,
                   ga.account_code    AS gl_account_code,
                   ga.account_name_th AS gl_account_name
            FROM cm_bank_charge c
            LEFT JOIN cm_bank_account ba ON ba.id = c.bank_account_id
            LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
            LEFT JOIN gl_account      ga ON ga.id = c.gl_account_id
            ${where}
            ORDER BY c.charge_date DESC, c.id DESC`, params);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const createRow = async (req, res) => {
    const { bank_account_id, charge_date, charge_type, amount, currency_code,
            description, gl_account_id, gl_doc_type_id, reference_no } = req.body;
    if (!bank_account_id || !charge_date || !amount)
        return res.status(400).json({ error: 'ต้องระบุ bank_account_id, charge_date, amount' });
    const createdBy = req.headers.username || 'system';
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);

        // Period check
        const pc = await checkCmPeriodOpen(client, charge_date);
        if (!pc.allowed) return res.status(400).json({ error: pc.message });

        const r = await client.query(`
            INSERT INTO cm_bank_charge
                (bank_account_id, charge_date, charge_type, amount, currency_code,
                 description, gl_account_id, gl_doc_type_id, reference_no, status, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Draft',$10)
            RETURNING *`,
            [bank_account_id, charge_date, charge_type || 'BANK_CHARGE',
             amount, currency_code || 'THB', description || null,
             gl_account_id || null, gl_doc_type_id || null,
             reference_no || null, createdBy]);
        res.status(201).json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const { charge_date, charge_type, amount, currency_code,
            description, gl_account_id, gl_doc_type_id, reference_no } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        if (charge_date) {
            const pc = await checkCmPeriodOpen(client, charge_date);
            if (!pc.allowed) return res.status(400).json({ error: pc.message });
        }
        const r = await client.query(`
            UPDATE cm_bank_charge SET
                charge_date    = COALESCE($1, charge_date),
                charge_type    = COALESCE($2, charge_type),
                amount         = COALESCE($3, amount),
                currency_code  = COALESCE($4, currency_code),
                description    = COALESCE($5, description),
                gl_account_id  = $6,
                gl_doc_type_id = $7,
                reference_no   = COALESCE($8, reference_no),
                updated_at     = NOW()
            WHERE id=$9 AND status='Draft' RETURNING *`,
            [charge_date || null, charge_type || null, amount || null,
             currency_code || null, description || null,
             gl_account_id || null, gl_doc_type_id || null,
             reference_no || null, id]);
        if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล หรือสถานะไม่ใช่ Draft' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const postCharge = async (req, res) => {
    const { id } = req.params;
    const userId   = req.headers.userid;
    const userName = req.headers.username || 'system';
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        await client.query('BEGIN');

        // Load charge
        const chRes = await client.query(`
            SELECT c.*, ba.gl_account_id AS bank_gl_account_id,
                   ba.account_code AS bank_code,
                   ba.account_name_th AS bank_name
            FROM cm_bank_charge c
            JOIN cm_bank_account ba ON ba.id = c.bank_account_id
            WHERE c.id=$1 AND c.status='Draft'`, [id]);
        if (!chRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ไม่พบรายการ หรือสถานะไม่ใช่ Draft' });
        }
        const ch = chRes.rows[0];

        // Period check
        const pc = await checkCmPeriodOpen(client, ch.charge_date);
        if (!pc.allowed) { await client.query('ROLLBACK'); return res.status(400).json({ error: pc.message }); }

        if (!ch.gl_account_id || !ch.bank_gl_account_id)
            { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ต้องตั้งค่า GL Account ก่อน Post' }); }

        // Get period
        const pRes = await client.query(`
            SELECT p.id FROM gl_posting_period p
            JOIN gl_fiscal_year fy ON fy.id=p.fiscal_year_id
            WHERE fy.is_active=true
              AND p.period_start_date::date<=$1::date
              AND p.period_end_date::date>=$1::date LIMIT 1`, [ch.charge_date]);
        const periodId = pRes.rows.length ? pRes.rows[0].id : null;

        // Determine GL doc number
        const docTypeId = ch.gl_doc_type_id;
        let docNo = `CHG-${ch.id}`;
        if (docTypeId) {
            const dnRes = await client.query(
                `SELECT next_doc_no FROM sa_module_document WHERE id=$1 FOR UPDATE`, [docTypeId]);
            if (dnRes.rows.length) {
                docNo = dnRes.rows[0].next_doc_no || docNo;
                await client.query(`UPDATE sa_module_document SET next_doc_no=next_doc_no WHERE id=$1`, [docTypeId]);
            }
        }

        // Insert GL header
        const hRes = await client.query(`
            INSERT INTO gl_entry_header
                (doc_no, doc_date, period_id, description, status, created_by, updated_at)
            VALUES ($1,$2,$3,$4,'Posted',$5,NOW()) RETURNING id`,
            [docNo, ch.charge_date, periodId,
             ch.description || `ค่าธรรมเนียม/ดอกเบี้ย ${ch.charge_type}`, userName]);
        const glId = hRes.rows[0].id;

        const isIncome = ch.charge_type === 'INTEREST_INCOME';
        // For BANK_CHARGE / INTEREST_EXPENSE: Dr expense/charge account, Cr bank
        // For INTEREST_INCOME: Dr bank, Cr income account
        const debitAccId  = isIncome ? ch.bank_gl_account_id : ch.gl_account_id;
        const creditAccId = isIncome ? ch.gl_account_id       : ch.bank_gl_account_id;
        const amt = parseFloat(ch.amount);

        await client.query(`
            INSERT INTO gl_entry_line (header_id, line_no, account_id, description, debit_amount_lc, credit_amount_lc)
            VALUES ($1,1,$2,$3,$4,0), ($1,2,$5,$3,0,$4)`,
            [glId, debitAccId, ch.description || ch.charge_type, amt, creditAccId]);

        // Update charge status
        await client.query(`
            UPDATE cm_bank_charge SET status='Posted', gl_entry_id=$1, gl_doc_no=$2, updated_at=NOW()
            WHERE id=$3`, [glId, docNo, id]);

        await client.query('COMMIT');

        const updated = await client.query(`
            SELECT c.*, ba.account_code AS bank_account_code, ba.account_name_th AS bank_account_name
            FROM cm_bank_charge c JOIN cm_bank_account ba ON ba.id=c.bank_account_id WHERE c.id=$1`, [id]);
        res.json(updated.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const voidCharge = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            UPDATE cm_bank_charge SET status='Voided', updated_at=NOW()
            WHERE id=$1 AND status='Draft' RETURNING *`, [id]);
        if (!r.rows.length) return res.status(400).json({ error: 'ไม่พบรายการ หรือสถานะไม่ใช่ Draft' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const r = await client.query(
            `DELETE FROM cm_bank_charge WHERE id=$1 AND status='Draft' RETURNING id`, [req.params.id]);
        if (!r.rows.length) return res.status(400).json({ error: 'ลบได้เฉพาะ Draft เท่านั้น' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { fetchRows, createRow, updateRow, postCharge, voidCharge, deleteRow };
