// controllers/ap/apPaymentRunController.js

const { generateNextRunNumber } = require('./apPaymentRunRunningController');
const apTransactionController = require('./apTransactionController');

// --- Fallback auto-generate run_number PR-YYYYMMDD-NNN, used only when the
// admin has not enabled/configured auto-numbering in ap_payment_run_running ---
const generateRunNumberFallback = async (client, date) => {
    const d = new Date(date);
    const yyyy = d.getFullYear();
    const mm   = (d.getMonth() + 1).toString().padStart(2, '0');
    const dd   = d.getDate().toString().padStart(2, '0');
    const prefix = `PR-${yyyy}${mm}${dd}-`;
    const result = await client.query(
        `SELECT run_number FROM ap_payment_run WHERE run_number LIKE $1 ORDER BY run_number DESC LIMIT 1`,
        [prefix + '%']
    );
    let seq = 1;
    if (result.rows.length > 0) {
        const last = result.rows[0].run_number;
        const lastSeq = parseInt(last.substring(prefix.length), 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    return prefix + seq.toString().padStart(3, '0');
};

// ตั้งค่าที่ ap_payment_run_running_screen (ตั้งค่าเลขที่ใบอนุมัติจ่ายอัตโนมัติ) ก่อน
// ถ้ายังไม่ได้ตั้งค่า/ปิดใช้งานอยู่ ให้ใช้รูปแบบเดิม PR-YYYYMMDD-NNN แทน
const generateRunNumber = async (client, date) => {
    const configured = await generateNextRunNumber(client);
    if (configured) return configured;
    return generateRunNumberFallback(client, date);
};

// --- GET list ---
const fetchRows = async (req, res) => {
    const { status, date_from, date_to } = req.query;
    await ensureApPaymentRunColumns(req.dbPool);
    let query = `
        SELECT r.id, r.run_number, r.run_date, r.description,
               r.payment_date, r.payment_method_id, r.due_date_filter,
               pm.method_code AS payment_method_code, pm.method_name_th AS payment_method_name,
               r.total_amount_lc, r.status,
               f.format_code AS bank_file_format_code,
               f.format_name AS bank_file_format_name,
               r.created_at, r.created_by
        FROM ap_payment_run r
        LEFT JOIN cm_bank_file_format f ON f.id = r.bank_file_format_id
        LEFT JOIN cm_payment_method pm ON pm.id = r.payment_method_id
        WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (status && status !== 'All') { params.push(status); query += ` AND r.status = $${pi++}`; }
    if (date_from) { params.push(date_from); query += ` AND r.run_date >= $${pi++}`; }
    if (date_to)   { params.push(date_to);   query += ` AND r.run_date <= $${pi++}`; }
    query += ` ORDER BY r.run_date DESC, r.id DESC`;
    try {
        const result = await req.dbPool.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching ap_payment_run list:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET one with lines ---
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        await ensureApPaymentRunColumns(req.dbPool);
        const hRes = await req.dbPool.query(`
            SELECT r.id, r.run_number, r.run_date, r.description,
                   r.payment_date, r.payment_method_id, r.due_date_filter,
                   pm.method_code AS payment_method_code, pm.method_name_th AS payment_method_name,
                   r.bank_file_format_id, r.total_amount_lc, r.status,
                   f.format_code AS bank_file_format_code,
                   f.format_name AS bank_file_format_name,
                   r.created_by, r.updated_by
            FROM ap_payment_run r
            LEFT JOIN cm_bank_file_format f ON f.id = r.bank_file_format_id
            LEFT JOIN cm_payment_method pm ON pm.id = r.payment_method_id
            WHERE r.id = $1`, [id]);
        if (hRes.rows.length === 0) return res.status(404).json({ message: 'Not found' });
        const header = hRes.rows[0];

        const lRes = await req.dbPool.query(`
            SELECT * FROM ap_payment_run_detail
            WHERE run_id = $1 ORDER BY sort_order, id`, [id]);

        const apprRes = await req.dbPool.query(`
            SELECT * FROM ap_payment_run_approval
            WHERE run_id = $1 ORDER BY sequence_no`, [id]);

        res.status(200).json({ ...header, lines: lRes.rows, approvals: apprRes.rows });
    } catch (error) {
        console.error('Error fetching ap_payment_run:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- Helper: ensure new columns on ap_payment_run exist (idempotent) ---
const ensureApPaymentRunColumns = async (dbPool) => {
    await dbPool.query(`ALTER TABLE ap_payment_run ADD COLUMN IF NOT EXISTS cm_bank_account_id INTEGER`);
    await dbPool.query(`ALTER TABLE ap_payment_run ADD COLUMN IF NOT EXISTS payment_date DATE`);
    await dbPool.query(`ALTER TABLE ap_payment_run ADD COLUMN IF NOT EXISTS payment_method_id INTEGER`);
    await dbPool.query(`ALTER TABLE ap_payment_run ADD COLUMN IF NOT EXISTS due_date_filter DATE`);
};

// --- POST create (Draft) ---
const createRun = async (req, res) => {
    const {
        run_date, description, bank_file_format_id, cm_bank_account_id,
        payment_date, payment_method_id, due_date_filter,
        lines = [],
    } = req.body;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureApPaymentRunColumns(req.dbPool);
        const runNumber = await generateRunNumber(client, run_date);
        const total = lines.reduce((s, l) => s + parseFloat(l.payment_amount_lc || 0), 0);
        const hRes = await client.query(`
            INSERT INTO ap_payment_run
                (run_number, run_date, description, bank_file_format_id, cm_bank_account_id,
                 payment_date, payment_method_id, due_date_filter,
                 total_amount_lc, status, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Draft',$10,$10)
            RETURNING id, run_number, run_date, description, bank_file_format_id, cm_bank_account_id,
                      payment_date, payment_method_id, due_date_filter, total_amount_lc, status`,
            [runNumber, run_date, description || null, bank_file_format_id || null, cm_bank_account_id || null,
             payment_date || null, payment_method_id || null, due_date_filter || null,
             total, userName]);
        const runId = hRes.rows[0].id;

        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            await client.query(`
                INSERT INTO ap_payment_run_detail
                    (run_id, ap_transaction_id, vendor_id, vendor_code, vendor_name_th,
                     bank_name, bank_branch_name, account_number, account_name,
                     invoice_no, invoice_date, due_date,
                     invoice_amount_lc, payment_amount_lc,
                     currency_code, exchange_rate, sort_order)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
                [runId, l.ap_transaction_id, l.vendor_id, l.vendor_code, l.vendor_name_th,
                 l.bank_name || null, l.bank_branch_name || null, l.account_number || null, l.account_name || null,
                 l.invoice_no, l.invoice_date || null, l.due_date || null,
                 l.invoice_amount_lc, l.payment_amount_lc,
                 l.currency_code || 'THB', l.exchange_rate || 1, i]);
        }
        await client.query('COMMIT');
        const full = await req.dbPool.query(`
            SELECT r.*, f.format_code AS bank_file_format_code, f.format_name AS bank_file_format_name
            FROM ap_payment_run r LEFT JOIN cm_bank_file_format f ON f.id = r.bank_file_format_id
            WHERE r.id=$1`, [runId]);
        const linesRes = await req.dbPool.query(`SELECT * FROM ap_payment_run_detail WHERE run_id=$1 ORDER BY sort_order, id`, [runId]);
        res.status(201).json({ ...full.rows[0], lines: linesRes.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating ap_payment_run:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

// --- PUT update (Draft only) ---
const updateRun = async (req, res) => {
    const { id } = req.params;
    const {
        run_date, description, bank_file_format_id, cm_bank_account_id,
        payment_date, payment_method_id, due_date_filter,
        lines = [],
    } = req.body;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureApPaymentRunColumns(req.dbPool);
        const existing = await client.query(`SELECT status FROM ap_payment_run WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (existing.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'แก้ไขได้เฉพาะเอกสาร Draft เท่านั้น' }); }

        const total = lines.reduce((s, l) => s + parseFloat(l.payment_amount_lc || 0), 0);
        await client.query(`
            UPDATE ap_payment_run
               SET run_date=$1, description=$2, bank_file_format_id=$3, cm_bank_account_id=$4,
                   payment_date=$5, payment_method_id=$6, due_date_filter=$7,
                   total_amount_lc=$8, updated_at=NOW(), updated_by=$9
             WHERE id=$10`,
            [run_date, description || null, bank_file_format_id || null, cm_bank_account_id || null,
             payment_date || null, payment_method_id || null, due_date_filter || null,
             total, userName, id]);

        await client.query(`DELETE FROM ap_payment_run_detail WHERE run_id=$1`, [id]);
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            await client.query(`
                INSERT INTO ap_payment_run_detail
                    (run_id, ap_transaction_id, vendor_id, vendor_code, vendor_name_th,
                     bank_name, bank_branch_name, account_number, account_name,
                     invoice_no, invoice_date, due_date,
                     invoice_amount_lc, payment_amount_lc,
                     currency_code, exchange_rate, sort_order)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
                [id, l.ap_transaction_id, l.vendor_id, l.vendor_code, l.vendor_name_th,
                 l.bank_name || null, l.bank_branch_name || null, l.account_number || null, l.account_name || null,
                 l.invoice_no, l.invoice_date || null, l.due_date || null,
                 l.invoice_amount_lc, l.payment_amount_lc,
                 l.currency_code || 'THB', l.exchange_rate || 1, i]);
        }
        await client.query('COMMIT');
        const full = await req.dbPool.query(`
            SELECT r.*, f.format_code AS bank_file_format_code, f.format_name AS bank_file_format_name
            FROM ap_payment_run r LEFT JOIN cm_bank_file_format f ON f.id = r.bank_file_format_id
            WHERE r.id=$1`, [id]);
        const linesRes = await req.dbPool.query(`SELECT * FROM ap_payment_run_detail WHERE run_id=$1 ORDER BY sort_order, id`, [id]);
        res.status(200).json({ ...full.rows[0], lines: linesRes.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating ap_payment_run:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

// --- PUT submit (Draft → Submitted) ---
const submitRun = async (req, res) => {
    const { id } = req.params;
    const { menu_id } = req.body || {};
    const userName = req.headers['username'] || null;
    if (!menu_id) return res.status(400).json({ message: 'ต้องระบุ menu_id' });
    const client = await req.dbPool.connect();
    try {
        const { ensureMenuApproverSchema, syncMenuApprovers } = require('../../utils/menuApproverSync');
        await ensureMenuApproverSchema(client);
        try { await client.query(`ALTER TABLE ap_payment_run ADD COLUMN IF NOT EXISTS approval_mode VARCHAR(10) DEFAULT 'ALL'`); } catch (_) {}
        await client.query('BEGIN');
        await syncMenuApprovers(client, menu_id);
        const existing = await client.query(`SELECT status FROM ap_payment_run WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (existing.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ส่งอนุมัติได้เฉพาะเอกสาร Draft เท่านั้น' }); }

        const menuRes = await client.query(`SELECT approval_mode FROM sa_menu WHERE id=$1`, [menu_id]);
        const approvalMode = menuRes.rows[0]?.approval_mode === 'ANY' ? 'ANY' : 'ALL';

        // Create approval records from sa_module_approver (ผูกกับ menu_id ของหน้าจอ Payment Run)
        const approvers = await client.query(`
            SELECT a.approval_level, a.approver_user_id, u.user_name
            FROM sa_module_approver a
            JOIN sa_user u ON u.id = a.approver_user_id
            WHERE a.menu_id=$1 AND a.is_active=true
            ORDER BY a.approval_level`, [menu_id]);

        if (approvers.rows.length === 0) {
            // ไม่มีผู้มีสิทธิ์อนุมัติเลย หรือถูกงดอนุมัติหมดทุกคน — admin ไม่ต้องการอนุมัติสำหรับเมนูนี้
            // ข้ามขั้นตอนอนุมัติไปเลยโดยไม่ต้องแจ้งเตือน แล้วผ่านตรงไป Approved
            await client.query(`DELETE FROM ap_payment_run_approval WHERE run_id=$1`, [id]);
            await client.query(`
                UPDATE ap_payment_run SET status='Approved', approval_mode=$1, updated_at=NOW(), updated_by=$2 WHERE id=$3`,
                [approvalMode, userName, id]);
            await client.query('COMMIT');
            return res.status(200).json({ message: 'ส่งอนุมัติสำเร็จ' });
        }

        await client.query(`
            UPDATE ap_payment_run SET status='Submitted', approval_mode=$1, updated_at=NOW(), updated_by=$2 WHERE id=$3`,
            [approvalMode, userName, id]);

        await client.query(`DELETE FROM ap_payment_run_approval WHERE run_id=$1`, [id]);
        for (const apr of approvers.rows) {
            await client.query(`
                INSERT INTO ap_payment_run_approval (run_id, approver_user_id, approver_user_name, sequence_no, status)
                VALUES ($1,$2,$3,$4,'Pending')`,
                [id, apr.approver_user_id, apr.user_name, apr.approval_level]);
        }
        await client.query('COMMIT');
        res.status(200).json({ message: 'ส่งอนุมัติสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error submitting ap_payment_run:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

// --- PUT void (Draft | Submitted → Void) ---
const voidRun = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM ap_payment_run WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (!['Draft', 'Submitted'].includes(existing.rows[0].status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ยกเลิกได้เฉพาะเอกสาร Draft หรือ Submitted เท่านั้น' });
        }
        await client.query(`
            UPDATE ap_payment_run SET status='Void', updated_at=NOW(), updated_by=$1 WHERE id=$2`,
            [userName, id]);
        await client.query('COMMIT');
        res.status(200).json({ message: 'ยกเลิกเอกสารสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error voiding ap_payment_run:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

// --- PUT approve (Submitted → Approved when all approve) ---
const approveRun = async (req, res) => {
    const { id } = req.params;
    const { remarks } = req.body || {};
    const userId = req.headers['userid'];
    const userName = req.headers['username'] || null;
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const run = await client.query(`SELECT status, approval_mode FROM ap_payment_run WHERE id=$1`, [id]);
        if (run.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (run.rows[0].status !== 'Submitted') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'อนุมัติได้เฉพาะเอกสาร Submitted เท่านั้น' }); }
        const isAnyMode = run.rows[0].approval_mode === 'ANY';

        // โหมด ALL: ต้องไม่มีลำดับก่อนหน้ายัง Pending อยู่ / โหมด ANY: ใครอนุมัติก่อนก็จบเลย ไม่ต้องรอลำดับ
        const myRecord = await client.query(`
            SELECT a.id FROM ap_payment_run_approval a
            WHERE a.run_id=$1 AND a.approver_user_id=$2 AND a.status='Pending'
              AND ($3::boolean OR NOT EXISTS (
                SELECT 1 FROM ap_payment_run_approval a2
                WHERE a2.run_id=$1 AND a2.sequence_no < a.sequence_no AND a2.status='Pending'
              ))`, [id, userId, isAnyMode]);

        if (myRecord.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'ไม่มีสิทธิ์อนุมัติ หรือยังรอการอนุมัติจากลำดับก่อนหน้า' });
        }

        await client.query(`
            UPDATE ap_payment_run_approval SET status='Approved', remarks=$1, approved_at=NOW() WHERE id=$2`,
            [remarks || null, myRecord.rows[0].id]);

        if (isAnyMode) {
            // คนใดคนหนึ่งอนุมัติก็พอ — แถวที่เหลือของคนอื่นเปลี่ยนเป็น Skipped แล้วจบทันที
            await client.query(
                `UPDATE ap_payment_run_approval SET status='Skipped' WHERE run_id=$1 AND status='Pending'`, [id]);
            await client.query(
                `UPDATE ap_payment_run SET status='Approved', updated_at=NOW(), updated_by=$1 WHERE id=$2`,
                [userName, id]);
        } else {
            // โหมด ALL: ต้องอนุมัติครบทุกคนตามลำดับ
            const remaining = await client.query(
                `SELECT COUNT(*) FROM ap_payment_run_approval WHERE run_id=$1 AND status='Pending'`, [id]);
            if (parseInt(remaining.rows[0].count) === 0) {
                await client.query(
                    `UPDATE ap_payment_run SET status='Approved', updated_at=NOW(), updated_by=$1 WHERE id=$2`,
                    [userName, id]);
            }
        }
        await client.query('COMMIT');
        res.status(200).json({ message: 'อนุมัติสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error approving ap_payment_run:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- PUT reject (Submitted → Rejected) ---
const rejectRun = async (req, res) => {
    const { id } = req.params;
    const { remarks } = req.body || {};
    const userId = req.headers['userid'];
    const userName = req.headers['username'] || null;
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const run = await client.query(`SELECT status FROM ap_payment_run WHERE id=$1`, [id]);
        if (run.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (run.rows[0].status !== 'Submitted') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ปฏิเสธได้เฉพาะเอกสาร Submitted เท่านั้น' }); }

        const myRecord = await client.query(`
            SELECT id FROM ap_payment_run_approval
            WHERE run_id=$1 AND approver_user_id=$2 AND status='Pending'`, [id, userId]);
        if (myRecord.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'ไม่มีสิทธิ์ปฏิเสธหรืออนุมัติไปแล้ว' });
        }

        await client.query(`
            UPDATE ap_payment_run_approval SET status='Rejected', remarks=$1, approved_at=NOW() WHERE id=$2`,
            [remarks || null, myRecord.rows[0].id]);
        await client.query(`
            UPDATE ap_payment_run SET status='Rejected', updated_at=NOW(), updated_by=$1 WHERE id=$2`,
            [userName, id]);
        await client.query('COMMIT');
        res.status(200).json({ message: 'ปฏิเสธการอนุมัติสำเร็จ' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error rejecting ap_payment_run:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- GET runs pending current user's approval ---
const fetchMyPending = async (req, res) => {
    const userId = req.headers['userid'];
    if (!userId) return res.status(401).json({ message: 'ต้องระบุ UserId' });
    try {
        const result = await req.dbPool.query(`
            SELECT r.id, r.run_number, r.run_date, r.description, r.total_amount_lc, r.status
            FROM ap_payment_run r
            WHERE r.status = 'Submitted'
              AND EXISTS (
                SELECT 1 FROM ap_payment_run_approval a
                WHERE a.run_id = r.id AND a.approver_user_id = $1 AND a.status = 'Pending'
              )
            ORDER BY r.run_date DESC, r.id DESC`, [userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching pending approvals:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET open invoices for payment run picker ---
const fetchOpenInvoicesForRun = async (req, res) => {
    const { vendor_code, date_from, date_to, payment_method_id, due_date_max } = req.query;
    await req.dbPool.query(`ALTER TABLE ap_vendor ADD COLUMN IF NOT EXISTS payment_method_id INTEGER`).catch(() => {});
    let query = `
        SELECT t.id AS txn_id, t.doc_no, t.doc_date, t.due_date,
               t.total_amount_lc, t.balance_amount_lc,
               t.currency_code, t.exchange_rate,
               v.id AS vendor_id, v.vendor_code, v.vendor_name_th, v.vendor_name_en,
               b.bank_name, b.branch_name AS bank_branch_name,
               b.account_number, b.account_name
        FROM ap_transaction t
        JOIN sa_module_document d ON d.id = t.doc_id
        JOIN ap_vendor v ON v.id = t.vendor_id
        LEFT JOIN ap_vendor_bank_account b ON b.vendor_id = t.vendor_id AND b.is_default = true
        WHERE t.status = 'Posted'
          AND t.balance_amount_lc > 0.005
          AND d.sys_doc_type IN ('10','50')`;
    const params = [];
    let pi = 1;
    if (vendor_code) { params.push(`%${vendor_code.toUpperCase()}%`); query += ` AND UPPER(v.vendor_code) LIKE $${pi++}`; }
    if (date_from)   { params.push(date_from); query += ` AND t.doc_date >= $${pi++}`; }
    if (date_to)     { params.push(date_to);   query += ` AND t.doc_date <= $${pi++}`; }
    // ใช้กรองเจ้าหนี้ — เฉพาะเจ้าหนี้ที่ตั้ง "ประเภทการชำระหลัก" ตรงกับที่เลือกในใบอนุมัติจ่าย
    if (payment_method_id) { params.push(payment_method_id); query += ` AND v.payment_method_id = $${pi++}`; }
    // ใช้กรองใบแจ้งหนี้ที่ครบกำหนดชำระแล้ว ไม่เกินวันที่ระบุ
    if (due_date_max)      { params.push(due_date_max);      query += ` AND t.due_date <= $${pi++}`; }
    query += ` ORDER BY v.vendor_code, t.doc_date, t.id`;
    try {
        const result = await req.dbPool.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching open invoices for payment run:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- Helper: ensure the run→ap_transaction traceability table exists ---
const ensureRunPaymentTable = async (pool) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ap_payment_run_payment (
            id                SERIAL PRIMARY KEY,
            run_id            INTEGER NOT NULL REFERENCES ap_payment_run(id) ON DELETE CASCADE,
            vendor_id         INTEGER NOT NULL,
            ap_transaction_id INTEGER NOT NULL REFERENCES ap_transaction(id),
            created_at        TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(run_id, vendor_id)
        )
    `);
};

// --- PUT finalize (Approved → Completed): ส่งชำระ ---
// สร้างธุรกรรมจ่ายชำระ (ap_transaction, doc type ที่เลือก) จริง 1 ใบต่อ 1 เจ้าหนี้ที่มีอยู่ในใบอนุมัติจ่าย
// โดยเรียกใช้ apTransactionController.createTransaction ตัวเดียวกับที่หน้าจอ AP Transaction ใช้
// (ไม่สร้าง GL posting แยกเองอีกต่อไป — เลิกใช้กลไก postRun/postGl เดิมทั้งหมด)
// body: { doc_id, post: true|false } — post=true จะ Post GL ทันที, false จะสร้างเป็น Draft
// รองรับการเรียกซ้ำ (idempotent): เจ้าหนี้ที่สร้างธุรกรรมสำเร็จไปแล้วในครั้งก่อนจะถูกข้าม
const finalizeRun = async (req, res) => {
    const { id } = req.params;
    const { doc_id, post } = req.body || {};
    const userName = req.headers['username'] || null;
    if (!doc_id) return res.status(400).json({ message: 'ต้องระบุประเภทเอกสาร' });
    try {
        await ensureRunPaymentTable(req.dbPool);

        const runRes = await req.dbPool.query(`SELECT * FROM ap_payment_run WHERE id=$1`, [id]);
        if (runRes.rows.length === 0) return res.status(404).json({ message: 'Not found' });
        const run = runRes.rows[0];
        if (run.status !== 'Approved') {
            return res.status(400).json({ message: 'ส่งชำระได้เฉพาะเอกสารที่อนุมัติแล้วเท่านั้น' });
        }

        const docRes = await req.dbPool.query(`SELECT * FROM sa_module_document WHERE id=$1`, [doc_id]);
        if (docRes.rows.length === 0) return res.status(400).json({ message: 'ไม่พบประเภทเอกสารที่เลือก' });

        const linesRes = await req.dbPool.query(
            `SELECT * FROM ap_payment_run_detail WHERE run_id=$1 ORDER BY sort_order, id`, [id]);
        const lines = linesRes.rows;
        if (lines.length === 0) return res.status(400).json({ message: 'ไม่มีรายการที่จะจ่ายชำระ' });

        const alreadyDoneRes = await req.dbPool.query(
            `SELECT vendor_id FROM ap_payment_run_payment WHERE run_id=$1`, [id]);
        const alreadyDoneVendorIds = new Set(alreadyDoneRes.rows.map(r => r.vendor_id));

        const byVendor = new Map();
        for (const l of lines) {
            if (!byVendor.has(l.vendor_id)) byVendor.set(l.vendor_id, []);
            byVendor.get(l.vendor_id).push(l);
        }

        const created = [];
        const errors = [];
        for (const [vendorId, vLines] of byVendor) {
            if (alreadyDoneVendorIds.has(vendorId)) continue; // สร้างธุรกรรมให้เจ้าหนี้รายนี้ไปแล้วในครั้งก่อน
            try {
                const vRes = await req.dbPool.query(`SELECT * FROM ap_vendor WHERE id=$1`, [vendorId]);
                const vendor = vRes.rows[0];
                if (!vendor) { errors.push({ vendor_id: vendorId, message: 'ไม่พบเจ้าหนี้' }); continue; }

                const currencyCode = vLines[0].currency_code || 'THB';
                const currencyRes = await req.dbPool.query(
                    `SELECT id FROM cd_currency WHERE currency_code=$1 LIMIT 1`, [currencyCode]);
                const totalLc = vLines.reduce((s, l) => s + parseFloat(l.payment_amount_lc || 0), 0);
                const docDate = run.payment_date || run.run_date;

                const header = {
                    doc_id,
                    doc_no: 'AUTO',
                    doc_date: docDate,
                    vendor_id: vendorId,
                    vendor_code: vendor.vendor_code,
                    vendor_name_th: vendor.vendor_name_th,
                    ap_account_id: vendor.ap_account_id || null,
                    currency_id: currencyRes.rows[0]?.id || null,
                    currency_code: currencyCode,
                    exchange_rate: vLines[0].exchange_rate || 1,
                    subtotal_fc: totalLc, before_vat_fc: totalLc, total_amount_fc: totalLc,
                    subtotal_lc: totalLc, before_vat_lc: totalLc, total_amount_lc: totalLc,
                    ref_no: run.run_number,
                    description: run.description || `Payment for ${run.run_number}`,
                    created_by: userName,
                };
                const applies = vLines.map(l => ({
                    applied_to_id: l.ap_transaction_id,
                    applied_amount_lc: parseFloat(l.payment_amount_lc || 0),
                    applied_amount_fc: parseFloat(l.payment_amount_lc || 0),
                    apply_type: 'invoice',
                }));
                const payments = [{
                    payment_method_id: run.payment_method_id || null,
                    payment_method_type: 'TRANSFER',
                    cm_bank_account_id: run.cm_bank_account_id || null,
                    amount_lc: totalLc, amount_fc: totalLc,
                    payment_date: docDate,
                }];

                const fakeReq = {
                    body: { header, details: [], applies, payments, whts: [], action: post ? 'Post' : 'Draft' },
                    dbPool: req.dbPool,
                };
                let captured = null;
                const fakeRes = {
                    status(code) { this.code = code; return this; },
                    json(body) { captured = { code: this.code, body }; },
                };
                await apTransactionController.createTransaction(fakeReq, fakeRes);

                if (captured && captured.code >= 200 && captured.code < 300) {
                    created.push({ vendor_id: vendorId, ap_transaction_id: captured.body.id, doc_no: captured.body.doc_no });
                    await req.dbPool.query(
                        `INSERT INTO ap_payment_run_payment (run_id, vendor_id, ap_transaction_id) VALUES ($1,$2,$3)
                         ON CONFLICT (run_id, vendor_id) DO NOTHING`,
                        [id, vendorId, captured.body.id]);
                } else {
                    errors.push({ vendor_id: vendorId, message: captured?.body?.message || 'สร้างธุรกรรมไม่สำเร็จ' });
                }
            } catch (e) {
                errors.push({ vendor_id: vendorId, message: e.message });
            }
        }

        // ปิดใบอนุมัติจ่ายเป็น Completed เฉพาะเมื่อสร้างธุรกรรมครบทุกเจ้าหนี้แล้ว (รวมครั้งก่อนหน้าถ้ามี)
        const doneCountRes = await req.dbPool.query(
            `SELECT COUNT(DISTINCT vendor_id) FROM ap_payment_run_payment WHERE run_id=$1`, [id]);
        const doneCount = parseInt(doneCountRes.rows[0].count, 10);
        if (doneCount >= byVendor.size) {
            await req.dbPool.query(
                `UPDATE ap_payment_run SET status='Completed', updated_at=NOW(), updated_by=$1 WHERE id=$2`,
                [userName, id]);
        }

        res.status(200).json({
            message: errors.length === 0
                ? 'ส่งชำระสำเร็จ'
                : `สร้างธุรกรรมสำเร็จ ${created.length} ใบ, ล้มเหลว ${errors.length} รายการ`,
            created, errors,
        });
    } catch (error) {
        console.error('Error finalizing ap_payment_run:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    }
};

module.exports = {
    fetchRows,
    fetchRow,
    createRun,
    updateRun,
    submitRun,
    approveRun,
    rejectRun,
    voidRun,
    finalizeRun,
    fetchMyPending,
    fetchOpenInvoicesForRun,
};
