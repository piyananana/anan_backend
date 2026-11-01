// ยอดเงินฝากธนาคาร/เงินสดย่อยฝั่ง CM (สกุลเงินหลัก) — ใช้ร่วมกันทุกหน้าจอ/รายงาน (เดิมแต่ละที่คิดเองและไม่ตรงกัน:
// บางที่ไม่นับยอดยกมาหรือผลปรับมูลค่าอัตราแลกเปลี่ยน, บางที่ยังอ่านตารางโอนเงินของโมดูลเก่า)
// = ยอดยกมา (cm_bank_opening_balance ล่าสุดที่ไม่เกินวันที่ — รวมรายการของวันยกมาแล้ว)
//   + เงินเข้า (cm_receipt) − เงินออก (cm_payment) ที่ไม่ Voided หลังวันยกมา
//   + ผลปรับมูลค่าอัตราแลกเปลี่ยนที่ Post แล้ว หลังวันยกมา
// รายการของทุกโมดูลอยู่ใน cm_receipt/cm_payment แล้ว (utils/cmBankItems.js)
// before = true: ยอดก่อนวันที่ (ยอดยกมาของรายงานช่วงวันที่)
const exists = async (db, table) =>
    (await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`])).rows[0].ok;

const bankBalanceLc = async (db, bankAccountId, date, { before = false } = {}) => {
    const cmp = before ? '<' : '<=';
    let balance = 0;
    let fromDate = null;
    if (await exists(db, 'cm_bank_opening_balance')) {
        const ob = (await db.query(`
            SELECT opening_balance, to_char(as_of_date, 'YYYY-MM-DD') AS d FROM cm_bank_opening_balance
             WHERE bank_account_id = $1 AND as_of_date ${cmp} $2::date
             ORDER BY as_of_date DESC LIMIT 1`, [bankAccountId, date])).rows[0];
        if (ob) { balance = Number(ob.opening_balance) || 0; fromDate = ob.d; }
    }
    const after = (col) => (fromDate ? `AND ${col} > $3::date` : '');
    const params = fromDate ? [bankAccountId, date, fromDate] : [bankAccountId, date];
    if (await exists(db, 'cm_receipt')) {
        balance += Number((await db.query(`
            SELECT COALESCE(SUM(amount_lc), 0) AS amt FROM cm_receipt
             WHERE bank_account_id = $1 AND status <> 'Voided' AND receipt_date ${cmp} $2::date ${after('receipt_date')}`, params)).rows[0].amt);
    }
    if (await exists(db, 'cm_payment')) {
        balance -= Number((await db.query(`
            SELECT COALESCE(SUM(amount_lc), 0) AS amt FROM cm_payment
             WHERE bank_account_id = $1 AND status <> 'Voided' AND payment_date ${cmp} $2::date ${after('payment_date')}`, params)).rows[0].amt);
    }
    if (await exists(db, 'cm_bank_fx_revaluation')) {
        balance += Number((await db.query(`
            SELECT COALESCE(SUM(rl.fx_gain_loss), 0) AS adj
              FROM cm_bank_fx_revaluation_line rl JOIN cm_bank_fx_revaluation rv ON rv.id = rl.revaluation_id
             WHERE rl.bank_account_id = $1 AND rv.status = 'Posted'
               AND rv.revaluation_date ${cmp} $2::date ${after('rv.revaluation_date')}`, params)).rows[0].adj);
    }
    return Math.round(balance * 100) / 100;
};

module.exports = { bankBalanceLc };
