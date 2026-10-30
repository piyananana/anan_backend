// controllers/sa/creditApprovalController.js — endpoint ขออนุมัติเกินวงเงินเครดิต ใช้ร่วม AR / IM (ดู utils/creditCheck.js)
// สร้าง handler ชุดเดียวกันให้แต่ละโมดูลผ่าน makeCreditHandlers
const C = require('../../utils/creditCheck');

const DOCS = {
  AR: {
    table: 'ar_transaction',
    checkTypes: C.AR_CHECK_TYPES,
    load: async (db, id) => {
      const r = (await db.query(`
        SELECT t.id, t.status, t.customer_id, t.total_amount_lc, t.credit_status, t.credit_amount,
               d.sys_doc_type, d.doc_code
          FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id WHERE t.id = $1`, [id])).rows[0];
      if (r) r.amount = C.arDocAmount(r.sys_doc_type, r.total_amount_lc);
      return r;
    },
  },
  IM: {
    table: 'im_transaction',
    checkTypes: C.IM_CHECK_TYPES,
    load: async (db, id) => {
      const r = (await db.query(`
        SELECT t.id, t.status, t.customer_id, t.credit_status, t.credit_amount, t.exchange_rate, d.sys_doc_type, d.doc_code
          FROM im_transaction t JOIN sa_module_document d ON d.id = t.doc_id WHERE t.id = $1`, [id])).rows[0];
      if (r) {
        const details = (await db.query(`SELECT * FROM im_transaction_detail WHERE header_id=$1`, [id])).rows;
        r.amount = C.imDocAmount(r.sys_doc_type, details, r.exchange_rate);
      }
      return r;
    },
  },
  // ใบสั่งขาย — ขออนุมัติได้ตอนเป็นร่างหรือถูกปฏิเสธ (ก่อนส่งอนุมัติใบสั่งขาย)
  SO: {
    table: 'so_transaction',
    checkTypes: null,
    draftStatuses: ['Draft', 'Rejected'],
    load: async (db, id) => {
      const r = (await db.query(`
        SELECT t.id, t.status, t.customer_id, t.credit_status, t.credit_amount, t.exchange_rate, t.doc_code
          FROM so_transaction t WHERE t.id = $1`, [id])).rows[0];
      if (r) {
        const details = (await db.query(`SELECT qty_ordered, unit_price_fc FROM so_transaction_detail WHERE header_id=$1`, [id])).rows;
        r.amount = C.soDocAmount(details, r.exchange_rate);
      }
      return r;
    },
  },
};

const fail = (res, e) => {
  if (!e.status) console.error('credit approval error:', e);
  res.status(e.status || 500).json({ message: e.message || 'Internal server error' });
};

const makeCreditHandlers = (module) => {
  const cfg = DOCS[module];
  const { table } = cfg;

  // GET ?customer_id=&exclude_id= — วงเงิน + ยอดคงค้าง (ไม่รวมเอกสารนี้) ให้หน้าจอคำนวณยอดหลังเอกสาร
  const creditInfo = async (req, res) => {
    try {
      await C.ensureCreditSchema(req.dbPool);
      const customerId = Number(req.query.customer_id);
      if (!customerId) return res.status(400).json({ message: 'ต้องระบุ customer_id' });
      const exclude = Number(req.query.exclude_id) || 0;
      const exp = await C.customerExposure(req.dbPool, customerId,
        module === 'AR' ? { excludeArId: exclude } : { excludeImId: exclude });
      if (!exp) return res.status(404).json({ message: 'ไม่พบลูกค้า' });
      res.json({ ...exp, checked: exp.credit_limit > 0 });
    } catch (e) { fail(res, e); }
  };

  // PUT /:id/credit_request { menu_id } — เอกสารร่างที่บันทึกแล้วและยอดเกินวงเงิน
  const request = async (req, res) => {
    const { id } = req.params;
    const menuId = req.body?.menu_id;
    if (!menuId) return res.status(400).json({ message: 'ต้องระบุ menu_id' });
    const userName = req.headers.username || null;
    await C.ensureCreditSchema(req.dbPool);
    const client = await req.dbPool.connect();
    try {
      const { ensureMenuApproverSchema } = require('../../utils/menuApproverSync');
      await ensureMenuApproverSchema(client);
      await client.query('BEGIN');
      await client.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
      const doc = await cfg.load(client, id);
      if (!doc) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
      if (!(cfg.draftStatuses || ['Draft']).includes(doc.status)) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ขออนุมัติได้เฉพาะเอกสารร่าง' }); }
      if (cfg.checkTypes && !cfg.checkTypes.includes(doc.sys_doc_type)) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'เอกสารประเภทนี้ไม่ต้องตรวจวงเงินเครดิต' }); }
      if (doc.credit_status === 'Pending') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'เอกสารนี้ขออนุมัติไปแล้ว รออนุมัติอยู่' }); }
      const exp = await C.customerExposure(client, doc.customer_id,
        module === 'AR' ? { excludeArId: Number(id) } : { excludeImId: Number(id) });
      const ev = C.evaluate(exp, doc.amount);
      if (!ev.exceeded) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ยอดหนี้ไม่เกินวงเงินเครดิต ไม่ต้องขออนุมัติ' }); }
      const r = await C.requestCreditApproval(client, {
        table, module, id: Number(id), menuId, docCode: doc.doc_code, ev, userName,
      });
      await client.query('COMMIT');
      res.json({
        credit_status: r.status,
        message: r.status === 'Approved' ? 'ไม่มีผู้อนุมัติในคิว — อนุมัติให้อัตโนมัติ'
          : 'ส่งขออนุมัติเกินวงเงินแล้ว' + (r.excluded ? ` (ข้ามผู้อนุมัติที่วงเงินอนุมัติไม่พอ ${r.excluded} คน)` : ''),
      });
    } catch (e) { await client.query('ROLLBACK'); fail(res, e); } finally { client.release(); }
  };

  const action = (fn, okMsg) => async (req, res) => {
    const userId = Number(req.headers.userid);
    await C.ensureCreditSchema(req.dbPool);
    const client = await req.dbPool.connect();
    try {
      await client.query('BEGIN');
      const status = await fn(client, { table, module, id: Number(req.params.id), userId, remarks: req.body?.remarks });
      await client.query('COMMIT');
      res.json({ message: okMsg, credit_status: status ?? null });
    } catch (e) { await client.query('ROLLBACK'); fail(res, e); } finally { client.release(); }
  };

  const myPending = async (req, res) => {
    try {
      await C.ensureCreditSchema(req.dbPool);
      res.json(await C.myPendingCredit(req.dbPool, { table, module, userId: Number(req.headers.userid) }));
    } catch (e) { fail(res, e); }
  };

  return {
    creditInfo, request, myPending,
    approve: action(C.approveCredit, 'อนุมัติเกินวงเงินแล้ว'),
    reject: action(C.rejectCredit, 'ปฏิเสธคำขออนุมัติเกินวงเงินแล้ว'),
    withdraw: action(C.withdrawCredit, 'ถอนคำขออนุมัติเกินวงเงินแล้ว'),
  };
};

module.exports = { makeCreditHandlers };
