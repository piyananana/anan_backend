// controllers/cm/cmPaymentController.js
const { today } = require('../../utils/dateUtil');
const { getBaseCurrencyCode } = require('../../utils/baseCurrency');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
const { checkCmPeriodOpen } = require('./cmPeriodCheckHelper');
'use strict';

const ensureCmPaymentTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_payment (
            id                  SERIAL PRIMARY KEY,
            payment_date        DATE          NOT NULL,
            bank_account_id     INTEGER       REFERENCES cm_bank_account(id),
            payment_method_id   INTEGER,
            payment_method_type VARCHAR(30)   NOT NULL DEFAULT 'TRANSFER',
            ap_payment_run_id   INTEGER,
            ap_doc_no           VARCHAR(50),
            payee_type          VARCHAR(10)   DEFAULT 'VENDOR',
            payee_id            INTEGER,
            payee_code          VARCHAR(50),
            payee_name_th       VARCHAR(200),
            amount_lc           NUMERIC(18,4) NOT NULL DEFAULT 0,
            amount_fc           NUMERIC(18,4) NOT NULL DEFAULT 0,
            currency_code       VARCHAR(10)   NOT NULL DEFAULT 'THB',
            exchange_rate       NUMERIC(15,6) NOT NULL DEFAULT 1,
            check_no            VARCHAR(50),
            check_date          DATE,
            checkbook_id        INTEGER       REFERENCES cm_checkbook(id),
            status              VARCHAR(20)   NOT NULL DEFAULT 'Pending',
            clearing_date       DATE,
            clearing_note       TEXT,
            gl_entry_id         INTEGER,
            remark              TEXT,
            created_by          INTEGER,
            created_at          TIMESTAMP DEFAULT NOW(),
            updated_at          TIMESTAMP DEFAULT NOW()
        )
    `);
};

const BASE_SELECT = `
    SELECT p.*,
           ba.account_code     AS bank_account_code,
           ba.account_name_th  AS bank_account_name,
           ba.account_name_en  AS bank_account_name_en,
           cb.bank_name_thai    AS bank_name,
           cb.bank_name_eng     AS bank_name_en,
           cb.short_name       AS bank_short_name,
           pm.method_code      AS payment_method_code,
           pm.method_name_th   AS payment_method_name,
           pm.method_name_en   AS payment_method_name_en,
           ck.checkbook_code   AS checkbook_code,
           v.vendor_name_en    AS payee_name_en,
           (SELECT COALESCE(gp.cm_status, 'OPEN') FROM gl_posting_period gp
             WHERE p.clearing_date BETWEEN gp.period_start_date AND gp.period_end_date
             ORDER BY gp.period_start_date DESC LIMIT 1) AS clear_period_status
    FROM cm_payment p
    LEFT JOIN cm_bank_account   ba ON ba.id = p.bank_account_id
    LEFT JOIN cd_bank           cb ON cb.id = ba.bank_id
    LEFT JOIN cm_payment_method pm ON pm.id = p.payment_method_id
    LEFT JOIN cm_checkbook      ck ON ck.id = p.checkbook_id
    LEFT JOIN ap_vendor         v  ON v.id = p.payee_id AND p.payee_type = 'VENDOR'
`;

// รายการจ่ายเงินผ่านธนาคาร: ส่วนใหญ่สร้างโดยใบจ่ายเงิน AP / จ่ายชำระแบบกลุ่ม ตอนโพสต์ (ใช้รายการบัญชีของต้นทาง)
// - เคลียร์ / ยกเลิกการเคลียร์: เปลี่ยนสถานะอย่างเดียว ไม่กระทบบัญชี — ยกเลิกการเคลียร์ไม่ได้เมื่อกระทบยอดแล้ว
//   หรืองวด CM ของวันที่เคลียร์ปิดแล้ว
// - ยกเลิก: รายการที่มาจาก AP ต้องยกเลิกที่เอกสารต้นทาง (ไม่เช่นนั้นยอด CM กับบัญชีจะไม่ตรงกัน)
//   ยกเลิกในหน้านี้ได้เฉพาะรายการที่บันทึกเองในหน้านี้ (ไม่มีรายการบัญชี)
const getUnclearBlock = (p) => {
    if (p.status !== 'Cleared') return { code: 'NOT_CLEARED' };
    if (p.is_reconciled === true) return { code: 'RECONCILED' };
    if (p.clear_period_status && p.clear_period_status !== 'OPEN') return { code: 'PERIOD_CLOSED' };
    return null;
};

const getVoidBlock = (p) => {
    if (p.status !== 'Pending') return { code: 'NOT_PENDING' };
    if (p.is_reconciled === true) return { code: 'RECONCILED' };
    if (p.ap_transaction_id || p.ar_transaction_id || p.cm_transaction_id || p.gl_entry_id) return { code: 'SOURCE_DOC', ref: p.ap_doc_no };
    return null;
};

const BLOCK_MESSAGES = {
    NOT_CLEARED:   'ยกเลิกการเคลียร์ได้เฉพาะรายการที่เคลียร์แล้ว',
    NOT_PENDING:   'ยกเลิกได้เฉพาะรายการที่รอเคลียร์',
    RECONCILED:    'รายการนี้กระทบยอดกับ Bank Statement แล้ว กรุณายกเลิกการกระทบยอดก่อน',
    PERIOD_CLOSED: 'งวด CM ของวันที่เคลียร์ปิดแล้ว',
    SOURCE_DOC:    'รายการนี้มาจากเอกสาร AR/AP/CM กรุณายกเลิกที่เอกสารต้นทาง',
};
const blockMessage = (b) => BLOCK_MESSAGES[b.code] + (b.ref ? ` (${b.ref})` : '');
const blockError = (res, b) => res.status(400).json({ error: blockMessage(b), code: b.code, ref: b.ref || null });

const fetchById = async (db, id) => {
    const p = (await db.query(`${BASE_SELECT} WHERE p.id = $1`, [id])).rows[0];
    if (!p) return null;
    const ub = getUnclearBlock(p), vb = getVoidBlock(p);
    return {
        ...p,
        unclear_block: ub?.code || null,
        void_block: vb?.code || null, void_block_ref: vb?.ref || null,
        reverse_history: await getReverseHistory(db, 'cm_payment', p.id),
    };
};

const lockById = async (client, id) => {
    await client.query(`SELECT id FROM cm_payment WHERE id = $1 FOR UPDATE`, [id]);
    return (await client.query(`${BASE_SELECT} WHERE p.id = $1`, [id])).rows[0];
};

const reasonOf = (req) => (req.body?.reason || req.body?.clearing_note || '').trim();
const userIdOf = (req) => req.body?.user_id || req.headers['userid'] || null;

// GET list
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureCmPaymentTable(client);
        const { bank_account_id, status, date_from, date_to, payment_method_type } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (bank_account_id)             { where += ` AND p.bank_account_id = $${pi++}`;      params.push(bank_account_id); }
        if (status && status !== 'All')  { where += ` AND p.status = $${pi++}`;               params.push(status); }
        if (date_from)                   { where += ` AND p.payment_date >= $${pi++}`;        params.push(date_from); }
        if (date_to)                     { where += ` AND p.payment_date <= $${pi++}`;        params.push(date_to); }
        if (payment_method_type)         { where += ` AND p.payment_method_type = $${pi++}`;  params.push(payment_method_type); }
        const result = await client.query(
            `${BASE_SELECT} ${where} ORDER BY p.payment_date DESC, p.id DESC`, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// GET one
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureCmPaymentTable(client);
        const row = await fetchById(client, req.params.id);
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// POST — create manual payment (check issuance or transfer)
// สร้างรายการจ่ายเองโดยไม่มีรายการบัญชีทำให้ยอดธนาคารฝั่ง CM ไม่ตรงกับ GL — เลิกใช้ (user-approved 2026-11-01,
// ดู project_cm_recheck_2026_11) รายการจ่ายมาจากธุรกรรม CM รายจ่าย (20) / ใบจ่ายชำระ AP เท่านั้น
const createPayment = async (req, res) =>
    res.status(400).json({ error: 'สร้างรายการจ่ายในหน้านี้ไม่ได้แล้ว กรุณาบันทึกที่ธุรกรรม CM ประเภทรายจ่าย (20) หรือใบจ่ายชำระ AP' });

const clearPayment = async (req, res) => {
    const { id } = req.params;
    const { clearing_date, clearing_note } = req.body;
    const clearDate = clearing_date || today();
    const client = await req.dbPool.connect();
    try {
        await ensureCmPaymentTable(client);
        const pc = await checkCmPeriodOpen(client, clearDate);
        if (!pc.allowed) return res.status(400).json({ error: pc.message });
        const result = await client.query(`
            UPDATE cm_payment
            SET status        = 'Cleared',
                clearing_date = $1,
                clearing_note = $2,
                updated_at    = NOW()
            WHERE id = $3 AND status = 'Pending'
            RETURNING *`,
            [clearDate, clearing_note || null, id]);
        if (result.rows.length === 0)
            return res.status(400).json({ error: 'ไม่สามารถเคลียร์ได้ หรือสถานะไม่ใช่ Pending' });
        res.json(await fetchById(client, id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT /unclear — ยกเลิกการเคลียร์ (Cleared → Pending)
const unclearPayment = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: 'กรุณาระบุเหตุผล' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const p = await lockById(client, id);
        if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        const b = getUnclearBlock(p);
        if (b) { await client.query('ROLLBACK'); return blockError(res, b); }
        await client.query(`
            UPDATE cm_payment SET status = 'Pending', clearing_date = NULL, clearing_note = NULL, updated_at = NOW()
             WHERE id = $1`, [id]);
        await logReverse(client, {
            sysModule: '81', tableName: 'cm_payment', recordId: Number(id), docNo: p.check_no || p.ap_doc_no,
            fromStatus: 'Cleared', toStatus: 'Pending', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json(await fetchById(client, id));
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT /void — เฉพาะรายการที่บันทึกเองในหน้านี้
const voidPayment = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการยกเลิก' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const p = await lockById(client, id);
        if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        const b = getVoidBlock(p);
        if (b) { await client.query('ROLLBACK'); return blockError(res, b); }
        await client.query(`
            UPDATE cm_payment SET status = 'Voided', clearing_note = $1, updated_at = NOW() WHERE id = $2`, [reason, id]);
        await logReverse(client, {
            sysModule: '81', tableName: 'cm_payment', recordId: Number(id), docNo: p.check_no || p.ap_doc_no,
            fromStatus: 'Pending', toStatus: 'Void', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json(await fetchById(client, id));
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

module.exports = { fetchRows, fetchRow, createPayment, clearPayment, unclearPayment, voidPayment, ensureCmPaymentTable };
