// controllers/cm/cmRemittanceAdviceController.js
// Returns data for Remittance Advice PDF generation
'use strict';

// GET /cm_remittance_advice/:payment_id
const getRemittanceData = async (req, res) => {
    const { payment_id } = req.params;
    const client = await req.dbPool.connect();
    try {
        // Load payment
        const pmtRes = await client.query(`
            SELECT p.*,
                   ba.account_code       AS bank_account_code,
                   ba.account_name_th    AS bank_account_name,
                   ba.account_number     AS bank_account_number,
                   cb.bank_name_thai      AS bank_name,
                   cb.short_name         AS bank_short_name,
                   cb.bank_code          AS bank_code
            FROM cm_payment p
            LEFT JOIN cm_bank_account ba ON ba.id = p.bank_account_id
            LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
            WHERE p.id=$1`, [payment_id]);
        if (!pmtRes.rows.length) return res.status(404).json({ error: 'ไม่พบรายการจ่ายเงิน' });
        const pmt = pmtRes.rows[0];

        // Company info
        const coRes = await client.query(`
            SELECT company_name_thai, company_name_english,
                   address_line1, address_line2, address_line3,
                   tel, tax_id, logo_url
            FROM sa_company LIMIT 1`);
        const company = coRes.rows[0] || {};

        // Vendor info — join via ap_document if available
        let vendor = null;
        let invoices = [];
        if (pmt.ap_doc_no) {
            // Try to load AP document
            const apRes = await client.query(`
                SELECT d.*,
                       v.vendor_code, v.vendor_name_thai, v.vendor_name_english,
                       v.tax_id AS vendor_tax_id,
                       v.address_line1 AS vendor_address,
                       v.bank_account_no AS vendor_bank_account
                FROM ap_document d
                LEFT JOIN ap_vendor v ON v.id = d.vendor_id
                WHERE d.doc_no = $1
                LIMIT 1`, [pmt.ap_doc_no]);
            if (apRes.rows.length) {
                const doc = apRes.rows[0];
                vendor = {
                    vendor_code:    doc.vendor_code,
                    vendor_name:    doc.vendor_name_thai || doc.vendor_name_english || pmt.payee_name_th,
                    vendor_name_en: doc.vendor_name_english,
                    tax_id:         doc.vendor_tax_id,
                    address:        doc.vendor_address,
                    bank_account:   doc.vendor_bank_account,
                };
                invoices = [{
                    doc_no:    doc.doc_no,
                    doc_date:  doc.doc_date,
                    amount:    doc.total_amount,
                    wht:       pmt.wht_amount || 0,
                    net_paid:  pmt.amount_lc,
                    due_date:  doc.due_date,
                }];
            }
        }

        // Fallback: use payee_name from payment
        if (!vendor) {
            vendor = {
                vendor_name:    pmt.payee_name_th || pmt.payee_name_en || '',
                vendor_name_en: pmt.payee_name_en || '',
                bank_account:   pmt.bank_account_no || '',
            };
            if (pmt.ap_doc_no) {
                invoices = [{
                    doc_no:   pmt.ap_doc_no,
                    net_paid: pmt.amount_lc,
                    wht:      pmt.wht_amount || 0,
                }];
            }
        }

        res.json({
            payment:  pmt,
            company,
            vendor,
            invoices,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// GET /cm_remittance_advice/batch?payment_ids=1,2,3
const getBatchRemittanceData = async (req, res) => {
    const { payment_ids } = req.query;
    if (!payment_ids) return res.status(400).json({ error: 'ต้องระบุ payment_ids' });
    const ids = payment_ids.split(',').map(id => parseInt(id.trim())).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'payment_ids ไม่ถูกต้อง' });

    const client = await req.dbPool.connect();
    try {
        const pmtRes = await client.query(`
            SELECT p.*,
                   ba.account_code    AS bank_account_code,
                   ba.account_name_th AS bank_account_name,
                   ba.account_number  AS bank_account_number,
                   cb.bank_name_thai   AS bank_name,
                   cb.short_name      AS bank_short_name
            FROM cm_payment p
            LEFT JOIN cm_bank_account ba ON ba.id = p.bank_account_id
            LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id
            WHERE p.id = ANY($1::int[])
            ORDER BY p.payment_date, p.id`, [ids]);

        const coRes = await client.query(
            `SELECT company_name_thai, company_name_english, address_line1, tel, tax_id, logo_url
             FROM sa_company LIMIT 1`);
        const company = coRes.rows[0] || {};

        // Group by payee (payee_name_th)
        const grouped = {};
        for (const pmt of pmtRes.rows) {
            const key = pmt.payee_name_th || `pmt_${pmt.id}`;
            if (!grouped[key]) {
                grouped[key] = {
                    vendor_name:  pmt.payee_name_th,
                    vendor_name_en: pmt.payee_name_en || '',
                    bank_account: pmt.bank_account_no || '',
                    payments: [],
                };
            }
            grouped[key].payments.push(pmt);
        }

        res.json({ company, groups: Object.values(grouped) });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { getRemittanceData, getBatchRemittanceData };
