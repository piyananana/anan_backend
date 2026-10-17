// Middleware for account-setup save endpoints: reject a body whose *_account_id fields point at a header
// account (gl_account.is_normal_account = false). Postings to header accounts are dropped by the trial
// balance roll-up, so a setup pointing at one leaves the report unbalanced; the DB trigger in
// sql/gl_normal_account_guard.sql blocks the posting itself, this catches it earlier at setup time.

const rejectHeaderAccounts = async (req, res, next) => {
  try {
    const body = req.body || {};
    const ids = Object.keys(body)
      .filter(k => /_account_id$/.test(k) && body[k] != null && body[k] !== '')
      .map(k => Number(body[k]))
      .filter(Number.isInteger);
    if (ids.length === 0) return next();
    const r = await req.dbPool.query(
      `SELECT account_code FROM gl_account WHERE id = ANY($1::int[]) AND NOT is_normal_account ORDER BY account_code`,
      [ids]
    );
    if (r.rows.length > 0) {
      const codes = r.rows.map(x => x.account_code).join(', ');
      return res.status(400).json({
        message: `บัญชี ${codes} เป็นบัญชีคุม ลงรายการไม่ได้ กรุณาเลือกบัญชีย่อยที่ลงรายการได้`,
        code: 'HEADER_ACCOUNT',
      });
    }
    next();
  } catch (err) {
    console.error('rejectHeaderAccounts error:', err);
    res.status(500).json({ message: err.message });
  }
};

module.exports = { rejectHeaderAccounts };
