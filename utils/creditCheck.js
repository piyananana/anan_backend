// ตรวจวงเงินเครดิตลูกหนี้ + ขออนุมัติเกินวงเงิน — ใช้ร่วม AR (ar_transaction) และ IM (im_transaction)
// กติกา (ผู้ใช้กำหนด 2026-10-20):
//   - ar_customer.credit_limit = 0 → ไม่ได้กำหนด ไม่ตรวจ (อยากให้ขออนุมัติทุกครั้ง ให้ตั้งวงเงินน้อยๆ เช่น 0.01)
//   - ตรวจตอน Post: ยอดหนี้หลังเอกสาร = ยอดคงค้าง + ยอดเอกสาร (รวม VAT, ใบลดหนี้ติดลบ) — เกินวงเงิน = ต้องขออนุมัติ
//     ใบลดหนี้ก็ตรวจ: ถ้าลดแล้วยังเกินวงเงินอยู่ ต้องขออนุมัติ
//   - ยอดคงค้าง = ใบแจ้งหนี้/เพิ่มหนี้ที่โพสต์แล้วคงเหลือ − ใบลดหนี้/เงินมัดจำที่ยังไม่ได้ตัด
//                 + ใบส่งสินค้ารอตั้งหนี้ (IM 32) ที่ส่งแล้วยังไม่ออกใบแจ้งหนี้
//     ไม่นับ: IM 30 (ส่งสินค้าไม่ตั้งหนี้ — ตรวจตอนโพสต์ แต่ไม่นับซ้ำ เพราะจะออกใบแจ้งหนี้ AR เองภายหลัง), ใบสั่งขาย
//   - วงเงินและยอดคงค้างเป็นสกุลเงินหลัก (บาท): AR ใช้ยอด *_lc; IM ราคาขายอยู่ในสกุลเงินเอกสาร → × exchange_rate
//     ภาษีคิดจากยอดบาทรายบรรทัด (ตรงกับใบแจ้งหนี้ AR ที่ IM สร้าง)
//   - ผู้อนุมัติ = คิวผู้อนุมัติของเมนูเอกสารนั้น (sa_module_approver ตาม menu_id + doc_type=doc_code) เหมือนการอนุมัติอื่น
//     ไม่มีผู้อนุมัติในคิว = ตามตัวเลือกของเมนู sa_menu.no_approver_action: ALLOW = อนุมัติให้อัตโนมัติ (ค่าเริ่มต้น),
//     BLOCK = ขออนุมัติไม่ได้ (โพสต์เกินวงเงินไม่ได้จนกว่าจะตั้งผู้อนุมัติ)
//   - วงเงินอนุมัติของผู้อนุมัติ (sa_module_approver.approval_limit) จำกัด "ส่วนที่เกินวงเงิน": 0 = ไม่จำกัด;
//     ผู้อนุมัติที่วงเงินไม่พอจะไม่ถูกใส่ในคิว — ไม่มีใครวงเงินพอเลย = ขออนุมัติไม่ได้
//   - การอนุมัติผูกกับยอดเอกสาร: ยอดเพิ่มขึ้นจากที่อนุมัติ (ใบลดหนี้ = ลดน้อยลง) ต้องขออนุมัติใหม่
// สถานะเอกสารไม่เปลี่ยน (ยังเป็น Draft) — ใช้คอลัมน์ credit_status: NULL / Pending / Approved แยกต่างหาก
// ใบสั่งขาย (SO, user-approved 2026-10-30): ตรวจตอนส่งอนุมัติ — ยอด = จำนวนสั่ง × ราคา × อัตราแลกเปลี่ยน (SO ยังไม่มี VAT)
//   ใช้กลไกขออนุมัติเกินวงเงินเดียวกัน (doc_kind 'SO_CREDIT') แต่ยอด SO ไม่นับเป็นยอดคงค้างของเอกสารอื่น
// คิวผู้อนุมัติเก็บที่ตารางกลาง doc_approval (utils/docApproval.js, doc_kind 'AR_CREDIT' / 'IM_CREDIT') — ตาราง
// credit_approval เดิมเลิกใช้แล้ว; โหมด ALL/ANY เก็บที่คอลัมน์ credit_approval_mode ของหัวเอกสาร

const DA = require('./docApproval');
const kindOf = (module) => (module === 'AR' ? 'AR_CREDIT' : module === 'SO' ? 'SO_CREDIT' : 'IM_CREDIT');

const AR_CHECK_TYPES = ['10', '30', '35', '50', '55'];
const AR_CREDIT_TYPES = ['50', '55'];
const IM_CHECK_TYPES = ['30', '31', '32', '35', '40', '45'];
const IM_CREDIT_TYPES = ['35', '40'];

const round2 = (n) => Math.round(Number(n) * 100) / 100;

const ensured = new Set();
// เรียกด้วย pool (นอก transaction)
const ensureCreditSchema = async (db) => {
  const dbName = db.options?.database || db.database;
  if (dbName && ensured.has(dbName)) return;
  for (const t of ['ar_transaction', 'im_transaction', 'so_transaction']) {
    await db.query(`ALTER TABLE IF EXISTS ${t}
      ADD COLUMN IF NOT EXISTS credit_status        VARCHAR(10),
      ADD COLUMN IF NOT EXISTS credit_amount        NUMERIC(18,2),
      ADD COLUMN IF NOT EXISTS credit_limit_at      NUMERIC(18,2),
      ADD COLUMN IF NOT EXISTS credit_outstanding_at NUMERIC(18,2),
      ADD COLUMN IF NOT EXISTS credit_approval_mode VARCHAR(10),
      ADD COLUMN IF NOT EXISTS credit_requested_by  VARCHAR(100),
      ADD COLUMN IF NOT EXISTS credit_requested_at  TIMESTAMPTZ`);
  }
  await DA.ensureDocApprovalSchema(db); // คิวผู้อนุมัติ + sa_menu.no_approver_action
  if (dbName) ensured.add(dbName);
};

// วงเงิน + ยอดคงค้างของลูกค้า (ไม่รวมเอกสารที่กำลังตรวจ)
const customerExposure = async (db, customerId, { excludeArId = 0, excludeImId = 0 } = {}) => {
  const r = (await db.query(`
    SELECT COALESCE(c.credit_limit, 0)::float AS credit_limit,
           COALESCE((
             SELECT SUM(CASE WHEN d.sys_doc_type IN ('10','30','35') THEN t.balance_amount_lc
                             ELSE -t.balance_amount_lc END)
               FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
              WHERE t.customer_id = c.id AND t.status = 'Posted' AND t.id <> $2
                AND d.sys_doc_type IN ('10','30','35','50','55','60')
                AND t.balance_amount_lc > 0
           ), 0)::float AS ar_outstanding,
           COALESCE((
             SELECT SUM(x.lc + ROUND(x.lc * x.vat / 100, 2))
               FROM (SELECT ROUND(ABS(dt.qty) * COALESCE(dt.unit_price, 0) * COALESCE(NULLIF(i.exchange_rate, 0), 1), 2) AS lc,
                            CASE WHEN COALESCE(dt.vat_type, 'NOVAT') = 'NOVAT' THEN 0 ELSE COALESCE(dt.vat_rate, 0) END AS vat
               FROM im_transaction i JOIN sa_module_document d ON d.id = i.doc_id
               JOIN im_transaction_detail dt ON dt.header_id = i.id
              WHERE i.customer_id = c.id AND i.status = 'Delivered' AND d.sys_doc_type = '32' AND i.id <> $3) x
           ), 0)::float AS unbilled_delivery
      FROM ar_customer c WHERE c.id = $1`, [customerId, excludeArId || 0, excludeImId || 0])).rows[0];
  if (!r) return null;
  return {
    credit_limit: round2(r.credit_limit),
    outstanding: round2(r.ar_outstanding + r.unbilled_delivery),
    ar_outstanding: round2(r.ar_outstanding),
    unbilled_delivery: round2(r.unbilled_delivery),
  };
};

// ผลการตรวจ: { checked, credit_limit, outstanding, amount, after, over, exceeded }
const evaluate = (exp, amount) => {
  const after = round2(exp.outstanding + amount);
  const checked = exp.credit_limit > 0;
  return {
    checked, credit_limit: exp.credit_limit, outstanding: exp.outstanding,
    ar_outstanding: exp.ar_outstanding, unbilled_delivery: exp.unbilled_delivery,
    amount: round2(amount), after, over: round2(after - exp.credit_limit),
    exceeded: checked && after > exp.credit_limit + 0.005,
  };
};

// ยอดเอกสาร (รวม VAT, ใบลดหนี้ติดลบ)
const arDocAmount = (sysDocType, totalAmountLc) =>
  round2((AR_CREDIT_TYPES.includes(sysDocType) ? -1 : 1) * Math.abs(Number(totalAmountLc) || 0));

// IM: จำนวน = counted − system (หรือ qty หลังโพสต์) × ราคาขาย × อัตราแลกเปลี่ยน (เป็นบาท) + VAT จากยอดบาท
const imDocAmount = (sysDocType, details, exchangeRate = 1) => {
  const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 1;
  const sum = (details || []).reduce((s, d) => {
    const q = d.qty != null && Number(d.qty) !== 0 ? Number(d.qty) : (Number(d.counted_qty) || 0) - (Number(d.system_qty) || 0);
    const vat = !d.vat_type || d.vat_type === 'NOVAT' ? 0 : (Number(d.vat_rate) || 0);
    const lc = round2(Math.abs(q) * (Number(d.unit_price) || 0) * rate);
    return s + lc + round2(lc * vat / 100);
  }, 0);
  return round2((IM_CREDIT_TYPES.includes(sysDocType) ? -1 : 1) * sum);
};

// SO: Σ จำนวนสั่ง × ราคาต่อหน่วย × อัตราแลกเปลี่ยน (เป็นบาท) — ยังไม่มี VAT ในบรรทัด SO
const soDocAmount = (details, exchangeRate = 1) => {
  const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 1;
  return round2((details || []).reduce((s, d) =>
    s + round2((Number(d.qty_ordered) || 0) * (Number(d.unit_price_fc) || 0) * rate), 0));
};

// อนุมัติแล้วใช้ได้กับยอดนี้ไหม (ยอดไม่เพิ่มจากที่อนุมัติ)
const approvalCovers = (row, amount) =>
  row.credit_status === 'Approved' && row.credit_amount !== null && amount <= Number(row.credit_amount) + 0.005;

// ตรวจก่อนโพสต์ — throw (code CREDIT_LIMIT) ถ้าเกินวงเงินและยังไม่ได้รับอนุมัติที่ครอบคลุมยอดนี้
const assertCreditForPost = async (db, { customerId, amount, excludeArId, excludeImId, row, actionTh = 'โพสต์' }) => {
  if (!customerId) return null;
  const exp = await customerExposure(db, customerId, { excludeArId, excludeImId });
  if (!exp) return null;
  const ev = evaluate(exp, amount);
  if (!ev.exceeded) return ev;
  if (row && approvalCovers(row, amount)) return ev;
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pending = row?.credit_status === 'Pending';
  const e = new Error(pending
    ? 'เอกสารนี้อยู่ระหว่างรออนุมัติเกินวงเงินเครดิต'
    : `ยอดหนี้หลังเอกสารนี้ ${fmt(ev.after)} เกินวงเงินเครดิต ${fmt(ev.credit_limit)} (เกิน ${fmt(ev.over)}) — กรุณาขออนุมัติเกินวงเงินก่อน${actionTh}`);
  e.status = 400;
  e.code = 'CREDIT_LIMIT';
  e.credit = ev;
  throw e;
};

// คำขออนุมัติ: สร้างคิวจากผู้อนุมัติของเมนู (doc_type = doc_code)
//   ไม่มีผู้อนุมัติ = ตาม no_approver_action ของเมนู (ALLOW อนุมัติอัตโนมัติ / BLOCK ขอไม่ได้)
//   ผู้อนุมัติที่ approval_limit > 0 และน้อยกว่าส่วนที่เกิน (ev.over) จะไม่อยู่ในคิว
// คืน { status: 'Pending' | 'Approved', approvers, excluded }
const fmt2 = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const requestCreditApproval = async (client, { table, module, id, menuId, docCode, ev, userName }) => {
  // คิวแยกตามประเภทเอกสาร (doc_code) เสมอ + ตัดผู้อนุมัติที่วงเงินอนุมัติไม่พอสำหรับส่วนที่เกิน
  const q = await DA.buildQueue(client, {
    kind: kindOf(module), recordId: id, menuId, docCode, alwaysDocType: true,
    filter: (all) => {
      const ok = all.filter((a) => a.approval_limit <= 0 || a.approval_limit + 0.005 >= ev.over);
      if (all.length && !ok.length) {
        const max = Math.max(...all.map((a) => a.approval_limit));
        throw DA.httpErr(400, `ไม่มีผู้อนุมัติที่มีวงเงินอนุมัติพอสำหรับส่วนที่เกิน ${fmt2(ev.over)} (วงเงินอนุมัติสูงสุด ${fmt2(max)})`);
      }
      return ok;
    },
  });
  const status = q.count ? 'Pending' : 'Approved';
  await client.query(`
    UPDATE ${table} SET credit_status=$1, credit_amount=$2, credit_limit_at=$3, credit_outstanding_at=$4,
           credit_approval_mode=$5, credit_requested_by=$6, credit_requested_at=NOW()
     WHERE id=$7`, [status, ev.amount, ev.credit_limit, ev.outstanding, q.mode, userName, id]);
  return { status, approvers: q.count, excluded: q.total - q.count };
};

// อนุมัติ (ตามลำดับ หรือคนใดคนหนึ่งถ้า ANY) — คืนสถานะใหม่ของเอกสาร
const approveCredit = async (client, { table, module, id, userId, remarks }) => {
  const doc = (await client.query(`SELECT credit_status, credit_approval_mode FROM ${table} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!doc) throw DA.httpErr(404, 'Not found');
  if (doc.credit_status !== 'Pending') throw DA.httpErr(400, 'เอกสารนี้ไม่ได้อยู่ระหว่างรออนุมัติเกินวงเงิน');
  const done = await DA.approveStep(client, { kind: kindOf(module), recordId: id, userId, mode: doc.credit_approval_mode, remarks });
  if (done) await client.query(`UPDATE ${table} SET credit_status='Approved' WHERE id=$1`, [id]);
  return done ? 'Approved' : 'Pending';
};

// ปฏิเสธ (ผู้อนุมัติ) / ถอนคำขอ (ผู้ขอ) — กลับเป็นไม่มีคำขอ ให้แก้เอกสารแล้วขอใหม่ได้
const rejectCredit = async (client, { table, module, id, userId, remarks }) => {
  const doc = (await client.query(`SELECT credit_status FROM ${table} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!doc) throw DA.httpErr(404, 'Not found');
  if (doc.credit_status !== 'Pending') throw DA.httpErr(400, 'เอกสารนี้ไม่ได้อยู่ระหว่างรออนุมัติเกินวงเงิน');
  await DA.rejectStep(client, { kind: kindOf(module), recordId: id, userId, remarks });
  await client.query(`UPDATE ${table} SET credit_status=NULL WHERE id=$1`, [id]);
};

const withdrawCredit = async (client, { table, module, id }) => {
  const doc = (await client.query(`SELECT credit_status, status FROM ${table} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!doc) throw DA.httpErr(404, 'Not found');
  if (!doc.credit_status) throw DA.httpErr(400, 'เอกสารนี้ไม่มีคำขออนุมัติเกินวงเงิน');
  if (!['Draft', 'Rejected'].includes(doc.status)) throw DA.httpErr(400, 'ถอนคำขอได้เฉพาะเอกสารร่าง');
  await DA.skipPending(client, kindOf(module), id);
  await client.query(`UPDATE ${table} SET credit_status=NULL WHERE id=$1`, [id]);
};

const loadCreditApprovals = (db, module, id) => DA.loadApprovals(db, kindOf(module), id);

// รายการที่รอผู้ใช้คนนี้อนุมัติ (ตามลำดับ) — สำหรับกระดิ่งที่หน้า Home
const myPendingCredit = async (db, { table, module, userId }) => (await db.query(`
  SELECT t.id, t.doc_no, t.doc_date, t.customer_code, t.customer_name_th, t.credit_amount::float AS amount,
         t.credit_limit_at::float AS credit_limit, t.credit_outstanding_at::float AS outstanding, t.credit_requested_by
    FROM ${table} t
   WHERE t.credit_status = 'Pending' AND ${DA.myTurnSql('t', '$1', '$2', 'credit_approval_mode')}
   ORDER BY t.credit_requested_at`, [kindOf(module), userId])).rows;

module.exports = {
  AR_CHECK_TYPES, IM_CHECK_TYPES,
  ensureCreditSchema, customerExposure, evaluate, arDocAmount, imDocAmount, soDocAmount, approvalCovers,
  assertCreditForPost, requestCreditApproval, approveCredit, rejectCredit, withdrawCredit,
  loadCreditApprovals, myPendingCredit,
};
