// controllers/ap/apBulkPaymentController.js
'use strict';
const { checkCmPeriodOpen } = require('../cm/cmPeriodCheckHelper');

// GET eligible AP invoices for bulk payment
// Returns posted ap_transaction rows (Purchase Invoice / Debit Note) with an outstanding balance
const getEligibleInvoices = async (req, res) => {
    const { vendor_search, due_date_to } = req.query;
    const client = await req.dbPool.connect();
    try {
        const params = [];
        const wheres = [`t.status = 'Posted'`, `t.balance_amount_lc > 0.005`, `d.sys_doc_type IN ('10','50')`];
        if (vendor_search) {
            params.push(`%${vendor_search.toUpperCase()}%`);
            const p = params.length;
            wheres.push(`(UPPER(v.vendor_code) LIKE $${p} OR UPPER(v.vendor_name_th) LIKE $${p} OR UPPER(COALESCE(v.vendor_name_en,'')) LIKE $${p})`);
        }
        if (due_date_to) { params.push(due_date_to); wheres.push(`t.due_date <= $${params.length}`); }

        const r = await client.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.due_date, t.status,
                   t.total_amount_lc  AS total_amount,
                   t.paid_amount_lc   AS paid_amount,
                   t.balance_amount_lc AS remaining_amount,
                   t.currency_code, t.exchange_rate,
                   v.id AS vendor_id, v.vendor_code, v.vendor_name_th, v.vendor_name_en
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            JOIN ap_vendor v ON v.id = t.vendor_id
            WHERE ${wheres.join(' AND ')}
            ORDER BY v.vendor_code, t.due_date, t.doc_no`,
            params);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// Build a running GL doc number the same way apPaymentRunController.generateGlDocNo does
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
        `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`, [glDocId]);
    return docNo;
};

// POST run bulk payment — pays multiple ap_transaction rows in one combined GL entry
// Body: { bank_account_id, payment_date, payment_method, items: [{ap_document_id, amount}] }
const runBulkPayment = async (req, res) => {
    const { bank_account_id, payment_date, payment_method, items } = req.body;
    if (!bank_account_id || !payment_date || !items || !items.length) {
        return res.status(400).json({ error: 'bank_account_id, payment_date and items are required' });
    }

    const createdBy = req.headers.username || 'system';
    const client = await req.dbPool.connect();
    try {
        const pc = await checkCmPeriodOpen(client, payment_date);
        if (!pc.allowed) return res.status(400).json({ error: pc.message });

        await client.query('BEGIN');

        // Paying bank account
        const baRes = await client.query(`SELECT * FROM cm_bank_account WHERE id=$1`, [bank_account_id]);
        if (!baRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Bank account not found' });
        }
        const bankAcct = baRes.rows[0];
        if (!bankAcct.gl_account_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Selected bank account has no GL account configured' });
        }

        // GL setup for AP Payment document type (sys_doc_type = '80')
        const setupRes = await client.query(`
            SELECT s.*, d.id AS sys_doc_id
            FROM sa_module_document d
            LEFT JOIN ap_gl_account_setup s ON s.doc_code = d.doc_code
            WHERE d.sys_module = '21' AND d.sys_doc_type = '80' AND d.is_doc_type = true
            LIMIT 1`);
        if (!setupRes.rows.length || !setupRes.rows[0].gl_doc_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'AP GL Account Setup for the Payment document type is not configured' });
        }
        const setup = setupRes.rows[0];

        // Open GL period
        const periodRes = await client.query(`
            SELECT id FROM gl_posting_period
            WHERE $1::date BETWEEN period_start_date AND period_end_date
              AND gl_status = 'OPEN' LIMIT 1`, [payment_date]);
        if (!periodRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `No open GL period found for ${payment_date}` });
        }
        const periodId = periodRes.rows[0].id;

        // Load + validate every selected AP transaction up front
        const docs = [];
        for (const item of items) {
            const apRes = await client.query(`
                SELECT t.*, v.vendor_code AS v_vendor_code, v.vendor_name_th, v.vendor_name_en,
                       v.ap_account_id AS vendor_ap_account_id
                FROM ap_transaction t JOIN ap_vendor v ON v.id = t.vendor_id
                WHERE t.id = $1`, [item.ap_document_id]);
            if (!apRes.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: `AP transaction id=${item.ap_document_id} not found` });
            }
            const payAmt = parseFloat(item.amount || 0);
            if (payAmt <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Payment amount must be greater than zero' });
            }
            const apDoc = apRes.rows[0];
            const apAccountId = apDoc.vendor_ap_account_id || setup.ap_account_id;
            if (!apAccountId) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: `No AP account configured for vendor ${apDoc.v_vendor_code}` });
            }
            docs.push({ doc: apDoc, amount: payAmt, apAccountId });
        }

        const totalAmount = docs.reduce((s, d) => s + d.amount, 0);

        let glDocNo = await generateGlDocNo(client, setup.gl_doc_id, payment_date);
        if (!glDocNo) glDocNo = `BULKPAY-${payment_date}-${Date.now()}`;

        const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name=$1 LIMIT 1`, [createdBy]);
        const createdByUserId = userRes.rows[0]?.id || null;

        // One combined GL entry for the whole batch
        const glHeaderRes = await client.query(`
            INSERT INTO gl_entry_header
              (doc_id, doc_no, doc_date, posting_date, period_id,
               ref_no, description,
               currency_id, exchange_rate, status,
               total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
               created_by)
            VALUES ($1,$2,$3,$3,$4,$5,$6,1,1,'Posted',$7,$7,$7,$7,$8)
            RETURNING id`,
            [setup.gl_doc_id, glDocNo, payment_date, periodId, glDocNo,
             `Bulk Payment ${glDocNo}`, totalAmount, createdByUserId]);
        const glEntryId = glHeaderRes.rows[0].id;

        let lineNo = 1;
        const created = [];
        for (const { doc: apDoc, amount: payAmt, apAccountId } of docs) {
            await client.query(`
                INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                VALUES ($1,$2,$3,$4,$5,0,$5,0)`,
                [glEntryId, lineNo++, apAccountId, `Payment ${apDoc.doc_no}`, payAmt]);

            const pmtRes = await client.query(`
                INSERT INTO cm_payment
                    (payment_date, bank_account_id, payment_method_type, ap_doc_no,
                     payee_type, payee_id, payee_code, payee_name_th,
                     amount_lc, amount_fc, currency_code, exchange_rate,
                     gl_entry_id, created_by)
                VALUES ($1,$2,$3,$4,'VENDOR',$5,$6,$7,$8,$8,$9,1,$10,$11)
                RETURNING id`,
                [payment_date, bank_account_id, payment_method || 'TRANSFER', apDoc.doc_no,
                 apDoc.vendor_id, apDoc.v_vendor_code, apDoc.vendor_name_th,
                 payAmt, apDoc.currency_code || 'THB', glEntryId, createdByUserId]);

            await client.query(`
                UPDATE ap_transaction SET
                    paid_amount_lc    = COALESCE(paid_amount_lc, 0) + $1,
                    balance_amount_lc = GREATEST(COALESCE(balance_amount_lc, 0) - $1, 0),
                    status = CASE
                        WHEN (COALESCE(balance_amount_lc, 0) - $1) <= 0.005 THEN 'Settled'
                        ELSE status
                    END,
                    updated_at = NOW()
                WHERE id = $2`, [payAmt, apDoc.id]);

            created.push({ payment_id: pmtRes.rows[0].id, doc_no: apDoc.doc_no, amount: payAmt });
        }

        // Credit line — total paid from the bank account
        await client.query(`
            INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
            VALUES ($1,$2,$3,$4,0,$5,0,$5)`,
            [glEntryId, lineNo, bankAcct.gl_account_id, `Bulk payment ${glDocNo}`, totalAmount]);

        await client.query('COMMIT');
        res.json({
            success:      true,
            created_count: created.length,
            gl_doc_no:    glDocNo,
            payments:     created,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

module.exports = { getEligibleInvoices, runBulkPayment };
