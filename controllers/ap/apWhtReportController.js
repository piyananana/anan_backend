// controllers/ap/apWhtReportController.js
/**
 * GET /ap_wht_report
 * Query params:
 *   month    – เดือน 1-12
 *   year     – ปี ค.ศ.
 *   pnd_form – 'pnd3' (บุคคลธรรมดา) | 'pnd53' (นิติบุคคล)
 *
 * Returns WHT lines for Posted payments in the given month/year,
 * filtered by vendor_type derived from pnd_form.
 */
const fetchWhtReport = async (req, res) => {
  const { month, year, pnd_form } = req.query;

  if (!month || !year || !pnd_form) {
    return res.status(400).json({ message: 'กรุณาระบุ month, year และ pnd_form' });
  }

  const vendorType = pnd_form === 'pnd3' ? 'individual' : 'juristic';

  try {
    // เพิ่มคอลัมน์ใหม่แบบ idempotent ก่อนใช้งาน
    await req.dbPool.query(`ALTER TABLE ap_transaction_wht ADD COLUMN IF NOT EXISTS wht_type_id INT REFERENCES cd_wht_type(id)`).catch(() => {});
    await req.dbPool.query(`ALTER TABLE ap_transaction_wht ADD COLUMN IF NOT EXISTS income_type VARCHAR(20)`).catch(() => {});

    const sql = `
      SELECT
        w.id,
        t.doc_no        AS payment_doc_no,
        t.doc_date      AS payment_date,
        v.vendor_code,
        v.vendor_name_th,
        v.tax_id,
        v.vendor_type,
        w.wht_type,
        w.income_type,
        w.wht_rate,
        w.base_amount_lc,
        w.wht_amount_lc,
        w.description,
        addr.address_no,
        addr.address_building_village,
        addr.address_alley,
        addr.address_road,
        addr.address_sub_district,
        addr.address_district,
        addr.address_province,
        addr.address_zip_code
      FROM ap_transaction_wht w
      JOIN ap_transaction t ON t.id = w.header_id
      JOIN ap_vendor      v ON v.id = t.vendor_id
      LEFT JOIN ap_vendor_address addr
             ON addr.vendor_id = v.id
            AND addr.address_type = 'billing'
            AND addr.is_default  = TRUE
      WHERE
        EXTRACT(MONTH FROM t.doc_date) = $1
        AND EXTRACT(YEAR  FROM t.doc_date) = $2
        AND v.vendor_type  = $3
        AND t.status       = 'Posted'
        AND w.wht_amount_lc > 0
      ORDER BY v.vendor_code ASC, t.doc_date ASC, w.id ASC
    `;

    const result = await req.dbPool.query(sql, [
      parseInt(month, 10),
      parseInt(year,  10),
      vendorType,
    ]);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching WHT report:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { fetchWhtReport };
