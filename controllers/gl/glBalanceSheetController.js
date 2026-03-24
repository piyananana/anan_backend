// controllers/gl/glBalanceSheetController.js

const getBalanceSheet = async (req, res) => {
  const { fiscal_year_id, period_id } = req.query;

  if (!fiscal_year_id) {
    return res.status(400).json({ error: 'fiscal_year_id is required' });
  }

  try {
    const client = await req.dbPool.connect();
    try {
      // 1. Period Config
      const periodsRes = await client.query(
        `SELECT id, period_number FROM gl_posting_period
         WHERE fiscal_year_id = $1 ORDER BY period_number ASC`,
        [fiscal_year_id]
      );
      if (periodsRes.rows.length === 0) {
        return res.status(400).json({ error: 'No periods found for this fiscal year' });
      }

      const allPeriods = periodsRes.rows;
      const begPeriod    = allPeriods[0];
      const normalPeriods = allPeriods.slice(1);
      const begPeriodIds  = begPeriod ? [begPeriod.id] : [];

      let targetPeriodIds = [];
      let prevPeriodIds   = [];

      if (period_id) {
        const pIndex = normalPeriods.findIndex(p => p.id == period_id);
        if (pIndex === -1) return res.status(400).json({ error: 'Period not found' });
        targetPeriodIds = [period_id];
        prevPeriodIds   = normalPeriods.slice(0, pIndex).map(p => p.id);
      } else {
        targetPeriodIds = normalPeriods.map(p => p.id);
        prevPeriodIds   = [];
      }

      // 2. Get income summary account id from closing config
      let incomeSummaryId = null;
      const configRes = await client.query(`
        SELECT income_summary_account_id FROM gl_closing_config LIMIT 1
      `);
      if (configRes.rows.length > 0) {
        incomeSummaryId = configRes.rows[0].income_summary_account_id;
      }

      // 3. Calculate net income using same method as income statement:
      //    rawBal = debit_amount − credit_amount per account
      //    netRaw = Σ rawBal for all REVENUE + EXPENSE control accounts (normal periods only)
      //    netIncome = −netRaw  (negative rawBal = profit = positive netIncome)
      let netIncome = 0;

      if (incomeSummaryId) {
        const plAccountsRes = await client.query(`
          SELECT id FROM gl_account
          WHERE account_type IN ('REVENUE', 'EXPENSE') AND is_normal_account = true
        `);

        if (plAccountsRes.rows.length > 0) {
          const plAccountIds = plAccountsRes.rows.map(a => a.id);

          let plPeriodIds;
          if (period_id) {
            const pIdx = normalPeriods.findIndex(p => p.id == period_id);
            plPeriodIds = normalPeriods.slice(0, pIdx + 1).map(p => p.id);
          } else {
            plPeriodIds = normalPeriods.map(p => p.id);
          }

          if (plPeriodIds.length > 0) {
            const plResult = await client.query(`
              SELECT
                COALESCE(SUM(debit_amount),  0) AS total_dr,
                COALESCE(SUM(credit_amount), 0) AS total_cr
              FROM gl_balance_accum
              WHERE period_id  = ANY($1::int[])
                AND account_id = ANY($2::int[])
            `, [plPeriodIds, plAccountIds]);

            // netRaw = Σ(dr − cr), netIncome = −netRaw = Σ(cr − dr)
            const netRaw = Number(plResult.rows[0].total_dr)
                         - Number(plResult.rows[0].total_cr);
            netIncome = -netRaw;
          }
        }
      }

      // 4. Fetch Balance Sheet accounts (ASSET, LIABILITY, EQUITY)
      const accountsRes = await client.query(`
        SELECT id, account_code, account_name_thai, parent_id,
               is_normal_account, account_type, normal_balance
        FROM gl_account
        WHERE account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
        ORDER BY account_code ASC
      `);
      const allAccounts = accountsRes.rows;
      if (allAccounts.length === 0) return res.json([]);

      const allAccountIds = allAccounts.map(a => a.id);

      // 5. Query balances for balance sheet accounts
      const balancesRes = await client.query(`
        WITH
        year_beg AS (
          SELECT account_id, SUM(debit_amount) AS dr, SUM(credit_amount) AS cr
          FROM gl_balance_accum
          WHERE period_id = ANY($1::int[]) AND account_id = ANY($4::int[])
          GROUP BY account_id
        ),
        prev_mvmt AS (
          SELECT account_id, SUM(debit_amount) AS dr, SUM(credit_amount) AS cr
          FROM gl_balance_accum
          WHERE period_id = ANY($2::int[]) AND account_id = ANY($4::int[])
          GROUP BY account_id
        ),
        curr_mvmt AS (
          SELECT account_id, SUM(debit_amount) AS dr, SUM(credit_amount) AS cr
          FROM gl_balance_accum
          WHERE period_id = ANY($3::int[]) AND account_id = ANY($4::int[])
          GROUP BY account_id
        ),
        all_keys AS (
          SELECT account_id FROM year_beg
          UNION SELECT account_id FROM prev_mvmt
          UNION SELECT account_id FROM curr_mvmt
        )
        SELECT
          t.account_id,
          COALESCE(yb.dr, 0) + COALESCE(pm.dr, 0) AS beg_dr,
          COALESCE(yb.cr, 0) + COALESCE(pm.cr, 0) AS beg_cr,
          COALESCE(cm.dr, 0) AS mvmt_dr,
          COALESCE(cm.cr, 0) AS mvmt_cr
        FROM all_keys t
        LEFT JOIN year_beg yb ON t.account_id = yb.account_id
        LEFT JOIN prev_mvmt pm ON t.account_id = pm.account_id
        LEFT JOIN curr_mvmt cm ON t.account_id = cm.account_id
      `, [begPeriodIds, prevPeriodIds, targetPeriodIds, allAccountIds]);

      // 6. Build accMap and hierarchy
      const accMap = {};
      allAccounts.forEach(acc => {
        accMap[acc.id] = { ...acc, children: [], beg_dr: 0, beg_cr: 0, mvmt_dr: 0, mvmt_cr: 0 };
      });
      allAccounts.forEach(acc => {
        if (acc.parent_id && accMap[acc.parent_id]) {
          accMap[acc.parent_id].children.push(accMap[acc.id]);
        }
      });

      // 7. Fill balances from gl_balance_accum
      balancesRes.rows.forEach(row => {
        if (accMap[row.account_id]) {
          const acc = accMap[row.account_id];
          acc.beg_dr += Number(row.beg_dr);
          acc.beg_cr += Number(row.beg_cr);
          acc.mvmt_dr += Number(row.mvmt_dr);
          acc.mvmt_cr += Number(row.mvmt_cr);
        }
      });

      // 8. Override income summary account with calculated net income (BEFORE rollup)
      //    This ensures parent header accounts roll up the correct net income value.
      if (incomeSummaryId && accMap[incomeSummaryId]) {
        const acc = accMap[incomeSummaryId];
        acc.beg_dr = 0; acc.beg_cr = 0; acc.mvmt_dr = 0; acc.mvmt_cr = 0;
        // Set raw Dr/Cr so that end_balance = netIncome after normal_balance transform
        // CREDIT normal: end_balance = -(beg_dr - beg_cr) → set beg_cr = netIncome (profit) or beg_dr = -netIncome (loss)
        // DEBIT normal:  end_balance =  (beg_dr - beg_cr) → set beg_dr = netIncome (profit) or beg_cr = -netIncome (loss)
        if (acc.normal_balance === 'DEBIT') {
          if (netIncome >= 0) acc.beg_dr = netIncome;
          else                acc.beg_cr = -netIncome;
        } else {
          if (netIncome >= 0) acc.beg_cr = netIncome;
          else                acc.beg_dr = -netIncome;
        }
      }

      // 9. Roll-up header accounts (now includes overridden net income)
      const calculateRollup = (node) => {
        if (!node.is_normal_account) {
          let h_beg_dr = 0, h_beg_cr = 0, h_mvmt_dr = 0, h_mvmt_cr = 0;
          node.children.forEach(child => {
            calculateRollup(child);
            h_beg_dr += child.beg_dr;
            h_beg_cr += child.beg_cr;
            h_mvmt_dr += child.mvmt_dr;
            h_mvmt_cr += child.mvmt_cr;
          });
          node.beg_dr = h_beg_dr;
          node.beg_cr = h_beg_cr;
          node.mvmt_dr = h_mvmt_dr;
          node.mvmt_cr = h_mvmt_cr;
        }
      };

      const rootAccounts = allAccounts
        .filter(a => !a.parent_id || !accMap[a.parent_id])
        .map(a => accMap[a.id]);
      rootAccounts.forEach(root => calculateRollup(root));

      // 10. Flatten result
      const resultList = allAccounts.map(a => {
        const d = accMap[a.id];
        const netEnd    = (d.beg_dr - d.beg_cr) + (d.mvmt_dr - d.mvmt_cr);
        const endBalance = d.normal_balance === 'DEBIT' ? netEnd : -netEnd;

        return {
          account_id:        d.id,
          account_code:      d.account_code,
          account_name_thai: d.account_name_thai,
          parent_id:         d.parent_id,
          is_header:         !d.is_normal_account,
          account_type:      d.account_type,
          normal_balance:    d.normal_balance,
          end_balance:       endBalance,
        };
      });

      res.json(resultList);

    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Balance sheet error:', err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getBalanceSheet };
