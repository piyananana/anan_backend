// controllers/cm/cmReceiptController.js
const { today } = require('../../utils/dateUtil');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');
const { checkCmPeriodOpen } = require('./cmPeriodCheckHelper');
const { voidArDocument, getArVoidBlockById } = require('../ar/arTransactionController');
'use strict';

const ensureCmReceiptTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_receipt (
            id                  SERIAL PRIMARY KEY,
            receipt_date        DATE          NOT NULL,
            bank_account_id     INTEGER       REFERENCES cm_bank_account(id),
            payment_method_id   INTEGER,
            payment_method_type VARCHAR(30)   NOT NULL DEFAULT 'CASH',
            ar_transaction_id   INTEGER,
            ar_doc_no           VARCHAR(50),
            customer_id         INTEGER,
            customer_code       VARCHAR(50),
            customer_name_th    VARCHAR(200),
            amount_lc           NUMERIC(18,4) NOT NULL DEFAULT 0,
            amount_fc           NUMERIC(18,4) NOT NULL DEFAULT 0,
            currency_code       VARCHAR(10)   NOT NULL DEFAULT 'THB',
            exchange_rate       NUMERIC(15,6) NOT NULL DEFAULT 1,
            check_no            VARCHAR(50),
            check_date          DATE,
            drawer_bank         VARCHAR(200),
            status              VARCHAR(20)   NOT NULL DEFAULT 'Pending',
            clearing_date       DATE,
            clearing_note       TEXT,
            gl_entry_id         INTEGER,
            created_by          INTEGER,
            created_at          TIMESTAMP DEFAULT NOW(),
            updated_at          TIMESTAMP DEFAULT NOW()
        )
    `);
};

const BASE_SELECT = `
    SELECT r.*,
           ba.account_code     AS bank_account_code,
           ba.account_name_th  AS bank_account_name,
           cb.bank_name_thai    AS bank_name,
           cb.short_name       AS bank_short_name,
           pm.method_code      AS payment_method_code,
           pm.method_name_th   AS payment_method_name,
           at.status           AS source_status,
           (SELECT COALESCE(gp.cm_status, 'OPEN') FROM gl_posting_period gp
             WHERE r.clearing_date BETWEEN gp.period_start_date AND gp.period_end_date
             ORDER BY gp.period_start_date DESC LIMIT 1) AS clear_period_status
    FROM cm_receipt r
    LEFT JOIN cm_bank_account   ba ON ba.id = r.bank_account_id
    LEFT JOIN cd_bank           cb ON cb.id = ba.bank_id
    LEFT JOIN cm_payment_method pm ON pm.id = r.payment_method_id
    LEFT JOIN ar_transaction    at ON at.id = r.ar_transaction_id
`;

// รายการรับเงินผ่านธนาคารสร้างโดยใบเสร็จ AR ตอนโพสต์ (ไม่มีรายการบัญชีของตัวเอง ใช้ของใบเสร็จ)
// - เคลียร์ / ยกเลิกการเคลียร์: เปลี่ยนสถานะอย่างเดียว ไม่กระทบบัญชี — ยกเลิกการเคลียร์ไม่ได้เมื่อกระทบยอดแล้ว
//   หรืองวด CM ของวันที่เคลียร์ปิดแล้ว
// - เช็คคืน: ลูกค้าไม่ได้จ่ายจริง → ยกเลิกใบเสร็จ AR ต้นทางด้วย (ลงรายการกลับวันนี้ ใบแจ้งหนี้กลับมามียอดค้าง)
//   รายการรับอื่นของใบเสร็จเดียวกันจะถูกยกเลิกตามไปด้วย ต้องออกใบเสร็จใหม่สำหรับส่วนที่ได้รับจริง
// - ยกเลิก: รายการที่มาจากใบเสร็จ AR ต้องยกเลิกที่ใบเสร็จ (ไม่เช่นนั้นยอด CM กับบัญชีจะไม่ตรงกัน)
const getUnclearBlock = (r) => {
    if (r.status !== 'Cleared') return { code: 'NOT_CLEARED' };
    if (r.is_reconciled === true) return { code: 'RECONCILED' };
    if (r.clear_period_status && r.clear_period_status !== 'OPEN') return { code: 'PERIOD_CLOSED' };
    return null;
};

const getVoidBlock = (r) => {
    if (r.status !== 'Pending') return { code: 'NOT_PENDING' };
    if (r.is_reconciled === true) return { code: 'RECONCILED' };
    if (r.ar_transaction_id || r.gl_entry_id) return { code: 'SOURCE_DOC', ref: r.ar_doc_no };
    return null;
};

const getBounceBlock = async (db, r) => {
    if (r.status !== 'Pending') return { code: 'NOT_PENDING' };
    if (r.payment_method_type !== 'CHECK') return { code: 'NOT_CHECK' };
    if (r.is_reconciled === true) return { code: 'RECONCILED' };
    if (r.ar_transaction_id && r.source_status === 'Posted') {
        const b = await getArVoidBlockById(db, r.ar_transaction_id);
        if (b) return { code: 'AR_BLOCKED', ref: r.ar_doc_no, message: b.message };
    }
    return null;
};

const BLOCK_MESSAGES = {
    NOT_CLEARED:   'ยกเลิกการเคลียร์ได้เฉพาะรายการที่เคลียร์แล้ว',
    NOT_PENDING:   'ทำได้เฉพาะรายการที่รอเคลียร์',
    NOT_CHECK:     'บันทึกเช็คคืนได้เฉพาะรายการรับเป็นเช็ค',
    RECONCILED:    'รายการนี้กระทบยอดกับ Bank Statement แล้ว กรุณายกเลิกการกระทบยอดก่อน',
    PERIOD_CLOSED: 'งวด CM ของวันที่เคลียร์ปิดแล้ว',
    SOURCE_DOC:    'รายการนี้มาจากใบเสร็จ AR กรุณายกเลิกที่ใบเสร็จ',
    AR_BLOCKED:    'ยกเลิกใบเสร็จ AR ต้นทางไม่ได้',
};
const blockMessage = (b) => BLOCK_MESSAGES[b.code] + (b.ref ? ` (${b.ref})` : '') + (b.message ? `: ${b.message}` : '');
const blockError = (res, b) => res.status(400).json({ error: blockMessage(b), code: b.code, ref: b.ref || null });

const fetchById = async (db, id) => {
    const r = (await db.query(`${BASE_SELECT} WHERE r.id = $1`, [id])).rows[0];
    if (!r) return null;
    const ub = getUnclearBlock(r), vb = getVoidBlock(r), bb = await getBounceBlock(db, r);
    return {
        ...r,
        unclear_block: ub?.code || null,
        void_block: vb?.code || null, void_block_ref: vb?.ref || null,
        bounce_block: bb?.code || null, bounce_block_ref: bb?.ref || null,
        bounce_block_message: bb ? blockMessage(bb) : null,
        reverse_history: await getReverseHistory(db, 'cm_receipt', r.id),
    };
};

// GET list — filters: bank_account_id, status, date_from, date_to, payment_method_type
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureCmReceiptTable(client);
        const { bank_account_id, status, date_from, date_to, payment_method_type } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (bank_account_id)              { where += ` AND r.bank_account_id = $${pi++}`;      params.push(bank_account_id); }
        if (status && status !== 'All')   { where += ` AND r.status = $${pi++}`;               params.push(status); }
        if (date_from)                    { where += ` AND r.receipt_date >= $${pi++}`;        params.push(date_from); }
        if (date_to)                      { where += ` AND r.receipt_date <= $${pi++}`;        params.push(date_to); }
        if (payment_method_type)          { where += ` AND r.payment_method_type = $${pi++}`;  params.push(payment_method_type); }
        const result = await client.query(
            `${BASE_SELECT} ${where} ORDER BY r.receipt_date DESC, r.id DESC`, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// GET one
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureCmReceiptTable(client);
        const row = await fetchById(client, req.params.id);
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const reasonOf = (req) => (req.body?.reason || req.body?.clearing_note || '').trim();
const userIdOf = (req) => req.body?.user_id || req.headers['userid'] || null;
const userNameOf = (req) => req.headers['username'] || null;

// โหลดรายการพร้อมล็อกแถว (ใช้ใน transaction)
const lockById = async (client, id) => {
    await client.query(`SELECT id FROM cm_receipt WHERE id = $1 FOR UPDATE`, [id]);
    return (await client.query(`${BASE_SELECT} WHERE r.id = $1`, [id])).rows[0];
};

// PUT /clear
const clearReceipt = async (req, res) => {
    const { id } = req.params;
    const { clearing_date, clearing_note } = req.body;
    const clearDate = clearing_date || today();
    const client = await req.dbPool.connect();
    try {
        await ensureCmReceiptTable(client);
        const pc = await checkCmPeriodOpen(client, clearDate);
        if (!pc.allowed) return res.status(400).json({ error: pc.message });
        const result = await client.query(`
            UPDATE cm_receipt
            SET status = 'Cleared',
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
const unclearReceipt = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: 'กรุณาระบุเหตุผล' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const r = await lockById(client, id);
        if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        const b = getUnclearBlock(r);
        if (b) { await client.query('ROLLBACK'); return blockError(res, b); }
        await client.query(`
            UPDATE cm_receipt SET status = 'Pending', clearing_date = NULL, clearing_note = NULL, updated_at = NOW()
             WHERE id = $1`, [id]);
        await logReverse(client, {
            sysModule: '81', tableName: 'cm_receipt', recordId: Number(id), docNo: r.check_no || r.ar_doc_no,
            fromStatus: 'Cleared', toStatus: 'Pending', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json(await fetchById(client, id));
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT /bounce — เช็คคืน: ยกเลิกใบเสร็จ AR ต้นทาง แล้วตั้งสถานะ Bounced
const bounceReceipt = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: 'กรุณาระบุเหตุผล' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const r = await lockById(client, id);
        if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        const b = await getBounceBlock(client, r);
        if (b) { await client.query('ROLLBACK'); return blockError(res, b); }
        const bounceDate = today();
        const pc = await checkCmPeriodOpen(client, bounceDate);
        if (!pc.allowed) { await client.query('ROLLBACK'); return res.status(400).json({ error: pc.message }); }

        if (r.ar_transaction_id && r.source_status === 'Posted') {
            const v = await voidArDocument(client, r.ar_transaction_id, {
                voidReason: r.check_no ? `เช็คคืน ${r.check_no}: ${reason}` : `เช็คคืน: ${reason}`,
                userId: userIdOf(req), userName: userNameOf(req),
            });
            if (v.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: v.error, code: v.code }); }
        }
        await client.query(`
            UPDATE cm_receipt SET status = 'Bounced', clearing_date = $1, clearing_note = $2, updated_at = NOW()
             WHERE id = $3`, [bounceDate, reason, id]);
        await logReverse(client, {
            sysModule: '81', tableName: 'cm_receipt', recordId: Number(id), docNo: r.check_no || r.ar_doc_no,
            fromStatus: 'Pending', toStatus: 'Bounced', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json(await fetchById(client, id));
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

// PUT /void — เฉพาะรายการที่ไม่ได้มาจากใบเสร็จ AR
const voidReceipt = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: 'กรุณาระบุเหตุผลการยกเลิก' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const r = await lockById(client, id);
        if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        const b = getVoidBlock(r);
        if (b) { await client.query('ROLLBACK'); return blockError(res, b); }
        await client.query(`
            UPDATE cm_receipt SET status = 'Voided', clearing_note = $1, updated_at = NOW() WHERE id = $2`, [reason, id]);
        await logReverse(client, {
            sysModule: '81', tableName: 'cm_receipt', recordId: Number(id), docNo: r.check_no || r.ar_doc_no,
            fromStatus: 'Pending', toStatus: 'Void', reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json(await fetchById(client, id));
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

module.exports = { fetchRows, fetchRow, clearReceipt, unclearReceipt, bounceReceipt, voidReceipt, ensureCmReceiptTable };
