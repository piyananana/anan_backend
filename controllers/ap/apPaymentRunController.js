// controllers/ap/apPaymentRunController.js

// --- Auto-generate run_number PR-YYYYMMDD-NNN ---
const generateRunNumber = async (client, date) => {
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

// --- GET list ---
const fetchRows = async (req, res) => {
    const { status, date_from, date_to } = req.query;
    let query = `
        SELECT r.id, r.run_number, r.run_date, r.description,
               r.total_amount_lc, r.status,
               f.format_code AS bank_file_format_code,
               f.format_name AS bank_file_format_name,
               r.created_at, r.created_by
        FROM ap_payment_run r
        LEFT JOIN cm_bank_file_format f ON f.id = r.bank_file_format_id
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
        const hRes = await req.dbPool.query(`
            SELECT r.id, r.run_number, r.run_date, r.description,
                   r.bank_file_format_id, r.total_amount_lc, r.status,
                   f.format_code AS bank_file_format_code,
                   f.format_name AS bank_file_format_name,
                   r.created_by, r.updated_by
            FROM ap_payment_run r
            LEFT JOIN cm_bank_file_format f ON f.id = r.bank_file_format_id
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

// --- Helper: ensure cm_bank_account_id column on ap_payment_run ---
const ensureApPaymentRunCmColumn = async (dbPool) => {
    await dbPool.query(`ALTER TABLE ap_payment_run ADD COLUMN IF NOT EXISTS cm_bank_account_id INTEGER`);
};

// --- Helper: Create CM payment records after AP payment run is posted ---
const postCmPaymentsHelper = async (client, run, lines, glEntryId) => {
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
        )`);

    // Idempotent: delete and re-create
    await client.query(`DELETE FROM cm_payment WHERE ap_payment_run_id = $1`, [run.id]);

    for (const line of lines) {
        const payAmt = parseFloat(line.payment_amount_lc || 0);
        if (payAmt === 0) continue;
        await client.query(`
            INSERT INTO cm_payment
                (payment_date, bank_account_id, payment_method_type,
                 ap_payment_run_id, ap_doc_no,
                 payee_type, payee_id, payee_code, payee_name_th,
                 amount_lc, currency_code, exchange_rate, gl_entry_id)
            VALUES ($1,$2,'TRANSFER',$3,$4,'VENDOR',$5,$6,$7,$8,'THB',1,$9)`,
            [
                run.run_date,
                run.cm_bank_account_id || null,
                run.id,
                run.run_number,
                line.vendor_id   || null,
                line.vendor_code || null,
                line.vendor_name_th || null,
                payAmt,
                glEntryId,
            ]);
    }
};

// --- POST create (Draft) ---
const createRun = async (req, res) => {
    const { run_date, description, bank_file_format_id, cm_bank_account_id, lines = [] } = req.body;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE ap_payment_run ADD COLUMN IF NOT EXISTS cm_bank_account_id INTEGER`);
        const runNumber = await generateRunNumber(client, run_date);
        const total = lines.reduce((s, l) => s + parseFloat(l.payment_amount_lc || 0), 0);
        const hRes = await client.query(`
            INSERT INTO ap_payment_run
                (run_number, run_date, description, bank_file_format_id, cm_bank_account_id, total_amount_lc, status, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,'Draft',$7,$7)
            RETURNING id, run_number, run_date, description, bank_file_format_id, cm_bank_account_id, total_amount_lc, status`,
            [runNumber, run_date, description || null, bank_file_format_id || null, cm_bank_account_id || null, total, userName]);
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
    const { run_date, description, bank_file_format_id, cm_bank_account_id, lines = [] } = req.body;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE ap_payment_run ADD COLUMN IF NOT EXISTS cm_bank_account_id INTEGER`);
        const existing = await client.query(`SELECT status FROM ap_payment_run WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (existing.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'แก้ไขได้เฉพาะเอกสาร Draft เท่านั้น' }); }

        const total = lines.reduce((s, l) => s + parseFloat(l.payment_amount_lc || 0), 0);
        await client.query(`
            UPDATE ap_payment_run
               SET run_date=$1, description=$2, bank_file_format_id=$3, cm_bank_account_id=$4,
                   total_amount_lc=$5, updated_at=NOW(), updated_by=$6
             WHERE id=$7`,
            [run_date, description || null, bank_file_format_id || null, cm_bank_account_id || null, total, userName, id]);

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
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM ap_payment_run WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (existing.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ส่งอนุมัติได้เฉพาะเอกสาร Draft เท่านั้น' }); }

        await client.query(`
            UPDATE ap_payment_run SET status='Submitted', updated_at=NOW(), updated_by=$1 WHERE id=$2`,
            [userName, id]);

        // Create approval records from sa_module_approver
        const approvers = await client.query(`
            SELECT a.approval_level, a.approver_user_id, u.user_name
            FROM sa_module_approver a
            JOIN sa_user u ON u.id = a.approver_user_id
            WHERE a.module_code='21' AND a.doc_category='payment_run' AND a.is_active=true
            ORDER BY a.approval_level`, []);

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
        const run = await client.query(`SELECT status FROM ap_payment_run WHERE id=$1`, [id]);
        if (run.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (run.rows[0].status !== 'Submitted') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'อนุมัติได้เฉพาะเอกสาร Submitted เท่านั้น' }); }

        // User must have pending record AND all lower-sequence approvers already approved
        const myRecord = await client.query(`
            SELECT a.id FROM ap_payment_run_approval a
            WHERE a.run_id=$1 AND a.approver_user_id=$2 AND a.status='Pending'
              AND NOT EXISTS (
                SELECT 1 FROM ap_payment_run_approval a2
                WHERE a2.run_id=$1 AND a2.sequence_no < a.sequence_no AND a2.status='Pending'
              )`, [id, userId]);

        if (myRecord.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'ไม่มีสิทธิ์อนุมัติ หรือยังรอการอนุมัติจากลำดับก่อนหน้า' });
        }

        await client.query(`
            UPDATE ap_payment_run_approval SET status='Approved', remarks=$1, approved_at=NOW() WHERE id=$2`,
            [remarks || null, myRecord.rows[0].id]);

        // If no more pending → promote run to Approved
        const remaining = await client.query(
            `SELECT COUNT(*) FROM ap_payment_run_approval WHERE run_id=$1 AND status='Pending'`, [id]);
        if (parseInt(remaining.rows[0].count) === 0) {
            await client.query(
                `UPDATE ap_payment_run SET status='Approved', updated_at=NOW(), updated_by=$1 WHERE id=$2`,
                [userName, id]);
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
    const { vendor_code, date_from, date_to } = req.query;
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
    query += ` ORDER BY v.vendor_code, t.doc_date, t.id`;
    try {
        const result = await req.dbPool.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching open invoices for payment run:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- Helper: Generate GL document number (mirrors apTransactionController logic) ---
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
        `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
        [glDocId]);
    return docNo;
};

// --- PUT post GL (Approved → Completed) ---
const postRun = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers['username'] || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // Ensure columns exist (idempotent migration)
        await client.query(`
            ALTER TABLE ap_payment_run
            ADD COLUMN IF NOT EXISTS gl_entry_id       INT,
            ADD COLUMN IF NOT EXISTS gl_doc_no         VARCHAR(50),
            ADD COLUMN IF NOT EXISTS cm_bank_account_id INTEGER`);

        // 1. Verify run is Approved
        const runRes = await client.query(
            `SELECT * FROM ap_payment_run WHERE id = $1`, [id]);
        if (runRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Not found' });
        }
        const run = runRes.rows[0];
        if (run.status !== 'Approved') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'บันทึก GL ได้เฉพาะเอกสาร Approved เท่านั้น' });
        }

        // 2. Get lines
        const linesRes = await client.query(
            `SELECT * FROM ap_payment_run_detail WHERE run_id = $1 ORDER BY sort_order, id`, [id]);
        const lines = linesRes.rows;
        if (lines.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ไม่มีรายการชำระเงิน' });
        }

        // 3. Find GL setup for payment doc type (sys_doc_type='80')
        const setupRes = await client.query(`
            SELECT s.*, d.id AS sys_doc_id
            FROM sa_module_document d
            LEFT JOIN ap_gl_account_setup s ON s.doc_code = d.doc_code
            WHERE d.sys_module = '21' AND d.sys_doc_type = '80' AND d.is_doc_type = true
            LIMIT 1`);
        if (setupRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ไม่พบประเภทเอกสาร Payment (sys_doc_type=80) ในระบบ AP กรุณาตั้งค่า sa_module_document' });
        }
        const setup = setupRes.rows[0];
        if (!setup.gl_doc_id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ยังไม่ได้ตั้งค่า GL Document Type ใน AP GL Account Setup สำหรับประเภทเอกสาร Payment' });
        }

        // 4. Find open GL period
        const periodRes = await client.query(`
            SELECT id FROM gl_posting_period
            WHERE $1::date BETWEEN period_start_date AND period_end_date
              AND gl_status = 'OPEN'
            LIMIT 1`, [run.run_date]);
        if (periodRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${run.run_date}` });
        }
        const periodId = periodRes.rows[0].id;

        // 5. Determine bank/transfer account (credit side)
        const bankAccountId = setup.transfer_account_id || setup.cash_account_id;
        if (!bankAccountId) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ยังไม่ได้ตั้งค่าบัญชีธนาคาร/โอนเงิน ใน AP GL Account Setup' });
        }

        // 6. Generate GL doc number
        let glDocNo = await generateGlDocNo(client, setup.gl_doc_id, run.run_date);
        if (!glDocNo) glDocNo = `GL-${run.run_number}`;

        const totalAmount = lines.reduce((s, l) => s + parseFloat(l.payment_amount_lc || 0), 0);

        // 7. Resolve created_by user id
        const userRes = await client.query(
            `SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
        const createdByUserId = userRes.rows[0]?.id || null;

        // 8. Insert GL entry header
        const glHeaderRes = await client.query(`
            INSERT INTO gl_entry_header
              (doc_id, doc_no, doc_date, posting_date, period_id,
               ref_no, description,
               currency_id, exchange_rate, status,
               total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
               created_by, ref_doc_id, ref_doc_no, external_source_id)
            VALUES ($1,$2,$3,$3,$4,$5,$6,1,1,'Posted',$7,$7,$7,$7,$8,$9,$10,$11)
            RETURNING id`,
            [setup.gl_doc_id, glDocNo, run.run_date, periodId,
             run.run_number,
             run.description || `Payment Run ${run.run_number}`,
             totalAmount, createdByUserId,
             setup.sys_doc_id, run.run_number, id]);
        const glEntryId = glHeaderRes.rows[0].id;

        // 9. Insert DR lines — one per payment run detail
        let lineNo = 1;
        for (const line of lines) {
            const payAmt = parseFloat(line.payment_amount_lc || 0);
            if (payAmt === 0) continue;

            // Resolve AP account: prefer vendor's own account, fall back to setup default
            let apAccountId = setup.ap_account_id ? Number(setup.ap_account_id) : null;
            const vendorRes = await client.query(
                `SELECT ap_account_id FROM ap_vendor WHERE id = $1`, [line.vendor_id]);
            if (vendorRes.rows[0]?.ap_account_id)
                apAccountId = Number(vendorRes.rows[0].ap_account_id);

            if (!apAccountId) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: `ไม่พบบัญชีเจ้าหนี้สำหรับ ${line.vendor_code} กรุณาตั้งค่าในเจ้าหนี้หรือ AP GL Account Setup`
                });
            }

            await client.query(`
                INSERT INTO gl_entry_detail
                  (header_id, line_no, account_id, description,
                   debit_lc, credit_lc, debit_fc, credit_fc)
                VALUES ($1,$2,$3,$4,$5,0,$5,0)`,
                [glEntryId, lineNo++, apAccountId,
                 `ชำระ ${line.vendor_code} ${line.invoice_no}`, payAmt]);
        }

        // 10. Insert CR line — bank/transfer total
        await client.query(`
            INSERT INTO gl_entry_detail
              (header_id, line_no, account_id, description,
               debit_lc, credit_lc, debit_fc, credit_fc)
            VALUES ($1,$2,$3,$4,0,$5,0,$5)`,
            [glEntryId, lineNo, bankAccountId,
             `โอนชำระ ${run.run_number}`, totalAmount]);

        // 11. Update each AP transaction's paid/balance amounts
        for (const line of lines) {
            const payAmt = parseFloat(line.payment_amount_lc || 0);
            if (payAmt === 0) continue;
            await client.query(`
                UPDATE ap_transaction
                SET paid_amount_lc    = COALESCE(paid_amount_lc, 0) + $1,
                    balance_amount_lc = GREATEST(COALESCE(balance_amount_lc, 0) - $1, 0),
                    status = CASE
                        WHEN (COALESCE(balance_amount_lc, 0) - $1) <= 0.005 THEN 'Settled'
                        ELSE status
                    END,
                    updated_at = NOW()
                WHERE id = $2`,
                [payAmt, line.ap_transaction_id]);
        }

        // 12. Mark run Completed, store GL reference
        await client.query(`
            UPDATE ap_payment_run
            SET status = 'Completed', gl_entry_id = $1, gl_doc_no = $2,
                updated_at = NOW(), updated_by = $3
            WHERE id = $4`,
            [glEntryId, glDocNo, userName, id]);

        // 13. Post CM payment records (always, bank_account_id nullable if not set)
        await postCmPaymentsHelper(client, run, lines, glEntryId);

        await client.query('COMMIT');
        res.status(200).json({ message: 'บันทึก GL สำเร็จ', gl_entry_id: glEntryId, gl_doc_no: glDocNo });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error posting GL for payment run:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally {
        client.release();
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
    postRun,
    fetchMyPending,
    fetchOpenInvoicesForRun,
};
