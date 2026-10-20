// utils/docApproval.js — คิวอนุมัติเอกสารแบบกลาง (ตาราง doc_approval เดียว แยกด้วย doc_kind)
// ใช้กับเอกสารที่เปลี่ยนจาก "อนุมัติขั้นเดียว" มาเป็น "คิวผู้อนุมัติของเมนู" (2026-10-20): PO, SO, เปลี่ยนแปลงราคา,
// ตรวจนับสต็อก, ใบสั่งผลิต — รูปแบบเดียวกับ pr_transaction_approval / ap_payment_run_approval:
//   - คิวมาจาก sa_module_approver ของเมนู (sync จากสิทธิ์ "อนุมัติ") — เมนู uses_doc_type แยกคิวตาม doc_code
//   - sa_menu.approval_mode: ALL = ครบทุกคนตามลำดับ, ANY = คนใดคนหนึ่ง (เก็บโหมดไว้ที่หัวเอกสาร approval_mode)
//   - ไม่มีผู้อนุมัติ = ตาม sa_menu.no_approver_action (ALLOW อนุมัติอัตโนมัติ / BLOCK ส่งอนุมัติไม่ได้)
// ฝั่งเอกสารรับผิดชอบสถานะของตัวเอง (เช่น Draft -> Submitted -> Approved/Rejected) — ไฟล์นี้จัดการเฉพาะคิว

const { ensureMenuApproverSchema, syncMenuApprovers, isNoApproverBlocked, NO_APPROVER_BLOCK_MSG } = require('./menuApproverSync');

const httpErr = (status, message) => Object.assign(new Error(message), { status });

const ensured = new Set();
// เรียกด้วย pool (นอก transaction) ได้ดีที่สุด — เรียกด้วย client ก็ได้แต่จะไม่จำผล
const ensureDocApprovalSchema = async (db) => {
  const dbName = db.options?.database || db.database;
  if (dbName && ensured.has(dbName)) return;
  await ensureMenuApproverSchema(db);
  await db.query(`
    CREATE TABLE IF NOT EXISTS doc_approval (
      id                 SERIAL PRIMARY KEY,
      doc_kind           VARCHAR(20) NOT NULL,        -- PO / SO / IM_PRICE / IM_COUNT / MO
      record_id          INTEGER     NOT NULL,
      approver_user_id   INTEGER     NOT NULL,
      approver_user_name VARCHAR(100),
      sequence_no        INTEGER     NOT NULL DEFAULT 1,
      status             VARCHAR(20) NOT NULL DEFAULT 'Pending', -- Pending / Approved / Rejected / Skipped
      remarks            TEXT,
      approved_at        TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_doc_approval_record ON doc_approval (doc_kind, record_id)`);
  await migrateLegacy(db);
  // จำว่าสร้างแล้วเฉพาะตอนเรียกด้วย pool — client ในทรานแซกชันอาจ rollback ทำให้ตารางไม่ถูกสร้างจริง
  if (dbName && typeof db.release !== 'function') ensured.add(dbName);
};

// ตารางคิวเดิมแยกต่อเอกสาร (ก่อนรวมเป็น doc_approval 2026-10-20) — ย้ายข้อมูลมาครั้งเดียวต่อ doc_kind
// (เฉพาะเมื่อ doc_kind นั้นยังไม่มีแถวใน doc_approval) ตารางเดิมเก็บไว้ไม่ลบ แต่ไม่มีโค้ดใดเขียน/อ่านแล้ว
const LEGACY = [
  { kind: 'PR',        table: 'pr_transaction_approval',    recordCol: 'header_id' },
  { kind: 'QUOTE',     table: 'quote_transaction_approval', recordCol: 'header_id' },
  { kind: 'AP_TXN',    table: 'ap_transaction_approval',    recordCol: 'transaction_id' },
  { kind: 'AP_PAYRUN', table: 'ap_payment_run_approval',    recordCol: 'run_id' },
  { kind: 'GL_CLOSE',  table: 'gl_period_close_approval',   recordCol: 'request_id' },
  { kind: 'AR_CREDIT', table: 'credit_approval',            recordCol: 'record_id', where: `module = 'AR'` },
  { kind: 'IM_CREDIT', table: 'credit_approval',            recordCol: 'record_id', where: `module = 'IM'` },
];
const migrateLegacy = async (db) => {
  for (const l of LEGACY) {
    const exists = (await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [l.table])).rows[0].ok;
    if (!exists) continue;
    const has = (await db.query(`SELECT 1 FROM doc_approval WHERE doc_kind=$1 LIMIT 1`, [l.kind])).rows.length > 0;
    if (has) continue;
    await db.query(`
      INSERT INTO doc_approval (doc_kind, record_id, approver_user_id, approver_user_name, sequence_no, status, remarks, approved_at)
      SELECT $1, ${l.recordCol}, approver_user_id, approver_user_name, COALESCE(sequence_no, 1), status, remarks, approved_at
        FROM ${l.table} ${l.where ? `WHERE ${l.where}` : ''}
       ORDER BY id`, [l.kind]);
  }
};

// สร้างคิวใหม่ (ลบคิวเดิมของเอกสารนี้) — คืน { mode, count, total }; count 0 = ไม่มีผู้อนุมัติและเมนูตั้ง "ให้ผ่าน"
//   alwaysDocType: แยกคิวตาม doc_code เสมอ (AP ตั้งหนี้ / วงเงินเครดิต) แทนที่จะดู sa_menu.uses_doc_type
//   filter(approvers, all): กรองผู้อนุมัติก่อนใส่คิว (วงเงินเครดิต: ตัดคนที่วงเงินอนุมัติไม่พอ) — โยน error เองได้
const buildQueue = async (client, { kind, recordId, menuId, docCode = null, alwaysDocType = false, filter = null }) => {
  if (!menuId) throw httpErr(400, 'ต้องระบุ menu_id');
  const menu = (await client.query(
    `SELECT approval_mode, uses_doc_type, no_approver_action FROM sa_menu WHERE id=$1`, [menuId])).rows[0] || {};
  const mode = menu.approval_mode === 'ANY' ? 'ANY' : 'ALL';
  const docType = alwaysDocType || menu.uses_doc_type ? docCode : null;
  await syncMenuApprovers(client, menuId, docType);
  const all = (await client.query(`
    SELECT a.approval_level, a.approver_user_id, u.user_name, COALESCE(a.approval_limit, 0)::float AS approval_limit
      FROM sa_module_approver a JOIN sa_user u ON u.id = a.approver_user_id
     WHERE a.menu_id=$1 AND a.doc_type IS NOT DISTINCT FROM $2 AND a.is_active=true
     ORDER BY a.approval_level`, [menuId, docType])).rows;
  if (!all.length && isNoApproverBlocked(menu)) throw httpErr(400, NO_APPROVER_BLOCK_MSG);
  const approvers = filter ? filter(all) : all;
  await client.query(`DELETE FROM doc_approval WHERE doc_kind=$1 AND record_id=$2`, [kind, recordId]);
  for (const a of approvers) {
    await client.query(`
      INSERT INTO doc_approval (doc_kind, record_id, approver_user_id, approver_user_name, sequence_no, status)
      VALUES ($1,$2,$3,$4,$5,'Pending')`, [kind, recordId, a.approver_user_id, a.user_name, a.approval_level]);
  }
  return { mode, count: approvers.length, total: all.length };
};

// อนุมัติลำดับของผู้ใช้นี้ — คืน true เมื่ออนุมัติครบ (ANY: คนแรกที่อนุมัติ)
const approveStep = async (client, { kind, recordId, userId, mode, remarks }) => {
  const isAny = mode === 'ANY';
  // เอกสารที่รออนุมัติมาตั้งแต่ก่อนใช้คิว (ไม่มีแถวใน doc_approval) — ต้องถอยเป็นร่างแล้วส่งใหม่เพื่อสร้างคิว
  const queued = Number((await client.query(
    `SELECT COUNT(*) FROM doc_approval WHERE doc_kind=$1 AND record_id=$2`, [kind, recordId])).rows[0].count);
  if (!queued) throw httpErr(400, 'เอกสารนี้ส่งขออนุมัติไว้ก่อนเปิดใช้คิวผู้อนุมัติ — กรุณาถอยเป็นร่างแล้วส่งขออนุมัติใหม่');
  const mine = (await client.query(`
    SELECT a.id FROM doc_approval a
     WHERE a.doc_kind=$1 AND a.record_id=$2 AND a.approver_user_id=$3 AND a.status='Pending'
       AND ($4::boolean OR NOT EXISTS (
         SELECT 1 FROM doc_approval a2
          WHERE a2.doc_kind=$1 AND a2.record_id=$2 AND a2.sequence_no < a.sequence_no AND a2.status='Pending'))
     ORDER BY a.sequence_no LIMIT 1`, [kind, recordId, userId, isAny])).rows[0];
  if (!mine) throw httpErr(403, 'ไม่มีสิทธิ์อนุมัติ หรือยังรอการอนุมัติจากลำดับก่อนหน้า');
  await client.query(`UPDATE doc_approval SET status='Approved', remarks=$1, approved_at=NOW() WHERE id=$2`, [remarks || null, mine.id]);
  if (isAny) await skipPending(client, kind, recordId);
  const left = Number((await client.query(
    `SELECT COUNT(*) FROM doc_approval WHERE doc_kind=$1 AND record_id=$2 AND status='Pending'`, [kind, recordId])).rows[0].count);
  return left === 0;
};

// ปฏิเสธ — ผู้อนุมัติในคิวที่ยังไม่ได้ตัดสิน (ไม่ต้องรอลำดับ)
const rejectStep = async (client, { kind, recordId, userId, remarks }) => {
  const mine = (await client.query(
    `SELECT id FROM doc_approval WHERE doc_kind=$1 AND record_id=$2 AND approver_user_id=$3 AND status='Pending' LIMIT 1`,
    [kind, recordId, userId])).rows[0];
  if (!mine) throw httpErr(403, 'ไม่มีสิทธิ์ปฏิเสธ หรืออนุมัติไปแล้ว');
  await client.query(`UPDATE doc_approval SET status='Rejected', remarks=$1, approved_at=NOW() WHERE id=$2`, [remarks || null, mine.id]);
  await skipPending(client, kind, recordId);
};

// ถอย/ถอนคำขอ — ผู้อนุมัติที่ยังไม่ตัดสินถูกข้าม
const skipPending = (client, kind, recordId) =>
  client.query(`UPDATE doc_approval SET status='Skipped' WHERE doc_kind=$1 AND record_id=$2 AND status='Pending'`, [kind, recordId]);

const loadApprovals = async (db, kind, recordId) => (await db.query(`
  SELECT id, approver_user_id, approver_user_name, sequence_no, status, remarks, approved_at
    FROM doc_approval WHERE doc_kind=$1 AND record_id=$2 ORDER BY sequence_no, id`, [kind, recordId])).rows;

// เงื่อนไข SQL "ถึงคิวผู้ใช้นี้" สำหรับรายการรออนุมัติ (กระดิ่งหน้า Home)
// alias = alias ของตารางหัวเอกสาร (ต้องมีคอลัมน์ id และคอลัมน์โหมด modeCol); kindParam/userParam = $n ของพารามิเตอร์
const myTurnSql = (alias, kindParam, userParam, modeCol = 'approval_mode') => `EXISTS (
  SELECT 1 FROM doc_approval a
   WHERE a.doc_kind=${kindParam} AND a.record_id=${alias}.id AND a.approver_user_id=${userParam} AND a.status='Pending'
     AND (${alias}.${modeCol} = 'ANY' OR NOT EXISTS (
       SELECT 1 FROM doc_approval a2 WHERE a2.doc_kind=${kindParam} AND a2.record_id=${alias}.id
          AND a2.sequence_no < a.sequence_no AND a2.status='Pending')))`;

module.exports = {
  httpErr, ensureDocApprovalSchema, buildQueue, approveStep, rejectStep, skipPending, loadApprovals, myTurnSql,
};
