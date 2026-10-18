// controllers/cm/cmPostDatedCheckController.js
'use strict';
const { checkCmPeriodOpen } = require('./cmPeriodCheckHelper');
const { ymd, today } = require('../../utils/dateUtil');
const { logReverse, getReverseHistory } = require('../../utils/reverseLog');

const ensureTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_post_dated_check (
            id                   SERIAL PRIMARY KEY,
            direction            VARCHAR(10)  NOT NULL CHECK (direction IN ('RECEIVED','ISSUED')),
            check_no             VARCHAR(50)  NOT NULL,
            check_date           DATE         NOT NULL,
            bank_id              INTEGER      REFERENCES cd_bank(id),
            payee_payer_name     VARCHAR(200),
            amount               NUMERIC(18,4) NOT NULL DEFAULT 0,
            currency_code        VARCHAR(3)   NOT NULL DEFAULT 'THB',
            our_bank_account_id  INTEGER      REFERENCES cm_bank_account(id),
            linked_receipt_id    INTEGER      REFERENCES cm_receipt(id),
            linked_payment_id    INTEGER,
            status               VARCHAR(20)  NOT NULL DEFAULT 'Holding',
            deposit_date         DATE,
            cleared_date         DATE,
            returned_date        DATE,
            cancelled_date       DATE,
            replacement_check_no VARCHAR(50),
            notes                TEXT,
            created_by           VARCHAR(100),
            created_at           TIMESTAMPTZ  DEFAULT NOW(),
            updated_at           TIMESTAMPTZ  DEFAULT NOW()
        )
    `);
};

const fetchRows = async (req, res) => {
    const { direction, status, bank_account_id, date_from, date_to } = req.query;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const params = [];
        const wheres = [];
        if (direction)        { params.push(direction);        wheres.push(`p.direction=$${params.length}`); }
        if (status && status !== 'All') { params.push(status); wheres.push(`p.status=$${params.length}`); }
        else wheres.push(`p.status <> 'Deleted'`);
        if (bank_account_id)  { params.push(bank_account_id);  wheres.push(`p.our_bank_account_id=$${params.length}`); }
        if (date_from)        { params.push(date_from);        wheres.push(`p.check_date>=$${params.length}`); }
        if (date_to)          { params.push(date_to);          wheres.push(`p.check_date<=$${params.length}`); }

        const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const r = await client.query(`${BASE_SELECT} ${where} ORDER BY p.check_date, p.id`, params);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const BASE_SELECT = `
    SELECT p.*,
           b.bank_name_thai       AS bank_name,
           b.short_name          AS bank_short_name,
           ba.account_code       AS our_account_code,
           ba.account_name_th    AS our_account_name,
           cb.short_name         AS our_bank_name
    FROM cm_post_dated_check p
    LEFT JOIN cd_bank         b  ON b.id  = p.bank_id
    LEFT JOIN cm_bank_account ba ON ba.id = p.our_bank_account_id
    LEFT JOIN cd_bank         cb ON cb.id = ba.bank_id`;

// ทะเบียนเช็คลงวันที่ล่วงหน้า ไม่มีรายการบัญชี
// - ถอยสถานะ: กลับไปสถานะก่อนหน้า (นำฝาก → ถือไว้, เคลียร์/คืน → นำฝาก หรือถือไว้, ยกเลิก → สถานะก่อนยกเลิก)
//   ทำไม่ได้เมื่องวด CM ของวันที่ของสถานะที่จะถอยปิดแล้ว
// - ยกเลิก / ลบ (เฉพาะถือไว้ เก็บไว้ด้วยสถานะ Deleted): ต้องมีเหตุผล
// ทุกการกระทำบันทึกที่ sa_document_reverse_log
const EVENT_DATE_COL = { Deposited: 'deposit_date', Cleared: 'cleared_date', Returned: 'returned_date', Cancelled: 'cancelled_date' };

const previousStatus = (r) => {
    if (r.status === 'Deposited') return 'Holding';
    if (r.status === 'Cancelled' && r.returned_date) return 'Returned';
    return r.deposit_date ? 'Deposited' : 'Holding';
};

const getRevertBlock = async (db, r) => {
    const col = EVENT_DATE_COL[r.status];
    if (!col) return { code: 'NOT_REVERTIBLE' };
    if (r[col]) {
        const pc = await checkCmPeriodOpen(db, ymd(r[col]));
        if (!pc.allowed) return { code: 'PERIOD_CLOSED', message: pc.message };
    }
    return null;
};

const fetchById = async (db, id) => {
    const r = (await db.query(`${BASE_SELECT} WHERE p.id = $1`, [id])).rows[0];
    if (!r) return null;
    const rb = await getRevertBlock(db, r);
    return {
        ...r,
        revert_block: rb?.code || null,
        revert_block_message: rb?.message || null,
        revert_to: EVENT_DATE_COL[r.status] ? previousStatus(r) : null,
        reverse_history: await getReverseHistory(db, 'cm_post_dated_check', Number(id)),
    };
};

const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const row = await fetchById(client, req.params.id);
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json(row);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const reasonOf = (req) => (req.body?.reason || '').trim();
const userIdOf = (req) => req.body?.user_id || req.headers['userid'] || null;

// PUT /:id/revert — ถอยสถานะ
const revertCheck = async (req, res) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: 'กรุณาระบุเหตุผล' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const r = (await client.query(`SELECT * FROM cm_post_dated_check WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        const b = await getRevertBlock(client, r);
        if (b) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: b.message || 'ถอยสถานะได้เฉพาะเช็คที่นำฝาก เคลียร์ คืน หรือยกเลิกแล้ว', code: b.code });
        }
        const to = previousStatus(r);
        await client.query(`
            UPDATE cm_post_dated_check SET status = $1, ${EVENT_DATE_COL[r.status]} = NULL, updated_at = NOW()
             WHERE id = $2`, [to, id]);
        await logReverse(client, {
            sysModule: '81', tableName: 'cm_post_dated_check', recordId: Number(id), docNo: r.check_no,
            fromStatus: r.status, toStatus: to, reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json(await fetchById(client, id));
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const createRow = async (req, res) => {
    const { direction, check_no, check_date, bank_id, payee_payer_name,
            amount, currency_code, our_bank_account_id, linked_receipt_id,
            linked_payment_id, notes } = req.body;
    if (!direction || !check_no || !check_date || !amount)
        return res.status(400).json({ error: 'ต้องระบุ direction, check_no, check_date, amount' });

    const createdBy = req.headers.username || 'system';
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);

        // Period check
        const pc = await checkCmPeriodOpen(client, check_date);
        if (!pc.allowed) return res.status(400).json({ error: pc.message });

        const r = await client.query(`
            INSERT INTO cm_post_dated_check
                (direction, check_no, check_date, bank_id, payee_payer_name,
                 amount, currency_code, our_bank_account_id, linked_receipt_id,
                 linked_payment_id, status, notes, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Holding',$11,$12)
            RETURNING *`,
            [direction, check_no, check_date, bank_id || null, payee_payer_name || null,
             amount, currency_code || 'THB', our_bank_account_id || null,
             linked_receipt_id || null, linked_payment_id || null, notes || null, createdBy]);
        res.status(201).json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const { bank_id, payee_payer_name, amount, currency_code,
            our_bank_account_id, notes } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            UPDATE cm_post_dated_check SET
                bank_id             = COALESCE($1, bank_id),
                payee_payer_name    = COALESCE($2, payee_payer_name),
                amount              = COALESCE($3, amount),
                currency_code       = COALESCE($4, currency_code),
                our_bank_account_id = COALESCE($5, our_bank_account_id),
                notes               = $6,
                updated_at          = NOW()
            WHERE id=$7 AND status='Holding' RETURNING *`,
            [bank_id || null, payee_payer_name || null, amount || null,
             currency_code || null, our_bank_account_id || null,
             notes || null, id]);
        if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล หรือสถานะไม่ใช่ Holding' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT /:id/present  — Mark as Deposited/Presented
// นำฝาก / เคลียร์ / คืน: วันที่ของสถานะต้องอยู่ในงวด CM ที่เปิดอยู่ (ไม่ระบุ = วันนี้)
const periodBlock = async (db, date) => {
    const pc = await checkCmPeriodOpen(db, date || today());
    return pc.allowed ? null : pc.message;
};

const presentCheck = async (req, res) => {
    const { id } = req.params;
    const { deposit_date } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const pm = await periodBlock(client, deposit_date);
        if (pm) return res.status(400).json({ error: pm, code: 'PERIOD_CLOSED' });
        const r = await client.query(`
            UPDATE cm_post_dated_check SET
                status       = 'Deposited',
                deposit_date = COALESCE($1, NOW()::date),
                updated_at   = NOW()
            WHERE id=$2 AND status='Holding' RETURNING *`,
            [deposit_date || null, id]);
        if (!r.rows.length) return res.status(400).json({ error: 'ไม่พบรายการ หรือสถานะไม่ใช่ Holding' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT /:id/clear  — Mark as Cleared (bank confirmed)
const clearCheck = async (req, res) => {
    const { id } = req.params;
    const { cleared_date } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const pm = await periodBlock(client, cleared_date);
        if (pm) return res.status(400).json({ error: pm, code: 'PERIOD_CLOSED' });
        const r = await client.query(`
            UPDATE cm_post_dated_check SET
                status       = 'Cleared',
                cleared_date = COALESCE($1, NOW()::date),
                updated_at   = NOW()
            WHERE id=$2 AND status IN ('Holding','Deposited') RETURNING *`,
            [cleared_date || null, id]);
        if (!r.rows.length) return res.status(400).json({ error: 'ไม่พบรายการ หรือสถานะไม่ถูกต้อง' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT /:id/return  — Mark as Returned (bounced)
const returnCheck = async (req, res) => {
    const { id } = req.params;
    const { returned_date, notes } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const pm = await periodBlock(client, returned_date);
        if (pm) return res.status(400).json({ error: pm, code: 'PERIOD_CLOSED' });
        const r = await client.query(`
            UPDATE cm_post_dated_check SET
                status        = 'Returned',
                returned_date = COALESCE($1, NOW()::date),
                notes         = COALESCE($2, notes),
                updated_at    = NOW()
            WHERE id=$3 AND status IN ('Holding','Deposited') RETURNING *`,
            [returned_date || null, notes || null, id]);
        if (!r.rows.length) return res.status(400).json({ error: 'ไม่พบรายการ หรือสถานะไม่ถูกต้อง' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// PUT /:id/cancel  — Cancel the check
// เปลี่ยนสถานะพร้อมเหตุผล + บันทึกประวัติ (ยกเลิก / ลบ)
const changeStatus = async (req, res, { allowed, toStatus, logStatus, setDate, blockMessage }) => {
    const { id } = req.params;
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: 'กรุณาระบุเหตุผล' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTable(client);
        const r = (await client.query(`SELECT * FROM cm_post_dated_check WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        if (!allowed.includes(r.status)) { await client.query('ROLLBACK'); return res.status(400).json({ error: blockMessage }); }
        await client.query(`
            UPDATE cm_post_dated_check SET status = $1, updated_at = NOW()${setDate ? ', cancelled_date = CURRENT_DATE' : ''}
             WHERE id = $2`, [toStatus, id]);
        await logReverse(client, {
            sysModule: '81', tableName: 'cm_post_dated_check', recordId: Number(id), docNo: r.check_no,
            fromStatus: r.status, toStatus: logStatus, reason, userId: userIdOf(req),
        });
        await client.query('COMMIT');
        res.json(await fetchById(client, id));
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const cancelCheck = (req, res) => changeStatus(req, res, {
    allowed: ['Holding', 'Deposited', 'Returned'], toStatus: 'Cancelled', logStatus: 'Void', setDate: true,
    blockMessage: 'ยกเลิกได้เฉพาะเช็คที่ถือไว้ นำฝาก หรือคืนแล้ว',
});

// ลบ: เฉพาะถือไว้ — เก็บไว้ด้วยสถานะ Deleted (ไม่แสดงในรายการ เว้นแต่เลือกสถานะ Deleted)
const deleteRow = (req, res) => changeStatus(req, res, {
    allowed: ['Holding'], toStatus: 'Deleted', logStatus: 'Deleted',
    blockMessage: 'ลบได้เฉพาะเช็คที่ถือไว้',
});

// GET summary counts
const getSummary = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            SELECT direction, status, COUNT(*) AS count, SUM(amount) AS total_amount
            FROM cm_post_dated_check
            WHERE status <> 'Deleted'
            GROUP BY direction, status
            ORDER BY direction, status`);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { fetchRows, fetchRow, createRow, updateRow, presentCheck, clearCheck, returnCheck, cancelCheck, revertCheck, deleteRow, getSummary };
