// controllers/gl/glIncomeStatementController.js

const getIncomeStatement = async (req, res) => {
  const { fiscal_year_id, period_id } = req.query;

  if (!fiscal_year_id) {
    return res.status(400).json({ error: 'fiscal_year_id is required' });
  }

  try {
    const client = await req.dbPool.connect();
    try {
      // 1. Period Config — skip period 1 (opening balance)
      const periodsRes = await client.query(
        `SELECT id, period_number FROM gl_posting_period
         WHERE fiscal_year_id = $1 ORDER BY period_number ASC`,
        [fiscal_year_id]
      );
      if (periodsRes.rows.length === 0) {
        return res.status(400).json({ error: 'No periods found for this fiscal year' });
      }

      const normalPeriods = periodsRes.rows.slice(1); // period 2+ only

      let targetPeriodIds = [];
      if (period_id) {
        const pIndex = normalPeriods.findIndex(p => p.id == period_id);
        if (pIndex === -1) return res.status(400).json({ error: 'Period not found' });
        targetPeriodIds = normalPeriods.slice(0, pIndex + 1).map(p => p.id);
      } else {
        targetPeriodIds = normalPeriods.map(p => p.id);
      }

      if (targetPeriodIds.length === 0) {
        return res.json([]);
      }

      // 2. Fetch REVENUE and EXPENSE accounts
      const accountsRes = await client.query(`
        SELECT id, account_code, account_name_thai, parent_id,
               is_control_account, account_type, normal_balance
        FROM gl_account
        WHERE account_type IN ('REVENUE', 'EXPENSE')
        ORDER BY account_code ASC
      `);
      const allAccounts = accountsRes.rows;
      if (allAccounts.length === 0) return res.json([]);

      const allAccountIds = allAccounts.map(a => a.id);

      // 3. Query balances for target periods
      const balancesRes = await client.query(`
        SELECT account_id,
               COALESCE(SUM(debit_amount),  0) AS total_dr,
               COALESCE(SUM(credit_amount), 0) AS total_cr
        FROM gl_balance_accum
        WHERE period_id  = ANY($1::int[])
          AND account_id = ANY($2::int[])
        GROUP BY account_id
      `, [targetPeriodIds, allAccountIds]);

      // 4. Build accMap and hierarchy
      const accMap = {};
      allAccounts.forEach(acc => {
        accMap[acc.id] = { ...acc, children: [], total_dr: 0, total_cr: 0 };
      });
      allAccounts.forEach(acc => {
        if (acc.parent_id && accMap[acc.parent_id]) {
          accMap[acc.parent_id].children.push(accMap[acc.id]);
        }
      });

      // 5. Fill balances
      balancesRes.rows.forEach(row => {
        if (accMap[row.account_id]) {
          accMap[row.account_id].total_dr += Number(row.total_dr);
          accMap[row.account_id].total_cr += Number(row.total_cr);
        }
      });

      // 6. Rollup header accounts
      const calculateRollup = (node) => {
        if (!node.is_control_account) {
          let h_dr = 0, h_cr = 0;
          node.children.forEach(child => {
            calculateRollup(child);
            h_dr += child.total_dr;
            h_cr += child.total_cr;
          });
          node.total_dr = h_dr;
          node.total_cr = h_cr;
        }
      };

      const rootAccounts = allAccounts
        .filter(a => !a.parent_id || !accMap[a.parent_id])
        .map(a => accMap[a.id]);
      rootAccounts.forEach(root => calculateRollup(root));

      // 7. Flatten result
      const resultList = allAccounts.map(a => {
        const d = accMap[a.id];
        const netEnd    = d.total_dr - d.total_cr;
        const endBalance = d.normal_balance === 'DEBIT' ? netEnd : -netEnd;

        return {
          account_id:        d.id,
          account_code:      d.account_code,
          account_name_thai: d.account_name_thai,
          parent_id:         d.parent_id,
          is_header:         !d.is_control_account,
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
    console.error('Income statement error:', err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getIncomeStatement };
