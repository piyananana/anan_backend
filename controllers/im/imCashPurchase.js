// controllers/im/imCashPurchase.js — ซื้อเงินสด ('14') (user decisions 2026-11-13)
// รับสินค้าเหมือน '11' + ใบตั้งหนี้ AP (postApBillFromGrn) + ใบจ่ายชำระ AP ('80') ที่ตัดใบตั้งหนี้นั้นเต็มยอดคงค้าง (หลังหักมัดจำ)
// ในการ Post ครั้งเดียว — วิธีจ่าย/ภาษีหัก ณ ที่จ่าย เก็บที่เอกสาร IM (im_transaction_payment/_wht ชุดเดียวกับขายเงินสด)
//   - ต้องได้รับอนุมัติก่อน Post (ข้อ ก): คิวผู้อนุมัติของเมนู แยกตามประเภทเอกสาร + วงเงินอนุมัติจ่าย (payment_limit) ตามยอดที่จ่ายจริง
//     สถานะเอกสารยังเป็น Draft — ใช้คอลัมน์ pay_status: NULL / Pending / Approved (แบบเดียวกับขออนุมัติเกินวงเงินเครดิต)
//     ยอดจ่ายเพิ่มจากที่อนุมัติ = ต้องขออนุมัติใหม่; ใบจ่าย AP ที่สร้างให้ถือว่าอนุมัติแล้ว (ไม่ผ่านคิวของ AP ซ้ำ)
//   - ใบกำกับภาษี (tax_invoice_kind): FULL = เต็มรูป (ขอคืนภาษีซื้อ ต้องมีเลขที่) / ABB = อย่างย่อ / NONE = ไม่มี —
//     ABB/NONE ขอคืนภาษีซื้อไม่ได้: VAT รวมเข้าต้นทุนสินค้า (บรรทัดเป็นไม่มี VAT ราคารวม VAT) ไม่ลงรายงานภาษีซื้อ
//   - ผู้ขายจริงรายเอกสาร (bill_to_*) ทับผู้ขายเงินสดในใบตั้งหนี้/ใบจ่าย และรายงานภาษีซื้อ
'use strict';

const DA = require('../../utils/docApproval');
const { deleteBankItems } = require('../../utils/cmBankItems');
const { resolveReceiptDoc, ensureImGlAccountSetupTable } = require('./imGlAccountSetupController');

const CASH_PURCHASE_TYPE = '14';
const TAX_INVOICE_KINDS = ['FULL', 'ABB', 'NONE'];
const APPROVAL_KIND = 'IM_CASHPUR';
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

const BILL_TO_COLS = `ADD COLUMN IF NOT EXISTS bill_to_name VARCHAR(200), ADD COLUMN IF NOT EXISTS bill_to_address TEXT,
        ADD COLUMN IF NOT EXISTS bill_to_tax_id VARCHAR(20), ADD COLUMN IF NOT EXISTS bill_to_branch VARCHAR(10)`;
const ensureCashPurchaseSchema = async (db) => {
    await db.query(`ALTER TABLE im_transaction
        ADD COLUMN IF NOT EXISTS tax_invoice_kind VARCHAR(10),
        ADD COLUMN IF NOT EXISTS linked_ap_payment_id INTEGER,
        ADD COLUMN IF NOT EXISTS linked_ap_payment_doc_no VARCHAR(50),
        ADD COLUMN IF NOT EXISTS pay_status VARCHAR(10),
        ADD COLUMN IF NOT EXISTS pay_amount NUMERIC(18,2),
        ADD COLUMN IF NOT EXISTS pay_approval_mode VARCHAR(10),
        ADD COLUMN IF NOT EXISTS pay_requested_by VARCHAR(100),
        ADD COLUMN IF NOT EXISTS pay_requested_at TIMESTAMPTZ`);
    await db.query(`ALTER TABLE ap_transaction ${BILL_TO_COLS}`);
    // จ่ายด้วยเช็คจากสมุดเช็ค (เลขเช็คออกตอนสร้างใบจ่าย AP)
    await db.query(`ALTER TABLE IF EXISTS im_transaction_payment ADD COLUMN IF NOT EXISTS checkbook_id INTEGER`);
};

const isCashPurchase = (sysDocType) => sysDocType === CASH_PURCHASE_TYPE;
const taxKindOf = (h) => (TAX_INVOICE_KINDS.includes(h?.tax_invoice_kind) ? h.tax_invoice_kind : 'FULL');

// ABB/NONE: ภาษีซื้อขอคืนไม่ได้ → บรรทัดเป็นไม่มี VAT ที่ราคารวม VAT (ต้นทุนสินค้ารวม VAT) — แก้ใน details ก่อนบันทึก
const normalizeCashPurchaseLines = (header, details) => {
    if (taxKindOf(header) === 'FULL') return;
    for (const d of details || []) {
        const rate = d.vat_type && d.vat_type !== 'NOVAT' ? Number(d.vat_rate) || 0 : 0;
        if (rate && !header.price_includes_vat && d.unit_cost_fc != null) d.unit_cost_fc = round4(Number(d.unit_cost_fc) * (100 + rate) / 100);
        if (d.vat_type) { d.vat_type = 'NOVAT'; d.vat_rate = 0; }
    }
};

const defaultCashVendor = async (client, docId) => {
    await ensureImGlAccountSetupTable(client);
    const r = await client.query(`
        SELECT s.default_vendor_id FROM sa_module_document d JOIN im_gl_account_setup s ON s.doc_code = d.doc_code WHERE d.id = $1`, [docId]);
    return r.rows[0]?.default_vendor_id || null;
};

const loadLines = async (db, headerId) => ({
    payments: (await db.query(`SELECT * FROM im_transaction_payment WHERE header_id = $1 ORDER BY line_no, id`, [headerId])).rows,
    whts: (await db.query(`SELECT * FROM im_transaction_wht WHERE header_id = $1 ORDER BY line_no, id`, [headerId])).rows,
});

// ยอดที่จ่ายจริง (สกุลเงินหลัก) = วิธีจ่ายทั้งหมด × อัตราแลกเปลี่ยนของเอกสาร — ใช้กับวงเงินอนุมัติจ่าย
const cashPaidLc = async (db, headerId) => {
    const r = (await db.query(`
        SELECT COALESCE(SUM(p.amount_fc), 0) AS fc, MAX(t.exchange_rate) AS rate
          FROM im_transaction t LEFT JOIN im_transaction_payment p ON p.header_id = t.id WHERE t.id = $1`, [headerId])).rows[0];
    return round2(Number(r.fc) * (Number(r.rate) || 1));
};

// ก่อน Post: ต้องอนุมัติแล้ว และยอดจ่ายไม่เกินยอดที่อนุมัติ (ยอดจ่าย 0 = มัดจำครอบคลุมทั้งหมด ไม่ต้องอนุมัติ)
const assertCashPurchaseApproved = async (client, headerId) => {
    const row = (await client.query(`SELECT pay_status, pay_amount FROM im_transaction WHERE id = $1`, [headerId])).rows[0];
    const amount = await cashPaidLc(client, headerId);
    if (amount <= 0) return;
    const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (row?.pay_status === 'Pending') throw bad('เอกสารซื้อเงินสดนี้อยู่ระหว่างรออนุมัติจ่าย');
    if (row?.pay_status !== 'Approved') throw bad(`ซื้อเงินสดต้องส่งขออนุมัติจ่าย (ยอด ${fmt(amount)}) และได้รับอนุมัติก่อน Post`);
    if (amount > Number(row.pay_amount) + 0.005) {
        throw bad(`ยอดจ่าย ${fmt(amount)} มากกว่ายอดที่อนุมัติ ${fmt(row.pay_amount)} — กรุณาขออนุมัติจ่ายใหม่`);
    }
};

// ใบจ่ายชำระ AP อัตโนมัติ: ตัดใบตั้งหนี้ที่เพิ่งสร้างเต็มยอดคงค้าง (หลังหักมัดจำ) — วิธีจ่าย + ภาษีหัก ณ ที่จ่าย
// ต้องรวมเท่ายอดคงค้างพอดี สร้างผ่าน insertApTransaction ของ AP (ลงบัญชี ตัดยอด รายการจ่ายผ่านธนาคาร เหมือนบันทึกใน AP)
// ยอดคงค้าง 0 (มัดจำครอบคลุมทั้งหมด) = ไม่สร้างใบจ่าย
const postApPaymentForCashPurchase = async (client, { headerId, header, billId, docNo }) => {
    const ap = require('../ap/apTransactionController');
    const bill = (await client.query(`UPDATE ap_transaction SET due_date = doc_date WHERE id = $1 RETURNING *`, [billId])).rows[0];
    const rate = Number(bill.exchange_rate) || 1;
    const advFc = Number((await client.query(`
        SELECT COALESCE(SUM(applied_amount_fc), 0) AS v FROM ap_transaction_apply WHERE transaction_id = $1 AND apply_type = 'inv_advance'`,
        [billId])).rows[0].v);
    const dueFc = round2(Number(bill.total_amount_fc) - advFc);
    const { payments, whts } = await loadLines(client, headerId);
    const payFc = round2(payments.reduce((s, p) => s + Number(p.amount_fc), 0));
    const whtLc = round2(whts.reduce((s, w) => s + Number(w.wht_amount_lc), 0));
    if (dueFc <= 0) {
        if (payFc || whtLc) throw bad('เงินมัดจำครอบคลุมยอดซื้อทั้งหมดแล้ว ไม่ต้องระบุวิธีจ่าย');
        return null;
    }
    const whtFc = round2(whtLc / rate);
    if (Math.abs(payFc + whtFc - dueFc) > 0.01) {
        throw bad(`ยอดจ่าย (${payFc.toFixed(2)}) + ภาษีหัก ณ ที่จ่าย (${whtFc.toFixed(2)}) ต้องเท่ากับยอดที่ต้องจ่าย (${dueFc.toFixed(2)})`);
    }
    // ยอดเงินบาทตามอัตราของใบตั้งหนี้ (อัตราเดียวกัน ไม่มีกำไร/ขาดทุนอัตราแลกเปลี่ยน) — บรรทัดสุดท้ายรับเศษปัด
    const appliedLc = round2(dueFc * rate);
    const cashLc = round2(appliedLc - whtLc);
    let restLc = cashLc;
    const pays = payments.map((p, i) => {
        const lc = i === payments.length - 1 ? round2(restLc) : round2(Number(p.amount_fc) * rate);
        restLc -= lc;
        return { ...p, amount_fc: Number(p.amount_fc), amount_lc: lc, payment_date: header.doc_date };
    });
    const apWhts = whts.map(w => ({
        wht_type: w.wht_name || w.wht_code, wht_type_id: w.wht_type_id, income_type: w.income_type, wht_rate: w.wht_rate,
        base_amount_lc: w.base_amount_lc, wht_amount_lc: w.wht_amount_lc, description: w.description,
    }));
    const payDoc = await resolveReceiptDoc(client, header.doc_code);
    const cashFc = round2(dueFc - whtFc);
    const r = await ap.insertApTransaction(client, {
        header: {
            doc_id: payDoc.id, doc_no: header.linked_ap_payment_doc_no || 'AUTO', doc_date: header.doc_date, due_date: header.doc_date,
            vendor_id: bill.vendor_id, vendor_code: bill.vendor_code, vendor_name_th: bill.vendor_name_th,
            ap_account_id: bill.ap_account_id, currency_id: bill.currency_id, currency_code: bill.currency_code, exchange_rate: rate,
            subtotal_fc: cashFc, total_amount_fc: cashFc, subtotal_lc: cashLc, total_amount_lc: cashLc,
            ref_doc_id: header.doc_id, ref_doc_no: docNo, description: `จ่ายชำระจากการซื้อเงินสด ${docNo}`,
            dim1_id: header.dim1_id, dim2_id: header.dim2_id, dim3_id: header.dim3_id, dim4_id: header.dim4_id, dim5_id: header.dim5_id,
            branch_id: header.branch_id, created_by: header.updated_by || header.created_by,
        },
        details: [],
        applies: [{ applied_to_id: billId, applied_amount_fc: dueFc, applied_amount_lc: appliedLc, apply_type: 'invoice' }],
        payments: pays, whts: apWhts, action: 'Post',
    }, { preApproved: true });
    await saveApBillTo(client, r.id, header);
    return r.id;
};

// ผู้ขายจริงรายเอกสาร → ใบตั้งหนี้/ใบจ่าย (ชื่อว่าง = ใช้ผู้ขายเงินสดตามเดิม)
const billToOf = (h) => {
    const t = (v) => (v == null ? '' : String(v)).trim() || null;
    return { bill_to_name: t(h?.bill_to_name), bill_to_address: t(h?.bill_to_address), bill_to_tax_id: t(h?.bill_to_tax_id), bill_to_branch: t(h?.bill_to_branch) };
};
const saveApBillTo = async (client, apId, header) => {
    const b = billToOf(header);
    if (!b.bill_to_name) return;
    await client.query(`UPDATE ap_transaction SET bill_to_name=$1, bill_to_address=$2, bill_to_tax_id=$3, bill_to_branch=$4 WHERE id=$5`,
        [b.bill_to_name, b.bill_to_address, b.bill_to_tax_id, b.bill_to_branch, apId]);
};

// ถอยเป็นร่าง: ลบใบจ่าย (รายการจ่ายผ่านธนาคารที่ยังไม่เคลียร์) ผ่าน removeLinkedBill ของ IM — คืนเลขที่ไว้ใช้ซ้ำ
const removeLinkedPayment = async (client, paymentId, removeLinkedBill) => {
    await deleteBankItems(client, 'AP', paymentId);
    return removeLinkedBill(client, 'ap_transaction', 'AP', paymentId);
};

// ───────── ขออนุมัติจ่าย (เมนูเอกสาร IM, คิวแยกตามประเภทเอกสาร, วงเงินอนุมัติจ่าย) ─────────
const fail = (res, e) => {
    if (!e.status) console.error('im cash purchase approval:', e);
    res.status(e.status || 500).json({ message: e.message || 'Internal server error' });
};
const lockDoc = async (client, id) => (await client.query(`
    SELECT t.id, t.status, t.doc_code, t.pay_status, t.pay_approval_mode, d.sys_doc_type
      FROM im_transaction t JOIN sa_module_document d ON d.id = t.doc_id WHERE t.id = $1 FOR UPDATE OF t`, [id])).rows[0];

// PUT /im_transaction/:id/payment_request { menu_id } — เอกสารร่างที่บันทึกแล้ว
const requestPayment = async (req, res) => {
    const id = Number(req.params.id);
    const menuId = req.body?.menu_id;
    if (!menuId) return res.status(400).json({ message: 'ต้องระบุ menu_id' });
    await DA.ensureDocApprovalSchema(req.dbPool);
    await ensureCashPurchaseSchema(req.dbPool);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const doc = await lockDoc(client, id);
        if (!doc) throw bad('Not found', 404);
        if (!isCashPurchase(doc.sys_doc_type)) throw bad('ขออนุมัติจ่ายได้เฉพาะเอกสารซื้อเงินสด');
        if (doc.status !== 'Draft') throw bad('ขออนุมัติจ่ายได้เฉพาะเอกสารร่าง');
        if (doc.pay_status === 'Pending') throw bad('เอกสารนี้ขออนุมัติจ่ายไปแล้ว รออนุมัติอยู่');
        const amount = await cashPaidLc(client, id);
        if (amount <= 0) throw bad('ยังไม่ได้ระบุวิธีจ่าย — ไม่มียอดที่ต้องขออนุมัติ');
        const q = await DA.buildQueue(client, {
            kind: APPROVAL_KIND, recordId: id, menuId, docCode: doc.doc_code, alwaysDocType: true, paymentAmount: amount,
        });
        const status = q.count ? 'Pending' : 'Approved';
        await client.query(`
            UPDATE im_transaction SET pay_status=$1, pay_amount=$2, pay_approval_mode=$3, pay_requested_by=$4, pay_requested_at=NOW()
             WHERE id=$5`, [status, amount, q.mode, req.headers.username || null, id]);
        await client.query('COMMIT');
        res.json({ pay_status: status, message: status === 'Approved' ? 'ไม่มีผู้อนุมัติในคิว — อนุมัติให้อัตโนมัติ' : 'ส่งขออนุมัติจ่ายแล้ว' });
    } catch (e) { await client.query('ROLLBACK'); fail(res, e); } finally { client.release(); }
};

const decide = (fn, okMsg) => async (req, res) => {
    const id = Number(req.params.id);
    const userId = Number(req.headers.userid);
    await DA.ensureDocApprovalSchema(req.dbPool);
    await ensureCashPurchaseSchema(req.dbPool);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const doc = await lockDoc(client, id);
        if (!doc) throw bad('Not found', 404);
        const status = await fn(client, doc, { userId, remarks: req.body?.remarks });
        await client.query('COMMIT');
        res.json({ message: okMsg, pay_status: status });
    } catch (e) { await client.query('ROLLBACK'); fail(res, e); } finally { client.release(); }
};
const approve = async (client, doc, { userId, remarks }) => {
    if (doc.pay_status !== 'Pending') throw bad('เอกสารนี้ไม่ได้อยู่ระหว่างรออนุมัติจ่าย');
    const done = await DA.approveStep(client, { kind: APPROVAL_KIND, recordId: doc.id, userId, mode: doc.pay_approval_mode, remarks });
    if (done) await client.query(`UPDATE im_transaction SET pay_status='Approved' WHERE id=$1`, [doc.id]);
    return done ? 'Approved' : 'Pending';
};
const reject = async (client, doc, { userId, remarks }) => {
    if (doc.pay_status !== 'Pending') throw bad('เอกสารนี้ไม่ได้อยู่ระหว่างรออนุมัติจ่าย');
    await DA.rejectStep(client, { kind: APPROVAL_KIND, recordId: doc.id, userId, remarks });
    await client.query(`UPDATE im_transaction SET pay_status=NULL WHERE id=$1`, [doc.id]);
    return null;
};
// ถอนคำขอ / ยกเลิกการอนุมัติของเอกสารร่าง (แก้ไขแล้วขอใหม่)
const withdraw = async (client, doc) => {
    if (!doc.pay_status) throw bad('เอกสารนี้ไม่มีคำขออนุมัติจ่าย');
    if (doc.status !== 'Draft') throw bad('ถอนคำขอได้เฉพาะเอกสารร่าง');
    await DA.skipPending(client, APPROVAL_KIND, doc.id);
    await client.query(`UPDATE im_transaction SET pay_status=NULL WHERE id=$1`, [doc.id]);
    return null;
};

// GET /im_transaction/payment_my_pending — รายการที่ถึงคิวผู้ใช้นี้ (กระดิ่งหน้า Home)
const myPending = async (req, res) => {
    try {
        await DA.ensureDocApprovalSchema(req.dbPool);
        await ensureCashPurchaseSchema(req.dbPool);
        res.json((await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.doc_code, t.vendor_code, t.vendor_name_th, t.bill_to_name,
                   t.pay_amount::float AS amount, t.pay_requested_by, t.pay_requested_at
              FROM im_transaction t
             WHERE t.pay_status = 'Pending' AND ${DA.myTurnSql('t', '$1', '$2', 'pay_approval_mode')}
             ORDER BY t.pay_requested_at`, [APPROVAL_KIND, Number(req.headers.userid)])).rows);
    } catch (e) { fail(res, e); }
};

const loadPaymentApprovals = (db, id) => DA.loadApprovals(db, APPROVAL_KIND, id);

module.exports = {
    CASH_PURCHASE_TYPE, TAX_INVOICE_KINDS, APPROVAL_KIND, isCashPurchase, taxKindOf,
    ensureCashPurchaseSchema, normalizeCashPurchaseLines, defaultCashVendor, cashPaidLc, assertCashPurchaseApproved,
    postApPaymentForCashPurchase, saveApBillTo, billToOf, removeLinkedPayment, loadPaymentApprovals,
    requestPayment, myPending,
    approvePayment: decide(approve, 'อนุมัติจ่ายแล้ว'),
    rejectPayment: decide(reject, 'ปฏิเสธคำขออนุมัติจ่ายแล้ว'),
    withdrawPayment: decide(withdraw, 'ถอนคำขออนุมัติจ่ายแล้ว'),
};
