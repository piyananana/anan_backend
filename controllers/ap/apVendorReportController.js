// controllers/ap/apVendorReportController.js

/**
 * GET /ap_vendor/report
 * Query params:
 *   group_ids  – comma-separated vendor group IDs, e.g. "1,2,3"
 *   code_from  – vendor code lower bound (inclusive)
 *   code_to    – vendor code upper bound (inclusive)
 *   status     – '' | 'active' | 'inactive'
 *
 * Returns vendors with aggregated addresses / contacts / bank_accounts
 * so the frontend never needs N+1 fetchRow calls.
 */
const fetchReport = async (req, res) => {
  const { group_ids, code_from, code_to, status } = req.query;

  try {
    // idempotent migration
    await req.dbPool.query(
      `ALTER TABLE ap_vendor ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(18,4) NOT NULL DEFAULT 0`
    ).catch(() => {});

    const params = [];
    let p = 1;
    const conds = [];

    // กลุ่มผู้ขาย (multi)
    if (group_ids) {
      const ids = group_ids
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n));
      if (ids.length > 0) {
        conds.push(`v.vendor_group_id = ANY($${p}::int[])`);
        params.push(ids);
        p++;
      }
    }

    // ช่วงรหัสผู้ขาย
    if (code_from && code_from.trim() !== '') {
      conds.push(`v.vendor_code >= $${p}`);
      params.push(code_from.trim().toUpperCase());
      p++;
    }
    if (code_to && code_to.trim() !== '') {
      conds.push(`v.vendor_code <= $${p}`);
      params.push(code_to.trim().toUpperCase());
      p++;
    }

    // สถานะ
    if (status === 'active')   conds.push(`v.is_active = TRUE`);
    if (status === 'inactive') conds.push(`v.is_active = FALSE`);

    const where = conds.length > 0 ? 'AND ' + conds.join(' AND ') : '';

    const sql = `
      SELECT
        v.id,
        v.vendor_code,
        v.old_vendor_code,
        v.vendor_name_th,
        v.vendor_name_en,
        v.tax_id,
        v.credit_term_months,
        v.credit_term_days,
        v.credit_limit,
        v.currency_code,
        v.is_active,
        v.vendor_type,
        v.remark,
        v.vendor_group_id,
        vg.group_code        AS vendor_group_code,
        vg.group_name_thai   AS vendor_group_name,
        v.business_type_id,
        cbt.business_type_code,
        cbt.business_type_name_thai,
        v.ap_account_id,
        ga.account_code      AS ap_account_code,
        ga.account_name_thai AS ap_account_name_thai,

        /* ── ที่อยู่ ─────────────────────────────────────────────── */
        COALESCE(
          json_agg(DISTINCT jsonb_build_object(
            'id',                       addr.id,
            'vendor_id',                addr.vendor_id,
            'address_type',             addr.address_type,
            'address_no',               addr.address_no,
            'address_building_village', addr.address_building_village,
            'address_alley',            addr.address_alley,
            'address_road',             addr.address_road,
            'address_sub_district',     addr.address_sub_district,
            'address_district',         addr.address_district,
            'address_province',         addr.address_province,
            'address_country',          addr.address_country,
            'address_zip_code',         addr.address_zip_code,
            'is_default',               addr.is_default
          )) FILTER (WHERE addr.id IS NOT NULL),
          '[]'::json
        ) AS addresses,

        /* ── ผู้ติดต่อ ───────────────────────────────────────────── */
        COALESCE(
          json_agg(DISTINCT jsonb_build_object(
            'id',           ct.id,
            'vendor_id',    ct.vendor_id,
            'contact_name', ct.contact_name,
            'position',     ct.position,
            'phone',        ct.phone,
            'mobile',       ct.mobile,
            'email',        ct.email,
            'is_default',   ct.is_default
          )) FILTER (WHERE ct.id IS NOT NULL),
          '[]'::json
        ) AS contacts,

        /* ── บัญชีธนาคาร ─────────────────────────────────────────── */
        COALESCE(
          json_agg(DISTINCT jsonb_build_object(
            'id',             ba.id,
            'vendor_id',      ba.vendor_id,
            'bank_name',      ba.bank_name,
            'branch_name',    ba.branch_name,
            'account_number', ba.account_number,
            'account_name',   ba.account_name,
            'account_type',   ba.account_type,
            'is_default',     ba.is_default
          )) FILTER (WHERE ba.id IS NOT NULL),
          '[]'::json
        ) AS bank_accounts

      FROM ap_vendor v
      LEFT JOIN ap_vendor_group    vg  ON v.vendor_group_id  = vg.id
      LEFT JOIN cd_business_type   cbt ON v.business_type_id = cbt.id
      LEFT JOIN gl_account         ga  ON v.ap_account_id    = ga.id
      LEFT JOIN ap_vendor_address  addr ON addr.vendor_id    = v.id
      LEFT JOIN ap_vendor_contact  ct   ON ct.vendor_id      = v.id
      LEFT JOIN ap_vendor_bank_account ba ON ba.vendor_id    = v.id
      WHERE 1=1 ${where}
      GROUP BY
        v.id,
        vg.group_code, vg.group_name_thai,
        cbt.business_type_code, cbt.business_type_name_thai,
        ga.account_code, ga.account_name_thai
      ORDER BY v.vendor_code ASC
    `;

    const result = await req.dbPool.query(sql, params);
    res.status(200).json(result.rows.map(r => ({
      ...r,
      credit_limit: Number(r.credit_limit || 0),
    })));
  } catch (error) {
    console.error('Error fetching ap vendor report:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { fetchReport };
