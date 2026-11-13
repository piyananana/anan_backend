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
    await req.dbPool.query(`ALTER TABLE cd_wht_type ADD COLUMN IF NOT EXISTS wht_name_en VARCHAR(200)`).catch(() => {});

    const hasCm = (await req.dbPool.query(`SELECT to_regclass('public.cm_transaction_wht') IS NOT NULL AS ok`)).rows[0].ok;
    const sql = `
      SELECT
        w.id,
        t.doc_no        AS payment_doc_no,
        t.doc_date      AS payment_date,
        v.vendor_code,
        -- ซื้อเงินสด (IM '14'): ผู้ขายจริงที่ระบุในเอกสาร (bill_to_*) ใช้แทนผู้ขายเงินสดทั้งชุด — ช่องที่ว่างพิมพ์ว่าง
        CASE WHEN bt.name IS NOT NULL THEN bt.name ELSE v.vendor_name_th END AS vendor_name_th,
        CASE WHEN bt.name IS NOT NULL THEN bt.name ELSE v.vendor_name_en END AS vendor_name_en,
        CASE WHEN bt.name IS NOT NULL THEN bt.tax_id ELSE v.tax_id END AS tax_id,
        v.vendor_type,
        w.wht_type,
        wt.wht_name_en   AS wht_type_en,
        w.income_type,
        w.wht_rate,
        w.base_amount_lc,
        w.wht_amount_lc,
        w.description,
        CASE WHEN bt.name IS NOT NULL THEN bt.address ELSE addr.address_no END AS address_no,
        CASE WHEN bt.name IS NOT NULL THEN NULL ELSE addr.address_building_village END AS address_building_village,
        CASE WHEN bt.name IS NOT NULL THEN NULL ELSE addr.address_alley END AS address_alley,
        CASE WHEN bt.name IS NOT NULL THEN NULL ELSE addr.address_road END AS address_road,
        CASE WHEN bt.name IS NOT NULL THEN NULL ELSE addr.address_sub_district END AS address_sub_district,
        CASE WHEN bt.name IS NOT NULL THEN NULL ELSE addr.address_district END AS address_district,
        CASE WHEN bt.name IS NOT NULL THEN NULL ELSE addr.address_province END AS address_province,
        CASE WHEN bt.name IS NOT NULL THEN NULL ELSE addr.address_zip_code END AS address_zip_code
      FROM ap_transaction_wht w
      JOIN ap_transaction t ON t.id = w.header_id
      JOIN ap_vendor      v ON v.id = t.vendor_id
      CROSS JOIN LATERAL (SELECT NULLIF(to_jsonb(t)->>'bill_to_name', '') AS name, to_jsonb(t)->>'bill_to_tax_id' AS tax_id,
                                 to_jsonb(t)->>'bill_to_address' AS address) bt
      LEFT JOIN cd_wht_type wt ON wt.id = w.wht_type_id
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
      ${hasCm ? `
      UNION ALL
      -- รายจ่าย CM (20): ผู้รับเงินจาก snapshot ที่หัวเอกสาร (เลือกจากผู้ขาย AP หรือพิมพ์เอง) — ที่อยู่เป็นข้อความเดียว
      SELECT
        w.id, t.doc_no, t.doc_date, t.party_code, t.counterparty_name, NULL, t.party_tax_id, t.party_type,
        w.wht_type, wt.wht_name_en, w.income_type, w.wht_rate, w.base_amount_lc, w.wht_amount_lc, w.description,
        t.party_address, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM cm_transaction_wht w
      JOIN cm_transaction t ON t.id = w.header_id
      JOIN sa_module_document cd ON cd.id = t.doc_id AND cd.sys_doc_type = '20' -- รายรับ (10) = ผู้จ่ายหักเรา ไม่ใช่ ภ.ง.ด. ของเรา
      LEFT JOIN cd_wht_type wt ON wt.id = w.wht_type_id
      WHERE
        EXTRACT(MONTH FROM t.doc_date) = $1
        AND EXTRACT(YEAR  FROM t.doc_date) = $2
        AND t.party_type   = $3
        AND t.status       = 'Posted'
        AND w.wht_amount_lc > 0` : ''}
      ORDER BY vendor_code ASC, payment_date ASC, id ASC
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
