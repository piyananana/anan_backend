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
         ORDER BY (base_currency_flag IS TRUE) DESC, id LIMIT 1`, [FALLBACK_BASE_CODE])).rows[0];
    return { id: r?.id || null, code: r?.currency_code || FALLBACK_BASE_CODE };
};

// รหัสสกุลเงินหลัก สำหรับค่าเริ่มต้นตอนบันทึก (currency_code ว่าง) — cache 60 วินาทีต่อฐานข้อมูล
// เพราะถูกเรียกต่อแถวในการนำเข้าไฟล์ (สกุลเงินหลักแทบไม่เปลี่ยนหลังเริ่มใช้งาน)
const codeCache = new Map();
const getBaseCurrencyCode = async (db) => {
    const key = db.options?.database || db.database || db.connectionParameters?.database || '';
    const hit = key && codeCache.get(key);
    if (hit && hit.at > Date.now() - 60000) return hit.code;
    const { code } = await getBaseCurrency(db);
    if (key) codeCache.set(key, { code, at: Date.now() });
    return code;
};

// เรียกหลังแก้สกุลเงินหลัก (cd_currency) ให้ค่าใหม่มีผลทันที
const clearBaseCurrencyCache = () => codeCache.clear();

module.exports = { BASE_CURRENCY_CODE_SQL, getBaseCurrency, getBaseCurrencyCode, clearBaseCurrencyCache };
