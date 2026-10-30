// controllers/im/imConsignmentSettlementController.js
// Consignment Settlement — แปลงยอดขายสินค้าฝากขาย (sys_doc_type='13') ที่ขายออกไปแล้วแต่ยังไม่ตั้งหนี้ ให้เป็น
// ใบตั้งหนี้ AP จริง (ก้อนเดียวต่อผู้ฝากขาย ต่อการ settle 1 ครั้ง) — มิเรอร์วิธีสร้าง ap_transaction ของ
// postApBillFromGrn ใน imTransactionController.js แต่ต่างกันที่:
//   1. Debit ฝั่งซ้าย ไม่ใช่บัญชีค่าใช้จ่าย/สินค้าคงคลัง (มูลค่าสต็อกรับรู้ไปแล้วตอนรับฝากขาย) แต่เป็นการ "เคลียร์"
//      บัญชีเจ้าหนี้ฝากขาย (consignment_payable_account_id) ที่ค้างไว้จากตอนรับของ
//      => Dr เจ้าหนี้ฝากขาย / Cr เจ้าหนี้การค้า (AP)
//   2. ไม่มี VAT (มิเรอร์ '10' GRN ธรรมดาที่ไม่มี VAT ตอน Post — ถ้าใบกำกับจริงจากผู้ฝากขายมี VAT ผู้ใช้ปรับเพิ่มเองใน AP ภายหลัง)
//   3. มาจากการตัด im_stock_layer หลายใบของหลายเอกสารขายมารวมเป็นบิลเดียว ไม่ใช่ 1:1 กับเอกสารรับเหมือน '11'/'12'
const { generateDocNo } = require('./imTransactionController');
const { getBaseCurrency } = require('../../utils/baseCurrency');
const { resolveApAccountId } = require('../../utils/apAccount');
const { today, ymd } = require('../../utils/dateUtil');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');

// หา consumption ที่มาจาก layer ของเอกสารรับฝากขาย (sys_doc_type='13') และยังไม่ถูก settle
const PENDING_SELECT = `
    SELECT
        c.id AS consumption_id, c.qty, c.layer_id,
        l.unit_cost, l.lot_no, l.serial_no, l.source_doc_id AS receipt_header_id, l.source_doc_no AS receipt_doc_no,
        rt.id AS receipt_txn_id, rt.doc_code AS receipt_doc_code, rt.vendor_id,
        rt.currency_code AS receipt_currency_code, rt.exchange_rate AS receipt_exchange_rate,
        v.vendor_code, v.vendor_name_th, v.tax_id AS vendor_tax_id,
        st.id AS sale_txn_id, st.doc_no AS sale_doc_no, st.doc_date AS sale_doc_date,
        it.id AS item_id, it.item_code, it.item_name_th, it.item_name_en,
        gs.consignment_payable_account_id
    FROM im_stock_layer_consumption c
    JOIN im_stock_layer l          ON l.id = c.layer_id
    JOIN im_transaction rt         ON rt.id = l.source_doc_id
    JOIN sa_module_document rd     ON rd.doc_code = rt.doc_code AND rd.sys_doc_type = '13'
    JOIN im_transaction st         ON st.id = c.header_id
    JOIN im_item it                ON it.id = l.item_id
    LEFT JOIN ap_vendor v          ON v.id = rt.vendor_id
    LEFT JOIN im_gl_account_setup gs ON gs.doc_code = rt.doc_code
    WHERE c.settlement_ap_transaction_id IS NULL
`;

// GET /im_consignment_settlement/pending?vendor_id=
const fetchPending = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const { vendor_id } = req.query;
        const params = [];
        let where = '';
        if (vendor_id) {
            params.push(vendor_id);
            where = ` AND rt.vendor_id = $${params.length}`;
        }
        const result = await client.query(`${PENDING_SELECT} ${where} ORDER BY rt.vendor_id, it.item_code, st.doc_date, st.id`, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching consignment settlement pending rows:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// Marker set on every ap_transaction row postSettlement creates — used to identify "is this ap_transaction a
// consignment settlement" independent of im_stock_layer_consumption.settlement_ap_transaction_id, which gets nulled
// out on void / delete (so a join against it would make those settlements vanish from history).
// apTransactionController ใช้คำนำหน้าเดียวกันกันหน้าจอ AP ถอย/ยกเลิก/แก้ไขใบนี้ (CONSIGNMENT)
const SETTLEMENT_DESCRIPTION_PREFIX = 'ตั้งหนี้สินค้าฝากขาย';

const userIdOf = (req) => {
    const v = Number(req.body?.user_id || req.headers['userid']);
    return Number.isFinite(v) && v > 0 ? v : null;
};
const reasonOf = (req) => (req.body?.reason || '').trim();

// งวดที่ GL และ AP เปิด (OPEN) สำหรับวันที่ใบตั้งหนี้
const openPeriodId = async (client, date) => (await client.query(
    `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date
       AND gl_status = 'OPEN' AND ap_status = 'OPEN' LIMIT 1`, [date])).rows[0]?.id || null;

// ลงรายการบัญชีของใบตั้งหนี้ฝากขายจากบรรทัดใน ap_transaction_detail (Dr เจ้าหนี้ฝากขาย / Cr เจ้าหนี้การค้า)
// ใช้ตอนตั้งหนี้ครั้งแรก และตอนโพสต์ใหม่หลังถอยเป็นร่าง (เลขที่รายการบัญชีเดิมเก็บไว้ที่ gl_doc_no)
const postSettlementGl = async (client, apTransactionId, userId) => {
    const tx = (await client.query(`SELECT * FROM ap_transaction WHERE id = $1`, [apTransactionId])).rows[0];
    const lines = (await client.query(
        `SELECT expense_account_id, total_amount_lc FROM ap_transaction_detail WHERE header_id = $1 ORDER BY line_no`,
        [apTransactionId])).rows;
    const debitByAccount = {};
    for (const l of lines) {
        debitByAccount[l.expense_account_id] = (debitByAccount[l.expense_account_id] || 0) + Number(l.total_amount_lc);
    }
    const glDetails = [];
    for (const [accId, amt] of Object.entries(debitByAccount)) {
        if (amt === 0) continue;
        glDetails.push({ account_id: Number(accId), description: `Settle เจ้าหนี้ฝากขาย ${tx.doc_no}`, debit_lc: amt, credit_lc: 0 });
    }
    const total = glDetails.reduce((s, l) => s + l.debit_lc, 0);
    if (total !== 0) {
        glDetails.push({ account_id: Number(tx.ap_account_id), description: `ตั้งหนี้ผู้ฝากขาย ${tx.doc_no}`, debit_lc: 0, credit_lc: total });
    }
    if (glDetails.length === 0) return null;

    const glDocNo = tx.gl_doc_no || `GL-${tx.doc_no}`;
    const glRes = await client.query(`
        INSERT INTO gl_entry_header
        (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
         currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
         created_by, ref_doc_id, ref_doc_no, external_source_id, ref_doc_date)
        VALUES ($1,$2,$3,$3,$4,$5,$6,$12,1,'Posted',$7,$7,0,0,$8,$9,$10,$11,$3)
        RETURNING id
    `, [
        tx.gl_doc_id, glDocNo, tx.doc_date, tx.period_id, tx.ref_no, tx.description,
        total, userId, tx.doc_id, tx.doc_no, apTransactionId,
        (await getBaseCurrency(client)).id, // ยอดเป็นบาทล้วน (fc 0) — สกุลเงินหลัก ไม่ใช่ id 1 ตายตัว
    ]);
    const glEntryId = glRes.rows[0].id;
    let glLineNo = 1;
    for (const l of glDetails) {
        await client.query(`
            INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
            VALUES ($1,$2,$3,$4,$5,$6,0,0)
        `, [glEntryId, glLineNo++, l.account_id, l.description, l.debit_lc, l.credit_lc]);
    }
    await client.query(`UPDATE ap_transaction SET gl_entry_id = $1, gl_doc_no = $2 WHERE id = $3`, [glEntryId, glDocNo, apTransactionId]);
    return glEntryId;
};

// POST /im_consignment_settlement { vendor_id, consumption_ids: [...], ref_no?, doc_date? }
// สร้างใบตั้งหนี้ AP ก้อนเดียว (Dr เจ้าหนี้ฝากขาย / Cr เจ้าหนี้การค้า) จาก consumption ที่เลือก แล้ว mark ว่า settle แล้ว
const postSettlement = async (req, res) => {
    const { vendor_id, consumption_ids, ref_no, doc_date } = req.body;
    const client = await req.dbPool.connect();
    try {
        if (!vendor_id) return res.status(400).json({ message: 'กรุณาระบุผู้ฝากขาย' });
        if (!Array.isArray(consumption_ids) || consumption_ids.length === 0) {
            return res.status(400).json({ message: 'กรุณาเลือกรายการที่จะตั้งหนี้อย่างน้อย 1 รายการ' });
        }
        const settleDate = doc_date || today();

        await client.query('BEGIN');

        const pendingRes = await client.query(
            `${PENDING_SELECT} AND c.id = ANY($1::int[])`, [consumption_ids]
        );
        if (pendingRes.rows.length === 0) throw new Error('ไม่พบรายการที่จะตั้งหนี้ หรือถูกตั้งหนี้ไปแล้ว');
        const rows = pendingRes.rows;
        const otherVendor = rows.find(r => Number(r.vendor_id) !== Number(vendor_id));
        if (otherVendor) throw new Error('เลือกรายการได้เฉพาะของผู้ฝากขายรายเดียวกันต่อการ Settlement หนึ่งครั้ง');
        const missingAccount = rows.find(r => !r.consignment_payable_account_id);
        if (missingAccount) {
            throw new Error(`ยังไม่ได้ตั้งค่าบัญชีเจ้าหนี้ฝากขาย (consignment_payable_account_id) สำหรับเอกสาร ${missingAccount.receipt_doc_code}`);
        }
        // ใบตั้งหนี้ AP มีสกุลเงินเดียวต่อเอกสาร — ถ้ารายการที่เลือกมาจากใบรับฝากขายคนละสกุลเงิน (เช่น ผู้ฝากขายเคย
        // ส่งของมาเป็น USD ครั้งหนึ่ง แล้วเปลี่ยนมาเป็น THB อีกครั้ง) ต้อง Settlement แยกชุดตามสกุลเงิน
        const { code: baseCode } = await getBaseCurrency(client);
        const docCurrencyCode = rows[0].receipt_currency_code || baseCode;
        const mixedCurrency = rows.find(r => (r.receipt_currency_code || baseCode) !== docCurrencyCode);
        if (mixedCurrency) {
            throw new Error('รายการที่เลือกมาจากใบรับฝากขายคนละสกุลเงิน กรุณา Settlement แยกตามสกุลเงิน');
        }
        const docExchangeRate = Number(rows[0].receipt_exchange_rate) || 1;

        const apDocRes = await client.query(`
            SELECT id, doc_code FROM sa_module_document
            WHERE sys_module='21' AND sys_doc_type='10' AND is_doc_type=true AND is_active=true
            ORDER BY sort_order LIMIT 1
        `);
        if (apDocRes.rows.length === 0) throw new Error('ไม่พบประเภทเอกสารใบกำกับสินค้า (Purchase Invoice) ในโมดูล AP');
        const apDocId = apDocRes.rows[0].id;
        const apDocCode = apDocRes.rows[0].doc_code;

        const apSetupRes = await client.query(`SELECT * FROM ap_gl_account_setup WHERE doc_code = $1`, [apDocCode]);
        const apSetup = apSetupRes.rows[0] || null;
        if (!apSetup?.gl_doc_id) throw new Error('ยังไม่ได้ตั้งค่า GL Document Type ใน ap_gl_account_setup สำหรับใบกำกับสินค้า');

        // บัญชีเจ้าหนี้ — ลำดับเดียวกับ AP: เจ้าหนี้ > กลุ่มเจ้าหนี้ > ประเภทเอกสาร AP (utils/apAccount.js)
        const apAccountId = await resolveApAccountId(client, { vendorId: vendor_id, docId: apDocId });
        if (!apAccountId) throw new Error('ไม่พบบัญชีเจ้าหนี้สำหรับการลงบัญชี กรุณาตั้งค่าที่เจ้าหนี้ กลุ่มเจ้าหนี้ หรือการตั้งค่ารหัสบัญชีของประเภทเอกสาร');

        const vendorRow = rows[0];
        const periodId = await openPeriodId(client, settleDate);
        if (!periodId) throw new Error(`งวดบัญชี/งวด AP ของวันที่ ${settleDate} ยังไม่เปิด ตั้งหนี้ไม่ได้`);

        let apDocNo = await generateDocNo(client, apDocId, settleDate, null);
        if (!apDocNo) apDocNo = `CONS-${Date.now()}`;
        const createdByUserId = userIdOf(req);

        // unit_cost บน im_stock_layer เป็นบาทเสมอ (ไม่มี FC บน stock layer — ดู plan) แปลงกลับเป็นสกุลเงินของใบรับ
        // ฝากขายต้นทาง (docExchangeRate ตรวจแล้วว่าทุกบรรทัดมาจากอัตราเดียวกันข้างบน) เพื่อให้ใบตั้งหนี้ AP ที่สร้าง
        // อัตโนมัตินี้ตรงกับสกุลเงินจริงของผู้ฝากขาย แทนที่จะ hardcode 'THB'/1 เหมือนเดิม
        const lineRows = rows.map(r => {
            const unitCostLc = Number(r.unit_cost);
            const unitCostFc = unitCostLc / docExchangeRate;
            const qty = Number(r.qty);
            return {
                itemCode: r.item_code, itemName: r.item_name_th,
                quantity: qty, unitPriceFc: unitCostFc, amountLc: qty * unitCostLc, amountFc: qty * unitCostFc,
                consignmentPayableAccountId: Number(r.consignment_payable_account_id),
            };
        });
        const totalAmountLc = lineRows.reduce((s, l) => s + l.amountLc, 0);
        const totalAmountFc = lineRows.reduce((s, l) => s + l.amountFc, 0);

        const apHeaderRes = await client.query(`
            INSERT INTO ap_transaction
            (doc_id, doc_no, doc_date, period_id, vendor_id, vendor_code, vendor_name_th, ap_account_id, gl_doc_id,
             currency_code, exchange_rate, subtotal_fc, before_vat_fc, vat_amount_fc, total_amount_fc,
             subtotal_lc, before_vat_lc, vat_amount_lc, total_amount_lc,
             balance_amount_lc, ref_no, description, status, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,0,$12,$13,$13,0,$13,$13,$14,$15,'Posted',$16,$16)
            RETURNING id
        `, [
            apDocId, apDocNo, settleDate, periodId, vendor_id, vendorRow.vendor_code, vendorRow.vendor_name_th, apAccountId, apSetup.gl_doc_id,
            docCurrencyCode, docExchangeRate, totalAmountFc,
            totalAmountLc, ref_no || null, `${SETTLEMENT_DESCRIPTION_PREFIX} (Consignment Settlement) ${apDocNo}`, createdByUserId,
        ]);
        const apTransactionId = apHeaderRes.rows[0].id;

        let lineNo = 1;
        for (const l of lineRows) {
            await client.query(`
                INSERT INTO ap_transaction_detail
                (header_id, line_no, description, quantity, unit_price_fc, subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
                 expense_account_id, subtotal_lc, vat_amount_lc, total_amount_lc)
                VALUES ($1,$2,$3,$4,$5,$6,'NOVAT',0,0,$6,$7,$8,0,$8)
            `, [apTransactionId, lineNo++, l.itemName || l.itemCode, l.quantity, l.unitPriceFc, l.amountFc, l.consignmentPayableAccountId, l.amountLc]);
        }

        await postSettlementGl(client, apTransactionId, createdByUserId);

        await client.query(
            `UPDATE im_stock_layer_consumption SET settlement_ap_transaction_id = $1 WHERE id = ANY($2::int[])`,
            [apTransactionId, consumption_ids]
        );

        await client.query('COMMIT');
        res.status(201).json({ ap_transaction_id: apTransactionId, ap_doc_no: apDocNo, total_amount: totalAmountLc, line_count: lineRows.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error posting consignment settlement:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// ===== ถอยเป็นร่าง / โพสต์ใหม่ / ยกเลิก / ลบ =====
// - ถอย (Posted → Draft): งวด GL + AP ของใบตั้งหนี้ยังเปิด และใบตั้งหนี้ยังไม่ถูกจ่าย/จับคู่/อยู่ในชุดจ่ายเงิน/ปรับอัตราแลกเปลี่ยน
//   ลบรายการบัญชี (เก็บเลขที่ไว้ที่ gl_doc_no) รายการขายฝากขายยังผูกกับร่างนี้ โพสต์ใหม่ได้ด้วยเลขที่เดิม
// - ลบ: เฉพาะร่าง เก็บไว้ด้วยสถานะ Deleted คืนรายการขายฝากขายกลับไปรอตั้งหนี้ (เลขที่นี้ใช้ต่อไม่ได้)
// - ยกเลิก: ใช้เมื่อถอยไม่ได้ (เช่น งวดเดิมปิดแล้ว) ลงรายการบัญชีกลับในวันที่ยกเลิก คืนรายการขายฝากขายกลับไปรอตั้งหนี้
// ทุกการกระทำต้องมีเหตุผล บันทึกที่ sa_document_reverse_log (ตาราง ap_transaction — หน้าจอ AP เห็นประวัติเดียวกัน)
const SETTLEMENT_BLOCK_MESSAGES = {
    NOT_REVERSIBLE: 'ถอยได้เฉพาะใบตั้งหนี้ที่โพสต์แล้ว',
    NOT_POSTED:     'ยกเลิกได้เฉพาะใบตั้งหนี้ที่โพสต์แล้ว (ร่างให้ลบแทน)',
    NOT_DRAFT:      'ใบตั้งหนี้ที่โพสต์แล้วลบไม่ได้ กรุณาถอยเป็นร่างก่อน',
    PERIOD_CLOSED:  'งวดบัญชีของใบตั้งหนี้นี้ปิดแล้ว ถอยไม่ได้',
    VOIDED:         'ใบตั้งหนี้นี้ถูกยกเลิกหรือลบแล้ว',
};
const packBlock = (code, ref, message) => ({ code, ref: ref || null, message: message || SETTLEMENT_BLOCK_MESSAGES[code] });

// เหตุที่ถอย / ยกเลิก / ลบ / โพสต์ใหม่ไม่ได้ (null = ทำได้)
const computeSettlementBlocks = async (db, id) => {
    const { getApLinkedState } = require('../ap/apTransactionController');
    const st = await getApLinkedState(db, id);
    if (!st) return {};
    if (['Void', 'Deleted'].includes(st.status)) {
        const v = packBlock('VOIDED');
        return { reverse_block: v, void_block: v, delete_block: v, post_block: v };
    }
    if (st.status !== 'Posted') {
        return {
            reverse_block: packBlock('NOT_REVERSIBLE'), void_block: packBlock('NOT_POSTED'),
            delete_block: null, post_block: null,
        };
    }
    // AP_BLOCKED: ใบตั้งหนี้ถูกจ่าย / จับคู่ / อยู่ในชุดจ่ายเงิน / ปรับอัตราแลกเปลี่ยน / จ่ายผ่านธนาคารที่เคลียร์แล้ว
    const apBlock = st.block ? packBlock('AP_BLOCKED', st.block.ref, st.block.message) : null;
    return {
        reverse_block: apBlock || (!st.periodOpen ? packBlock('PERIOD_CLOSED') : null),
        void_block: apBlock,
        delete_block: packBlock('NOT_DRAFT'),
        post_block: packBlock('NOT_DRAFT', null, 'ใบตั้งหนี้นี้โพสต์แล้ว'),
    };
};

// ล็อกใบตั้งหนี้ฝากขาย (ต้องเป็นใบที่ postSettlement สร้าง)
const lockSettlement = async (client, id) => (await client.query(
    `SELECT * FROM ap_transaction WHERE id = $1 AND description LIKE $2 FOR UPDATE`,
    [id, `${SETTLEMENT_DESCRIPTION_PREFIX}%`])).rows[0] || null;

const fetchSettlementById = async (db, id) => {
    const row = (await db.query(`
        SELECT id, doc_no, doc_date, status, total_amount_lc, ref_no, gl_doc_no, void_reason, voided_at,
               (SELECT COUNT(*)::int FROM im_stock_layer_consumption c WHERE c.settlement_ap_transaction_id = t.id) AS line_count
          FROM ap_transaction t WHERE id = $1`, [id])).rows[0];
    if (!row) return null;
    return {
        ...row, ...(await computeSettlementBlocks(db, id)),
        reverse_history: await getReverseHistory(db, 'ap_transaction', id),
    };
};

// GET /im_consignment_settlement?vendor_id= — settlement history for one vendor, including voided / deleted ones.
const fetchSettled = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const { vendor_id } = req.query;
        if (!vendor_id) return res.status(400).json({ message: 'กรุณาระบุผู้ฝากขาย' });
        const ids = (await client.query(`
            SELECT id FROM ap_transaction
            WHERE vendor_id = $1 AND description LIKE $2
            ORDER BY doc_date DESC, id DESC
        `, [vendor_id, `${SETTLEMENT_DESCRIPTION_PREFIX}%`])).rows;
        const rows = [];
        for (const r of ids) rows.push(await fetchSettlementById(client, r.id));
        res.json(rows);
    } catch (error) {
        console.error('Error fetching consignment settlement history:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// ดำเนินการกับใบตั้งหนี้ฝากขายใน transaction เดียว: fn คืน { status, message, code, ref } เมื่อทำไม่ได้
const runAction = async (req, res, label, fn) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const tx = await lockSettlement(client, id);
        if (!tx) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบรายการตั้งหนี้สินค้าฝากขายนี้' }); }
        const err = await fn(client, tx, reason);
        if (err) {
            await client.query('ROLLBACK');
            return res.status(err.status || 400).json({ message: err.message, code: err.code || null, ref: err.ref || null });
        }
        await client.query('COMMIT');
        res.status(200).json(await fetchSettlementById(req.dbPool, id));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error ${label} consignment settlement:`, error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};
const blockError = (b) => ({ message: b.message + (b.ref && b.code !== 'AP_BLOCKED' ? ` (${b.ref})` : ''), code: b.code, ref: b.ref });

// PUT /im_consignment_settlement/:id/reverse { reason } — Posted → Draft
const reverseSettlement = (req, res) => runAction(req, res, 'reversing', async (client, tx, reason) => {
    if (!reason) return { message: 'กรุณาระบุเหตุผลการถอยเอกสาร' };
    const b = (await computeSettlementBlocks(client, tx.id)).reverse_block;
    if (b) return blockError(b);
    let glDocNo = tx.gl_doc_no;
    if (tx.gl_entry_id) {
        glDocNo = (await client.query(`SELECT doc_no FROM gl_entry_header WHERE id = $1`, [tx.gl_entry_id])).rows[0]?.doc_no || glDocNo;
        // ตัด FK ก่อน (ap_transaction.gl_entry_id ไม่มี ON DELETE SET NULL)
        await client.query(`UPDATE ap_transaction SET gl_entry_id = NULL WHERE id = $1`, [tx.id]);
        await client.query(`DELETE FROM gl_entry_header WHERE id = $1`, [tx.gl_entry_id]);
    }
    await client.query(`DELETE FROM vt_transaction WHERE module_code = 'AP' AND source_header_id = $1`, [tx.id]);
    await client.query(`
        UPDATE ap_transaction SET status = 'Draft', gl_doc_no = $1, updated_by = $2, updated_at = NOW()
         WHERE id = $3`, [glDocNo, req.headers.username || null, tx.id]);
    await logReverse(client, {
        sysModule: '21', tableName: 'ap_transaction', recordId: Number(tx.id), docNo: tx.doc_no,
        fromStatus: tx.status, toStatus: 'Draft', reason, userId: userIdOf(req),
    });
    return null;
});

// PUT /im_consignment_settlement/:id/post { doc_date?, ref_no? } — โพสต์ร่างใหม่ด้วยเลขที่เดิม (รายการขายฝากขายชุดเดิม)
const repostSettlement = (req, res) => runAction(req, res, 'reposting', async (client, tx) => {
    const b = (await computeSettlementBlocks(client, tx.id)).post_block;
    if (b) return blockError(b);
    const docDate = req.body?.doc_date || tx.doc_date;
    const periodId = await openPeriodId(client, docDate);
    if (!periodId) return { message: `งวดบัญชี/งวด AP ของวันที่ ${ymd(docDate)} ยังไม่เปิด โพสต์ไม่ได้`, code: 'PERIOD_CLOSED' };
    const refNo = req.body?.ref_no !== undefined ? (req.body.ref_no || null) : tx.ref_no;
    await client.query(`
        UPDATE ap_transaction SET status = 'Posted', doc_date = $1, period_id = $2, ref_no = $3,
               updated_by = $4, updated_at = NOW()
         WHERE id = $5`, [docDate, periodId, refNo, req.headers.username || null, tx.id]);
    await postSettlementGl(client, tx.id, userIdOf(req));
    return null;
});

// DELETE /im_consignment_settlement/:id { reason } — เฉพาะร่าง: เก็บไว้ด้วยสถานะ Deleted คืนรายการกลับไปรอตั้งหนี้
const deleteSettlement = (req, res) => runAction(req, res, 'deleting', async (client, tx, reason) => {
    if (!reason) return { message: 'กรุณาระบุเหตุผลการลบเอกสาร' };
    const b = (await computeSettlementBlocks(client, tx.id)).delete_block;
    if (b) return blockError(b);
    await client.query(
        `UPDATE im_stock_layer_consumption SET settlement_ap_transaction_id = NULL WHERE settlement_ap_transaction_id = $1`, [tx.id]);
    await client.query(`
        UPDATE ap_transaction SET status = 'Deleted', updated_by = $1, updated_at = NOW() WHERE id = $2`,
        [req.headers.username || null, tx.id]);
    await logReverse(client, {
        sysModule: '21', tableName: 'ap_transaction', recordId: Number(tx.id), docNo: tx.doc_no,
        fromStatus: tx.status, toStatus: 'Deleted', reason, userId: userIdOf(req),
    });
    return null;
});

// PUT /im_consignment_settlement/:id/void { reason } — ยกเลิกผ่าน AP (รายการบัญชีกลับวันที่ยกเลิก + ประวัติ)
// แล้วคืนรายการขายฝากขายกลับไปรอตั้งหนี้ ตั้งหนี้ใหม่ได้
const voidSettlement = (req, res) => runAction(req, res, 'voiding', async (client, tx, reason) => {
    if (!reason) return { message: 'กรุณาระบุเหตุผลการยกเลิก' };
    const b = (await computeSettlementBlocks(client, tx.id)).void_block;
    if (b) return blockError(b);
    const { voidApDocument } = require('../ap/apTransactionController');
    const r = await voidApDocument(client, tx.id, {
        voidReason: reason, userId: userIdOf(req), userName: req.headers.username || null, fromConsignment: true,
    });
    if (r.message) return { message: r.message, code: r.code, ref: r.ref, status: r.httpStatus };
    await client.query(
        `UPDATE im_stock_layer_consumption SET settlement_ap_transaction_id = NULL WHERE settlement_ap_transaction_id = $1`, [tx.id]);
    return null;
});

module.exports = {
    fetchPending, postSettlement, fetchSettled,
    reverseSettlement, repostSettlement, deleteSettlement, voidSettlement, computeSettlementBlocks,
};
