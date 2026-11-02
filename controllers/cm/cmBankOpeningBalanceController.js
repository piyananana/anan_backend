// controllers/cm/cmBankOpeningBalanceController.js
'use strict';
const { getBaseCurrencyCode } = require('../../utils/baseCurrency');

const ensureTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_bank_opening_balance (
            id              SERIAL PRIMARY KEY,
            bank_account_id INT UNIQUE NOT NULL REFERENCES cm_bank_account(id),
            as_of_date      DATE NOT NULL,
            opening_balance NUMERIC(18,4) NOT NULL DEFAULT 0,
            notes           TEXT,
            created_by      VARCHAR(100),
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    // opening_balance = ยอดสกุลเงินหลัก (ทุกรายงานยอดธนาคารใช้), opening_balance_fc = ยอดสกุลเงินของบัญชี —
    // การปรับมูลค่าอัตราแลกเปลี่ยนของบัญชีเงินตราต่างประเทศเริ่มจากยอดนี้ (บัญชีสกุลเงินหลักเท่ากันเสมอ)
    await client.query(`ALTER TABLE cm_bank_opening_balance ADD COLUMN IF NOT EXISTS opening_balance_fc NUMERIC(18,4)`);
};

const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            SELECT ob.*,
                   ba.account_code AS bank_account_code,
                   ba.account_name_th AS bank_account_name,
                   ba.currency_code,
                   cb.short_name AS bank_short_name
            FROM cm_bank_opening_balance ob
            LEFT JOIN cm_bank_account ba ON ba.id = ob.bank_account_id
            LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
            ORDER BY ba.account_code`);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const upsertRow = async (req, res) => {
    const { bank_account_id, as_of_date, opening_balance, opening_balance_fc, notes } = req.body;
    if (!bank_account_id || !as_of_date) {
        return res.status(400).json({ error: 'ต้องระบุ bank_account_id และ as_of_date' });
    }
    const createdBy = req.headers.username || 'system';
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const acc = (await client.query(`SELECT currency_code FROM cm_bank_account WHERE id = $1`, [bank_account_id])).rows[0];
        const isBase = !acc?.currency_code || acc.currency_code === await getBaseCurrencyCode(client);
        const lc = Number(opening_balance) || 0;
        const fc = isBase ? lc : Number(opening_balance_fc);
        if (!isBase && !Number.isFinite(fc)) {
            return res.status(400).json({ error: `กรุณาระบุยอดยกมาเป็นสกุลเงินของบัญชี (${acc.currency_code})` });
        }
        const r = await client.query(`
            INSERT INTO cm_bank_opening_balance
                (bank_account_id, as_of_date, opening_balance, opening_balance_fc, notes, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (bank_account_id) DO UPDATE SET
                as_of_date         = EXCLUDED.as_of_date,
                opening_balance    = EXCLUDED.opening_balance,
                opening_balance_fc = EXCLUDED.opening_balance_fc,
                notes              = EXCLUDED.notes,
                updated_at         = NOW()
            RETURNING *`,
            [bank_account_id, as_of_date, lc, fc, notes || null, createdBy]);
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(
            `DELETE FROM cm_bank_opening_balance WHERE bank_account_id=$1 RETURNING id`,
            [req.params.bank_account_id]);
        if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { fetchRows, upsertRow, deleteRow, ensureTable };
