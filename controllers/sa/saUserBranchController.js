// controllers/sa/saUserBranchController.js
// จัดการสาขาที่ผู้ใช้มีสิทธิ์เข้าถึง

// GET /api/sa/sa_user_branch/:userId
const getBranchesByUserId = async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await req.dbPool.query(
      `SELECT ub.id, ub.user_id, ub.branch_id, ub.is_default,
              b.branch_code, b.branch_name_thai
       FROM sa_user_branch ub
       JOIN cd_branch b ON b.id = ub.branch_id
       WHERE ub.user_id = $1
       ORDER BY ub.is_default DESC, b.branch_code ASC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching user branches:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// PUT /api/sa/sa_user_branch/:userId  — replace all branch assignments for a user
const updateBranchesByUserId = async (req, res) => {
  const { userId } = req.params;
  const { branches } = req.body; // [{branch_id, is_default}]
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sa_user_branch WHERE user_id = $1', [userId]);
    for (const b of branches || []) {
      await client.query(
        `INSERT INTO sa_user_branch (user_id, branch_id, is_default)
         VALUES ($1, $2, $3)`,
        [userId, b.branch_id, b.is_default === true]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating user branches:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

module.exports = { getBranchesByUserId, updateBranchesByUserId };
