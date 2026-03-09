// controllers/gl/glYearEndClosingController.js
// Year-end closing: 6-step wizard

// ─── Helpers ─────────────────────────────────────────────────────────────────

const generateDocNo = async (client, docId, date) => {
  const docConfigRes = await client.query(
    `SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]
  );
  const config = docConfigRes.rows[0];
  if (!config || !config.is_auto_numbering) return null;

  let docNo = config.format_prefix || '';
  if (config.format_suffix_date) {
    const d = new Date(date);
    const year  = d.getFullYear().toString();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day   = d.getDate().toString().padStart(2, '0');
    if (config.format_suffix_date === 'YY')       docNo += year.substring(2);
    else if (config.format_suffix_date === 'YYYY') docNo += year;
    else if (config.format_suffix_date === 'YYMM') docNo += year.substring(2) + month;
    else if (config.format_suffix_date === 'YYYYMM') docNo += year + month;
    else if (config.format_suffix_date === 'YYYYMMDD') docNo += year + month + day;
  }
  if (config.format_separator) docNo += config.format_separator;
  docNo += config.next_running_number.toString().padStart(config.running_length, '0');
  await client.query(
    `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
    [docId]
  );
  return docNo;
};

const updateBalanceAccum = async (client, headerId, isReverse = false) => {
  const detailsRes = await client.query(`SELECT * FROM gl_entry_detail WHERE header_id = $1`, [headerId]);
  const headerRes  = await client.query(`SELECT * FROM gl_entry_header WHERE id = $1`, [headerId]);
  const header  = headerRes.rows[0];
  const details = detailsRes.rows;
  const multiplier = isReverse ? -1 : 1;

  for (const row of details) {
    const debit    = (Number(row.debit_lc)  || 0) * multiplier;
    const credit   = (Number(row.credit_lc) || 0) * multiplier;
    const netChange = debit - credit;
    await client.query(`
      INSERT INTO gl_balance_accum
        (period_id, account_id, branch_id, project_id, business_unit_id, currency_id,
         debit_amount, credit_amount, end_balance, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (period_id, account_id, branch_id, project_id, business_unit_id, currency_id)
      DO UPDATE SET
        debit_amount  = gl_balance_accum.debit_amount  + EXCLUDED.debit_amount,
        credit_amount = gl_balance_accum.credit_amount + EXCLUDED.credit_amount,
        end_balance   = gl_balance_accum.end_balance   + (EXCLUDED.debit_amount - EXCLUDED.credit_amount),
        updated_at    = NOW()
    `, [
      header.period_id,
      row.account_id,
      row.branch_id        || 0,
      row.project_id       || 0,
      row.business_unit_id || 0,
      header.currency_id   || 1,
      debit, credit, netChange,
    ]);
  }
};

// Insert a GL entry bypassing OPEN check (closing entries go into any period)
const createClosingEntry = async (client, { docId, docNo, docDate, periodId, description, details, createdBy }) => {
  const totalDebit  = details.reduce((s, d) => s + (Number(d.debit_lc)  || 0), 0);
  const totalCredit = details.reduce((s, d) => s + (Number(d.credit_lc) || 0), 0);

  const headerRes = await client.query(`
    INSERT INTO gl_entry_header
      (doc_id, doc_no, doc_date, posting_date, period_id, description,
       currency_id, exchange_rate, status,
       total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc, created_by)
    VALUES ($1,$2,$3,$3,$4,$5, 1,1,'Posted', $6,$7,$6,$7,$8)
    RETURNING id
  `, [docId, docNo, docDate, periodId, description, totalDebit, totalCredit, createdBy || 1]);
  const headerId = headerRes.rows[0].id;

  let lineNo = 1;
  for (const d of details) {
    await client.query(`
      INSERT INTO gl_entry_detail
        (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc,
         branch_id, project_id, business_unit_id)
      VALUES ($1,$2,$3,$4,$5,$6,$5,$6, NULL,NULL,NULL)
    `, [headerId, lineNo++, d.account_id, d.description || description, d.debit_lc || 0, d.credit_lc || 0]);
  }

  await updateBalanceAccum(client, headerId, false);
  return headerId;
};

// ─── Endpoints ────────────────────────────────────────────────────────────────

// GET /gl_year_end_closing/:fiscalYearId  — get or init closing session
const getOrInitClosing = async (req, res) => {
  const { fiscalYearId } = req.params;
  try {
    let result = await req.dbPool.query(
      `SELECT * FROM gl_year_end_closing WHERE fiscal_year_id = $1 ORDER BY id DESC LIMIT 1`,
      [fiscalYearId]
    );
    if (result.rows.length === 0) {
      result = await req.dbPool.query(
        `INSERT INTO gl_year_end_closing (fiscal_year_id) VALUES ($1) RETURNING *`,
        [fiscalYearId]
      );
    }
    res.status(200).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /gl_year_end_closing/:id/step1  — checklist validation
const runStep1 = async (req, res) => {
  const { id } = req.params;
  const pool = req.dbPool;
  try {
    const closingRes = await pool.query(`SELECT * FROM gl_year_end_closing WHERE id = $1`, [id]);
    const closing = closingRes.rows[0];
    const fyId = closing.fiscal_year_id;

    // Check unposted entries
    const unpostedRes = await pool.query(`
      SELECT COUNT(*) AS cnt FROM gl_entry_header h
      JOIN gl_posting_period p ON p.id = h.period_id
      WHERE p.fiscal_year_id = $1 AND h.status = 'Draft'
    `, [fyId]);
    const unpostedCount = Number(unpostedRes.rows[0].cnt);

    // Check balanced periods
    const unbalancedRes = await pool.query(`
      SELECT COUNT(*) AS cnt FROM gl_entry_header h
      JOIN gl_posting_period p ON p.id = h.period_id
      WHERE p.fiscal_year_id = $1 AND h.status = 'Posted'
        AND ABS(h.total_debit_lc - h.total_credit_lc) > 0.01
    `, [fyId]);
    const unbalancedCount = Number(unbalancedRes.rows[0].cnt);

    const step1Result = { unposted_count: unpostedCount, unbalanced_count: unbalancedCount };
    const ok = unpostedCount === 0 && unbalancedCount === 0;

    await pool.query(
      `UPDATE gl_year_end_closing SET step1_checklist_ok=$1, step1_result=$2, updated_at=NOW() WHERE id=$3`,
      [ok, JSON.stringify(step1Result), id]
    );

    res.status(200).json({ ok, ...step1Result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /gl_year_end_closing/:id/step3/preview  — preview closing entries (revenue/expense → income summary)
const previewStep3 = async (req, res) => {
  const { id } = req.params;
  const pool = req.dbPool;
  try {
    const closingRes = await pool.query(`SELECT * FROM gl_year_end_closing WHERE id = $1`, [id]);
    const closing = closingRes.rows[0];
    const fyId = closing.fiscal_year_id;

    const configRes = await pool.query(`SELECT * FROM gl_closing_config LIMIT 1`);
    if (configRes.rows.length === 0) return res.status(400).json({ message: 'Closing config not set' });
    const config = configRes.rows[0];

    // Net balance per account (debit positive, credit negative) for Rev/Exp accounts
    const balRes = await pool.query(`
      SELECT
        a.id          AS account_id,
        a.account_code,
        a.account_name_thai,
        a.account_type,
        COALESCE(SUM(d.debit_lc - d.credit_lc), 0) AS net_balance
      FROM gl_account a
      JOIN gl_entry_detail d ON d.account_id = a.id
      JOIN gl_entry_header h ON h.id = d.header_id AND h.status = 'Posted'
      JOIN gl_posting_period p ON p.id = h.period_id AND p.fiscal_year_id = $1
      WHERE a.account_type = ANY($2::text[]) OR a.account_type = ANY($3::text[])
      GROUP BY a.id, a.account_code, a.account_name_thai, a.account_type
      HAVING ABS(SUM(d.debit_lc - d.credit_lc)) > 0.001
      ORDER BY a.account_code
    `, [fyId, config.revenue_account_types, config.expense_account_types]);

    res.status(200).json(balRes.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /gl_year_end_closing/:id/step3/confirm  — create closing entry
const confirmStep3 = async (req, res) => {
  const { id } = req.params;
  const { doc_date, created_by } = req.body;
  const pool = req.dbPool;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const closingRes = await client.query(`SELECT * FROM gl_year_end_closing WHERE id = $1`, [id]);
    const closing = closingRes.rows[0];
    if (closing.step3_closing_ok) throw new Error('Step 3 already completed');
    const fyId = closing.fiscal_year_id;

    const configRes = await client.query(`SELECT * FROM gl_closing_config LIMIT 1`);
    if (configRes.rows.length === 0) throw new Error('Closing config not set');
    const config = configRes.rows[0];

    // Get last period of fiscal year for the closing entry
    const periodRes = await client.query(`
      SELECT id FROM gl_posting_period
      WHERE fiscal_year_id = $1
      ORDER BY period_end_date DESC LIMIT 1
    `, [fyId]);
    if (periodRes.rows.length === 0) throw new Error('No posting periods found');
    const closingPeriodId = periodRes.rows[0].id;

    // Calculate net balances for revenue and expense accounts
    const balRes = await client.query(`
      SELECT
        a.id AS account_id, a.account_type,
        COALESCE(SUM(d.debit_lc - d.credit_lc), 0) AS net_balance
      FROM gl_account a
      JOIN gl_entry_detail d ON d.account_id = a.id
      JOIN gl_entry_header h ON h.id = d.header_id AND h.status = 'Posted'
      JOIN gl_posting_period p ON p.id = h.period_id AND p.fiscal_year_id = $1
      WHERE a.account_type = ANY($2::text[]) OR a.account_type = ANY($3::text[])
      GROUP BY a.id, a.account_type
      HAVING ABS(SUM(d.debit_lc - d.credit_lc)) > 0.001
    `, [fyId, config.revenue_account_types, config.expense_account_types]);

    if (balRes.rows.length === 0) throw new Error('No revenue/expense balances to close');

    // Build entry details: reverse each account's balance to bring to zero
    const details = [];
    let incomeSummaryNet = 0;

    for (const row of balRes.rows) {
      const net = Number(row.net_balance);
      // To close: entry opposite of current balance
      if (net > 0) {
        // Debit balance → credit to close
        details.push({ account_id: row.account_id, debit_lc: 0, credit_lc: net });
        incomeSummaryNet -= net; // income summary gets debit
      } else if (net < 0) {
        // Credit balance → debit to close
        details.push({ account_id: row.account_id, debit_lc: -net, credit_lc: 0 });
        incomeSummaryNet += (-net); // income summary gets credit
      }
    }

    // Income summary account receives the net
    // incomeSummaryNet > 0 = net credit (profit) → credit income summary
    // incomeSummaryNet < 0 = net debit  (loss)   → debit  income summary
    if (incomeSummaryNet > 0) {
      details.push({ account_id: config.income_summary_account_id, debit_lc: 0, credit_lc: incomeSummaryNet });
    } else if (incomeSummaryNet < 0) {
      details.push({ account_id: config.income_summary_account_id, debit_lc: -incomeSummaryNet, credit_lc: 0 });
    }

    // Generate doc no
    let docNo = 'CLOSE-AUTO';
    if (config.closing_doc_id) {
      docNo = await generateDocNo(client, config.closing_doc_id, doc_date) || docNo;
    }

    const entryId = await createClosingEntry(client, {
      docId: config.closing_doc_id || 1,
      docNo,
      docDate: doc_date,
      periodId: closingPeriodId,
      description: 'ปิดบัญชีรายได้และค่าใช้จ่าย',
      details,
      createdBy: created_by,
    });

    await client.query(
      `UPDATE gl_year_end_closing SET step3_closing_ok=TRUE, step3_entry_id=$1, updated_at=NOW() WHERE id=$2`,
      [entryId, id]
    );

    await client.query('COMMIT');
    res.status(200).json({ ok: true, entry_id: entryId, doc_no: docNo });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

// GET /gl_year_end_closing/:id/step4/preview  — preview net income transfer to retained earnings
const previewStep4 = async (req, res) => {
  const { id } = req.params;
  const pool = req.dbPool;
  try {
    const closingRes = await pool.query(`SELECT * FROM gl_year_end_closing WHERE id = $1`, [id]);
    const closing = closingRes.rows[0];
    if (!closing.step3_closing_ok) return res.status(400).json({ message: 'Complete step 3 first' });

    const configRes = await pool.query(`SELECT * FROM gl_closing_config LIMIT 1`);
    const config = configRes.rows[0];

    // Net balance of income summary account
    const balRes = await pool.query(`
      SELECT COALESCE(SUM(d.debit_lc - d.credit_lc), 0) AS net_balance
      FROM gl_entry_detail d
      JOIN gl_entry_header h ON h.id = d.header_id AND h.status = 'Posted'
      JOIN gl_posting_period p ON p.id = h.period_id AND p.fiscal_year_id = $1
      WHERE d.account_id = $2
    `, [closing.fiscal_year_id, config.income_summary_account_id]);

    // netIncome = debit - credit of income summary:
    //   < 0 = credit balance = PROFIT   → display as positive
    //   > 0 = debit  balance = LOSS     → display as negative
    const netIncome = Number(balRes.rows[0].net_balance);

    res.status(200).json({
      income_summary_account_id: config.income_summary_account_id,
      retained_earnings_account_id: config.retained_earnings_account_id,
      net_income: -netIncome,  // positive = profit, negative = loss
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /gl_year_end_closing/:id/step4/confirm  — transfer net income to retained earnings
const confirmStep4 = async (req, res) => {
  const { id } = req.params;
  const { doc_date, created_by } = req.body;
  const pool = req.dbPool;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const closingRes = await client.query(`SELECT * FROM gl_year_end_closing WHERE id = $1`, [id]);
    const closing = closingRes.rows[0];
    if (!closing.step3_closing_ok) throw new Error('Complete step 3 first');
    if (closing.step4_transfer_ok) throw new Error('Step 4 already completed');

    const configRes = await client.query(`SELECT * FROM gl_closing_config LIMIT 1`);
    const config = configRes.rows[0];

    const periodRes = await client.query(`
      SELECT id FROM gl_posting_period
      WHERE fiscal_year_id = $1
      ORDER BY period_end_date DESC LIMIT 1
    `, [closing.fiscal_year_id]);
    const closingPeriodId = periodRes.rows[0].id;

    // Net balance of income summary account (after step 3)
    const balRes = await client.query(`
      SELECT COALESCE(SUM(d.debit_lc - d.credit_lc), 0) AS net_balance
      FROM gl_entry_detail d
      JOIN gl_entry_header h ON h.id = d.header_id AND h.status = 'Posted'
      JOIN gl_posting_period p ON p.id = h.period_id AND p.fiscal_year_id = $1
      WHERE d.account_id = $2
    `, [closing.fiscal_year_id, config.income_summary_account_id]);

    // netIncome = SUM(debit_lc - credit_lc) of income summary account
    //   < 0 = credit balance = PROFIT  (revenue > expense)
    //   > 0 = debit  balance = LOSS    (expense > revenue)
    const netIncome = Number(balRes.rows[0].net_balance);
    if (Math.abs(netIncome) < 0.001) throw new Error('Net income is zero — nothing to transfer');

    const details = [];
    if (netIncome < 0) {
      // Profit: income summary has credit balance → debit it to close, credit retained earnings
      const profit = -netIncome;
      details.push({ account_id: config.income_summary_account_id,    debit_lc: profit, credit_lc: 0 });
      details.push({ account_id: config.retained_earnings_account_id, debit_lc: 0,      credit_lc: profit });
    } else {
      // Loss: income summary has debit balance → credit it to close, debit retained earnings
      details.push({ account_id: config.income_summary_account_id,    debit_lc: 0,        credit_lc: netIncome });
      details.push({ account_id: config.retained_earnings_account_id, debit_lc: netIncome, credit_lc: 0 });
    }

    let docNo = 'TRANSFER-AUTO';
    if (config.closing_doc_id) {
      docNo = await generateDocNo(client, config.closing_doc_id, doc_date) || docNo;
    }

    const entryId = await createClosingEntry(client, {
      docId: config.closing_doc_id || 1,
      docNo,
      docDate: doc_date,
      periodId: closingPeriodId,
      description: 'โอนกำไร/ขาดทุนสุทธิเข้ากำไรสะสม',
      details,
      createdBy: created_by,
    });

    await client.query(
      `UPDATE gl_year_end_closing SET step4_transfer_ok=TRUE, step4_entry_id=$1, updated_at=NOW() WHERE id=$2`,
      [entryId, id]
    );

    await client.query('COMMIT');
    res.status(200).json({ ok: true, entry_id: entryId, doc_no: docNo, net_income: -netIncome });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

// GET /gl_year_end_closing/:id/step5/preview  — preview carry-forward balances (B/S accounts)
const previewStep5 = async (req, res) => {
  const { id } = req.params;
  const pool = req.dbPool;
  try {
    const closingRes = await pool.query(`SELECT * FROM gl_year_end_closing WHERE id = $1`, [id]);
    const closing = closingRes.rows[0];
    if (!closing.step4_transfer_ok) return res.status(400).json({ message: 'Complete step 4 first' });

    const configRes = await pool.query(`SELECT * FROM gl_closing_config LIMIT 1`);
    const config = configRes.rows[0];

    const allTypes = [...config.revenue_account_types, ...config.expense_account_types];

    // Balance sheet accounts: everything that is NOT revenue/expense
    const balRes = await pool.query(`
      SELECT
        a.id AS account_id,
        a.account_code,
        a.account_name_thai,
        a.account_type,
        COALESCE(SUM(d.debit_lc - d.credit_lc), 0) AS net_balance
      FROM gl_account a
      JOIN gl_entry_detail d ON d.account_id = a.id
      JOIN gl_entry_header h ON h.id = d.header_id AND h.status = 'Posted'
      JOIN gl_posting_period p ON p.id = h.period_id AND p.fiscal_year_id = $1
      WHERE a.account_type != ALL($2::text[])
      GROUP BY a.id, a.account_code, a.account_name_thai, a.account_type
      HAVING ABS(SUM(d.debit_lc - d.credit_lc)) > 0.001
      ORDER BY a.account_code
    `, [closing.fiscal_year_id, allTypes]);

    res.status(200).json(balRes.rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /gl_year_end_closing/:id/step5/confirm  — create carry-forward GL entry in next year period 1
const confirmStep5 = async (req, res) => {
  const { id } = req.params;
  const { doc_date, next_fiscal_year_id, created_by } = req.body;
  const pool = req.dbPool;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const closingRes = await client.query(`SELECT * FROM gl_year_end_closing WHERE id = $1`, [id]);
    const closing = closingRes.rows[0];
    if (!closing.step4_transfer_ok) throw new Error('Complete step 4 first');
    if (closing.step5_carry_forward_ok) throw new Error('Step 5 already completed');

    const configRes = await client.query(`SELECT * FROM gl_closing_config LIMIT 1`);
    const config = configRes.rows[0];
    const allTypes = [...config.revenue_account_types, ...config.expense_account_types];

    // Get period 1 of next fiscal year
    const nextPeriodRes = await client.query(`
      SELECT id FROM gl_posting_period
      WHERE fiscal_year_id = $1
      ORDER BY period_start_date ASC LIMIT 1
    `, [next_fiscal_year_id]);
    if (nextPeriodRes.rows.length === 0) throw new Error('No posting periods in next fiscal year');
    const nextPeriodId = nextPeriodRes.rows[0].id;

    // Balance sheet account ending balances
    const balRes = await client.query(`
      SELECT
        a.id AS account_id,
        COALESCE(SUM(d.debit_lc - d.credit_lc), 0) AS net_balance
      FROM gl_account a
      JOIN gl_entry_detail d ON d.account_id = a.id
      JOIN gl_entry_header h ON h.id = d.header_id AND h.status = 'Posted'
      JOIN gl_posting_period p ON p.id = h.period_id AND p.fiscal_year_id = $1
      WHERE a.account_type != ALL($2::text[])
      GROUP BY a.id
      HAVING ABS(SUM(d.debit_lc - d.credit_lc)) > 0.001
    `, [closing.fiscal_year_id, allTypes]);

    if (balRes.rows.length === 0) throw new Error('No balance sheet balances to carry forward');

    const details = [];
    for (const row of balRes.rows) {
      const net = Number(row.net_balance);
      if (net > 0) {
        details.push({ account_id: row.account_id, debit_lc: net, credit_lc: 0 });
      } else if (net < 0) {
        details.push({ account_id: row.account_id, debit_lc: 0, credit_lc: -net });
      }
    }

    let docNo = 'CARRYFORWARD-AUTO';
    if (config.carry_forward_doc_id) {
      docNo = await generateDocNo(client, config.carry_forward_doc_id, doc_date) || docNo;
    }

    const entryId = await createClosingEntry(client, {
      docId: config.carry_forward_doc_id || 1,
      docNo,
      docDate: doc_date,
      periodId: nextPeriodId,
      description: 'ยกยอดงบดุลเข้าปีบัญชีใหม่',
      details,
      createdBy: created_by,
    });

    await client.query(`
      UPDATE gl_year_end_closing
      SET step5_carry_forward_ok=TRUE, step5_entry_id=$1, next_fiscal_year_id=$2, updated_at=NOW()
      WHERE id=$3
    `, [entryId, next_fiscal_year_id, id]);

    await client.query('COMMIT');
    res.status(200).json({ ok: true, entry_id: entryId, doc_no: docNo });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

// POST /gl_year_end_closing/:id/step2/confirm  — mark adjusting entries done
const confirmStep2 = async (req, res) => {
  const { id } = req.params;
  const pool = req.dbPool;
  try {
    const closingRes = await pool.query(`SELECT * FROM gl_year_end_closing WHERE id = $1`, [id]);
    const closing = closingRes.rows[0];
    if (!closing) return res.status(404).json({ message: 'Closing session not found' });
    if (!closing.step1_checklist_ok) return res.status(400).json({ message: 'Complete step 1 first' });
    if (closing.step2_adjusting_ok) return res.status(400).json({ message: 'Step 2 already completed' });

    await pool.query(
      `UPDATE gl_year_end_closing SET step2_adjusting_ok=TRUE, updated_at=NOW() WHERE id=$1`,
      [id]
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /gl_year_end_closing/:id/step6/confirm  — lock fiscal year
const confirmStep6 = async (req, res) => {
  const { id } = req.params;
  const pool = req.dbPool;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const closingRes = await client.query(`SELECT * FROM gl_year_end_closing WHERE id = $1`, [id]);
    const closing = closingRes.rows[0];
    if (!closing.step5_carry_forward_ok) throw new Error('Complete step 5 first');
    if (closing.step6_lock_ok) throw new Error('Step 6 already completed');

    const fyId = closing.fiscal_year_id;

    // Lock all posting periods of this fiscal year (set gl_status = CLOSED)
    await client.query(`
      UPDATE gl_posting_period
      SET gl_status = 'CLOSED', updated_at = NOW()
      WHERE fiscal_year_id = $1
    `, [fyId]);

    // Mark fiscal year as inactive
    await client.query(`
      UPDATE gl_fiscal_year SET is_active = FALSE, updated_at = NOW() WHERE id = $1
    `, [fyId]);

    await client.query(`
      UPDATE gl_year_end_closing
      SET step6_lock_ok=TRUE, status='COMPLETED', updated_at=NOW()
      WHERE id=$1
    `, [id]);

    await client.query('COMMIT');
    res.status(200).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

module.exports = {
  getOrInitClosing,
  runStep1,
  confirmStep2,
  previewStep3,
  confirmStep3,
  previewStep4,
  confirmStep4,
  previewStep5,
  confirmStep5,
  confirmStep6,
};
