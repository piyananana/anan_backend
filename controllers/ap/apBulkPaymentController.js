// controllers/ap/apBulkPaymentController.js
'use strict';
const { checkCmPeriodOpen } = require('../cm/cmPeriodCheckHelper');
const { getBaseCurrencyCode } = require('../../utils/baseCurrency');
const { computePaymentDeferredVat, insertDeferredVtRecordsForPayment } = require('./apTransactionController');
const { describeJournalLines } = require('../../utils/glJournalPreview');
const { postedApAccountId } = require('../../utils/apAccount');
const DA = require('../../utils/docApproval');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
const { reasonOf, userIdOf } = require('../../utils/docAction');
const { ymd } = require('../../utils/dateUtil');

// ชุดจ่ายแบบกลุ่ม (ap_bulk_payment) — ต้องผ่านการอนุมัติก่อนจ่าย:
// Draft → Submitted → Approved → Paid (ปฏิเสธ/ถอย → Draft, ลบ = Deleted)
// คิวผู้อนุมัติของเมนู ApBulkPaymentScreen ที่ตารางกลาง doc_approval (doc_kind 'AP_BULKPAY')
// พร้อมวงเงินอนุมัติจ่ายเทียบกับยอดรวมของชุด
const KIND = 'AP_BULKPAY';
const OPEN_STATUSES = `('Draft','Submitted','Approved')`;
const ensureBulkSchema = async (db) => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS ap_bulk_payment (
            id              SERIAL PRIMARY KEY,
            batch_no        VARCHAR(30) NOT NULL UNIQUE,
            payment_date    DATE NOT NULL,
            bank_account_id INTEGER NOT NULL,
            payment_method  VARCHAR(20) NOT NULL DEFAULT 'TRANSFER',
            description     TEXT,
            total_amount_lc NUMERIC(18,2) NOT NULL DEFAULT 0,
            status          VARCHAR(20) NOT NULL DEFAULT 'Draft',
            approval_mode   VARCHAR(10) DEFAULT 'ALL',
            gl_entry_id     INTEGER,
            gl_doc_no       VARCHAR(50),
            paid_by         VARCHAR(100),
            paid_at         TIMESTAMPTZ,
            created_by      VARCHAR(100),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by      VARCHAR(100),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await db.query(`
        CREATE TABLE IF NOT EXISTS ap_bulk_payment_detail (
            id                SERIAL PRIMARY KEY,
            batch_id          INTEGER NOT NULL REFERENCES ap_bulk_payment(id) ON DELETE CASCADE,
            ap_transaction_id INTEGER NOT NULL,
            amount_lc         NUMERIC(18,2) NOT NULL,
            sort_order        INTEGER NOT NULL DEFAULT 0
        )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ap_bulk_payment_detail_batch ON ap_bulk_payment_detail (batch_id)`);
    await DA.ensureDocApprovalSchema(db);
};

// GET eligible AP invoices for bulk payment
// Returns posted ap_transaction rows (Purchase Invoice / Debit Note) with an outstanding balance
// ที่ยังไม่อยู่ในชุดจ่ายแบบกลุ่มที่ค้างอยู่ (Draft/Submitted/Approved) — กันเลือกซ้ำสองชุด
const getEligibleInvoices = async (req, res) => {
    const { vendor_search, due_date_to } = req.query;
    await ensureBulkSchema(req.dbPool);
    const client = await req.dbPool.connect();
    try {
        const params = [];
        const wheres = [`t.status = 'Posted'`, `t.balance_amount_lc > 0.005`, `d.sys_doc_type IN ('10','50')`,
            `NOT EXISTS (SELECT 1 FROM ap_bulk_payment_detail bd JOIN ap_bulk_payment b ON b.id = bd.batch_id
                          WHERE bd.ap_transaction_id = t.id AND b.status IN ${OPEN_STATUSES})`];
        if (vendor_search) {
            params.push(`%${vendor_search.toUpperCase()}%`);
            const p = params.length;
            wheres.push(`(UPPER(v.vendor_code) LIKE $${p} OR UPPER(v.vendor_name_th) LIKE $${p} OR UPPER(COALESCE(v.vendor_name_en,'')) LIKE $${p})`);
        }
        if (due_date_to) { params.push(due_date_to); wheres.push(`t.due_date <= $${params.length}`); }

        const r = await client.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.due_date, t.status,
                   t.total_amount_lc  AS total_amount,
                   t.paid_amount_lc   AS paid_amount,
                   t.balance_amount_lc AS remaining_amount,
                   t.currency_code, t.exchange_rate,
                   v.id AS vendor_id, v.vendor_code, v.vendor_name_th, v.vendor_name_en
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            JOIN ap_vendor v ON v.id = t.vendor_id
            WHERE ${wheres.join(' AND ')}
            ORDER BY v.vendor_code, t.due_date, t.doc_no`,
            params);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// Build a running GL doc number the same way apPaymentRunController.generateGlDocNo does
const generateGlDocNo = async (client, glDocId, date) => {
    const docRes = await client.query(
        `SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [glDocId]);
    const doc = docRes.rows[0];
    if (!doc || !doc.is_auto_numbering) return null;

    const d = new Date(date);
    const year  = d.getFullYear().toString();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day   = d.getDate().toString().padStart(2, '0');

    let docNo = doc.format_prefix || '';
    const sfx = doc.format_suffix_date || '';
    if      (sfx === 'YY')       docNo += year.substring(2);
    else if (sfx === 'YYYY')     docNo += year;
    else if (sfx === 'YYMM')     docNo += year.substring(2) + month;
    else if (sfx === 'YYYYMM')   docNo += year + month;
    else if (sfx === 'YYYYMMDD') docNo += year + month + day;
    if (doc.format_separator) docNo += doc.format_separator;
    docNo += doc.next_running_number.toString().padStart(doc.running_length || 4, '0');

    await client.query(
        `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`, [glDocId]);
    return docNo;
};

// ข้อผิดพลาดที่ส่งกลับผู้ใช้พร้อม HTTP status
class BulkPayError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

// ตรวจข้อมูลและสร้างบรรทัดรายการบัญชีของการจ่ายแบบกลุ่ม — ใช้ทั้ง preview และ run (ไม่เขียนข้อมูล)
// บรรทัด: Dr เจ้าหนี้ทีละใบ, Cr ธนาคารยอดรวม, แล้ว Dr ภาษีซื้อ / Cr ภาษีซื้อรอตัด ของใบที่มี VAT รอตัดบัญชี
const prepareBulkPayment = async (client, { bank_account_id, payment_date, items }) => {
    if (!bank_account_id || !payment_date || !items || !items.length)
        throw new BulkPayError(400, 'bank_account_id, payment_date and items are required');

    // Paying bank account
    const baRes = await client.query(`SELECT * FROM cm_bank_account WHERE id=$1`, [bank_account_id]);
    if (!baRes.rows.length) throw new BulkPayError(404, 'Bank account not found');
    const bankAcct = baRes.rows[0];
    if (!bankAcct.gl_account_id) throw new BulkPayError(400, 'Selected bank account has no GL account configured');

    // GL setup for AP Payment document type (sys_doc_type = '80')
    const setupRes = await client.query(`
        SELECT s.*, d.id AS sys_doc_id
        FROM sa_module_document d
        LEFT JOIN ap_gl_account_setup s ON s.doc_code = d.doc_code
        WHERE d.sys_module = '21' AND d.sys_doc_type = '80' AND d.is_doc_type = true
        LIMIT 1`);
    if (!setupRes.rows.length || !setupRes.rows[0].gl_doc_id)
        throw new BulkPayError(400, 'AP GL Account Setup for the Payment document type is not configured');
    const setup = setupRes.rows[0];

    // Load + validate every selected AP transaction up front
    const docs = [];
    for (const item of items) {
        const apRes = await client.query(`
            SELECT t.*, v.vendor_code AS v_vendor_code, v.vendor_name_th, v.vendor_name_en
            FROM ap_transaction t JOIN ap_vendor v ON v.id = t.vendor_id
            WHERE t.id = $1`, [item.ap_document_id]);
        if (!apRes.rows.length) throw new BulkPayError(404, `AP transaction id=${item.ap_document_id} not found`);
        const payAmt = parseFloat(item.amount || 0);
        if (payAmt <= 0) throw new BulkPayError(400, 'Payment amount must be greater than zero');
        const apDoc = apRes.rows[0];
        // ใบอาจถูกจ่ายไปบางส่วนระหว่างรออนุมัติ — จ่ายเกินยอดค้างไม่ได้
        if (apDoc.status !== 'Posted' || payAmt > Number(apDoc.balance_amount_lc || 0) + 0.005)
            throw new BulkPayError(400, `ใบตั้งหนี้ ${apDoc.doc_no} ยอดค้างชำระเหลือ ${Number(apDoc.balance_amount_lc || 0).toFixed(2)} (สถานะ ${apDoc.status}) น้อยกว่ายอดที่จะจ่าย ${payAmt.toFixed(2)}`);
        // ล้างเข้าบัญชีเจ้าหนี้ที่ใบตั้งหนี้ลงไว้ (utils/apAccount.js)
        const apAccountId = await postedApAccountId(client, apDoc.id);
        if (!apAccountId) throw new BulkPayError(400, `ไม่พบบัญชีเจ้าหนี้ของใบตั้งหนี้ ${apDoc.doc_no} กรุณาตั้งค่าที่เจ้าหนี้ กลุ่มเจ้าหนี้ หรือการตั้งค่ารหัสบัญชีของประเภทเอกสาร`);
        docs.push({ doc: apDoc, amount: payAmt, apAccountId });
    }

    const totalAmount = docs.reduce((s, d) => s + d.amount, 0);

    const lines = docs.map(({ doc, amount, apAccountId }) =>
        ({ account_id: apAccountId, description: `Payment ${doc.doc_no}`, debit: amount, credit: 0 }));
    lines.push({ account_id: bankAcct.gl_account_id, description: 'Bulk payment', debit: 0, credit: totalAmount, isBank: true });

    // รับรู้ VAT รอตัดบัญชี (บริการ) ของใบแจ้งหนี้ตามสัดส่วนที่จ่าย — Dr ภาษีซื้อ / Cr ภาษีซื้อรอตัด
    // (มิเรอร์การจ่ายชำระปกติใน apTransactionController — จ่ายแบบกลุ่มเป็นยอดบาท จึงใช้สัดส่วนยอดบาท)
    const deferredByDoc = [];
    let deferredTotal = 0;
    for (const { doc: apDoc, amount: payAmt } of docs) {
        const totalLc = Number(apDoc.total_amount_lc) || 0;
        if (totalLc === 0) continue;
        const deferred = await computePaymentDeferredVat(client, [{ invoiceId: apDoc.id, ratio: payAmt / totalLc }]);
        if (deferred.vatLc === 0) continue;
        if (!setup.vat_input_account_id || !setup.vat_pending_input_account_id) {
            throw new BulkPayError(400, `ใบแจ้งหนี้ ${apDoc.doc_no} มี VAT รอตัดบัญชีที่ต้องรับรู้ — กรุณาตั้งค่าบัญชีภาษีซื้อและบัญชีภาษีซื้อรอตัดบัญชีในการตั้งค่าบัญชี AP ของเอกสารจ่ายชำระ`);
        }
        lines.push(
            { account_id: setup.vat_input_account_id, description: `รับรู้ VAT รอตัดบัญชี ${apDoc.doc_no}`, debit: deferred.vatLc, credit: 0 },
            { account_id: setup.vat_pending_input_account_id, description: `VAT รอตัดบัญชี ${apDoc.doc_no}`, debit: 0, credit: deferred.vatLc });
        deferredByDoc.push({ apDoc, deferred });
        deferredTotal += deferred.vatLc;
    }

    return { setup, bankAcct, docs, totalAmount, lines, deferredByDoc, deferredTotal };
};

// POST preview bulk payment — รายการบัญชีที่จะเกิด (ไม่บันทึกอะไร)
// Body: เหมือน run
const previewBulkPayment = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const { lines } = await prepareBulkPayment(client, req.body);
        res.json({ journal: await describeJournalLines(client, lines) });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
};

// จ่ายจริง — combined GL entry ใบเดียวทั้งชุด + cm_payment ต่อใบตั้งหนี้ (เรียกจาก payBatch เท่านั้น ต้องผ่านอนุมัติแล้ว)
// คืน { glEntryId, glDocNo, created } — ข้อผิดพลาดของผู้ใช้โยนเป็น BulkPayError
const payItems = async (client, body, createdBy) => {
    const { payment_date, bank_account_id, payment_method } = body;
    const pc = await checkCmPeriodOpen(client, payment_date);
    if (!pc.allowed) throw new BulkPayError(400, pc.message);

    const { setup, docs, totalAmount, lines, deferredByDoc, deferredTotal } = await prepareBulkPayment(client, body);

    // Open GL period
    const periodRes = await client.query(`
        SELECT id FROM gl_posting_period
        WHERE $1::date BETWEEN period_start_date AND period_end_date
          AND gl_status = 'OPEN' LIMIT 1`, [payment_date]);
    if (!periodRes.rows.length) throw new BulkPayError(400, `No open GL period found for ${payment_date}`);
    const periodId = periodRes.rows[0].id;

    let glDocNo = await generateGlDocNo(client, setup.gl_doc_id, payment_date);
    if (!glDocNo) glDocNo = `BULKPAY-${payment_date}-${Date.now()}`;

    const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name=$1 LIMIT 1`, [createdBy]);
    const createdByUserId = userRes.rows[0]?.id || null;

    // One combined GL entry for the whole batch
    const totalGl = totalAmount + deferredTotal;
    const glHeaderRes = await client.query(`
        INSERT INTO gl_entry_header
          (doc_id, doc_no, doc_date, posting_date, period_id,
           ref_no, description,
           currency_id, exchange_rate, status,
           total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
           created_by)
        VALUES ($1,$2,$3,$3,$4,$5,$6,1,1,'Posted',$7,$7,$7,$7,$8)
        RETURNING id`,
        [setup.gl_doc_id, glDocNo, payment_date, periodId, body.batch_no || glDocNo,
         `Bulk Payment ${body.batch_no || glDocNo}`, totalGl, createdByUserId]);
    const glEntryId = glHeaderRes.rows[0].id;

    let lineNo = 1;
    for (const l of lines) {
        await client.query(`
            INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
            VALUES ($1,$2,$3,$4,$5,$6,$5,$6)`,
            [glEntryId, lineNo++, l.account_id, l.isBank ? `Bulk payment ${glDocNo}` : l.description, l.debit, l.credit]);
    }

    const created = [];
    for (const { doc: apDoc, amount: payAmt } of docs) {
        const pmtRes = await client.query(`
            INSERT INTO cm_payment
                (payment_date, bank_account_id, payment_method_type, ap_doc_no,
                 payee_type, payee_id, payee_code, payee_name_th,
                 amount_lc, amount_fc, currency_code, exchange_rate,
                 gl_entry_id, created_by)
            VALUES ($1,$2,$3,$4,'VENDOR',$5,$6,$7,$8,$8,$9,1,$10,$11)
            RETURNING id`,
            [payment_date, bank_account_id, payment_method || 'TRANSFER', apDoc.doc_no,
             apDoc.vendor_id, apDoc.v_vendor_code, apDoc.vendor_name_th,
             payAmt, apDoc.currency_code || await getBaseCurrencyCode(client), glEntryId, createdByUserId]);

        await client.query(`
            UPDATE ap_transaction SET
                paid_amount_lc    = COALESCE(paid_amount_lc, 0) + $1,
                balance_amount_lc = GREATEST(COALESCE(balance_amount_lc, 0) - $1, 0),
                status = CASE
                    WHEN (COALESCE(balance_amount_lc, 0) - $1) <= 0.005 THEN 'Settled'
                    ELSE status
                END,
                updated_at = NOW()
            WHERE id = $2`, [payAmt, apDoc.id]);

        created.push({ payment_id: pmtRes.rows[0].id, doc_no: apDoc.doc_no, amount: payAmt });
    }

    // รายงานภาษีซื้อของ VAT รอตัดที่รับรู้
    for (const { apDoc, deferred } of deferredByDoc) {
        await insertDeferredVtRecordsForPayment(client, apDoc.id, {
            doc_id: setup.sys_doc_id, doc_no: glDocNo, doc_date: payment_date,
            vendor_id: apDoc.vendor_id, vendor_name_th: apDoc.vendor_name_th, created_by: createdBy,
        }, deferred);
    }
    return { glEntryId, glDocNo, created };
};

// ── ชุดจ่ายแบบกลุ่ม ─────────────────────────────────────────────────────────

const errOut = (res, err, label) => {
    if (!err.status) console.error(`Error ${label} ap_bulk_payment:`, err);
    res.status(err.status || 500).json({ error: err.message, message: err.message || 'Internal server error' });
};

// รายการของชุดในรูปแบบเดียวกับ body ของ preview/prepare
const batchBody = async (db, batch) => {
    const items = (await db.query(`
        SELECT ap_transaction_id AS ap_document_id, amount_lc::float AS amount
          FROM ap_bulk_payment_detail WHERE batch_id=$1 ORDER BY sort_order, id`, [batch.id])).rows;
    return {
        batch_no: batch.batch_no, bank_account_id: batch.bank_account_id, payment_method: batch.payment_method,
        payment_date: batch.payment_date instanceof Date ? ymd(batch.payment_date) : batch.payment_date, items,
    };
};

// เลขที่ชุด BP<YYYYMM>-NNNN เรียงต่อในเดือนของวันที่จ่าย
const nextBatchNo = async (client, paymentDate) => {
    await client.query(`LOCK TABLE ap_bulk_payment IN SHARE ROW EXCLUSIVE MODE`);
    const prefix = `BP${String(paymentDate).slice(0, 7).replace('-', '')}-`;
    const last = (await client.query(`
        SELECT MAX(CAST(SUBSTRING(batch_no FROM $2) AS INTEGER)) AS n
          FROM ap_bulk_payment WHERE batch_no LIKE $1 AND SUBSTRING(batch_no FROM $2) ~ '^[0-9]+$'`,
        [`${prefix}%`, prefix.length + 1])).rows[0].n || 0;
    return `${prefix}${String(last + 1).padStart(4, '0')}`;
};

// GET /ap_bulk_payment/batches?status=
const listBatches = async (req, res) => {
    try {
        await ensureBulkSchema(req.dbPool);
        const params = [];
        let where = `b.status <> 'Deleted'`;
        if (req.query.status) { params.push(req.query.status); where = `b.status = $1`; }
        const r = await req.dbPool.query(`
            SELECT b.id, b.batch_no, b.payment_date, b.payment_method, b.description, b.total_amount_lc::float AS total_amount_lc,
                   b.status, b.gl_doc_no, b.created_by, b.created_at,
                   ba.account_code AS bank_account_code, ba.account_name_th AS bank_account_name_th, ba.account_name_en AS bank_account_name_en,
                   (SELECT COUNT(*)::int FROM ap_bulk_payment_detail d WHERE d.batch_id = b.id) AS item_count
              FROM ap_bulk_payment b LEFT JOIN cm_bank_account ba ON ba.id = b.bank_account_id
             WHERE ${where}
             ORDER BY b.payment_date DESC, b.id DESC`, params);
        res.json(r.rows);
    } catch (err) { errOut(res, err, 'listing'); }
};

// GET /ap_bulk_payment/batches/:id — หัว + รายการ + ขั้นตอนอนุมัติ
const getBatch = async (req, res) => {
    try {
        await ensureBulkSchema(req.dbPool);
        const id = Number(req.params.id);
        const b = (await req.dbPool.query(`
            SELECT b.*, b.total_amount_lc::float AS total_amount_lc,
                   ba.account_code AS bank_account_code, ba.account_name_th AS bank_account_name_th, ba.account_name_en AS bank_account_name_en
              FROM ap_bulk_payment b LEFT JOIN cm_bank_account ba ON ba.id = b.bank_account_id WHERE b.id=$1`, [id])).rows[0];
        if (!b) return res.status(404).json({ error: 'Not found', message: 'Not found' });
        const items = (await req.dbPool.query(`
            SELECT d.id, d.ap_transaction_id, d.amount_lc::float AS amount_lc,
                   t.doc_no, t.doc_date, t.due_date, t.status AS invoice_status, t.balance_amount_lc::float AS balance_amount_lc,
                   v.vendor_code, v.vendor_name_th, v.vendor_name_en
              FROM ap_bulk_payment_detail d
              JOIN ap_transaction t ON t.id = d.ap_transaction_id
              JOIN ap_vendor v ON v.id = t.vendor_id
             WHERE d.batch_id=$1 ORDER BY d.sort_order, d.id`, [id])).rows;
        res.json({
            ...b, items,
            approvals: await DA.loadApprovals(req.dbPool, KIND, id),
            reverse_history: await getReverseHistory(req.dbPool, 'ap_bulk_payment', id),
        });
    } catch (err) { errOut(res, err, 'fetching'); }
};

// POST /ap_bulk_payment/batches — สร้างชุดเป็น Draft
// Body: { bank_account_id, payment_date, payment_method, description, items: [{ap_document_id, amount}] }
const createBatch = async (req, res) => {
    const userName = req.headers.username || null;
    await ensureBulkSchema(req.dbPool);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const body = req.body || {};
        const { docs, totalAmount } = await prepareBulkPayment(client, body);
        const ids = docs.map(d => d.doc.id);
        if (new Set(ids).size !== ids.length) throw new BulkPayError(400, 'เลือกใบตั้งหนี้ซ้ำในชุดเดียวกัน');
        const dup = (await client.query(`
            SELECT t.doc_no, b.batch_no FROM ap_bulk_payment_detail d
              JOIN ap_bulk_payment b ON b.id = d.batch_id JOIN ap_transaction t ON t.id = d.ap_transaction_id
             WHERE d.ap_transaction_id = ANY($1::int[]) AND b.status IN ${OPEN_STATUSES} LIMIT 1`, [ids])).rows[0];
        if (dup) throw new BulkPayError(400, `ใบตั้งหนี้ ${dup.doc_no} อยู่ในชุดจ่ายแบบกลุ่ม ${dup.batch_no} ที่ยังค้างอยู่แล้ว`);
        const batchNo = await nextBatchNo(client, body.payment_date);
        const b = (await client.query(`
            INSERT INTO ap_bulk_payment (batch_no, payment_date, bank_account_id, payment_method, description, total_amount_lc, status, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,'Draft',$7,$7) RETURNING id, batch_no`,
            [batchNo, body.payment_date, body.bank_account_id, body.payment_method || 'TRANSFER', body.description || null,
             Math.round(totalAmount * 100) / 100, userName])).rows[0];
        for (let i = 0; i < docs.length; i++) {
            await client.query(`INSERT INTO ap_bulk_payment_detail (batch_id, ap_transaction_id, amount_lc, sort_order) VALUES ($1,$2,$3,$4)`,
                [b.id, docs[i].doc.id, docs[i].amount, i]);
        }
        await client.query('COMMIT');
        res.status(201).json(b);
    } catch (err) {
        await client.query('ROLLBACK');
        errOut(res, err, 'creating');
    } finally { client.release(); }
};

// โหลดชุดแบบล็อกแถว แล้วทำงานในทรานแซกชันเดียว
const batchAction = (label, okMsg, work) => async (req, res) => {
    const ctx = {
        userId: userIdOf(req), userName: req.headers['username'] || null,
        menuId: req.body?.menu_id, remarks: req.body?.remarks, reason: reasonOf(req),
    };
    await ensureBulkSchema(req.dbPool);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const batch = (await client.query(`SELECT * FROM ap_bulk_payment WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
        if (!batch) throw DA.httpErr(404, 'Not found');
        const out = await work(client, batch, ctx);
        await client.query('COMMIT');
        res.status(200).json({ message: (typeof out === 'string' && out) || okMsg, ...(out && typeof out === 'object' ? out : {}) });
    } catch (err) {
        await client.query('ROLLBACK');
        errOut(res, err, label);
    } finally { client.release(); }
};

const setStatus = (client, id, status, userName) => client.query(
    `UPDATE ap_bulk_payment SET status=$1, updated_at=NOW(), updated_by=$2 WHERE id=$3`, [status, userName, id]);

// DELETE /ap_bulk_payment/batches/:id — Draft เท่านั้น (เก็บไว้เป็นสถานะ Deleted)
const deleteBatch = batchAction('deleting', 'ลบสำเร็จ', async (client, batch, { userName }) => {
    if (batch.status !== 'Draft') throw DA.httpErr(400, 'ลบได้เฉพาะชุดที่เป็น Draft เท่านั้น');
    await setStatus(client, batch.id, 'Deleted', userName);
});

// PUT /:id/submit { menu_id } — Draft → Submitted (ไม่มีผู้อนุมัติ + ให้ผ่าน → Approved ทันที)
// วงเงินอนุมัติจ่ายเทียบกับยอดรวมของชุด
const submitBatch = batchAction('submitting', 'ส่งอนุมัติสำเร็จ', async (client, batch, { menuId, userName }) => {
    if (!menuId) throw DA.httpErr(400, 'ต้องระบุ menu_id');
    if (batch.status !== 'Draft') throw DA.httpErr(400, 'ส่งอนุมัติได้เฉพาะชุดที่เป็น Draft เท่านั้น');
    const total = (await client.query(`
        SELECT COALESCE(SUM(amount_lc), 0)::float AS t FROM ap_bulk_payment_detail WHERE batch_id=$1`, [batch.id])).rows[0].t;
    const q = await DA.buildQueue(client, { kind: KIND, recordId: batch.id, menuId, paymentAmount: total });
    await client.query(`UPDATE ap_bulk_payment SET status='Submitted', approval_mode=$1, updated_at=NOW(), updated_by=$2 WHERE id=$3`,
        [q.mode, userName, batch.id]);
    if (q.count === 0) {
        await setStatus(client, batch.id, 'Approved', userName);
        return 'ส่งอนุมัติสำเร็จ (ข้ามขั้นตอนอนุมัติ)';
    }
});

// PUT /:id/approve — Submitted → Approved เมื่ออนุมัติครบ (หรือคนใดคนหนึ่งถ้า ANY)
const approveBatch = batchAction('approving', 'อนุมัติสำเร็จ', async (client, batch, { userId, userName, remarks }) => {
    if (!userId) throw DA.httpErr(401, 'ต้องระบุ UserId');
    if (batch.status !== 'Submitted') throw DA.httpErr(400, 'อนุมัติได้เฉพาะชุดที่เป็น Submitted เท่านั้น');
    const done = await DA.approveStep(client, { kind: KIND, recordId: batch.id, userId, mode: batch.approval_mode, remarks });
    if (done) await setStatus(client, batch.id, 'Approved', userName);
});

// PUT /:id/reject — Submitted → Draft
const rejectBatch = batchAction('rejecting', 'ปฏิเสธและส่งกลับไปเป็นร่างสำเร็จ', async (client, batch, { userId, userName, remarks }) => {
    if (!userId) throw DA.httpErr(401, 'ต้องระบุ UserId');
    if (batch.status !== 'Submitted') throw DA.httpErr(400, 'ปฏิเสธได้เฉพาะชุดที่เป็น Submitted เท่านั้น');
    await DA.rejectStep(client, { kind: KIND, recordId: batch.id, userId, remarks });
    await setStatus(client, batch.id, 'Draft', userName);
});

// PUT /:id/reverse { reason } — Submitted/Approved → Draft (ผู้อนุมัติที่ยังไม่ตัดสินถูกข้าม ต้องขออนุมัติใหม่)
const reverseBatch = batchAction('reversing', 'ถอยเป็นร่างสำเร็จ', async (client, batch, { userId, userName, reason }) => {
    if (!['Submitted', 'Approved'].includes(batch.status)) throw DA.httpErr(400, 'ถอยเป็นร่างได้เฉพาะชุดที่เป็น Submitted หรือ Approved เท่านั้น');
    if (!reason) throw DA.httpErr(400, 'กรุณาระบุเหตุผล');
    await DA.skipPending(client, KIND, batch.id);
    await setStatus(client, batch.id, 'Draft', userName);
    await logReverse(client, {
        sysModule: '21', tableName: 'ap_bulk_payment', recordId: batch.id, docNo: batch.batch_no,
        fromStatus: batch.status, toStatus: 'Draft', reason, userId,
    });
});

// POST /:id/preview — รายการบัญชีที่จะเกิดเมื่อจ่ายชุดนี้
const previewBatch = async (req, res) => {
    try {
        await ensureBulkSchema(req.dbPool);
        const batch = (await req.dbPool.query(`SELECT * FROM ap_bulk_payment WHERE id=$1`, [req.params.id])).rows[0];
        if (!batch) return res.status(404).json({ error: 'Not found', message: 'Not found' });
        const client = await req.dbPool.connect();
        try {
            const { lines } = await prepareBulkPayment(client, await batchBody(client, batch));
            res.json({ journal: await describeJournalLines(client, lines) });
        } finally { client.release(); }
    } catch (err) { errOut(res, err, 'previewing'); }
};

// PUT /:id/pay — Approved → Paid: บันทึก GL + รายการจ่ายธนาคาร (ต้องผ่านอนุมัติแล้วเท่านั้น)
const payBatch = batchAction('paying', 'จ่ายสำเร็จ', async (client, batch, { userName }) => {
    if (batch.status !== 'Approved') throw DA.httpErr(400, 'จ่ายได้เฉพาะชุดที่อนุมัติแล้วเท่านั้น');
    const { glEntryId, glDocNo, created } = await payItems(client, await batchBody(client, batch), userName || 'system');
    await client.query(`
        UPDATE ap_bulk_payment SET status='Paid', gl_entry_id=$1, gl_doc_no=$2, paid_by=$3, paid_at=NOW(), updated_at=NOW(), updated_by=$3
         WHERE id=$4`, [glEntryId, glDocNo, userName, batch.id]);
    return { gl_doc_no: glDocNo, created_count: created.length, payments: created };
});

// GET /ap_bulk_payment/my_pending — ชุดที่ถึงคิวผู้ใช้นี้อนุมัติ (กระดิ่งหน้า Home)
const fetchMyPending = async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    try {
        await ensureBulkSchema(req.dbPool);
        const r = await req.dbPool.query(`
            SELECT b.id, b.batch_no AS doc_no, b.payment_date AS doc_date, b.description,
                   b.total_amount_lc::float AS total_amount_lc, b.created_by AS submitted_by
              FROM ap_bulk_payment b
             WHERE b.status = 'Submitted' AND ${DA.myTurnSql('b', '$1', '$2')}
             ORDER BY b.payment_date DESC, b.id DESC`, [KIND, userId]);
        res.json(r.rows);
    } catch (err) { errOut(res, err, 'fetching pending'); }
};

module.exports = {
    getEligibleInvoices, previewBulkPayment,
    listBatches, getBatch, createBatch, deleteBatch, submitBatch, approveBatch, rejectBatch, reverseBatch,
    previewBatch, payBatch, fetchMyPending,
};
