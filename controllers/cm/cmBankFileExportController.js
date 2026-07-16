// controllers/cm/cmBankFileExportController.js
'use strict';

// GET: payments available to export for a bank account
const getPayments = async (req, res) => {
    const { bank_account_id, date_from, date_to, status } = req.query;
    if (!bank_account_id) return res.status(400).json({ error: 'ต้องระบุ bank_account_id' });

    const client = await req.dbPool.connect();
    try {
        const params = [bank_account_id];
        const wheres = ['p.bank_account_id=$1'];
        if (date_from) { params.push(date_from); wheres.push(`p.payment_date>=$${params.length}`); }
        if (date_to)   { params.push(date_to);   wheres.push(`p.payment_date<=$${params.length}`); }
        if (status && status !== 'All') { params.push(status); wheres.push(`p.status=$${params.length}`); }

        const r = await client.query(`
            SELECT p.id, p.ap_doc_no, p.payment_date, p.payment_method,
                   p.payee_name_th, p.payee_name_en,
                   p.bank_account_no AS payee_bank_account_no,
                   p.check_no, p.check_date,
                   p.amount_lc, p.currency_code, p.status,
                   ba.account_code AS bank_account_code,
                   ba.account_name_th AS bank_account_name,
                   cb.short_name AS bank_short_name
            FROM cm_payment p
            LEFT JOIN cm_bank_account ba ON ba.id = p.bank_account_id
            LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
            WHERE ${wheres.join(' AND ')}
            ORDER BY p.payment_date DESC, p.id DESC`,
            params);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// POST: generate export file content
const generateFile = async (req, res) => {
    const { format_id, payment_ids } = req.body;
    if (!format_id || !payment_ids || !payment_ids.length) {
        return res.status(400).json({ error: 'ต้องระบุ format_id และ payment_ids' });
    }

    const client = await req.dbPool.connect();
    try {
        // Load format config
        const fmtRes = await client.query(`SELECT * FROM cm_bank_file_format WHERE id=$1`, [format_id]);
        if (!fmtRes.rows.length) return res.status(404).json({ error: 'ไม่พบ format' });
        const fmt = fmtRes.rows[0];
        const columns = Array.isArray(fmt.columns) ? fmt.columns : JSON.parse(fmt.columns || '[]');
        const delimiter = fmt.delimiter || ',';

        // Load payments
        const pmtRes = await client.query(`
            SELECT p.*,
                   ba.account_code AS bank_account_code,
                   ba.account_name_th AS bank_account_name,
                   ba.bank_account_no AS bank_own_account_no,
                   cb.bank_code AS bank_code_ref,
                   cb.short_name AS bank_short_name
            FROM cm_payment p
            LEFT JOIN cm_bank_account ba ON ba.id = p.bank_account_id
            LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
            WHERE p.id = ANY($1::int[])
            ORDER BY p.payment_date, p.id`,
            [payment_ids]);
        const payments = pmtRes.rows;

        const lines = [];

        // Header row
        if (fmt.has_header) {
            const headerParts = columns.map(c => c.header || c.field || '');
            lines.push(headerParts.join(delimiter));
        }

        // Data rows
        for (const p of payments) {
            const parts = columns.map(col => {
                let val = '';
                const field = col.field || '';

                // Map field names to payment columns
                switch (field) {
                    case 'payment_date':     val = p.payment_date ? p.payment_date.toISOString().substring(0,10) : ''; break;
                    case 'payee_name_th':    val = p.payee_name_th || ''; break;
                    case 'payee_name_en':    val = p.payee_name_en || ''; break;
                    case 'amount_lc':        val = parseFloat(p.amount_lc || 0).toFixed(2); break;
                    case 'check_no':         val = p.check_no || ''; break;
                    case 'check_date':       val = p.check_date ? p.check_date.toISOString().substring(0,10) : ''; break;
                    case 'payee_bank_account_no': val = p.bank_account_no || p.payee_bank_account_no || ''; break;
                    case 'ap_doc_no':        val = p.ap_doc_no || ''; break;
                    case 'bank_code':        val = p.bank_code_ref || ''; break;
                    case 'bank_short_name':  val = p.bank_short_name || ''; break;
                    case 'currency_code':    val = p.currency_code || 'THB'; break;
                    case 'bank_account_code': val = p.bank_account_code || ''; break;
                    case 'bank_own_account_no': val = p.bank_own_account_no || ''; break;
                    default: val = p[field] !== undefined && p[field] !== null ? String(p[field]) : '';
                }

                // Apply width padding for fixed-width formats
                if (col.width && !delimiter) {
                    val = val.substring(0, col.width).padEnd(col.width, ' ');
                } else if (delimiter === ',') {
                    // CSV: wrap in quotes if contains delimiter or newline
                    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                        val = '"' + val.replace(/"/g, '""') + '"';
                    }
                }
                return val;
            });
            lines.push(parts.join(delimiter));
        }

        // Footer row
        if (fmt.has_footer) {
            const totalAmt = payments.reduce((s, p) => s + parseFloat(p.amount_lc || 0), 0);
            lines.push(`TOTAL${delimiter}${payments.length}${delimiter}${totalAmt.toFixed(2)}`);
        }

        const content  = lines.join('\r\n');
        const filename = `payment_export_${Date.now()}.${fmt.file_extension || 'txt'}`;
        res.json({ content, filename, format_name: fmt.format_name, row_count: payments.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { getPayments, generateFile };
