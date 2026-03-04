// controllers/gl/glTrialBalanceReportController.js

const getTrialBalance = async (req, res) => {
  const { fiscal_year_id, period_id, show_dimensions, hide_zero, show_header_totals } = req.query;

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

      const allPeriods = periodsRes.rows;
      let targetPeriodIds = [];
      let prevPeriodIds = [];

      if (period_id) {
        const pIndex = allPeriods.findIndex(p => p.id == period_id);
        if (pIndex === -1) return res.status(400).json({ error: 'Period not found' });
        targetPeriodIds = [period_id];
        prevPeriodIds = allPeriods.slice(0, pIndex).map(p => p.id);
      } else {
        targetPeriodIds = allPeriods.map(p => p.id);
        prevPeriodIds = [];
      }

      // 2. ดึงผังบัญชีทั้งหมด (เพิ่ม parent_id)
      const accountsRes = await client.query(`
        SELECT id, account_code, account_name_thai, parent_id, is_control_account 
        FROM gl_account 
        ORDER BY account_code ASC
      `);
      const allAccounts = accountsRes.rows;

      // 3. เตรียม SQL Parts
      // สำคัญ: ต้องระบุ table alias (t.) ให้ชัดเจนใน SELECT list
      const dimFields = isShowDim 
        ? ', t.business_unit_id, t.branch_id, t.project_id' 
        : '';
      
      const dimGroup = isShowDim 
        ? ', account_id, business_unit_id, branch_id, project_id' 
        : ', account_id';

      // Join Condition สำหรับ CTEs (ต้อง handle NULL ด้วย IS NOT DISTINCT FROM)
      const dimJoinCondition = isShowDim
        ? `AND t.business_unit_id IS NOT DISTINCT FROM alias.business_unit_id 
           AND t.branch_id IS NOT DISTINCT FROM alias.branch_id 
           AND t.project_id IS NOT DISTINCT FROM alias.project_id`
        : '';

      // ส่วน Join ไปหา Master Data เพื่อเอารหัส (Code)
      const masterJoins = isShowDim
        ? `LEFT JOIN cd_business_unit bu ON t.business_unit_id = bu.id
           LEFT JOIN cd_branch br ON t.branch_id = br.id
           LEFT JOIN cd_project pj ON t.project_id = pj.id`
        : '';
      
      const masterSelects = isShowDim
        ? ', bu.bu_code, br.branch_code, pj.project_code'
        : '';

      const sql = `
        WITH 
        year_beg AS (
          SELECT account_id ${dimFields}, SUM(amount_dr) as dr, SUM(amount_cr) as cr
          FROM gl_beginning_balance t
          JOIN gl_posting_period p ON t.posting_period_id = p.id
          WHERE p.fiscal_year_id = $1
          GROUP BY account_id ${dimFields}
        ),
        prev_mvmt AS (
          SELECT account_id ${dimFields}, SUM(debit_amount) as dr, SUM(credit_amount) as cr
          FROM gl_balance_accum t
          WHERE period_id = ANY($2::int[])
          GROUP BY account_id ${dimFields}
        ),
        curr_mvmt AS (
          SELECT account_id ${dimFields}, SUM(debit_amount) as dr, SUM(credit_amount) as cr
          FROM gl_balance_accum t
          WHERE period_id = ANY($3::int[])
          GROUP BY account_id ${dimFields}
        ),
        -- รวม Keys ทั้งหมดที่เกิดขึ้นในระบบ (Union Distinct)
        all_keys AS (
          SELECT account_id ${dimFields} FROM year_beg t
          UNION SELECT account_id ${dimFields} FROM prev_mvmt t
          UNION SELECT account_id ${dimFields} FROM curr_mvmt t
        )
        SELECT 
          t.account_id,
          a.account_code, 
          a.account_name_thai,
          a.parent_id,         -- [สำคัญ] สำหรับคำนวณ Level ที่ Frontend
          a.is_control_account 
          ${dimFields}
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

      const balancesRes = await client.query(sql, [fiscal_year_id, prevPeriodIds, targetPeriodIds]);
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
               bu_code: row.bu_code,
               branch_code: row.branch_code,
               project_code: row.project_code,
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
        if (!node.is_control_account) {
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
        // Net Ending
        const netEnd = (d.beg_dr - d.beg_cr) + (d.mvmt_dr - d.mvmt_cr);
        const end_dr = netEnd > 0 ? netEnd : 0;
        const end_cr = netEnd < 0 ? Math.abs(netEnd) : 0;

        return {
          account_id: d.id,
          account_code: d.account_code,
          account_name_thai: d.account_name_thai,
          parent_id: d.parent_id, // ส่งกลับไปให้ Frontend
          is_header: !d.is_control_account,
          // Values
          beg_dr: d.beg_dr, beg_cr: d.beg_cr,
          mvmt_dr: d.mvmt_dr, mvmt_cr: d.mvmt_cr,
          end_dr: end_dr, end_cr: end_cr,
          // Dimensions
          dimension_rows: d.dimension_rows || []
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

// // controllers/glReportController.js

// const getTrialBalance = async (req, res) => {
//   const { fiscal_year_id, period_id, show_dimensions, hide_zero, show_header_totals } = req.query;

//   try {
//     const client = await req.dbPool.connect();
//     try {
//       // 1. หา Period Config
//       const periodsRes = await client.query(
//         `SELECT id, period_number FROM gl_posting_period 
//          WHERE fiscal_year_id = $1 ORDER BY period_number ASC`,
//         [fiscal_year_id]
//       );
//       if (periodsRes.rows.length === 0) return res.status(400).json({ error: 'No periods found' });

//       const allPeriods = periodsRes.rows;
//       let targetPeriodIds = []; // IDs for movement
//       let prevPeriodIds = [];   // IDs for accumulated balance

//       if (period_id) {
//         // ระบุงวด: Movement = งวดนั้น, Beg = ยกมาต้นปี + สะสมงวดก่อนหน้า
//         const pIndex = allPeriods.findIndex(p => p.id == period_id);
//         if (pIndex === -1) return res.status(400).json({ error: 'Period not found' });
//         targetPeriodIds = [period_id];
//         prevPeriodIds = allPeriods.slice(0, pIndex).map(p => p.id);
//       } else {
//         // ไม่ระบุงวด: Movement = ทั้งปี, Beg = ยกมาต้นปี
//         targetPeriodIds = allPeriods.map(p => p.id);
//         prevPeriodIds = [];
//       }

//       // 2. ดึงผังบัญชีทั้งหมด (เรียงตามรหัส)
//       const accountsRes = await client.query(`
//         SELECT id, account_code, account_name_thai, parent_id, is_control_account 
//         FROM gl_account 
//         ORDER BY account_code ASC
//       `);
//       const allAccounts = accountsRes.rows;

//       // 3. ดึงยอด Transaction (คล้าย Logic เดิม แต่ดึงเฉพาะ Detail)
//       // Note: Header Account ปกติจะไม่มี Transaction ตรงๆ (ควรเป็น 0)
//       const dimsSelect = show_dimensions === 'true' 
//           ? `, t.business_unit_id, t.branch_id, t.project_id` : ``;
//       const dimsJoin = show_dimensions === 'true'
//           ? `LEFT JOIN cd_business_unit bu ON t.business_unit_id = bu.id
//              LEFT JOIN cd_branch br ON t.branch_id = br.id
//              LEFT JOIN cd_project pj ON t.project_id = pj.id` : ``;
//       const dimsSelectName = show_dimensions === 'true'
//           ? `, bu.bu_code, br.branch_code, pj.project_code` : ``; // ใช้ Code เพื่อประหยัดที่ใน PDF
      
//       const sql = `
//         WITH 
//         year_beg AS (
//           SELECT account_id ${dimsSelect}, SUM(amount_dr) as dr, SUM(amount_cr) as cr
//           FROM gl_beginning_balance b
//           JOIN gl_posting_period p ON b.posting_period_id = p.id
//           WHERE p.fiscal_year_id = $1
//           GROUP BY account_id ${dimsSelect}
//         ),
//         prev_mvmt AS (
//           SELECT account_id ${dimsSelect}, SUM(debit_amount) as dr, SUM(credit_amount) as cr
//           FROM gl_balance_accum t
//           WHERE period_id = ANY($2::int[])
//           GROUP BY account_id ${dimsSelect}
//         ),
//         curr_mvmt AS (
//           SELECT account_id ${dimsSelect}, SUM(debit_amount) as dr, SUM(credit_amount) as cr
//           FROM gl_balance_accum t
//           WHERE period_id = ANY($3::int[])
//           GROUP BY account_id ${dimsSelect}
//         )
//         SELECT 
//           t.account_id
//           ${dimsSelect}
//           ${dimsSelectName},
//           COALESCE(yb.dr, 0) + COALESCE(pm.dr, 0) as beg_dr,
//           COALESCE(yb.cr, 0) + COALESCE(pm.cr, 0) as beg_cr,
//           COALESCE(cm.dr, 0) as mvmt_dr,
//           COALESCE(cm.cr, 0) as mvmt_cr
//         FROM (
//           SELECT account_id ${dimsSelect} FROM year_beg
//           UNION SELECT account_id ${dimsSelect} FROM prev_mvmt
//           UNION SELECT account_id ${dimsSelect} FROM curr_mvmt
//         ) t
//         LEFT JOIN year_beg yb ON t.account_id = yb.account_id ${show_dimensions === 'true' ? 'AND t.business_unit_id IS NOT DISTINCT FROM yb.business_unit_id AND t.branch_id IS NOT DISTINCT FROM yb.branch_id AND t.project_id IS NOT DISTINCT FROM yb.project_id' : ''}
//         LEFT JOIN prev_mvmt pm ON t.account_id = pm.account_id ${show_dimensions === 'true' ? 'AND t.business_unit_id IS NOT DISTINCT FROM pm.business_unit_id AND t.branch_id IS NOT DISTINCT FROM pm.branch_id AND t.project_id IS NOT DISTINCT FROM pm.project_id' : ''}
//         LEFT JOIN curr_mvmt cm ON t.account_id = cm.account_id ${show_dimensions === 'true' ? 'AND t.business_unit_id IS NOT DISTINCT FROM cm.business_unit_id AND t.branch_id IS NOT DISTINCT FROM cm.branch_id AND t.project_id IS NOT DISTINCT FROM cm.project_id' : ''}
//         ${dimsJoin}
//       `;

//       const balancesRes = await client.query(sql, [fiscal_year_id, prevPeriodIds, targetPeriodIds]);
//       const balances = balancesRes.rows;

//       // 4. Merge Data & Calculate Rollup (In-Memory)
//       // สร้าง Map เพื่อเข้าถึงง่าย
//       const accMap = {};
//       allAccounts.forEach(acc => {
//         accMap[acc.id] = {
//           ...acc,
//           children: [],
//           // Values
//           beg_dr: 0, beg_cr: 0,
//           mvmt_dr: 0, mvmt_cr: 0,
//           // สำหรับเก็บ Detail Rows (กรณีแยก Dimension)
//           dimension_rows: [] 
//         };
//       });

//       // ใส่ Hierarchy
//       allAccounts.forEach(acc => {
//         if (acc.parent_id && accMap[acc.parent_id]) {
//           accMap[acc.parent_id].children.push(accMap[acc.id]);
//         }
//       });

//       // ใส่ Balances เข้า Account
//       balances.forEach(row => {
//         if (accMap[row.account_id]) {
//           const acc = accMap[row.account_id];
//           const bDr = Number(row.beg_dr);
//           const bCr = Number(row.beg_cr);
//           const mDr = Number(row.mvmt_dr);
//           const mCr = Number(row.mvmt_cr);

//           // ถ้าแสดง Dimension ให้เก็บแยกเป็น sub-rows
//           if (show_dimensions === 'true') {
//              // ถ้าเป็นยอดรวมของ Account นี้ (ไม่มี dimension หรือ dimension รวม) บวกเข้ายอดหลักด้วย
//              // แต่ปกติ transaction จะมี dimension ติดมา
//              acc.dimension_rows.push({
//                bu_code: row.bu_code,
//                branch_code: row.branch_code,
//                project_code: row.project_code,
//                beg_dr: bDr, beg_cr: bCr,
//                mvmt_dr: mDr, mvmt_cr: mCr
//              });
//           }

//           // บวกยอดเข้าตัว Account (Base values)
//           acc.beg_dr += bDr;
//           acc.beg_cr += bCr;
//           acc.mvmt_dr += mDr;
//           acc.mvmt_cr += mCr;
//         }
//       });

//       // Recursive Roll-up Function
//       const calculateRollup = (node) => {
//         // ถ้าเป็น Control Account (Detail) ให้ใช้ยอดตัวเอง (ซึ่งบวกมาจาก Balance Query แล้ว)
//         // ถ้าเป็น Header Account (Parent) ให้รวมยอดจากลูก
//         if (!node.is_control_account) {
//           // Reset Header Value ก่อนรวม (เผื่อมีขยะ) แต่ถ้า Switch OFF อาจจะอยากให้เป็น 0
//           // แต่เราคำนวณไว้ก่อน แล้วไปซ่อนตอน Display ง่ายกว่า
//            let h_beg_dr = 0, h_beg_cr = 0, h_mvmt_dr = 0, h_mvmt_cr = 0;
           
//            node.children.forEach(child => {
//              calculateRollup(child);
//              h_beg_dr += child.beg_dr;
//              h_beg_cr += child.beg_cr;
//              h_mvmt_dr += child.mvmt_dr;
//              h_mvmt_cr += child.mvmt_cr;
//            });

//            node.beg_dr = h_beg_dr;
//            node.beg_cr = h_beg_cr;
//            node.mvmt_dr = h_mvmt_dr;
//            node.mvmt_cr = h_mvmt_cr;
//         }
//       };

//       // เริ่มคำนวณจาก Root Nodes
//       const rootAccounts = allAccounts.filter(a => !a.parent_id).map(a => accMap[a.id]);
//       rootAccounts.forEach(root => calculateRollup(root));

//       // 5. Flatten List เพื่อส่งกลับไปแสดงผล (เรียงตาม Account Code)
//       // เราใช้ allAccounts ซึ่งเรียงตาม Code ไว้อยู่แล้ว
//       // แต่ต้อง map data จาก accMap ที่คำนวณเสร็จแล้ว
//       let resultList = allAccounts.map(a => {
//         const d = accMap[a.id];
//         // คำนวณ Ending Balance
//         const netEnd = (d.beg_dr - d.beg_cr) + (d.mvmt_dr - d.mvmt_cr);
//         const end_dr = netEnd > 0 ? netEnd : 0;
//         const end_cr = netEnd < 0 ? Math.abs(netEnd) : 0;

//         return {
//           account_id: d.id,
//           account_code: d.account_code,
//           account_name_thai: d.account_name_thai,
//           is_header: !d.is_control_account,
//           // Values
//           beg_dr: d.beg_dr, beg_cr: d.beg_cr,
//           mvmt_dr: d.mvmt_dr, mvmt_cr: d.mvmt_cr,
//           end_dr: end_dr, end_cr: end_cr,
//           // Dimensions
//           dimension_rows: d.dimension_rows || []
//         };
//       });

//       // 6. Filter Hide Zero
//       if (hide_zero === 'true') {
//         resultList = resultList.filter(row => {
//           const totalVal = row.beg_dr + row.beg_cr + row.mvmt_dr + row.mvmt_cr + row.end_dr + row.end_cr;
//           // ถ้าเป็น Header และมี Switch show_header_totals = false ให้เช็คยอดตัวเองเป็น 0 ไหม (ซึ่งปกติ Header ไม่มีรายการตรงๆ)
//           // แต่ Logic การซ่อนคือ ถ้าไม่มีรายการเคลื่อนไหวหรือคงเหลือเลย ให้ซ่อน
//           return Math.abs(totalVal) > 0.001; 
//         });
//       }

//       res.json(resultList);

//     } finally {
//       client.release();
//     }
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: err.message });
//   }
// };

// module.exports = { getTrialBalance };