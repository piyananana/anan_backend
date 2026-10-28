// สกุลเงินหลักของระบบ (cd_currency.base_currency_flag) — ใช้แทนการเขียน 'THB' ตายตัวในโค้ด
// ไม่มีสกุลเงินที่ตั้งเป็นสกุลเงินหลักเลย = ถือว่าเป็น THB (จุดเดียวที่อนุญาตให้สมมติบาท)
const FALLBACK_BASE_CODE = 'THB';

// ใช้ใน SQL ได้ตรงๆ เช่น `AND t.currency_code <> ${BASE_CURRENCY_CODE_SQL}`
const BASE_CURRENCY_CODE_SQL = `COALESCE((SELECT currency_code FROM cd_currency WHERE base_currency_flag = TRUE ORDER BY id LIMIT 1), '${FALLBACK_BASE_CODE}')`;

// { id, code } ของสกุลเงินหลัก — id เป็น null ถ้าไม่มีแถวใน cd_currency
const getBaseCurrency = async (db) => {
    const r = (await db.query(`
        SELECT id, currency_code FROM cd_currency
         WHERE base_currency_flag = TRUE OR currency_code = $1
         ORDER BY base_currency_flag DESC, id LIMIT 1`, [FALLBACK_BASE_CODE])).rows[0];
    return { id: r?.id || null, code: r?.currency_code || FALLBACK_BASE_CODE };
};

module.exports = { BASE_CURRENCY_CODE_SQL, getBaseCurrency };
