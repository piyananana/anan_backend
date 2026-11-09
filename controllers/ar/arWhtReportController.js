// controllers/ar/arWhtReportController.js
// รายงานภาษีถูกหัก ณ ที่จ่าย (ลูกค้าหักเรา) — ใช้กระทบยอดบัญชีภาษีถูกหัก ณ ที่จ่าย และตามหนังสือรับรอง (50 ทวิ)
// แหล่งข้อมูล: ใบเสร็จรับชำระ AR (80) ที่ Post แล้ว (ar_transaction_wht รวมใบเสร็จที่ขายเงินสดของ IM สร้างให้)
// และรายรับของ CM (cm_transaction sys_doc_type '10' — ผู้จ่ายหักเรา)
/**
 * GET /ar_wht_report
 * Query params:
 *   date_from, date_to – ช่วงวันที่เอกสาร (YYYY-MM-DD) บังคับ
 *   search             – รหัส/ชื่อลูกค้า เลขผู้เสียภาษี หรือเลขที่หนังสือรับรอง (ไม่บังคับ)
 */
const { ensureArWhtTable } = require('./arTransactionController');

const fetchWhtReport = async (req, res) => {
  const { date_from, date_to, search } = req.query;
  if (!date_from || !date_to) {
    return res.status(400).json({ message: 'กรุณาระบุ date_from และ date_to' });
  }

  try {
    await ensureArWhtTable(req.dbPool);
    await req.dbPool.query(`ALTER TABLE cd_wht_type ADD COLUMN IF NOT EXISTS wht_name_en VARCHAR(200)`);
    const hasCm = (await req.dbPool.query(`SELECT to_regclass('public.cm_transaction_wht') IS NOT NULL AS ok`)).rows[0].ok;
    const params = [date_from, date_to];
    let searchSql = '';
    if (search && search.trim()) {
      params.push(`%${search.trim().toUpperCase()}%`);
      searchSql = `WHERE UPPER(CONCAT_WS(' ', x.customer_code, x.customer_name_th, x.customer_name_en, x.tax_id, x.certificate_no, x.doc_no)) LIKE $3`;
    }

    const sql = `
      SELECT x.* FROM (
        SELECT
          'AR'               AS source,
          w.id,
          t.doc_no,
          t.doc_date,
          c.customer_code,
          t.customer_name_th,
          c.customer_name_en,
          -- ผู้ซื้อที่ระบุในเอกสาร (ขายเงินสด) ใช้แทนข้อมูลลูกค้าทั้งชุด — กฎเดียวกับรายงานภาษีขาย
          CASE WHEN COALESCE(to_jsonb(t)->>'bill_to_name', '') <> '' THEN to_jsonb(t)->>'bill_to_tax_id' ELSE c.tax_id END AS tax_id,
          w.wht_name         AS wht_type,
          wt.wht_name_en     AS wht_type_en,
          w.income_type,
          w.wht_rate,
          w.base_amount_lc,
          w.wht_amount_lc,
          w.certificate_no,
          w.description
        FROM ar_transaction_wht w
        JOIN ar_transaction t ON t.id = w.header_id
        JOIN sa_module_document d ON d.id = t.doc_id AND d.sys_doc_type = '80'
        LEFT JOIN ar_customer c ON c.id = t.customer_id
        LEFT JOIN cd_wht_type wt ON wt.id = w.wht_type_id
        WHERE t.doc_date BETWEEN $1::date AND $2::date
          AND t.status = 'Posted'
          AND w.wht_amount_lc > 0
        ${hasCm ? `
        UNION ALL
        -- รายรับ CM (10): ผู้จ่ายจาก snapshot ที่หัวเอกสาร — ไม่มีเลขที่หนังสือรับรองแยก
        SELECT
          'CM', w.id, t.doc_no, t.doc_date, t.party_code, t.counterparty_name, NULL, t.party_tax_id,
          w.wht_type, wt.wht_name_en, w.income_type, w.wht_rate, w.base_amount_lc, w.wht_amount_lc, NULL, w.description
        FROM cm_transaction_wht w
        JOIN cm_transaction t ON t.id = w.header_id
        JOIN sa_module_document cd ON cd.id = t.doc_id AND cd.sys_doc_type = '10'
        LEFT JOIN cd_wht_type wt ON wt.id = w.wht_type_id
        WHERE t.doc_date BETWEEN $1::date AND $2::date
          AND t.status = 'Posted'
          AND w.wht_amount_lc > 0` : ''}
      ) x
      ${searchSql}
      ORDER BY x.doc_date ASC, x.doc_no ASC, x.id ASC
    `;
    const result = await req.dbPool.query(sql, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching AR WHT report:', error);
    res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

module.exports = { fetchWhtReport };
