// controllers/cm/cmBankStatementImportController.js
const { today } = require('../../utils/dateUtil');
const { ensureTables } = require('./cmBankStatementController');
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

    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // ตารางเดียวกับหน้าจอ Bank Statement (เดิมไฟล์นี้สร้างตารางเองด้วยชื่อคอลัมน์ที่ไม่ตรงกัน
        // — description/debit_amount/credit_amount/reference_no ไม่มีอยู่จริง นำเข้าจึงไม่สำเร็จ)
        await ensureTables(client);
        const userRes = userName
            ? await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]) : { rows: [] };
        const createdBy = userRes.rows[0]?.id || null;

        // Compute date range from lines if not provided
        const lineDates = lines.map(l => l.line_date).filter(Boolean).sort();
        const dateFrom = statement_date_from || (lineDates.length ? lineDates[0]    : today());
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
                 opening_balance, closing_balance, notes, status, created_by)
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
            await client.query(`
                INSERT INTO cm_bank_statement_line
                    (statement_id, line_date, description, withdrawal_amount, deposit_amount, balance, reference)
                VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [stmtId, l.line_date, l.description || '',
                 parseFloat(l.debit  || 0),
                 parseFloat(l.credit || 0),
                 l.balance !== undefined && l.balance !== null ? parseFloat(l.balance) : 0,
                 l.reference_no || null]);
            imported++;
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
