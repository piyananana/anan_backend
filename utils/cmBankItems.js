// รายการเงินเข้า/ออกบัญชีธนาคาร (cm_receipt = เงินเข้า, cm_payment = เงินออก) — ยอดธนาคารฝั่ง CM, กระทบยอดกับ GL,
// จับคู่ bank statement, งบกระแสเงินสด, รายงาน และการปรับมูลค่าอัตราแลกเปลี่ยน อ่านจากสองตารางนี้เท่านั้น
// เอกสารทุกประเภทที่เงินผ่านบัญชีธนาคาร/เงินสดย่อยจึงต้องเขียนรายการที่นี่ตอนโพสต์ (user-approved 2026-11-01,
// ดู project_cm_recheck_2026_11):
//   AR 60 รับมัดจำ / 80 รับชำระ → เงินเข้า, AR 65 คืนมัดจำ → เงินออก
//   AP 60 จ่ายมัดจำ / 80 จ่ายชำระ → เงินออก, AP 65 รับคืนมัดจำ → เงินเข้า
//   CM 10 รายรับ → เข้า, 20 รายจ่าย → ออก, 30 เติมเงินสดย่อย → ออกจากธนาคาร + เข้ากองเงินสดย่อย,
//      40 เบิกเงินสดย่อย → ออกจากกองเงินสดย่อย, 50 โอน → ออกจากต้นทาง + เข้าปลายทาง,
//      70 ค่าธรรมเนียม → ออก, 90 ดอกเบี้ยรับ → เข้า / ดอกเบี้ยจ่าย → ออก
// source_type = โมดูล+ประเภทเอกสาร (เช่น 'CM50') — ว่าง = รายการเดิมของ AR/AP 80; งบกระแสเงินสดแยกเงินโอน (CM50)
// เลขที่เอกสารต้นทางเก็บที่ ar_doc_no (เงินเข้า) / ap_doc_no (เงินออก) ตามชื่อคอลัมน์เดิมที่รายงานทุกตัวใช้แสดง
// สถานะเริ่มต้น Pending เหมือนรายการของ AR/AP (เคลียร์ภายหลังในหน้ารายการรับ/จ่ายเงิน)
const { getBaseCurrencyCode } = require('./baseCurrency');

const ensured = new Set();
const ensureBankItemColumns = async (db) => {
    const key = db.options?.database || db.database || 'default';
    if (ensured.has(key)) return;
    // สร้างตารางก่อนเสมอ (ฐานข้อมูลใหม่ที่ยังไม่เคยใช้ CM) — require ตอนเรียกเพื่อเลี่ยง require วนกับ AR controller
    await require('../controllers/cm/cmReceiptController').ensureCmReceiptTable(db);
    await require('../controllers/cm/cmPaymentController').ensureCmPaymentTable(db);
    for (const t of ['cm_receipt', 'cm_payment']) {
        await db.query(`ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS ar_transaction_id INTEGER`);
        await db.query(`ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS ap_transaction_id INTEGER`);
        await db.query(`ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS cm_transaction_id INTEGER`);
        await db.query(`ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS source_type VARCHAR(10)`);
        await db.query(`CREATE INDEX IF NOT EXISTS ${t}_cm_transaction_idx ON ${t} (cm_transaction_id)`).catch(() => {});
    }
    await db.query(`ALTER TABLE IF EXISTS cm_payment ADD COLUMN IF NOT EXISTS drawer_bank VARCHAR(200)`);
    ensured.add(key);
    await backfillBankItems(db);
};

// เอกสารที่โพสต์ไว้ก่อนเริ่มเขียนรายการธนาคาร (CM ทุกประเภท, AR/AP 60/65) — สร้างรายการให้ครั้งเดียว (เฉพาะที่ยังไม่มี)
// เอกสารที่ยกเลิกแล้วไม่ต้องสร้าง (ไม่นับยอดอยู่แล้ว) — AR/AP 80 มีรายการอยู่แล้วตั้งแต่เดิม
const backfillBankItems = async (db) => {
    const missing = (module, table, types) => db.query(`
        SELECT t.id, t.gl_entry_id FROM ${table} t JOIN sa_module_document d ON d.id = t.doc_id
         WHERE t.status = 'Posted' ${types ? `AND d.sys_doc_type = ANY($1::text[])` : ''}
           AND NOT EXISTS (SELECT 1 FROM cm_receipt r WHERE r.${SOURCE_COL[module]} = t.id)
           AND NOT EXISTS (SELECT 1 FROM cm_payment p WHERE p.${SOURCE_COL[module]} = t.id)`, types ? [types] : [])
        .then(r => r.rows).catch(e => { if (e.code === '42P01') return []; throw e; });
    for (const r of await missing('CM', 'cm_transaction', null)) await syncCmBankItems(db, r.id, r.gl_entry_id);
    for (const r of await missing('AR', 'ar_transaction', ['60', '65'])) await syncPartyBankItems(db, 'AR', r.id, r.gl_entry_id);
    for (const r of await missing('AP', 'ap_transaction', ['60', '65'])) await syncPartyBankItems(db, 'AP', r.id, r.gl_entry_id);
};

const SOURCE_COL = { AR: 'ar_transaction_id', AP: 'ap_transaction_id', CM: 'cm_transaction_id' };

const insertReceipt = (client, r) => client.query(`
    INSERT INTO cm_receipt
        (receipt_date, bank_account_id, payment_method_id, payment_method_type,
         ar_transaction_id, ap_transaction_id, cm_transaction_id, source_type, ar_doc_no,
         customer_id, customer_code, customer_name_th,
         amount_lc, amount_fc, currency_code, exchange_rate,
         check_no, check_date, drawer_bank, gl_entry_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`, [
    r.date, r.bankAccountId, r.paymentMethodId || null, r.methodType || 'TRANSFER',
    r.arId || null, r.apId || null, r.cmId || null, r.sourceType, r.docNo || null,
    r.partyId || null, r.partyCode || null, r.partyName || null,
    r.amountLc || 0, r.amountFc || 0, r.currencyCode, r.exchangeRate || 1,
    r.checkNo || null, r.checkDate || null, r.drawerBank || null, r.glEntryId || null,
]);

const insertPayment = (client, r) => client.query(`
    INSERT INTO cm_payment
        (payment_date, bank_account_id, payment_method_id, payment_method_type,
         ar_transaction_id, ap_transaction_id, cm_transaction_id, source_type, ap_doc_no,
         payee_type, payee_id, payee_code, payee_name_th,
         amount_lc, amount_fc, currency_code, exchange_rate,
         check_no, check_date, drawer_bank, gl_entry_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, [
    r.date, r.bankAccountId, r.paymentMethodId || null, r.methodType || 'TRANSFER',
    r.arId || null, r.apId || null, r.cmId || null, r.sourceType, r.docNo || null,
    r.payeeType || 'OTHER', r.partyId || null, r.partyCode || null, r.partyName || null,
    r.amountLc || 0, r.amountFc || 0, r.currencyCode, r.exchangeRate || 1,
    r.checkNo || null, r.checkDate || null, r.drawerBank || null, r.glEntryId || null,
]);

const deleteBankItems = async (client, module, id) => {
    await ensureBankItemColumns(client);
    const col = SOURCE_COL[module];
    await client.query(`DELETE FROM cm_receipt WHERE ${col} = $1`, [id]);
    await client.query(`DELETE FROM cm_payment WHERE ${col} = $1`, [id]);
};

// ยกเลิกเอกสารต้นทาง: รายการที่ยังรอเคลียร์เป็น Voided (ที่เคลียร์/กระทบยอดแล้วต้องถูกกันไว้ก่อนด้วย bankItemsClearedSql)
const voidBankItems = async (client, module, id) => {
    await ensureBankItemColumns(client);
    const col = SOURCE_COL[module];
    for (const t of ['cm_receipt', 'cm_payment']) {
        await client.query(`UPDATE ${t} SET status = 'Voided', updated_at = NOW() WHERE ${col} = $1 AND status <> 'Voided'`, [id]);
    }
};

// subquery สำหรับเงื่อนไขถอย/ยกเลิก: รายการที่เคลียร์หรือกระทบยอดแล้ว (คืนเลขเช็ค/เลขที่) — alias = ตารางเอกสารต้นทาง
const bankItemsClearedSql = (module, alias) => {
    const col = SOURCE_COL[module];
    return `(SELECT string_agg(DISTINCT x.ref, ', ') FROM (
               SELECT COALESCE(c.check_no, c.ar_doc_no, c.id::text) AS ref FROM cm_receipt c
                WHERE c.${col} = ${alias}.id AND (c.status NOT IN ('Pending', 'Voided') OR c.is_reconciled IS TRUE)
               UNION ALL
               SELECT COALESCE(c.check_no, c.ap_doc_no, c.id::text) FROM cm_payment c
                WHERE c.${col} = ${alias}.id AND (c.status NOT IN ('Pending', 'Voided') OR c.is_reconciled IS TRUE)) x)`;
};

// AR 60/65/80 และ AP 60/65/80: หนึ่งรายการต่อช่องทางรับ/จ่ายที่ผูกบัญชีธนาคาร
const syncPartyBankItems = async (client, module, id, glEntryId) => {
    await ensureBankItemColumns(client);
    await deleteBankItems(client, module, id);
    const isAr = module === 'AR';
    const h = (await client.query(isAr ? `
        SELECT t.doc_no, t.doc_date, t.currency_code, t.exchange_rate, d.sys_doc_type,
               t.customer_id AS party_id, c.customer_code AS party_code, c.customer_name_th AS party_name
          FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
          LEFT JOIN ar_customer c ON c.id = t.customer_id WHERE t.id = $1` : `
        SELECT t.doc_no, t.doc_date, t.currency_code, t.exchange_rate, d.sys_doc_type,
               t.vendor_id AS party_id, v.vendor_code AS party_code, v.vendor_name_th AS party_name
          FROM ap_transaction t JOIN sa_module_document d ON d.id = t.doc_id
          LEFT JOIN ap_vendor v ON v.id = t.vendor_id WHERE t.id = $1`, [id])).rows[0];
    if (!h || !['60', '65', '80'].includes(h.sys_doc_type)) return;
    // เงินเข้า: AR 60/80, AP 65 — เงินออก: AR 65, AP 60/80
    const inflow = isAr ? h.sys_doc_type !== '65' : h.sys_doc_type === '65';
    const pms = (await client.query(`
        SELECT payment_method_id, payment_method_type, cm_bank_account_id, amount_lc, amount_fc,
               ref_no, payment_date, drawer_bank_name
          FROM ${isAr ? 'ar_transaction_payment' : 'ap_transaction_payment'}
         WHERE header_id = $1 AND cm_bank_account_id IS NOT NULL ORDER BY line_no`, [id])).rows;
    const currencyCode = h.currency_code || await getBaseCurrencyCode(client);
    for (const pm of pms) {
        const isCheck = pm.payment_method_type === 'CHECK';
        const row = {
            date: h.doc_date, bankAccountId: pm.cm_bank_account_id, paymentMethodId: pm.payment_method_id,
            methodType: pm.payment_method_type || 'CASH',
            arId: isAr ? id : null, apId: isAr ? null : id, sourceType: `${module}${h.sys_doc_type}`, docNo: h.doc_no,
            payeeType: isAr ? 'CUSTOMER' : 'VENDOR', partyId: h.party_id, partyCode: h.party_code, partyName: h.party_name,
            amountLc: pm.amount_lc, amountFc: pm.amount_fc, currencyCode, exchangeRate: h.exchange_rate,
            checkNo: isCheck ? pm.ref_no : null, checkDate: isCheck ? (pm.payment_date || h.doc_date) : null,
            drawerBank: pm.drawer_bank_name, glEntryId,
        };
        // รายการเดิมของ 80 ไม่มี source_type (รายงานถือว่าเป็นรับ/จ่ายชำระปกติ) — ใส่ให้ครบสำหรับรายการใหม่
        await (inflow ? insertReceipt(client, row) : insertPayment(client, row));
    }
};

// CM: ตามประเภทเอกสาร — ยอดใช้ยอดที่บันทึกแล้ว (normalizeAmounts ปัดเศษไว้แล้ว)
const syncCmBankItems = async (client, id, glEntryId) => {
    await ensureBankItemColumns(client);
    await deleteBankItems(client, 'CM', id);
    const h = (await client.query(`
        SELECT t.*, d.sys_doc_type FROM cm_transaction t JOIN sa_module_document d ON d.id = t.doc_id WHERE t.id = $1`, [id])).rows[0];
    if (!h) return;
    const sys = h.sys_doc_type;
    const base = {
        date: h.doc_date, cmId: id, sourceType: `CM${sys}`, docNo: h.doc_no, partyName: h.counterparty_name,
        currencyCode: h.currency_code || await getBaseCurrencyCode(client), exchangeRate: h.exchange_rate, glEntryId,
    };
    const whole = { amountLc: h.total_amount_lc, amountFc: h.total_amount_fc };
    const pms = (await client.query(`
        SELECT payment_method_id, payment_method_type, cm_bank_account_id, amount_lc, amount_fc,
               ref_no, payment_date, drawer_bank_name
          FROM cm_transaction_payment WHERE header_id = $1 AND cm_bank_account_id IS NOT NULL ORDER BY line_no`, [id])).rows;
    const fromPayments = async (inflow) => {
        for (const pm of pms) {
            const isCheck = pm.payment_method_type === 'CHECK';
            const row = {
                ...base, bankAccountId: pm.cm_bank_account_id, paymentMethodId: pm.payment_method_id,
                methodType: pm.payment_method_type, amountLc: pm.amount_lc, amountFc: pm.amount_fc,
                checkNo: isCheck ? pm.ref_no : null, checkDate: isCheck ? (pm.payment_date || h.doc_date) : null,
                drawerBank: pm.drawer_bank_name,
            };
            await (inflow ? insertReceipt(client, row) : insertPayment(client, row));
        }
    };
    if (sys === '10') await fromPayments(true);
    else if (sys === '20') await fromPayments(false);
    else if (sys === '30') {
        await fromPayments(false);
        // เงินเข้ากองเงินสดย่อย (เฉพาะเมื่อเลือกกองเงินสดย่อย — GL ลงบัญชีของกองนั้น)
        if (h.bank_account_id) await insertReceipt(client, { ...base, ...whole, bankAccountId: h.bank_account_id, methodType: 'CASH' });
    } else if (sys === '40') {
        if (h.bank_account_id) await insertPayment(client, { ...base, ...whole, bankAccountId: h.bank_account_id, methodType: 'CASH' });
    } else if (sys === '50') {
        await insertPayment(client, { ...base, ...whole, bankAccountId: h.from_bank_account_id });
        await insertReceipt(client, { ...base, ...whole, bankAccountId: h.to_bank_account_id });
    } else if (sys === '70') {
        await insertPayment(client, { ...base, ...whole, bankAccountId: h.bank_account_id });
    } else if (sys === '90') {
        // ดอกเบี้ยรับ: เงินเข้าธนาคารเฉพาะยอดสุทธิหลังภาษีถูกหัก ณ ที่จ่าย
        const row = { ...base, bankAccountId: h.bank_account_id,
            amountLc: Number(h.total_amount_lc) - (Number(h.wht_amount_lc) || 0), amountFc: Number(h.total_amount_fc) - (Number(h.wht_amount_fc) || 0) };
        await (h.charge_type === 'INTEREST_INCOME' ? insertReceipt(client, row) : insertPayment(client, row));
    }
};

module.exports = {
    ensureBankItemColumns, syncPartyBankItems, syncCmBankItems, deleteBankItems, voidBankItems, bankItemsClearedSql,
};
