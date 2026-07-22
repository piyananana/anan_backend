// controllers/ap/apRemittanceAdviceController.js
// Returns data for Remittance Advice PDF generation
'use strict';

const buildCompanyInfo = async (client) => {
    const coRes = await client.query(`
        SELECT thai_name, english_name, address_no, address_building_village,
               address_alley, address_road, address_sub_district, address_district,
               address_province, address_zip_code, tax_id_number
        FROM sa_company WHERE is_active = true LIMIT 1`);
    const co = coRes.rows[0] || {};
    const address = [
        co.address_no, co.address_building_village, co.address_alley, co.address_road,
        co.address_sub_district, co.address_district, co.address_province, co.address_zip_code,
    ].filter(Boolean).join(' ');
    return {
        company_name_th: co.thai_name || '',
        company_name_en: co.english_name || '',
        address,
        tax_id: co.tax_id_number || '',
    };
};

// Build the full { payment, company, vendor, invoices } payload for one cm_payment row
const buildRemittanceData = async (client, paymentId) => {
    const pmtRes = await client.query(`
        SELECT p.*,
               ba.account_code       AS bank_account_code,
               ba.account_name_th    AS bank_account_name_th,
               ba.account_name_en    AS bank_account_name_en,
               ba.account_number     AS bank_account_number,
               cb.bank_name_thai     AS bank_name_th,
               cb.bank_name_eng      AS bank_name_en,
               cb.short_name         AS bank_short_name,
               pm.method_name_th     AS payment_method_name_th,
               pm.method_name_en     AS payment_method_name_en
        FROM cm_payment p
        LEFT JOIN cm_bank_account ba ON ba.id = p.bank_account_id
        LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
        LEFT JOIN cm_payment_method pm ON pm.id = p.payment_method_id
        WHERE p.id = $1`, [paymentId]);
    if (!pmtRes.rows.length) return null;
    const pmt = pmtRes.rows[0];

    const company = await buildCompanyInfo(client);

    // Vendor info (payee)
    let vendor = null;
    if (pmt.payee_type === 'VENDOR' && pmt.payee_id) {
        const vRes = await client.query(
            `SELECT id, vendor_code, vendor_name_th, vendor_name_en, tax_id FROM ap_vendor WHERE id=$1`,
            [pmt.payee_id]);
        if (vRes.rows.length) {
            const v = vRes.rows[0];
            const vbRes = await client.query(
                `SELECT bank_name, branch_name, account_number, account_name
                 FROM ap_vendor_bank_account WHERE vendor_id=$1 ORDER BY is_default DESC LIMIT 1`,
                [v.id]);
            const vb = vbRes.rows[0] || {};
            vendor = {
                vendor_code:         v.vendor_code,
                vendor_name_th:      v.vendor_name_th,
                vendor_name_en:      v.vendor_name_en || '',
                tax_id:              v.tax_id || '',
                bank_name:           vb.bank_name || '',
                bank_branch_name:    vb.branch_name || '',
                bank_account_number: vb.account_number || '',
                bank_account_name:   vb.account_name || '',
            };
        }
    }
    if (!vendor) {
        vendor = {
            vendor_code:    pmt.payee_code || '',
            vendor_name_th: pmt.payee_name_th || '',
            vendor_name_en: '',
            tax_id: '', bank_name: '', bank_branch_name: '',
            bank_account_number: '', bank_account_name: '',
        };
    }

    // Invoice breakdown
    let invoices = [];
    if (pmt.ap_payment_run_id) {
        const linesRes = await client.query(
            `SELECT invoice_no, invoice_date, due_date, invoice_amount_lc, payment_amount_lc
             FROM ap_payment_run_detail WHERE run_id=$1 AND vendor_id=$2 ORDER BY sort_order, id`,
            [pmt.ap_payment_run_id, pmt.payee_id]);
        invoices = linesRes.rows.map(l => ({
            doc_no:       l.invoice_no,
            invoice_date: l.invoice_date,
            due_date:     l.due_date,
            total_amount: l.invoice_amount_lc,
            this_payment: l.payment_amount_lc,
        }));
    } else if (pmt.ap_doc_no) {
        const apRes = await client.query(
            `SELECT doc_no, doc_date, due_date, total_amount_lc
             FROM ap_transaction WHERE doc_no=$1 AND vendor_id=$2 LIMIT 1`,
            [pmt.ap_doc_no, pmt.payee_id]);
        if (apRes.rows.length) {
            const d = apRes.rows[0];
            invoices = [{
                doc_no: d.doc_no, invoice_date: d.doc_date, due_date: d.due_date,
                total_amount: d.total_amount_lc, this_payment: pmt.amount_lc,
            }];
        }
    }

    return { payment: pmt, company, vendor, invoices };
};

// GET /ap_remittance_advice/:payment_id
const getRemittanceData = async (req, res) => {
    const { payment_id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const data = await buildRemittanceData(client, payment_id);
        if (!data) return res.status(404).json({ error: 'Payment not found' });
        res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// GET /ap_remittance_advice/batch?payment_ids=1,2,3
// Returns a flat array — one { payment, company, vendor, invoices } entry per id, in request order
const getBatchRemittanceData = async (req, res) => {
    const { payment_ids } = req.query;
    if (!payment_ids) return res.status(400).json({ error: 'payment_ids is required' });
    const ids = payment_ids.split(',').map(id => parseInt(id.trim())).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'payment_ids is invalid' });

    const client = await req.dbPool.connect();
    try {
        const pages = [];
        for (const id of ids) {
            const data = await buildRemittanceData(client, id);
            if (data) pages.push(data);
        }
        res.json(pages);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { getRemittanceData, getBatchRemittanceData };
