// controllers/vt/vatReportController.js
// รายงานภาษีซื้อ / ภาษีขาย (สำหรับยื่นสรรพากร ภ.พ.30)
// ดึงข้อมูลจาก vt_transaction (ตารางกลาง VAT ของทุก module)

const getVatReport = async (req, res) => {
    const { vat_type, date_from, date_to } = req.query;

    if (!vat_type) {
        return res.status(400).json({ error: 'vat_type is required (OUTPUT_VAT | INPUT_VAT)' });
    }

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const vatTypes = vat_type === 'OUTPUT_VAT'
        ? ['OUTPUT_VAT']
        : vat_type === 'INPUT_VAT'
            ? ['INPUT_VAT']
            : [vat_type];

    const client = await req.dbPool.connect();
    try {
        // รวมยอดต่อใบกำกับภาษี 1 แถว (GROUP BY source_header_id)
        // ใช้ tax_invoice_no/date ถ้ามี ไม่งั้น fallback ไป doc_no/doc_date
        const result = await client.query(`
            SELECT
                COALESCE(vt.tax_invoice_no, vt.doc_no)           AS tax_invoice_no,
                COALESCE(vt.tax_invoice_date, vt.doc_date)       AS tax_invoice_date,
                vt.doc_no,
                vt.doc_date,
                vt.entity_name,
                vt.entity_tax_id,
                COALESCE(vt.entity_branch_code, '00000')         AS entity_branch_code,
                SUM(vt.base_amount_lc)                           AS base_amount,
                SUM(vt.vat_amount_lc)                            AS vat_amount
            FROM vt_transaction vt
            WHERE vt.is_voided = FALSE
              AND vt.vat_type = ANY($1::text[])
              AND vt.doc_date >= $2::date
              AND vt.doc_date <= $3::date
            GROUP BY
                vt.source_header_id,
                COALESCE(vt.tax_invoice_no, vt.doc_no),
                COALESCE(vt.tax_invoice_date, vt.doc_date),
                vt.doc_no,
                vt.doc_date,
                vt.entity_name,
                vt.entity_tax_id,
                vt.entity_branch_code
            ORDER BY
                COALESCE(vt.tax_invoice_date, vt.doc_date),
                COALESCE(vt.tax_invoice_no,   vt.doc_no)
        `, [vatTypes, dateFrom, dateTo]);

        const rows = result.rows.map((r, i) => ({
            seq:                i + 1,
            tax_invoice_no:     r.tax_invoice_no   || '',
            tax_invoice_date:   r.tax_invoice_date,
            doc_no:             r.doc_no            || '',
            doc_date:           r.doc_date,
            entity_name:        r.entity_name       || '',
            entity_tax_id:      r.entity_tax_id     || '',
            entity_branch_code: r.entity_branch_code,
            base_amount:        Number(r.base_amount || 0),
            vat_amount:         Number(r.vat_amount  || 0),
        }));

        res.json(rows);
    } catch (err) {
        console.error('VAT Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getVatReport };
