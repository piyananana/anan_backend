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

// หา consumption ที่มาจาก layer ของเอกสารรับฝากขาย (sys_doc_type='13') และยังไม่ถูก settle
const PENDING_SELECT = `
    SELECT
        c.id AS consumption_id, c.qty, c.layer_id,
        l.unit_cost, l.lot_no, l.serial_no, l.source_doc_id AS receipt_header_id, l.source_doc_no AS receipt_doc_no,
        rt.id AS receipt_txn_id, rt.doc_code AS receipt_doc_code, rt.vendor_id,
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

// POST /im_consignment_settlement { vendor_id, consumption_ids: [...], ref_no?, doc_date? }
// สร้างใบตั้งหนี้ AP ก้อนเดียว (Dr เจ้าหนี้ฝากขาย / Cr เจ้าหนี้การค้า) จาก consumption ที่เลือก แล้ว mark ว่า settle แล้ว
const postSettlement = async (req, res) => {
    const { vendor_id, consumption_ids, ref_no, doc_date } = req.body;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        if (!vendor_id) return res.status(400).json({ message: 'กรุณาระบุผู้ฝากขาย' });
        if (!Array.isArray(consumption_ids) || consumption_ids.length === 0) {
            return res.status(400).json({ message: 'กรุณาเลือกรายการที่จะตั้งหนี้อย่างน้อย 1 รายการ' });
        }
        const settleDate = doc_date || new Date().toISOString().slice(0, 10);

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

        let apAccountId = apSetup.ap_account_id ? Number(apSetup.ap_account_id) : null;
        if (!apAccountId) {
            const vendorAcctRes = await client.query(`SELECT ap_account_id FROM ap_vendor WHERE id = $1`, [vendor_id]);
            apAccountId = vendorAcctRes.rows[0]?.ap_account_id ? Number(vendorAcctRes.rows[0].ap_account_id) : null;
        }
        if (!apAccountId) throw new Error('ไม่พบบัญชีเจ้าหนี้สำหรับการลงบัญชี กรุณาตั้งค่าใน ap_gl_account_setup หรือผู้ขาย');

        const vendorRow = rows[0];
        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date AND gl_status='OPEN' AND ap_status != 'CLOSED' LIMIT 1`,
            [settleDate]
        );
        if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${settleDate}`);
        const periodId = periodRes.rows[0].id;

        let apDocNo = await generateDocNo(client, apDocId, settleDate, null);
        if (!apDocNo) apDocNo = `CONS-${Date.now()}`;

        let createdByUserId = null;
        if (userName) {
            const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
            if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
        }

        const lineRows = rows.map(r => ({
            itemCode: r.item_code, itemName: r.item_name_th,
            quantity: Number(r.qty), unitPriceFc: Number(r.unit_cost), amount: Number(r.qty) * Number(r.unit_cost),
            consignmentPayableAccountId: Number(r.consignment_payable_account_id),
        }));
        const totalAmount = lineRows.reduce((s, l) => s + l.amount, 0);

        const apHeaderRes = await client.query(`
            INSERT INTO ap_transaction
            (doc_id, doc_no, doc_date, period_id, vendor_id, vendor_code, vendor_name_th, ap_account_id, gl_doc_id,
             currency_code, exchange_rate, subtotal_fc, before_vat_fc, vat_amount_fc, total_amount_fc,
             subtotal_lc, before_vat_lc, vat_amount_lc, total_amount_lc,
             balance_amount_lc, ref_no, description, status, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'THB',1,$10,$10,0,$10,$10,$10,0,$10,$10,$11,$12,'Posted',$13,$13)
            RETURNING id
        `, [
            apDocId, apDocNo, settleDate, periodId, vendor_id, vendorRow.vendor_code, vendorRow.vendor_name_th, apAccountId, apSetup.gl_doc_id,
            totalAmount, ref_no || null, `ตั้งหนี้สินค้าฝากขาย (Consignment Settlement) ${apDocNo}`, createdByUserId,
        ]);
        const apTransactionId = apHeaderRes.rows[0].id;

        let lineNo = 1;
        for (const l of lineRows) {
            await client.query(`
                INSERT INTO ap_transaction_detail
                (header_id, line_no, description, quantity, unit_price_fc, subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
                 expense_account_id, subtotal_lc, vat_amount_lc, total_amount_lc)
                VALUES ($1,$2,$3,$4,$5,$6,'NOVAT',0,0,$6,$7,$6,0,$6)
            `, [apTransactionId, lineNo++, l.itemName || l.itemCode, l.quantity, l.unitPriceFc, l.amount, l.consignmentPayableAccountId]);
        }

        const debitByAccount = {};
        for (const l of lineRows) {
            debitByAccount[l.consignmentPayableAccountId] = (debitByAccount[l.consignmentPayableAccountId] || 0) + l.amount;
        }
        const apGlDetails = [];
        for (const [accId, amt] of Object.entries(debitByAccount)) {
            if (amt === 0) continue;
            apGlDetails.push({ account_id: Number(accId), description: `Settle เจ้าหนี้ฝากขาย ${apDocNo}`, debit_lc: amt, credit_lc: 0 });
        }
        if (totalAmount !== 0) {
            apGlDetails.push({ account_id: apAccountId, description: `ตั้งหนี้ผู้ฝากขาย ${apDocNo}`, debit_lc: 0, credit_lc: totalAmount });
        }

        if (apGlDetails.length > 0) {
            const totalDebit = apGlDetails.reduce((s, l) => s + l.debit_lc, 0);
            const totalCredit = apGlDetails.reduce((s, l) => s + l.credit_lc, 0);
            const apGlHeaderRes = await client.query(`
                INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
                 currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
                 created_by, ref_doc_id, ref_doc_no, external_source_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'Posted',$9,$10,0,0,$11,$12,$13,$14)
                RETURNING id
            `, [
                apSetup.gl_doc_id, `GL-${apDocNo}`, settleDate, settleDate, periodId,
                ref_no || null, `ตั้งหนี้สินค้าฝากขาย (Consignment Settlement) ${apDocNo}`,
                1, totalDebit, totalCredit, createdByUserId, apDocId, apDocNo, apTransactionId,
            ]);
            const apGlEntryId = apGlHeaderRes.rows[0].id;
            let glLineNo = 1;
            for (const l of apGlDetails) {
                await client.query(`
                    INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                    VALUES ($1,$2,$3,$4,$5,$6,0,0)
                `, [apGlEntryId, glLineNo++, l.account_id, l.description, l.debit_lc, l.credit_lc]);
            }
            await client.query(`UPDATE ap_transaction SET gl_entry_id = $1 WHERE id = $2`, [apGlEntryId, apTransactionId]);
        }

        await client.query(
            `UPDATE im_stock_layer_consumption SET settlement_ap_transaction_id = $1 WHERE id = ANY($2::int[])`,
            [apTransactionId, consumption_ids]
        );

        await client.query('COMMIT');
        res.status(201).json({ ap_transaction_id: apTransactionId, ap_doc_no: apDocNo, total_amount: totalAmount, line_count: lineRows.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error posting consignment settlement:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchPending, postSettlement };
