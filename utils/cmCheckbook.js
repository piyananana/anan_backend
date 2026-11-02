// เลขเช็คจากสมุดเช็ค (cm_checkbook) สำหรับช่องทางจ่ายด้วยเช็คของรายจ่าย CM (20) / เติมเงินสดย่อย (30) และ
// ใบจ่ายชำระ / ใบจ่ายมัดจำ AP (80/60) — user-approved 2026-11-02 (ดู project_cm_recheck_2026_11)
// แถวช่องทางจ่ายที่เลือกสมุดเช็ค (checkbook_id): ตอน Post
//   - เลขเช็คว่าง = ใช้เลขถัดไปของสมุดเช็คแล้วเลื่อนเลขถัดไป (หมดเล่ม = สถานะ Used)
//   - กรอกเลขเอง = ต้องอยู่ในช่วงเลขของสมุดเช็ค ถ้าตรงกับเลขถัดไปก็เลื่อนเลขให้
//   - เลขเช็คซ้ำกับรายการจ่ายที่ยังไม่ยกเลิกของบัญชีเดียวกัน = ไม่ให้ Post
// ออกเลขตอน Post (ไม่ใช่ตอนบันทึกร่าง) เพื่อไม่ให้ร่างหลายใบจองเลขเดียวกัน — ถอยเป็นร่างแล้วโพสต์ใหม่ใช้เลขเดิมของแถว
const { makeEnsureOnce } = require('./schemaOnce');
const ensureCheckbookColumns = makeEnsureOnce(
    [['cm_transaction_payment', 'checkbook_id'], ['ap_transaction_payment', 'checkbook_id']],
    async (db) => {
        for (const t of ['cm_transaction_payment', 'ap_transaction_payment']) {
            await db.query(`ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS checkbook_id INTEGER`);
        }
    }, { strict: false });

const isNum = (v) => /^\d+$/.test(String(v || ''));

// เลขถัดไป: ตัวเลขเพิ่มทีละ 1 คงจำนวนหลักเดิม (เหมือนการออกเลขเช็คเดิมของหน้ารายการจ่าย)
const advance = async (client, cb) => {
    if (!isNum(cb.next_check_no)) return;
    const next = (parseInt(cb.next_check_no, 10) + 1).toString().padStart(cb.next_check_no.length, '0');
    const used = isNum(cb.end_check_no) && parseInt(next, 10) > parseInt(cb.end_check_no, 10);
    await client.query(`UPDATE cm_checkbook SET next_check_no = $1, status = CASE WHEN $2 THEN 'Used' ELSE status END, updated_at = NOW() WHERE id = $3`,
        [next, used, cb.id]);
};

// table = ตารางช่องทางจ่ายของเอกสาร, sourceCol = คอลัมน์อ้างอิงเอกสารใน cm_payment (ไม่นับรายการของเอกสารนี้เองตอนตรวจซ้ำ)
const assignCheckNumbers = async (client, table, headerId, sourceCol) => {
    await ensureCheckbookColumns(client);
    const rows = (await client.query(`
        SELECT id, line_no, checkbook_id, cm_bank_account_id, ref_no FROM ${table}
         WHERE header_id = $1 AND checkbook_id IS NOT NULL AND payment_method_type = 'CHECK' ORDER BY line_no`, [headerId])).rows;
    const taken = new Set();
    for (const r of rows) {
        const cb = (await client.query(`SELECT * FROM cm_checkbook WHERE id = $1 FOR UPDATE`, [r.checkbook_id])).rows[0];
        if (!cb) throw new Error(`บรรทัดช่องทางจ่ายที่ ${r.line_no}: ไม่พบสมุดเช็คที่เลือก`);
        if (r.cm_bank_account_id && Number(cb.bank_account_id) !== Number(r.cm_bank_account_id)) {
            throw new Error(`สมุดเช็ค ${cb.checkbook_code} ไม่ใช่ของบัญชีธนาคารในบรรทัดช่องทางจ่ายที่ ${r.line_no}`);
        }
        let no = (r.ref_no || '').trim();
        if (!no) {
            if (cb.status !== 'Active' || !cb.next_check_no) throw new Error(`สมุดเช็ค ${cb.checkbook_code} ใช้หมดแล้วหรือไม่ได้ใช้งาน`);
            no = cb.next_check_no;
            await advance(client, cb);
        } else {
            const inRange = isNum(no) && isNum(cb.start_check_no) && isNum(cb.end_check_no)
                ? parseInt(no, 10) >= parseInt(cb.start_check_no, 10) && parseInt(no, 10) <= parseInt(cb.end_check_no, 10)
                : true;
            if (!inRange) throw new Error(`เลขเช็ค ${no} ไม่อยู่ในสมุดเช็ค ${cb.checkbook_code} (${cb.start_check_no}-${cb.end_check_no})`);
            if (no === cb.next_check_no && cb.status === 'Active') await advance(client, cb);
        }
        const dup = (await client.query(`
            SELECT 1 FROM cm_payment WHERE bank_account_id = $1 AND check_no = $2 AND status <> 'Voided'
               AND ${sourceCol} IS DISTINCT FROM $3 LIMIT 1`, [cb.bank_account_id, no, headerId])).rows.length;
        if (dup || taken.has(`${cb.bank_account_id}:${no}`)) throw new Error(`เลขเช็ค ${no} ของบัญชีนี้ถูกใช้ไปแล้ว`);
        taken.add(`${cb.bank_account_id}:${no}`);
        await client.query(`UPDATE ${table} SET ref_no = $1 WHERE id = $2`, [no, r.id]);
    }
};

module.exports = { ensureCheckbookColumns, assignCheckNumbers };
