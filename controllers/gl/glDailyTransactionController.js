// controllers/gl/glDailyTransactionController.js

const getDailyTransactions = async (req, res) => {
  const {
    fiscal_year_id, period_id,
    doc_date_from, doc_date_to,
    doc_codes,
    doc_no_from, doc_no_to,
    ref_doc_codes,
    ref_doc_no_from, ref_doc_no_to,
    ref_doc_date_from, ref_doc_date_to,
  } = req.query;

  if (!fiscal_year_id) {
    return res.status(400).json({ error: 'fiscal_year_id is required' });
  }

  const client = await req.dbPool.connect();
  try {
    // 1. Determine target period IDs (skip period 1 = opening balance)
    let periodIds;
    if (period_id) {
      periodIds = [parseInt(period_id)];
    } else {
      const periodsRes = await client.query(
        `SELECT id FROM gl_posting_period
         WHERE fiscal_year_id = $1 AND period_number > 1
         ORDER BY period_number ASC`,
        [fiscal_year_id]
      );
      periodIds = periodsRes.rows.map(p => p.id);
    }
    if (periodIds.length === 0) return res.json([]);

    // 2. Build dynamic query
    let sql = `
      SELECT
        h.id AS header_id,
        h.doc_date, h.doc_no,
        h.description AS header_desc,
        h.ref_doc_no, h.ref_doc_date,
        h.total_debit_lc, h.total_credit_lc,
        d.doc_code, d.doc_name_thai,
        rd.doc_code  AS ref_doc_code,
        rd.doc_name_thai AS ref_doc_name,
        det.id        AS detail_id,
        det.line_no,
        det.account_id,
        a.account_code,
        a.account_name_thai,
        det.description AS detail_desc,
        det.debit_lc,
        det.credit_lc,
        det.branch_id,
        det.business_unit_id,
        det.project_id
      FROM gl_entry_header h
      JOIN  sa_module_document d   ON h.doc_id     = d.id
      LEFT JOIN sa_module_document rd  ON h.ref_doc_id = rd.id
      JOIN  gl_entry_detail  det  ON det.header_id = h.id
      JOIN  gl_account       a    ON det.account_id = a.id
      WHERE h.period_id = ANY($1::int[])
        AND h.status = 'Posted'
    `;
    const params = [periodIds];

    if (doc_date_from) { params.push(doc_date_from);  sql += ` AND h.doc_date >= $${params.length}`; }
    if (doc_date_to)   { params.push(doc_date_to);    sql += ` AND h.doc_date <= $${params.length}`; }

    if (doc_codes) {
      const codes = doc_codes.split(',').map(c => c.trim()).filter(Boolean);
      if (codes.length > 0) { params.push(codes); sql += ` AND d.doc_code = ANY($${params.length}::text[])`; }
    }

    if (doc_no_from) { params.push(doc_no_from); sql += ` AND h.doc_no >= $${params.length}`; }
    if (doc_no_to)   { params.push(doc_no_to);   sql += ` AND h.doc_no <= $${params.length}`; }

    if (ref_doc_codes) {
      const codes = ref_doc_codes.split(',').map(c => c.trim()).filter(Boolean);
      if (codes.length > 0) { params.push(codes); sql += ` AND rd.doc_code = ANY($${params.length}::text[])`; }
    }

    if (ref_doc_no_from)   { params.push(ref_doc_no_from);   sql += ` AND h.ref_doc_no >= $${params.length}`; }
    if (ref_doc_no_to)     { params.push(ref_doc_no_to);     sql += ` AND h.ref_doc_no <= $${params.length}`; }
    if (ref_doc_date_from) { params.push(ref_doc_date_from); sql += ` AND h.ref_doc_date >= $${params.length}`; }
    if (ref_doc_date_to)   { params.push(ref_doc_date_to);   sql += ` AND h.ref_doc_date <= $${params.length}`; }

    // Order: by header (date, doc_code, doc_no), then detail (debit rows first, then by account_code)
    sql += `
      ORDER BY h.doc_date ASC, d.doc_code ASC, h.doc_no ASC,
               CASE WHEN det.debit_lc > 0 THEN 0 ELSE 1 END ASC,
               a.account_code ASC
    `;

    const result = await client.query(sql, params);

    // 3. Group flat rows into headers with nested details (preserving order)
    const headerMap = new Map();
    for (const row of result.rows) {
      if (!headerMap.has(row.header_id)) {
        headerMap.set(row.header_id, {
          header_id:       row.header_id,
          doc_date:        row.doc_date,
          doc_code:        row.doc_code,
          doc_name_thai:   row.doc_name_thai,
          doc_no:          row.doc_no,
          description:     row.header_desc,
          ref_doc_code:    row.ref_doc_code,
          ref_doc_name:    row.ref_doc_name,
          ref_doc_no:      row.ref_doc_no,
          ref_doc_date:    row.ref_doc_date,
          total_debit_lc:  Number(row.total_debit_lc)  || 0,
          total_credit_lc: Number(row.total_credit_lc) || 0,
          details: [],
        });
      }
      headerMap.get(row.header_id).details.push({
        detail_id:          row.detail_id,
        line_no:            row.line_no,
        account_code:       row.account_code,
        account_name_thai:  row.account_name_thai,
        description:        row.detail_desc,
        debit_lc:           Number(row.debit_lc)  || 0,
        credit_lc:          Number(row.credit_lc) || 0,
        branch_id:          row.branch_id,
        business_unit_id:   row.business_unit_id,
        project_id:         row.project_id,
      });
    }

    res.json(Array.from(headerMap.values()));
  } catch (err) {
    console.error('Daily transaction report error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

// Returns all active document types: GL types and non-GL types (for filter dropdowns)
const getDocTypes = async (req, res) => {
  const client = await req.dbPool.connect();
  try {
    const result = await client.query(`
      SELECT id, doc_code, doc_name_thai, sys_module
      FROM sa_module_document
      WHERE is_doc_type = TRUE AND is_active = TRUE
      ORDER BY sys_module, doc_code
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('getDocTypes error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

module.exports = { getDailyTransactions, getDocTypes };
