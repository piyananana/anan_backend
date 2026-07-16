// controllers/cm/cmBankStatementImportController.js
'use strict';

// POST: import parsed lines into a new bank statement
// Body: {
//   bank_account_id, statement_date_from, statement_date_to, description,
//   lines: [{ line_date, description, debit, credit, balance }]
// }
const importStatement = async (req, res) => {
    const { bank_account_id, statement_date_from, statement_date_to,
            description, lines } = req.body;

    if (!bank_account_id) return res.status(400).json({ error: 'ต้องระบุ bank_account_id' });
    if (!Array.isArray(lines) || lines.length === 0)
        return res.status(400).json({ error: 'ต้องมีข้อมูล lines อย่างน้อย 1 รายการ' });

    const createdBy = req.headers.username || 'system';
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // Ensure bank_statement tables exist (delegate to the existing controller pattern)
        await client.query(`
            CREATE TABLE IF NOT EXISTS cm_bank_statement (
                id                    SERIAL PRIMARY KEY,
                bank_account_id       INTEGER NOT NULL REFERENCES cm_bank_account(id),
                statement_date_from   DATE NOT NULL,
                statement_date_to     DATE NOT NULL,
                opening_balance       NUMERIC(18,4) NOT NULL DEFAULT 0,
                closing_balance       NUMERIC(18,4) NOT NULL DEFAULT 0,
                description           TEXT,
                status                VARCHAR(20) NOT NULL DEFAULT 'Draft',
                created_by            VARCHAR(100),
                created_at            TIMESTAMPTZ DEFAULT NOW(),
                updated_at            TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS cm_bank_statement_line (
                id              SERIAL PRIMARY KEY,
                statement_id    INTEGER NOT NULL REFERENCES cm_bank_statement(id) ON DELETE CASCADE,
                line_date       DATE    NOT NULL,
                description     TEXT,
                debit_amount    NUMERIC(18,4) NOT NULL DEFAULT 0,
                credit_amount   NUMERIC(18,4) NOT NULL DEFAULT 0,
                balance         NUMERIC(18,4),
                is_reconciled   BOOLEAN NOT NULL DEFAULT FALSE,
                reference_no    VARCHAR(100),
                created_at      TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // Compute date range from lines if not provided
        const lineDates = lines.map(l => l.line_date).filter(Boolean).sort();
        const dateFrom = statement_date_from || (lineDates.length ? lineDates[0]    : new Date().toISOString().substring(0,10));
        const dateTo   = statement_date_to   || (lineDates.length ? lineDates[lineDates.length-1] : dateFrom);

        // Opening balance = balance of first line minus its net movement
        let openingBalance = 0;
        if (lines.length > 0 && lines[0].balance !== undefined && lines[0].balance !== null) {
            const first = lines[0];
            openingBalance = parseFloat(first.balance || 0)
                - parseFloat(first.credit || 0)
                + parseFloat(first.debit  || 0);
        }
        const lastLine = lines[lines.length - 1];
        const closingBalance = lastLine.balance !== undefined && lastLine.balance !== null
            ? parseFloat(lastLine.balance)
            : openingBalance + lines.reduce((s, l) =>
                s + parseFloat(l.credit || 0) - parseFloat(l.debit || 0), 0);

        // Insert statement header
        const stmtRes = await client.query(`
            INSERT INTO cm_bank_statement
                (bank_account_id, statement_date_from, statement_date_to,
                 opening_balance, closing_balance, description, status, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,'Draft',$7) RETURNING id`,
            [bank_account_id, dateFrom, dateTo,
             Math.round(openingBalance * 100) / 100,
             Math.round(closingBalance * 100) / 100,
             description || `Import ${dateFrom} ~ ${dateTo}`, createdBy]);
        const stmtId = stmtRes.rows[0].id;

        // Insert lines
        let imported = 0;
        const errors = [];
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (!l.line_date) { errors.push(`Row ${i+1}: ไม่มีวันที่`); continue; }
            try {
                await client.query(`
                    INSERT INTO cm_bank_statement_line
                        (statement_id, line_date, description, debit_amount, credit_amount, balance, reference_no)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                    [stmtId, l.line_date, l.description || '',
                     parseFloat(l.debit  || 0),
                     parseFloat(l.credit || 0),
                     l.balance !== undefined && l.balance !== null ? parseFloat(l.balance) : null,
                     l.reference_no || null]);
                imported++;
            } catch (err) {
                errors.push(`Row ${i+1}: ${err.message}`);
            }
        }

        await client.query('COMMIT');
        res.json({
            success: true,
            statement_id:   stmtId,
            lines_imported: imported,
            errors,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

module.exports = { importStatement };
