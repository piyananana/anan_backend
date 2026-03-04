// controllers/glBeginningBalanceController.js

// 1. ดึงข้อมูลยอดยกมาทั้งหมดของปีที่เลือก
const getBalancesByYearId = async (req, res) => {
  const { year } = req.params;
  try {
    const result = await req.dbPool.query(
      `SELECT b.*, p.*, f.*, bu.*, br.*, pr.* 
      FROM gl_beginning_balance b
      LEFT JOIN gl_posting_period p ON b.posting_period_id = p.id
      LEFT JOIN gl_fiscal_year f ON p.fiscal_year_id = f.id
      LEFT JOIN cd_business_unit bu ON b.business_unit_id = bu.id
      LEFT JOIN cd_branch br ON b.branch_id = br.id
      LEFT JOIN cd_project pr ON b.project_id = pr.id
      WHERE f.id = $1`,
      [year]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
};

// 2. ดึงข้อมูลยอดยกมาทั้งหมดของงวดที่เลือก
const getBalancesByPeriodId = async (req, res) => {
  const { periodId } = req.params;
  try {
    const result = await req.dbPool.query(
      `SELECT b.*, p.*, f.*, bu.*, br.*, pr.* 
      FROM gl_beginning_balance b
      LEFT JOIN gl_posting_period p ON b.posting_period_id = p.id
      LEFT JOIN gl_fiscal_year f ON p.fiscal_year_id = f.id
      LEFT JOIN cd_business_unit bu ON b.business_unit_id = bu.id
      LEFT JOIN cd_branch br ON b.branch_id = br.id
      LEFT JOIN cd_project pr ON b.project_id = pr.id
      WHERE b.posting_period_id = $1`,
      [periodId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
};

// 3. บันทึกข้อมูล (Save/Update)
// รับ Data เป็น Array ของรายการที่มีการเปลี่ยนแปลง
const saveBeginningBalances = async (req, res) => {
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    
    const { posting_period_id, balances } = req.body; 
    // balances = [{ account_id, branch_id, project_id, amount_dr, amount_cr }, ...]

    // วิธีการ: ลบของเก่าออกก่อน แล้ว Insert ใหม่ (หรือจะใช้ UPSERT ก็ได้ แต่วิธีนี้จัดการง่ายกว่ากรณี user ลบรายการย่อย)
    // หมายเหตุ: ใน production ควรใช้ UPSERT (INSERT ON CONFLICT) เพื่อ performance ที่ดีกว่า 
    // แต่เพื่อความง่ายของโค้ดตัวอย่าง จะใช้การ Delete เฉพาะ Account ที่ส่งมา แล้ว Insert ใหม่
    
    for (const item of balances) {
      // 1. ลบรายการเดิมของ Account นี้ ในปีนี้ (เพื่อเคลียร์ยอดเก่า)
      await client.query(
        `DELETE FROM gl_beginning_balance 
         WHERE posting_period_id = $1 AND account_id = $2`,
        [posting_period_id, item.account_id]
      );

      // 2. Insert รายการใหม่ (ถ้ามียอด)
      if (item.amount_dr > 0 || item.amount_cr > 0) {
         await client.query(
           `INSERT INTO gl_beginning_balance 
            (posting_period_id, account_id, business_unit_id, branch_id, project_id, amount_dr, amount_cr)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
           [
             posting_period_id, 
             item.account_id, 
             item.business_unit_id || null, 
             item.branch_id || null, 
             item.project_id || null, 
             item.amount_dr, 
             item.amount_cr
           ]
         );
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Saved successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Save failed' });
  } finally {
    client.release();
  }
};

module.exports = {
    getBalancesByYearId,
    getBalancesByPeriodId,
    saveBeginningBalances
};
