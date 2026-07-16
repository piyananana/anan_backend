// controllers/gl/glTrialBalanceReportController.js

const getTrialBalance = async (req, res) => {
  const { fiscal_year_id, period_id, show_dimensions, hide_zero, show_header_totals, branch_id } = req.query;
  const branchId = branch_id ? parseInt(branch_id) : null;

  // Convert string 'true'/'false' to boolean for easier logic
  const isShowDim = show_dimensions === 'true';
  const isHideZero = hide_zero === 'true';

  try {
    const client = await req.dbPool.connect();
    try {
      // 1. หา Period Config
      const periodsRes = await client.query(
        `SELECT id, period_number FROM gl_posting_period 
         WHERE fiscal_year_id = $1 ORDER BY period_number ASC`,
        [fiscal_year_id]
      );
      if (periodsRes.rows.length === 0) return res.status(400).json({ error: 'No periods found' });

      const allPeriods = periodsRes.rows; // เรียงตาม period_number ASC
      // งวดแรกสุด = งวดยกยอด, งวดที่เหลือ = งวดปกติ
      const begPeriod = allPeriods[0];
      const normalPeriods = allPeriods.slice(1);
      const begPeriodIds = begPeriod ? [begPeriod.id] : [];

      let targetPeriodIds = [];
      let prevPeriodIds = [];

      if (period_id) {
        const pIndex = normalPeriods.findIndex(p => p.id == period_id);
        if (pIndex === -1) return res.status(400).json({ error: 'Period not found' });
        targetPeriodIds = [period_id];
        prevPeriodIds = normalPeriods.slice(0, pIndex).map(p => p.id);
      } else {
        targetPeriodIds = normalPeriods.map(p => p.id);
        prevPeriodIds = [];
      }

      // 2. ดึงผังบัญชีทั้งหมด (เพิ่ม parent_id)
      const accountsRes = await client.query(`
        SELECT id, account_code, account_name_thai, account_name_eng, parent_id, is_normal_account
        FROM gl_account
        ORDER BY account_code ASC
      `);
      const allAccounts = accountsRes.rows;

      // 3. เตรียม SQL Parts
      // dimFields: ใช้ c. prefix ภายใน CTEs ที่มี JOIN gl_dim_combination c
      const dimFields = isShowDim
        ? ', c.branch_id, c.dim1_id, c.dim2_id, c.dim3_id, c.dim4_id, c.dim5_id'
        : '';

      // dimFieldsPlain: ใช้ใน all_keys CTE (ไม่มี alias)
      const dimFieldsPlain = isShowDim
        ? ', branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id'
        : '';

      // dimFieldsT: ใช้ใน main SELECT (FROM all_keys t)
      const dimFieldsT = isShowDim
        ? ', t.branch_id, t.dim1_id, t.dim2_id, t.dim3_id, t.dim4_id, t.dim5_id'
        : '';

      // Join Condition สำหรับ CTEs (ต้อง handle NULL ด้วย IS NOT DISTINCT FROM)
      const dimJoinCondition = isShowDim
        ? `AND t.branch_id IS NOT DISTINCT FROM alias.branch_id
           AND t.dim1_id IS NOT DISTINCT FROM alias.dim1_id
           AND t.dim2_id IS NOT DISTINCT FROM alias.dim2_id
           AND t.dim3_id IS NOT DISTINCT FROM alias.dim3_id
           AND t.dim4_id IS NOT DISTINCT FROM alias.dim4_id
           AND t.dim5_id IS NOT DISTINCT FROM alias.dim5_id`
        : '';

      // ส่วน Join ไปหา Master Data เพื่อเอารหัส (Code) — ใช้ t. เพราะ FROM all_keys t
      const masterJoins = isShowDim
        ? `LEFT JOIN cd_branch br ON t.branch_id = br.id
           LEFT JOIN gl_dimension_value v1 ON v1.id = t.dim1_id
           LEFT JOIN gl_dimension_value v2 ON v2.id = t.dim2_id`
        : '';

      const masterSelects = isShowDim
        ? ', br.branch_code, v1.value_code AS dim1_code, v1.value_name_thai AS dim1_name, v2.value_code AS dim2_code, v2.value_name_thai AS dim2_name'
        : '';

      const sql = `
        WITH
        year_beg AS (
          SELECT account_id ${dimFields}, SUM(debit_amount) as dr, SUM(credit_amount) as cr
          FROM gl_balance_accum t
          JOIN gl_dim_combination c ON c.id = t.combo_id
          WHERE period_id = ANY($1::int[])
            AND ($4::int IS NULL OR c.branch_id = $4)
          GROUP BY account_id ${dimFields}
        ),
        prev_mvmt AS (
          SELECT account_id ${dimFields}, SUM(debit_amount) as dr, SUM(credit_amount) as cr
          FROM gl_balance_accum t
          JOIN gl_dim_combination c ON c.id = t.combo_id
          WHERE period_id = ANY($2::int[])
            AND ($4::int IS NULL OR c.branch_id = $4)
          GROUP BY account_id ${dimFields}
        ),
        curr_mvmt AS (
          SELECT account_id ${dimFields}, SUM(debit_amount) as dr, SUM(credit_amount) as cr
          FROM gl_balance_accum t
          JOIN gl_dim_combination c ON c.id = t.combo_id
          WHERE period_id = ANY($3::int[])
            AND ($4::int IS NULL OR c.branch_id = $4)
          GROUP BY account_id ${dimFields}
        ),
        -- รวม Keys ทั้งหมดที่เกิดขึ้นในระบบ (Union Distinct)
        all_keys AS (
          SELECT account_id ${dimFieldsPlain} FROM year_beg
          UNION SELECT account_id ${dimFieldsPlain} FROM prev_mvmt
          UNION SELECT account_id ${dimFieldsPlain} FROM curr_mvmt
        )
        SELECT
          t.account_id,
          a.account_code,
          a.account_name_thai,
          a.account_name_eng,
          a.parent_id,         -- [สำคัญ] สำหรับคำนวณ Level ที่ Frontend
          a.is_normal_account
          ${dimFieldsT}
          ${masterSelects},    -- [สำคัญ] รหัส BU/Branch/Project
          
          -- คำนวณยอดรวม
          COALESCE(yb.dr, 0) + COALESCE(pm.dr, 0) as beg_dr,
          COALESCE(yb.cr, 0) + COALESCE(pm.cr, 0) as beg_cr,
          COALESCE(cm.dr, 0) as mvmt_dr,
          COALESCE(cm.cr, 0) as mvmt_cr

        FROM all_keys t
        LEFT JOIN gl_account a ON t.account_id = a.id
        LEFT JOIN year_beg yb ON t.account_id = yb.account_id ${dimJoinCondition.replace(/alias/g, 'yb')}
        LEFT JOIN prev_mvmt pm ON t.account_id = pm.account_id ${dimJoinCondition.replace(/alias/g, 'pm')}
        LEFT JOIN curr_mvmt cm ON t.account_id = cm.account_id ${dimJoinCondition.replace(/alias/g, 'cm')}
        ${masterJoins}
        ORDER BY a.account_code ASC
      `;

      const balancesRes = await client.query(sql, [begPeriodIds, prevPeriodIds, targetPeriodIds, branchId]);
      const balances = balancesRes.rows;

      // 4. Merge Data & Calculate Rollup (In-Memory)
      const accMap = {};
      
      // Init Map from All Accounts (เพื่อให้ได้บัญชีครบทุกตัว แม้ไม่มี transaction)
      allAccounts.forEach(acc => {
        accMap[acc.id] = {
          ...acc,
          children: [],
          beg_dr: 0, beg_cr: 0,
          mvmt_dr: 0, mvmt_cr: 0,
          dimension_rows: [] 
        };
      });

      // Build Hierarchy Tree
      allAccounts.forEach(acc => {
        if (acc.parent_id && accMap[acc.parent_id]) {
          accMap[acc.parent_id].children.push(accMap[acc.id]);
        }
      });

      // Fill Values from Query Result
      balances.forEach(row => {
        if (accMap[row.account_id]) {
          const acc = accMap[row.account_id];
          const bDr = Number(row.beg_dr);
          const bCr = Number(row.beg_cr);
          const mDr = Number(row.mvmt_dr);
          const mCr = Number(row.mvmt_cr);

          // เก็บข้อมูล Dimension แยกไว้ใน Array ของ Account นั้นๆ
          if (isShowDim) {
             acc.dimension_rows.push({
               branch_code: row.branch_code,
               dim1_code: row.dim1_code,
               dim1_name: row.dim1_name,
               dim2_code: row.dim2_code,
               dim2_name: row.dim2_name,
               beg_dr: bDr, beg_cr: bCr,
               mvmt_dr: mDr, mvmt_cr: mCr
             });
          }

          // รวมยอดเข้าตัว Account หลัก
          acc.beg_dr += bDr;
          acc.beg_cr += bCr;
          acc.mvmt_dr += mDr;
          acc.mvmt_cr += mCr;
        }
      });

      // Recursive Roll-up Function (รวมยอดลูกสู่แม่)
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

      // Calculate starting from Roots
      const rootAccounts = allAccounts.filter(a => !a.parent_id).map(a => accMap[a.id]);
      rootAccounts.forEach(root => calculateRollup(root));

      // 5. Flatten Result
      let resultList = allAccounts.map(a => {
        const d = accMap[a.id];
        // Net Beginning Balance (แสดงในฝั่งเดียวเหมือนยอดยกไป)
        const netBeg = d.beg_dr - d.beg_cr;
        const beg_dr_net = netBeg > 0 ? netBeg : 0;
        const beg_cr_net = netBeg < 0 ? Math.abs(netBeg) : 0;
        // Net Ending Balance
        const netEnd = netBeg + (d.mvmt_dr - d.mvmt_cr);
        const end_dr = netEnd > 0 ? netEnd : 0;
        const end_cr = netEnd < 0 ? Math.abs(netEnd) : 0;

        return {
          account_id: d.id,
          account_code: d.account_code,
          account_name_thai: d.account_name_thai,
          account_name_eng: d.account_name_eng,
          parent_id: d.parent_id, // ส่งกลับไปให้ Frontend
          is_header: !d.is_normal_account,
          // Values
          beg_dr: beg_dr_net, beg_cr: beg_cr_net,
          mvmt_dr: d.mvmt_dr, mvmt_cr: d.mvmt_cr,
          end_dr: end_dr, end_cr: end_cr,
          // Dimensions (net beg ด้วยเช่นกัน)
          dimension_rows: (d.dimension_rows || []).map(dim => {
            const dimNetBeg = dim.beg_dr - dim.beg_cr;
            return {
              ...dim,
              beg_dr: dimNetBeg > 0 ? dimNetBeg : 0,
              beg_cr: dimNetBeg < 0 ? Math.abs(dimNetBeg) : 0,
            };
          })
        };
      });

      // 6. Filter Hide Zero
      if (isHideZero) {
        resultList = resultList.filter(row => {
          const totalVal = row.beg_dr + row.beg_cr + row.mvmt_dr + row.mvmt_cr + row.end_dr + row.end_cr;
          return Math.abs(totalVal) > 0.001; 
        });
      }

      res.json(resultList);

    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getTrialBalance };
