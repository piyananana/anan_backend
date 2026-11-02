// คอลัมน์มิติในเทมเพลตนำเข้า — หนึ่งคอลัมน์ต่อประเภทมิติที่เปิดใช้ (dim_<type_code>) ใส่รหัสค่ามิติ
// เหมือนยอดยกมา GL (glOpeningBalanceImportController.js) — ใช้กับยอดยกมาลูกหนี้/เจ้าหนี้ (user-approved 2026-11-02)
// คอลัมน์เป็น optional: เทมเพลตรุ่นเก่าที่ไม่มีคอลัมน์มิติยังนำเข้าได้

const activeDimTypes = async (db) => (await db.query(
    `SELECT type_code, name_thai, slot_no FROM gl_dimension_type WHERE is_active = true ORDER BY slot_no`)).rows;

const templateDimColumns = async (db) => (await activeDimTypes(db)).map(t => ({
    key: `dim_${t.type_code}`,
    label: `มิติ: ${t.name_thai} (รหัสค่ามิติ, ว่าง = ไม่ระบุ)`,
    required: false, example: '', optional: true,
}));

const loadDimLookup = async (db) => {
    const types = await activeDimTypes(db);
    const values = (await db.query(`SELECT id, type_code, value_code FROM gl_dimension_value WHERE is_active = true`)).rows;
    const valueMap = {};
    for (const v of values) valueMap[`${v.type_code}|${String(v.value_code).toUpperCase()}`] = v.id;
    return { types, valueMap };
};

// อ่านมิติของแถว → { dims: {dim1_id..dim5_id}, label: 'BU: A01, ...' } และเพิ่ม error ถ้ารหัสไม่ถูกต้อง
const parseRowDims = (getStr, lookup, rowErrors) => {
    const dims = { dim1_id: null, dim2_id: null, dim3_id: null, dim4_id: null, dim5_id: null };
    const labels = [];
    for (const t of lookup.types) {
        const cell = getStr(`dim_${t.type_code}`).toUpperCase();
        if (!cell) continue;
        const id = lookup.valueMap[`${t.type_code}|${cell}`];
        if (!id) {
            rowErrors.push({ column: `dim_${t.type_code}`, message: `ไม่พบ${t.name_thai} รหัส "${cell}"` });
        } else {
            dims[`dim${t.slot_no}_id`] = id;
            labels.push(`${t.name_thai}: ${cell}`);
        }
    }
    return { dims, label: labels.join(', ') || null };
};

module.exports = { templateDimColumns, loadDimLookup, parseRowDims };
