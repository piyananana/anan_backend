// เพิ่มคอลัมน์/ตารางแบบ idempotent ครั้งเดียวต่อฐานข้อมูล — จำว่าทำแล้วก็ต่อเมื่อเห็นว่าคอลัมน์มีอยู่แล้วจริง
// (commit โดย transaction ก่อนหน้า) ไม่ใช่หลังรัน ALTER ทันที: ALTER ที่รันใน transaction ของคำขอ ถ้าคำขอนั้น
// rollback คอลัมน์จะหายไปด้วย — การจำทันทีทำให้คำขอถัดไปข้ามการเพิ่มคอลัมน์แล้วพังจนกว่าจะ restart backend
// markers: [[ตาราง, คอลัมน์], ...] ที่ run สร้าง, strict = ตารางต้องมีอยู่ด้วย (false = ข้ามตารางที่ยังไม่มี)
const makeEnsureOnce = (markers, run, { strict = true } = {}) => {
    const done = new Set();
    return async (db) => {
        const key = db.options?.database || db.database || 'default';
        if (done.has(key)) return;
        const missing = (await db.query(`
            SELECT m.tbl FROM unnest($1::text[], $2::text[]) AS m(tbl, col)
             WHERE ${strict ? 'TRUE' : `to_regclass('public.' || m.tbl) IS NOT NULL`}
               AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                                WHERE c.table_schema = 'public' AND c.table_name = m.tbl AND c.column_name = m.col)`,
            [markers.map(m => m[0]), markers.map(m => m[1])])).rows.length;
        if (!missing) { done.add(key); return; }
        await run(db);
    };
};

module.exports = { makeEnsureOnce };
