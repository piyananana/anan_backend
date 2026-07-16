// controllers/cm/cmInterBankTransferController.js
'use strict';

const generateTransferNo = async (client, date) => {
    const d = new Date(date);
    const prefix = `IBT${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`;
    const r = await client.query(
        `SELECT transfer_no FROM cm_inter_bank_transfer WHERE transfer_no LIKE $1 ORDER BY transfer_no DESC LIMIT 1`,
        [`${prefix}%`]);
    if (!r.rows.length) return `${prefix}0001`;
    return `${prefix}${String(parseInt(r.rows[0].transfer_no.slice(-4))+1).padStart(4,'0')}`;
};

const generateGlDocNo = async (client, docCode, date) => {
    const d = new Date(date);
    const prefix = `${docCode}${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`;
    const r = await client.query(
        `SELECT gl_doc_no FROM gl_entry_header WHERE gl_doc_no LIKE $1 ORDER BY gl_doc_no DESC LIMIT 1`,
        [`${prefix}%`]);
    if (!r.rows.length) return `${prefix}0001`;
    return `${prefix}${String(parseInt(r.rows[0].gl_doc_no.slice(-4))+1).padStart(4,'0')}`;
};

const ensureTables = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_inter_bank_transfer (
            id                   SERIAL PRIMARY KEY,
            transfer_no          VARCHAR(30),
            transfer_date        DATE          NOT NULL,
            from_bank_account_id INTEGER       NOT NULL,
            to_bank_account_id   INTEGER       NOT NULL,
            amount               NUMERIC(18,4) NOT NULL DEFAULT 0,
            currency_code        VARCHAR(10)   NOT NULL DEFAULT 'THB',
            exchange_rate        NUMERIC(18,6) NOT NULL DEFAULT 1,
            amount_lc            NUMERIC(18,4) NOT NULL DEFAULT 0,
            description          VARCHAR(500),
            status               VARCHAR(20)   NOT NULL DEFAULT 'Draft',
            gl_doc_id            INTEGER,
            gl_doc_code          VARCHAR(30),
            gl_doc_no            VARCHAR(30),
            gl_entry_id          INTEGER,
            reversal_entry_id    INTEGER,
            created_at           TIMESTAMP DEFAULT NOW(),
            updated_at           TIMESTAMP DEFAULT NOW()
        )
    `);
};

const withJoins = `
    SELECT t.*,
        fa.account_code    AS from_account_code,
        fa.account_name_th AS from_account_name,
        fa.gl_account_id   AS from_gl_account_id,
        fb.short_name      AS from_bank_short_name,
        ta.account_code    AS to_account_code,
        ta.account_name_th AS to_account_name,
        ta.gl_account_id   AS to_gl_account_id,
        tb.short_name      AS to_bank_short_name,
        md.doc_name_thai   AS gl_doc_name
    FROM cm_inter_bank_transfer t
    LEFT JOIN cm_bank_account fa ON fa.id = t.from_bank_account_id
    LEFT JOIN cd_bank         fb ON fb.id = fa.bank_id
    LEFT JOIN cm_bank_account ta ON ta.id = t.to_bank_account_id
    LEFT JOIN cd_bank         tb ON tb.id = ta.bank_id
    LEFT JOIN sa_module_document md ON md.id = t.gl_doc_id
`;

const fetchRows = async (req, res) => {
    const { date_from, date_to, bank_account_id, status } = req.query;
    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const params = [], wheres = [];
        if (date_from)       { params.push(date_from);       wheres.push(`t.transfer_date >= $${params.length}`); }
        if (date_to)         { params.push(date_to);         wheres.push(`t.transfer_date <= $${params.length}`); }
        if (bank_account_id) {
            params.push(bank_account_id);
            wheres.push(`(t.from_bank_account_id=$${params.length} OR t.to_bank_account_id=$${params.length})`);
        }
        if (status) { params.push(status); wheres.push(`t.status=$${params.length}`); }
        const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
        const r = await client.query(`${withJoins} ${where} ORDER BY t.transfer_date DESC, t.id DESC`, params);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const r = await client.query(`${withJoins} WHERE t.id=$1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
        res.json(r.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const createRow = async (req, res) => {
    const { transfer_date, from_bank_account_id, to_bank_account_id, amount,
            currency_code, exchange_rate, amount_lc, description, gl_doc_id, gl_doc_code } = req.body;
    if (!transfer_date || !from_bank_account_id || !to_bank_account_id || !amount)
        return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
    if (parseInt(from_bank_account_id) === parseInt(to_bank_account_id))
        return res.status(400).json({ error: 'บัญชีต้นทางและปลายทางต้องไม่ใช่บัญชีเดียวกัน' });

    const client = await req.dbPool.connect();
    try {
        await ensureTables(client);
        const transferNo = await generateTransferNo(client, transfer_date);
        const r = await client.query(`
            INSERT INTO cm_inter_bank_transfer
                (transfer_no, transfer_date, from_bank_account_id, to_bank_account_id,
                 amount, currency_code, exchange_rate, amount_lc, description, gl_doc_id, gl_doc_code)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING id`,
            [transferNo, transfer_date, from_bank_account_id, to_bank_account_id,
             amount, currency_code || 'THB', exchange_rate || 1,
             amount_lc || amount, description, gl_doc_id || null, gl_doc_code || null]);
        res.json({ id: r.rows[0].id, transfer_no: transferNo });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { transfer_date, from_bank_account_id, to_bank_account_id, amount,
            currency_code, exchange_rate, amount_lc, description, gl_doc_id, gl_doc_code } = req.body;
    const client = await req.dbPool.connect();
    try {
        const chk = await client.query(`SELECT status FROM cm_inter_bank_transfer WHERE id=$1`, [req.params.id]);
        if (!chk.rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
        if (chk.rows[0].status !== 'Draft') return res.status(400).json({ error: 'แก้ไขได้เฉพาะ Draft' });
        if (parseInt(from_bank_account_id) === parseInt(to_bank_account_id))
            return res.status(400).json({ error: 'บัญชีต้นทางและปลายทางต้องไม่ใช่บัญชีเดียวกัน' });

        await client.query(`
            UPDATE cm_inter_bank_transfer SET
                transfer_date=$1, from_bank_account_id=$2, to_bank_account_id=$3,
                amount=$4, currency_code=$5, exchange_rate=$6, amount_lc=$7,
                description=$8, gl_doc_id=$9, gl_doc_code=$10, updated_at=NOW()
            WHERE id=$11`,
            [transfer_date, from_bank_account_id, to_bank_account_id,
             amount, currency_code || 'THB', exchange_rate || 1, amount_lc || amount,
             description, gl_doc_id || null, gl_doc_code || null, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const postRow = async (req, res) => {
    const { gl_doc_id, gl_doc_code } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const r = await client.query(`
            SELECT t.*, fa.gl_account_id AS from_gl_account_id, ta.gl_account_id AS to_gl_account_id
            FROM cm_inter_bank_transfer t
            LEFT JOIN cm_bank_account fa ON fa.id = t.from_bank_account_id
            LEFT JOIN cm_bank_account ta ON ta.id = t.to_bank_account_id
            WHERE t.id=$1`, [req.params.id]);
        if (!r.rows.length)       { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบข้อมูล' }); }
        const tx = r.rows[0];
        if (tx.status !== 'Draft')          { await client.query('ROLLBACK'); return res.status(400).json({ error: 'สถานะต้องเป็น Draft' }); }
        if (!tx.from_gl_account_id)         { await client.query('ROLLBACK'); return res.status(400).json({ error: 'บัญชีต้นทางยังไม่กำหนด GL Account' }); }
        if (!tx.to_gl_account_id)           { await client.query('ROLLBACK'); return res.status(400).json({ error: 'บัญชีปลายทางยังไม่กำหนด GL Account' }); }

        const docId   = gl_doc_id   || tx.gl_doc_id;
        const docCode = gl_doc_code || tx.gl_doc_code;
        if (!docId || !docCode) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'กรุณาเลือก GL Doc Type ก่อน Post' }); }

        const glDocNo  = await generateGlDocNo(client, docCode, tx.transfer_date);
        const amountLc = parseFloat(tx.amount_lc);

        const hRes = await client.query(`
            INSERT INTO gl_entry_header (gl_doc_no, gl_doc_id, entry_date, description, total_debit, total_credit, status)
            VALUES ($1,$2,$3,$4,$5,$5,'Posted') RETURNING id`,
            [glDocNo, docId, tx.transfer_date,
             tx.description || `โอนเงินระหว่างบัญชี ${tx.transfer_no}`, amountLc]);
        const headerId = hRes.rows[0].id;

        await client.query(`INSERT INTO gl_entry_lines (header_id,line_no,gl_account_id,debit_amount,credit_amount,description) VALUES ($1,1,$2,$3,0,'รับโอนเข้า')`,
            [headerId, tx.to_gl_account_id, amountLc]);
        await client.query(`INSERT INTO gl_entry_lines (header_id,line_no,gl_account_id,debit_amount,credit_amount,description) VALUES ($1,2,$2,0,$3,'โอนออก')`,
            [headerId, tx.from_gl_account_id, amountLc]);

        await client.query(`
            UPDATE cm_inter_bank_transfer
            SET status='Posted', gl_doc_id=$1, gl_doc_code=$2, gl_doc_no=$3, gl_entry_id=$4, updated_at=NOW()
            WHERE id=$5`,
            [docId, docCode, glDocNo, headerId, req.params.id]);

        await client.query('COMMIT');
        res.json({ success: true, gl_doc_no: glDocNo });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const voidRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const r = await client.query(`SELECT * FROM cm_inter_bank_transfer WHERE id=$1`, [req.params.id]);
        if (!r.rows.length)          { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบข้อมูล' }); }
        const tx = r.rows[0];
        if (tx.status !== 'Posted')  { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ยกเลิกได้เฉพาะ Posted' }); }

        const linesRes = await client.query(
            `SELECT * FROM gl_entry_lines WHERE header_id=$1 ORDER BY line_no`, [tx.gl_entry_id]);

        const today    = new Date().toISOString().slice(0,10);
        const revDocNo = await generateGlDocNo(client, tx.gl_doc_code, today);
        const amountLc = parseFloat(tx.amount_lc);

        const hRes = await client.query(`
            INSERT INTO gl_entry_header (gl_doc_no, gl_doc_id, entry_date, description, total_debit, total_credit, status)
            VALUES ($1,$2,$3,$4,$5,$5,'Posted') RETURNING id`,
            [revDocNo, tx.gl_doc_id, today,
             `ยกเลิก: ${tx.description || tx.transfer_no}`, amountLc]);
        const revId = hRes.rows[0].id;

        for (const line of linesRes.rows) {
            await client.query(`INSERT INTO gl_entry_lines (header_id,line_no,gl_account_id,debit_amount,credit_amount,description) VALUES ($1,$2,$3,$4,$5,$6)`,
                [revId, line.line_no, line.gl_account_id, line.credit_amount, line.debit_amount, `ยกเลิก: ${line.description}`]);
        }

        await client.query(`UPDATE cm_inter_bank_transfer SET status='Voided', reversal_entry_id=$1, updated_at=NOW() WHERE id=$2`,
            [revId, req.params.id]);

        await client.query('COMMIT');
        res.json({ success: true, reversal_doc_no: revDocNo });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const r = await client.query(`SELECT status FROM cm_inter_bank_transfer WHERE id=$1`, [req.params.id]);
        if (!r.rows.length)            return res.status(404).json({ error: 'ไม่พบข้อมูล' });
        if (r.rows[0].status !== 'Draft') return res.status(400).json({ error: 'ลบได้เฉพาะ Draft' });
        await client.query(`DELETE FROM cm_inter_bank_transfer WHERE id=$1`, [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { fetchRows, fetchRow, createRow, updateRow, postRow, voidRow, deleteRow };
