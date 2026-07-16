// controllers/cm/cmBulkPaymentController.js
'use strict';
const { checkCmPeriodOpen } = require('./cmPeriodCheckHelper');

// GET eligible AP documents for bulk payment
// Returns ap_documents that are Approved or partially paid, with outstanding amounts
const getEligibleInvoices = async (req, res) => {
    const { bank_account_id, vendor_id, date_to, payment_method } = req.query;
    const client = await req.dbPool.connect();
    try {
        const params = [];
        const wheres = [`d.status IN ('Approved','Partially Paid')`];
        if (vendor_id)   { params.push(vendor_id);   wheres.push(`d.vendor_id=$${params.length}`); }
        if (date_to)     { params.push(date_to);      wheres.push(`d.due_date<=$${params.length}`); }

        const r = await client.query(`
            SELECT d.id, d.doc_no, d.doc_date, d.due_date, d.status,
                   d.total_amount,
                   COALESCE(d.paid_amount, 0) AS paid_amount,
                   d.total_amount - COALESCE(d.paid_amount, 0) AS outstanding_amount,
                   d.currency_code,
                   d.exchange_rate,
                   d.wht_amount,
                   v.id AS vendor_id, v.vendor_code, v.vendor_name_thai,
                   v.bank_account_no AS vendor_bank_account,
                   v.bank_name AS vendor_bank_name
            FROM ap_document d
            JOIN ap_vendor v ON v.id = d.vendor_id
            WHERE ${wheres.join(' AND ')}
            ORDER BY v.vendor_code, d.due_date, d.doc_no`,
            params);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// POST run bulk payment
// Body: { bank_account_id, payment_date, payment_method, gl_doc_type_id, items: [{ap_doc_id, amount, wht_amount}] }
const runBulkPayment = async (req, res) => {
    const { bank_account_id, payment_date, payment_method, gl_doc_type_id, items } = req.body;
    if (!bank_account_id || !payment_date || !items || !items.length)
        return res.status(400).json({ error: 'ต้องระบุ bank_account_id, payment_date, items' });

    const createdBy = req.headers.username || 'system';
    const userId    = req.headers.userid;
    const client    = await req.dbPool.connect();

    try {
        // Period check
        const pc = await checkCmPeriodOpen(client, payment_date);
        if (!pc.allowed) return res.status(400).json({ error: pc.message });

        await client.query('BEGIN');

        // Load bank account
        const baRes = await client.query(`
            SELECT ba.*, cb.bank_code FROM cm_bank_account ba
            LEFT JOIN cd_bank cb ON cb.id=ba.bank_id
            WHERE ba.id=$1`, [bank_account_id]);
        if (!baRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ไม่พบบัญชีธนาคาร' });
        }
        const bankAcct = baRes.rows[0];

        // Load GL doc type for payment sequence
        let nextDocPrefix = 'PMT';
        if (gl_doc_type_id) {
            const dtRes = await client.query(
                `SELECT doc_code FROM sa_module_document WHERE id=$1`, [gl_doc_type_id]);
            if (dtRes.rows.length) nextDocPrefix = dtRes.rows[0].doc_code;
        }

        // Get period
        const pRes = await client.query(`
            SELECT p.id FROM gl_posting_period p
            JOIN gl_fiscal_year fy ON fy.id=p.fiscal_year_id
            WHERE fy.is_active=true
              AND p.period_start_date::date<=$1::date
              AND p.period_end_date::date>=$1::date LIMIT 1`, [payment_date]);
        const periodId = pRes.rows.length ? pRes.rows[0].id : null;

        const created = [];
        const errors  = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            try {
                // Load AP document
                const apRes = await client.query(`
                    SELECT d.*, v.vendor_name_thai, v.vendor_name_english,
                           v.bank_account_no AS vendor_bank_account
                    FROM ap_document d JOIN ap_vendor v ON v.id=d.vendor_id
                    WHERE d.id=$1`, [item.ap_doc_id]);
                if (!apRes.rows.length) throw new Error(`ไม่พบ AP Document id=${item.ap_doc_id}`);
                const apDoc = apRes.rows[0];

                const netAmt  = parseFloat(item.amount || 0);
                const whtAmt  = parseFloat(item.wht_amount || apDoc.wht_amount || 0);
                const payAmt  = netAmt - whtAmt;

                // Build payment doc no
                const today = payment_date.toString().replace(/-/g, '').substring(2, 8);
                const seq   = (i + 1).toString().padStart(4, '0');
                const docNo = `${nextDocPrefix}${today}-${seq}`;

                // Insert cm_payment
                const pmtRes = await client.query(`
                    INSERT INTO cm_payment
                        (bank_account_id, payment_date, payment_method, ap_doc_no,
                         payee_name_th, payee_name_en, bank_account_no,
                         amount_lc, currency_code, wht_amount,
                         doc_no, status, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Posted',$12)
                    RETURNING id, doc_no`,
                    [bank_account_id, payment_date, payment_method || 'TRANSFER',
                     apDoc.doc_no, apDoc.vendor_name_thai, apDoc.vendor_name_english,
                     apDoc.vendor_bank_account,
                     payAmt, apDoc.currency_code || 'THB',
                     whtAmt, docNo, createdBy]);
                const pmtId = pmtRes.rows[0].id;

                // Post GL: Dr AP clearing, Cr Bank, Dr WHT payable (if wht > 0)
                const glHRes = await client.query(`
                    INSERT INTO gl_entry_header
                        (doc_no, doc_date, period_id, description, status, created_by, updated_at)
                    VALUES ($1,$2,$3,$4,'Posted',$5,NOW()) RETURNING id`,
                    [docNo, payment_date, periodId,
                     `จ่ายเงิน ${apDoc.doc_no} - ${apDoc.vendor_name_thai}`, createdBy]);
                const glId = glHRes.rows[0].id;

                // Simple GL lines: Debit AP control account, Credit Bank
                // (assumes ap_gl_account_id is on the vendor or from CM GL setup)
                // We'll use bank GL account only if we have it
                if (bankAcct.gl_account_id) {
                    await client.query(`
                        INSERT INTO gl_entry_line (header_id, line_no, account_id, description, debit_amount_lc, credit_amount_lc)
                        VALUES ($1,1,$2,$3,0,$4)`,
                        [glId, bankAcct.gl_account_id,
                         `จ่ายเงิน ${apDoc.doc_no}`, payAmt]);
                }

                // Update AP document paid amount
                await client.query(`
                    UPDATE ap_document SET
                        paid_amount = COALESCE(paid_amount,0) + $1,
                        status = CASE
                            WHEN COALESCE(paid_amount,0)+$1 >= total_amount THEN 'Paid'
                            ELSE 'Partially Paid'
                        END
                    WHERE id=$2`, [netAmt, item.ap_doc_id]);

                // Link gl to payment
                await client.query(`UPDATE cm_payment SET gl_entry_id=$1, gl_doc_no=$2 WHERE id=$3`,
                    [glId, docNo, pmtId]);

                created.push({ payment_id: pmtId, doc_no: docNo, ap_doc_no: apDoc.doc_no, amount: payAmt });
            } catch (itemErr) {
                errors.push({ ap_doc_id: item.ap_doc_id, error: itemErr.message });
            }
        }

        await client.query('COMMIT');
        res.json({
            success:   true,
            created:   created.length,
            errors:    errors.length,
            payments:  created,
            error_details: errors,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

module.exports = { getEligibleInvoices, runBulkPayment };
