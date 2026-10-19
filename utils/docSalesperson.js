// พนักงานขายหลายคนต่อลูกค้า / ต่อเอกสาร
// ตารางลูกโครงสร้างเดียวกันทุกตาราง: ar_customer_salesperson (customer_id), <doc>_salesperson (header_id)
//   line_no        ลำดับที่พิมพ์ในฟอร์ม
//   salesperson_id FK cd_salesperson
//   is_primary     คนหลัก (ใช้ที่ลูกค้า — sync ไป ar_customer.salesperson_id ให้หน้าจอ/รายงานเดิมใช้ต่อได้)
//   share_percent  สัดส่วน % — กรอกที่ข้อมูลลูกค้าเท่านั้น
//   share_amount   จำนวนเงิน — กรอกที่ข้อมูลลูกค้าเท่านั้น (อิสระจาก %)
// เอกสารขาย: ผู้ป้อนเลือกแค่รายชื่อ (ไม่ต้องรู้สัดส่วน) — ระบบเก็บ % / จำนวนเงินจากข้อมูลลูกค้า ณ ตอนบันทึกลงเอกสาร
// (snapshot) เพื่อให้รายงานย้อนหลังไม่เปลี่ยนตามเมื่อแก้สัดส่วนที่ลูกค้าภายหลัง — บันทึกร่างซ้ำ = ดึงค่าล่าสุดอีกครั้ง
// โพสต์/อนุมัติแล้วแก้ไม่ได้ ค่าจึงตรึงไว้

const ensured = new Set();

// สร้างตารางลูก (idempotent) — table = ชื่อตารางลูก, parent = ตารางแม่, fk = คอลัมน์อ้างอิงแม่
const ensureSalespersonTable = async (db, table, parent, fk) => {
  // จำว่าสร้างแล้วต่อฐานข้อมูล — เรียกด้วย pool (นอก transaction) เพื่อไม่ให้จำผิดถ้า transaction ถูก rollback
  const dbName = db.options?.database || db.database;
  const key = `${dbName}:${table}`;
  if (dbName && ensured.has(key)) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id             SERIAL PRIMARY KEY,
      ${fk}          INTEGER NOT NULL REFERENCES ${parent}(id) ON DELETE CASCADE,
      line_no        SMALLINT NOT NULL DEFAULT 1,
      salesperson_id INTEGER NOT NULL REFERENCES cd_salesperson(id),
      is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
      share_percent  NUMERIC(7,4),
      share_amount   NUMERIC(18,2),
      UNIQUE (${fk}, salesperson_id)
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_${table}_sp ON ${table} (salesperson_id)`);
  if (dbName) ensured.add(key);
};

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// ตรวจ + จัดรูป: คืน { rows } หรือ { error } (ข้อความภาษาไทย)
// withShares = true (ข้อมูลลูกค้า) เก็บ % และจำนวนเงิน; false (เอกสาร) เก็บแค่รายชื่อ
const normalizeSalespersons = (list, withShares = false) => {
  const rows = [];
  const seen = new Set();
  for (const r of (Array.isArray(list) ? list : [])) {
    const spId = Number(r.salesperson_id);
    if (!spId) continue;
    if (seen.has(spId)) return { error: 'เลือกพนักงานขายซ้ำกัน' };
    seen.add(spId);
    const pct = withShares ? numOrNull(r.share_percent) : null;
    const amt = withShares ? numOrNull(r.share_amount) : null;
    if ((pct !== null && (isNaN(pct) || pct < 0 || pct > 100)) || (amt !== null && (isNaN(amt) || amt < 0)))
      return { error: 'สัดส่วนพนักงานขายต้องเป็น 0-100% และจำนวนเงินต้องไม่ติดลบ' };
    rows.push({ salesperson_id: spId, is_primary: !!r.is_primary, share_percent: pct, share_amount: amt });
  }
  const sumPct = rows.reduce((s, r) => s + (r.share_percent || 0), 0);
  if (sumPct > 100.0001) return { error: `สัดส่วนพนักงานขายรวมเกิน 100% (${round2(sumPct)}%)` };
  // คนหลักมีได้คนเดียว — ไม่ได้เลือก ให้คนแรกเป็นคนหลัก
  if (rows.length && !rows.some(r => r.is_primary)) rows[0].is_primary = true;
  let primarySeen = false;
  for (const r of rows) { if (r.is_primary && primarySeen) r.is_primary = false; if (r.is_primary) primarySeen = true; }
  return { rows };
};

// บันทึกแทนที่ทั้งชุด (rows จาก normalizeSalespersons) — คืน salesperson_id ของคนหลัก (null = ไม่มี)
const replaceSalespersons = async (db, table, fk, parentId, rows) => {
  await db.query(`DELETE FROM ${table} WHERE ${fk} = $1`, [parentId]);
  let i = 0;
  for (const r of rows) {
    await db.query(
      `INSERT INTO ${table} (${fk}, line_no, salesperson_id, is_primary, share_percent, share_amount)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [parentId, ++i, r.salesperson_id, r.is_primary, r.share_percent, r.share_amount]);
  }
  return rows.find(r => r.is_primary)?.salesperson_id ?? null;
};

// รายชื่อพร้อมรหัส/ชื่อพนักงานขาย เรียงตามลำดับพิมพ์
const loadSalespersons = async (db, table, fk, parentId) => (await db.query(`
    SELECT x.salesperson_id, x.line_no, x.is_primary,
           x.share_percent::float AS share_percent, x.share_amount::float AS share_amount,
           sp.salesperson_code, sp.salesperson_name_thai, sp.salesperson_name_eng
      FROM ${table} x
      JOIN cd_salesperson sp ON sp.id = x.salesperson_id
     WHERE x.${fk} = $1
     ORDER BY x.line_no, x.id`, [parentId])).rows;

// สัดส่วนของพนักงานขายแต่ละคนจากข้อมูลลูกค้า: Map(salesperson_id → { share_percent, share_amount })
const customerShareMap = async (db, customerId) => {
  if (!customerId) return new Map();
  const t = (await db.query(`SELECT to_regclass('ar_customer_salesperson') IS NOT NULL AS ok`)).rows[0];
  if (!t.ok) return new Map();
  const rows = (await db.query(
    `SELECT salesperson_id, share_percent::float AS share_percent, share_amount::float AS share_amount
       FROM ar_customer_salesperson WHERE customer_id = $1`, [customerId])).rows;
  return new Map(rows.map(r => [r.salesperson_id, r]));
};

// บันทึกพนักงานขายของเอกสาร — รับแค่รายชื่อ แล้วเติม % / จำนวนเงินจากข้อมูลลูกค้าของเอกสาร (ตารางแม่ = ชื่อตารางลูก
// ตัด _salesperson, ต้องมีคอลัมน์ customer_id) — คนที่ไม่อยู่ในข้อมูลลูกค้า = ว่าง
// list undefined = ไม่ได้ส่งมา ไม่แตะของเดิม; ผิดเงื่อนไข throw (status 400)
const saveDocSalespersons = async (db, table, fk, id, list) => {
  if (!Array.isArray(list)) return;
  const n = normalizeSalespersons(list, false);
  if (n.error) { const e = new Error(n.error); e.status = 400; throw e; }
  const parent = table.replace(/_salesperson$/, '');
  const cust = (await db.query(`SELECT customer_id FROM ${parent} WHERE id = $1`, [id])).rows[0]?.customer_id;
  const shares = await customerShareMap(db, cust);
  await replaceSalespersons(db, table, fk, id, n.rows.map(r => ({
    ...r,
    share_percent: shares.get(r.salesperson_id)?.share_percent ?? null,
    share_amount: shares.get(r.salesperson_id)?.share_amount ?? null,
  })));
};

// คัดลอกพนักงานขายพร้อมสัดส่วนที่ตรึงไว้จากเอกสารต้นทางไปเอกสารปลายทาง (เช่น ใบส่งสินค้า → ใบแจ้งหนี้ AR อัตโนมัติ)
const copySalespersons = async (db, from, to) => {
  const src = await loadSalespersons(db, from.table, from.fk, from.id);
  if (!src.length) return;
  await replaceSalespersons(db, to.table, to.fk, to.id, src.map(r => ({
    salesperson_id: r.salesperson_id, is_primary: r.is_primary,
    share_percent: r.share_percent, share_amount: r.share_amount,
  })));
};

// พนักงานขายของลูกค้า (ค่าเริ่มต้นของเอกสารขายใหม่)
const customerSalespersons = (db, customerId) =>
  loadSalespersons(db, 'ar_customer_salesperson', 'customer_id', customerId);

// ตัวกรองรายงาน AR ตามพนักงานขายของ "เอกสาร" (ไม่ใช่ของลูกค้า) — ใบขายที่มีพนักงานขายคนนี้ หรือใบรับชำระ/ลดหนี้
// ที่ตัดใบขายที่มีพนักงานขายคนนี้ (ar_transaction_apply) — alias = ar_transaction ในคำสั่งนั้น, param = เช่น '$5'
const arDocSalespersonSql = (alias, param) => `(EXISTS (SELECT 1 FROM ar_transaction_salesperson xs
                WHERE xs.header_id = ${alias}.id AND xs.salesperson_id = ${param})
             OR EXISTS (SELECT 1 FROM ar_transaction_apply xa
                JOIN ar_transaction_salesperson xs ON xs.header_id = xa.applied_to_id
                WHERE xa.transaction_id = ${alias}.id AND xs.salesperson_id = ${param}))`;
const ensureArDocSalesperson = (db) =>
  ensureSalespersonTable(db, 'ar_transaction_salesperson', 'ar_transaction', 'header_id');

module.exports = {
  arDocSalespersonSql, ensureArDocSalesperson,
  ensureSalespersonTable, normalizeSalespersons, replaceSalespersons, loadSalespersons,
  saveDocSalespersons, copySalespersons, customerSalespersons,
};
