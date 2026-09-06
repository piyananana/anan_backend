// controllers/cm/cmTransactionController.js
// หน้าจอ "ธุรกรรม CM" รวม — ยึดโครงสร้างเดียวกับ apTransactionController.js / arTransactionController.js
// ครอบคลุม sys_module='81' (CM) ทั้ง 9 ประเภทเอกสาร: 10 รายรับ, 15 รายรับจาก AR (read-only),
// 20 รายจ่าย, 25 รายจ่ายจาก AP (read-only), 30 เติมเงินสดย่อย, 40 เบิกเงินสดย่อย,
// 50 โอนเงินระหว่างบัญชี, 70 ค่าธรรมเนียมธนาคาร, 90 ดอกเบี้ย
//
// 15/25 ไม่มีตารางของตัวเอง — เป็นมุมมอง read-only ของ cm_receipt/cm_payment ที่ถูกสร้างโดย
// AR/AP ตอน Post เท่านั้น (ดู postCmReceiptsHelper ใน arTransactionController.js และ
// postCmPaymentHelper ใน apTransactionController.js) จึงไม่ผ่าน createTransaction/postGlEntry เลย

// --- Helper: Generate Document Number (คัดลอกจาก apTransactionController.js) ---
const generateDocNo = async (client, docId, date, branchId = null) => {
    let config = null;
    let useBranchCounter = false;
    let branchRowId = null;

    if (branchId) {
        const branchRes = await client.query(
            `SELECT * FROM sa_doc_number_branch WHERE doc_id = $1 AND branch_id = $2 FOR UPDATE`,
            [docId, branchId]
        );
        if (branchRes.rows.length > 0) {
            const globalRes = await client.query(`SELECT * FROM sa_module_document WHERE id = $1`, [docId]);
            const global = globalRes.rows[0];
            if (!global || !global.is_auto_numbering) return null;
            const bc = branchRes.rows[0];
            config = {
                format_prefix:       bc.format_prefix      ?? global.format_prefix      ?? '',
                format_separator:    bc.format_separator   ?? global.format_separator   ?? '',
                format_suffix_date:  bc.format_suffix_date ?? global.format_suffix_date ?? '',
                running_length:      bc.running_length     ?? global.running_length     ?? 4,
                next_running_number: bc.next_running_number,
            };
            useBranchCounter = true;
            branchRowId = bc.id;
        }
    }
    if (!useBranchCounter) {
        const globalRes = await client.query(`SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]);
        const global = globalRes.rows[0];
        if (!global || !global.is_auto_numbering) return null;
        config = {
            format_prefix:       global.format_prefix      || '',
            format_separator:    global.format_separator   || '',
            format_suffix_date:  global.format_suffix_date || '',
            running_length:      global.running_length     || 4,
            next_running_number: global.next_running_number,
        };
    }

    let docNo = config.format_prefix;
    if (config.format_suffix_date) {
        const d = new Date(date);
        const year  = d.getFullYear().toString();
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const day   = d.getDate().toString().padStart(2, '0');
        if      (config.format_suffix_date === 'YY')       docNo += year.substring(2);
        else if (config.format_suffix_date === 'YYYY')     docNo += year;
        else if (config.format_suffix_date === 'YYMM')     docNo += year.substring(2) + month;
        else if (config.format_suffix_date === 'YYYYMM')   docNo += year + month;
        else if (config.format_suffix_date === 'YYYYMMDD') docNo += year + month + day;
    }
    if (config.format_separator) docNo += config.format_separator;
    docNo += config.next_running_number.toString().padStart(config.running_length, '0');

    if (useBranchCounter) {
        await client.query(
            `UPDATE sa_doc_number_branch SET next_running_number = next_running_number + 1 WHERE id = $1`,
            [branchRowId]
        );
    } else {
        await client.query(
            `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
            [docId]
        );
    }
    return docNo;
};

// --- Helper: ensure schema exists (idempotent) ---
const ensureTables = async (pool) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cm_transaction (
            id                   SERIAL PRIMARY KEY,
            doc_id               INTEGER NOT NULL REFERENCES sa_module_document(id),
            doc_no               VARCHAR(50) NOT NULL,
            doc_date             DATE NOT NULL,
            period_id            INTEGER,
            from_bank_account_id INTEGER REFERENCES cm_bank_account(id),
            to_bank_account_id   INTEGER REFERENCES cm_bank_account(id),
            bank_account_id      INTEGER REFERENCES cm_bank_account(id),
            gl_account_id        INTEGER REFERENCES gl_account(id),
            charge_type          VARCHAR(30),
            counterparty_name    VARCHAR(200),
            currency_id          INTEGER,
            currency_code        VARCHAR(10) DEFAULT 'THB',
            exchange_rate        NUMERIC(15,6) DEFAULT 1,
            total_amount_fc      NUMERIC(18,4) DEFAULT 0,
            total_amount_lc      NUMERIC(18,4) DEFAULT 0,
            paid_amount_lc       NUMERIC(18,4) DEFAULT 0,
            balance_amount_lc    NUMERIC(18,4) DEFAULT 0,
            ref_no               VARCHAR(100),
            ref_doc_id           INTEGER,
            ref_doc_no           VARCHAR(50),
            description          TEXT,
            status               VARCHAR(20) NOT NULL DEFAULT 'Draft',
            gl_entry_id          INTEGER,
            dim1_id INTEGER, dim2_id INTEGER, dim3_id INTEGER, dim4_id INTEGER, dim5_id INTEGER,
            branch_id            INTEGER,
            created_by           VARCHAR(100),
            updated_by           VARCHAR(100),
            created_at           TIMESTAMPTZ DEFAULT NOW(),
            updated_at           TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cm_transaction_detail (
            id                 SERIAL PRIMARY KEY,
            header_id          INTEGER NOT NULL REFERENCES cm_transaction(id) ON DELETE CASCADE,
            line_no            INTEGER NOT NULL DEFAULT 1,
            description        VARCHAR(300),
            expense_account_id INTEGER REFERENCES gl_account(id),
            amount_lc          NUMERIC(18,4) DEFAULT 0,
            amount_fc          NUMERIC(18,4) DEFAULT 0
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cm_transaction_apply (
            id                 SERIAL PRIMARY KEY,
            transaction_id     INTEGER NOT NULL REFERENCES cm_transaction(id) ON DELETE CASCADE,
            applied_to_id      INTEGER NOT NULL REFERENCES cm_transaction(id),
            applied_amount_lc  NUMERIC(18,4) DEFAULT 0,
            applied_amount_fc  NUMERIC(18,4) DEFAULT 0,
            applied_date       DATE,
            created_by         VARCHAR(100)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cm_transaction_payment (
            id                   SERIAL PRIMARY KEY,
            header_id            INTEGER NOT NULL REFERENCES cm_transaction(id) ON DELETE CASCADE,
            line_no              INTEGER NOT NULL DEFAULT 1,
            payment_method_id    INTEGER REFERENCES cm_payment_method(id),
            payment_method_code  VARCHAR(50),
            payment_method_name  VARCHAR(200),
            payment_method_type  VARCHAR(30) NOT NULL DEFAULT 'CASH',
            cm_bank_account_id   INTEGER REFERENCES cm_bank_account(id),
            gl_account_id        INTEGER REFERENCES gl_account(id),
            amount_lc            NUMERIC(18,4) DEFAULT 0,
            amount_fc            NUMERIC(18,4) DEFAULT 0,
            ref_no               VARCHAR(100),
            payment_date         DATE,
            remark               TEXT,
            drawer_bank_name     VARCHAR(100),
            drawer_bank_branch   VARCHAR(100),
            drawer_account_no    VARCHAR(50),
            created_by           VARCHAR(100),
            created_at           TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    // ตั้งค่าบัญชี GL ต่อประเภทเอกสาร (ดู cmTransactionGlSetupController.js ที่ให้ admin แก้ไขค่าเหล่านี้)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cm_transaction_gl_setup (
            id                            SERIAL PRIMARY KEY,
            doc_code                      VARCHAR(20) NOT NULL UNIQUE,
            gl_doc_id                     INTEGER REFERENCES sa_module_document(id),
            revenue_account_id            INTEGER REFERENCES gl_account(id),
            expense_account_id            INTEGER REFERENCES gl_account(id),
            petty_cash_payable_account_id INTEGER REFERENCES gl_account(id),
            fx_gain_account_id            INTEGER REFERENCES gl_account(id),
            fx_loss_account_id            INTEGER REFERENCES gl_account(id),
            created_at                    TIMESTAMPTZ DEFAULT NOW(),
            updated_at                    TIMESTAMPTZ DEFAULT NOW(),
            created_by                    VARCHAR(100),
            updated_by                    VARCHAR(100)
        )
    `);
};

// --- Helper: resolve GL account for a payment row ---
// priority: payment.gl_account_id (client-resolved) -> cm_bank_account.gl_account_id -> null
const resolvePaymentGlAccount = async (client, payment) => {
    if (payment.gl_account_id) return Number(payment.gl_account_id);
    if (payment.cm_bank_account_id) {
        const baRes = await client.query(
            `SELECT gl_account_id FROM cm_bank_account WHERE id = $1`, [payment.cm_bank_account_id]
        );
        if (baRes.rows.length > 0 && baRes.rows[0].gl_account_id) return Number(baRes.rows[0].gl_account_id);
    }
    return null;
};

// --- Post GL entry — branches by sys_doc_type, mirrors apTransactionController.js's postGlEntry ---
const postGlEntry = async (client, headerId, header, details, applies, payments, docNo) => {
    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period
         WHERE $1::date BETWEEN period_start_date AND period_end_date
         AND gl_status = 'OPEN' LIMIT 1`,
        [header.doc_date]
    );
    if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.doc_date}`);
    const periodId = periodRes.rows[0].id;

    const docTypeRes = await client.query(
        `SELECT sys_doc_type, doc_code FROM sa_module_document WHERE id = $1 LIMIT 1`, [header.doc_id]
    );
    const sysDocType = docTypeRes.rows[0]?.sys_doc_type || '';
    const docCode    = docTypeRes.rows[0]?.doc_code || '';

    if (['15', '25'].includes(sysDocType)) return null; // read-only mirrors — never posted from here

    const setupRes = await client.query(
        `SELECT * FROM cm_transaction_gl_setup WHERE doc_code = $1`, [docCode]
    );
    const setup = setupRes.rows[0];
    if (!setup) throw new Error('ยังไม่ได้ตั้งค่าบัญชีสำหรับประเภทเอกสารนี้ กรุณาตั้งค่าใน CM GL Account Setup');
    if (!setup.gl_doc_id) throw new Error('ยังไม่ได้ตั้งค่า GL Document Type ใน CM GL Account Setup สำหรับประเภทเอกสารนี้');

    let glDocNo = await generateDocNo(client, setup.gl_doc_id, header.doc_date, header.branch_id);
    if (!glDocNo) glDocNo = `GL-${docNo}`;

    const totalAmountLc = Number(header.total_amount_lc) || 0;
    const totalAmountFc = Number(header.total_amount_fc) || totalAmountLc;
    const exchangeRate  = Number(header.exchange_rate) || 1;

    const glDetails = [];
    const pushLine = (accountId, description, debitLc, creditLc, debitFc, creditFc) => {
        if (!accountId) throw new Error(`ไม่พบบัญชี GL สำหรับรายการ: ${description}`);
        glDetails.push({
            account_id: Number(accountId), description,
            debit_lc: debitLc || 0, credit_lc: creditLc || 0,
            debit_fc: debitFc || 0, credit_fc: creditFc || 0,
        });
    };

    if (sysDocType === '10') {
        // รายรับ: Dr [บัญชีตามช่องทางรับเงิน] / Cr บัญชีรายได้
        const revenueAccountId = header.gl_account_id || setup.revenue_account_id;
        for (const p of payments) {
            const acc = await resolvePaymentGlAccount(client, p);
            pushLine(acc, `รับเงิน ${p.payment_method_code || ''} ${docNo}`, Number(p.amount_lc) || 0, 0, Number(p.amount_fc) || 0, 0);
        }
        pushLine(revenueAccountId, `รายรับ ${docNo}`, 0, totalAmountLc, 0, totalAmountFc);
    } else if (sysDocType === '20') {
        // รายจ่าย: Dr บัญชีค่าใช้จ่าย / Cr [บัญชีตามช่องทางจ่ายเงิน]
        const expenseAccountId = header.gl_account_id || setup.expense_account_id;
        pushLine(expenseAccountId, `รายจ่าย ${docNo}`, totalAmountLc, 0, totalAmountFc, 0);
        for (const p of payments) {
            const acc = await resolvePaymentGlAccount(client, p);
            pushLine(acc, `จ่ายเงิน ${p.payment_method_code || ''} ${docNo}`, 0, Number(p.amount_lc) || 0, 0, Number(p.amount_fc) || 0);
        }
    } else if (sysDocType === '30') {
        // เติมเงินสดย่อย: Dr บัญชีพักเบิกเงินสดย่อย (ล้างยอดใบเบิกที่ apply) / Cr [บัญชีตามช่องทางจ่ายเงิน]
        pushLine(setup.petty_cash_payable_account_id, `เติมเงินสดย่อย ${docNo}`, totalAmountLc, 0, totalAmountFc, 0);
        for (const p of payments) {
            const acc = await resolvePaymentGlAccount(client, p);
            pushLine(acc, `เติมเงินสดย่อย ${p.payment_method_code || ''} ${docNo}`, 0, Number(p.amount_lc) || 0, 0, Number(p.amount_fc) || 0);
        }
    } else if (sysDocType === '40') {
        // เบิกเงินสดย่อย: Dr บัญชีค่าใช้จ่ายตามรายการ / Cr บัญชีพักเบิกเงินสดย่อย
        for (const d of details) {
            pushLine(d.expense_account_id, d.description || `เบิกเงินสดย่อย ${docNo}`, Number(d.amount_lc) || 0, 0, Number(d.amount_fc) || 0, 0);
        }
        pushLine(setup.petty_cash_payable_account_id, `เบิกเงินสดย่อย ${docNo}`, 0, totalAmountLc, 0, totalAmountFc);
    } else if (sysDocType === '50') {
        // โอนเงินระหว่างบัญชี: Dr บัญชีปลายทาง / Cr บัญชีต้นทาง
        const fromRes = await client.query(`SELECT gl_account_id FROM cm_bank_account WHERE id = $1`, [header.from_bank_account_id]);
        const toRes   = await client.query(`SELECT gl_account_id FROM cm_bank_account WHERE id = $1`, [header.to_bank_account_id]);
        pushLine(toRes.rows[0]?.gl_account_id, `รับโอนเข้า ${docNo}`, totalAmountLc, 0, totalAmountFc, 0);
        pushLine(fromRes.rows[0]?.gl_account_id, `โอนออก ${docNo}`, 0, totalAmountLc, 0, totalAmountFc);
    } else if (['70', '90'].includes(sysDocType)) {
        // ค่าธรรมเนียมธนาคาร / ดอกเบี้ย: ทิศทาง Dr/Cr กลับกันถ้าเป็นดอกเบี้ยรับ
        const bankRes = await client.query(`SELECT gl_account_id FROM cm_bank_account WHERE id = $1`, [header.bank_account_id]);
        const bankAccountId = bankRes.rows[0]?.gl_account_id;
        const offsetAccountId = header.gl_account_id || setup.expense_account_id;
        const isIncome = header.charge_type === 'INTEREST_INCOME';
        const label = sysDocType === '90'
            ? (isIncome ? 'ดอกเบี้ยรับ' : 'ดอกเบี้ยจ่าย')
            : 'ค่าธรรมเนียมธนาคาร';
        if (isIncome) {
            pushLine(bankAccountId, `${label} ${docNo}`, totalAmountLc, 0, totalAmountFc, 0);
            pushLine(offsetAccountId, `${label} ${docNo}`, 0, totalAmountLc, 0, totalAmountFc);
        } else {
            pushLine(offsetAccountId, `${label} ${docNo}`, totalAmountLc, 0, totalAmountFc, 0);
            pushLine(bankAccountId, `${label} ${docNo}`, 0, totalAmountLc, 0, totalAmountFc);
        }
    } else {
        return null;
    }

    const totalDebitLc  = glDetails.reduce((s, l) => s + l.debit_lc, 0);
    const totalCreditLc = glDetails.reduce((s, l) => s + l.credit_lc, 0);
    const totalDebitFc  = glDetails.reduce((s, l) => s + l.debit_fc, 0);
    const totalCreditFc = glDetails.reduce((s, l) => s + l.credit_fc, 0);

    const glHeaderRes = await client.query(`
        INSERT INTO gl_entry_header
        (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
         currency_id, exchange_rate, status,
         total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Posted',$10,$11,$12,$13,$14)
        RETURNING id
    `, [
        setup.gl_doc_id, glDocNo, header.doc_date, header.doc_date, periodId,
        header.ref_no || docNo, header.description || docNo,
        header.currency_id || null, exchangeRate,
        totalDebitLc, totalCreditLc, totalDebitFc, totalCreditFc,
        header.created_by || null,
    ]);
    const glHeaderId = glHeaderRes.rows[0].id;

    // Dimension validation — เหมือน apTransactionController.js/arTransactionController.js:
    // ใช้ dim ระดับหัวเอกสารแปะลงทุก GL line ที่สร้าง แล้วตรวจสอบว่าครบตาม gl_account_dim_rule ของแต่ละบัญชีหรือไม่
    const hDim1 = header.dim1_id || null;
    const hDim2 = header.dim2_id || null;
    const hDim3 = header.dim3_id || null;
    const hDim4 = header.dim4_id || null;
    const hDim5 = header.dim5_id || null;
    {
        const dimTypeRes = await client.query(
            `SELECT type_code, slot_no FROM gl_dimension_type WHERE is_active = true`
        );
        const slotByType = {};
        for (const r of dimTypeRes.rows) slotByType[r.type_code] = r.slot_no;
        const accountIds = [...new Set(glDetails.map(r => r.account_id).filter(Boolean))];
        if (accountIds.length > 0) {
            const accRes = await client.query(
                `SELECT id, account_code FROM gl_account WHERE id = ANY($1::int[])`, [accountIds]
            );
            const accCodeMap = {};
            for (const r of accRes.rows) accCodeMap[r.id] = r.account_code;
            const headerDims = { 1: hDim1, 2: hDim2, 3: hDim3, 4: hDim4, 5: hDim5 };
            const errors = [];
            for (const accountId of accountIds) {
                const rulesRes = await client.query(
                    `SELECT type_code FROM gl_account_dim_rule WHERE account_id = $1 AND is_required = true`,
                    [accountId]
                );
                for (const rule of rulesRes.rows) {
                    const slot = slotByType[rule.type_code];
                    if (!slot) continue;
                    if (!headerDims[slot]) {
                        errors.push(`บัญชี ${accCodeMap[accountId] || accountId}: ต้องระบุ ${rule.type_code}`);
                    }
                }
            }
            if (errors.length > 0) throw new Error(`Dimension ไม่ครบ:\n${errors.join('\n')}`);
        }
    }

    let lineNo = 1;
    for (const l of glDetails) {
        await client.query(`
            INSERT INTO gl_entry_detail
            (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc,
             dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [glHeaderId, lineNo++, l.account_id, l.description, l.debit_lc, l.credit_lc, l.debit_fc, l.credit_fc,
            hDim1, hDim2, hDim3, hDim4, hDim5]);
    }

    return glHeaderId;
};

// --- Fetch helper ---
const fetchRowById = async (pool, id) => {
    const [hRes, dRes, aRes, pRes] = await Promise.all([
        pool.query(`
            SELECT t.*,
                   d.doc_code, d.doc_name_thai, d.doc_name_eng, d.sys_doc_type, d.is_auto_numbering,
                   fb.bank_name_th AS from_bank_name, fb.account_number AS from_account_number,
                   tb.bank_name_th AS to_bank_name, tb.account_number AS to_account_number,
                   bb.bank_name_th AS bank_name, bb.account_number AS bank_account_number,
                   b.branch_code, b.branch_name_thai,
                   dim1.value_name_thai AS dim1_name, dim2.value_name_thai AS dim2_name,
                   dim3.value_name_thai AS dim3_name, dim4.value_name_thai AS dim4_name, dim5.value_name_thai AS dim5_name
            FROM cm_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            LEFT JOIN cm_bank_account fb ON fb.id = t.from_bank_account_id
            LEFT JOIN cm_bank_account tb ON tb.id = t.to_bank_account_id
            LEFT JOIN cm_bank_account bb ON bb.id = t.bank_account_id
            LEFT JOIN cd_branch b ON b.id = t.branch_id
            LEFT JOIN gl_dimension_value dim1 ON dim1.id = t.dim1_id
            LEFT JOIN gl_dimension_value dim2 ON dim2.id = t.dim2_id
            LEFT JOIN gl_dimension_value dim3 ON dim3.id = t.dim3_id
            LEFT JOIN gl_dimension_value dim4 ON dim4.id = t.dim4_id
            LEFT JOIN gl_dimension_value dim5 ON dim5.id = t.dim5_id
            WHERE t.id = $1`, [id]),
        pool.query(`
            SELECT dt.*, a.account_code AS expense_account_code, a.account_name_thai AS expense_account_name
            FROM cm_transaction_detail dt
            LEFT JOIN gl_account a ON a.id = dt.expense_account_id
            WHERE dt.header_id = $1 ORDER BY dt.line_no`, [id]),
        pool.query(`
            SELECT ap.*, t.doc_no AS applied_to_doc_no, t.doc_date AS applied_to_doc_date
            FROM cm_transaction_apply ap
            LEFT JOIN cm_transaction t ON t.id = ap.applied_to_id
            WHERE ap.transaction_id = $1 ORDER BY ap.id`, [id]),
        pool.query(`SELECT * FROM cm_transaction_payment WHERE header_id = $1 ORDER BY line_no`, [id])
            .catch(() => ({ rows: [] })),
    ]);
    if (hRes.rows.length === 0) return null;
    return { ...hRes.rows[0], details: dRes.rows, applies: aRes.rows, payments: pRes.rows };
};

// --- GET list ---
const fetchRows = async (req, res) => {
    const { doc_type, status, date_from, date_to, search } = req.query;
    try {
        await ensureTables(req.dbPool);

        // 15/25 = มุมมอง read-only ของ cm_receipt/cm_payment (สร้างโดย AR/AP เท่านั้น)
        if (doc_type === '15') {
            let query = `
                SELECT r.id, r.receipt_date AS doc_date, r.status,
                       r.amount_lc AS total_amount_lc, r.currency_code, r.exchange_rate,
                       COALESCE(r.ar_doc_no, 'RCT-'||r.id) AS doc_no,
                       r.customer_name_th AS counterparty_name,
                       '15' AS sys_doc_type, 'CRA' AS doc_code, 'รายรับจาก AR' AS doc_name_thai
                FROM cm_receipt r WHERE 1=1`;
            const params = []; let pi = 1;
            if (status)    { params.push(status);    query += ` AND r.status = $${pi++}`; }
            if (date_from) { params.push(date_from); query += ` AND r.receipt_date >= $${pi++}`; }
            if (date_to)   { params.push(date_to);   query += ` AND r.receipt_date <= $${pi++}`; }
            query += ` ORDER BY r.receipt_date DESC, r.id DESC`;
            const result = await req.dbPool.query(query, params);
            return res.status(200).json(result.rows);
        }
        if (doc_type === '25') {
            let query = `
                SELECT p.id, p.payment_date AS doc_date, p.status,
                       p.amount_lc AS total_amount_lc, p.currency_code, p.exchange_rate,
                       COALESCE(p.ap_doc_no, 'PMT-'||p.id) AS doc_no,
                       p.payee_name_th AS counterparty_name,
                       '25' AS sys_doc_type, 'CPA' AS doc_code, 'รายจ่ายจาก AP' AS doc_name_thai
                FROM cm_payment p WHERE 1=1`;
            const params = []; let pi = 1;
            if (status)    { params.push(status);    query += ` AND p.status = $${pi++}`; }
            if (date_from) { params.push(date_from); query += ` AND p.payment_date >= $${pi++}`; }
            if (date_to)   { params.push(date_to);   query += ` AND p.payment_date <= $${pi++}`; }
            query += ` ORDER BY p.payment_date DESC, p.id DESC`;
            const result = await req.dbPool.query(query, params);
            return res.status(200).json(result.rows);
        }

        let query = `
            SELECT t.id, t.doc_no, t.doc_date, t.status,
                   t.total_amount_lc, t.currency_code, t.exchange_rate,
                   t.counterparty_name, t.balance_amount_lc,
                   d.doc_code, d.doc_name_thai, d.doc_name_eng, d.sys_doc_type
            FROM cm_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE 1=1`;
        const params = []; let pi = 1;
        if (doc_type)  { params.push(doc_type);  query += ` AND d.sys_doc_type = $${pi++}`; }
        if (status)    { params.push(status);    query += ` AND t.status = $${pi++}`; }
        if (date_from) { params.push(date_from); query += ` AND t.doc_date >= $${pi++}`; }
        if (date_to)   { params.push(date_to);   query += ` AND t.doc_date <= $${pi++}`; }
        if (search) {
            params.push(`%${search.toUpperCase()}%`);
            query += ` AND (UPPER(t.doc_no) LIKE $${pi} OR UPPER(COALESCE(t.counterparty_name,'')) LIKE $${pi})`;
            pi++;
        }
        query += ` ORDER BY t.doc_date DESC, t.id DESC`;
        const result = await req.dbPool.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching cm_transaction list:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET one ---
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        await ensureTables(req.dbPool);
        const data = await fetchRowById(req.dbPool, id);
        if (!data) return res.status(404).json({ message: 'Not found.' });
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching cm_transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET one — read-only view of an AR-sourced cm_receipt row (doc type 15) ---
const fetchReceiptView = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            `SELECT r.*, 'รายรับจาก AR' AS doc_name_thai, '15' AS sys_doc_type
             FROM cm_receipt r WHERE r.id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching cm_receipt view:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET one — read-only view of an AP-sourced cm_payment row (doc type 25) ---
const fetchPaymentView = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            `SELECT p.*, 'รายจ่ายจาก AP' AS doc_name_thai, '25' AS sys_doc_type
             FROM cm_payment p WHERE p.id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching cm_payment view:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET open vouchers (doc type 40, Posted, balance>0) — for Replenishment(30)'s apply picker ---
const fetchOpenVouchers = async (req, res) => {
    const { bank_account_id } = req.query;
    try {
        await ensureTables(req.dbPool);
        let query = `
            SELECT t.id, t.doc_no, t.doc_date, t.total_amount_lc, t.balance_amount_lc,
                   t.currency_code, t.exchange_rate, t.description
            FROM cm_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE d.sys_doc_type = '40' AND t.status = 'Posted' AND t.balance_amount_lc > 0.005`;
        const params = [];
        if (bank_account_id) { params.push(bank_account_id); query += ` AND t.bank_account_id = $${params.length}`; }
        query += ` ORDER BY t.doc_date, t.id`;
        const result = await req.dbPool.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching open cm vouchers:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- POST create ---
const createTransaction = async (req, res) => {
    const { header, details, applies, payments, action } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTables(req.dbPool);

        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`, [header.doc_date]
        );
        if (periodRes.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        const periodId = periodRes.rows[0].id;

        let finalDocNo = header.doc_no;
        if (!finalDocNo || finalDocNo === 'AUTO') {
            finalDocNo = await generateDocNo(client, header.doc_id, header.doc_date, header.branch_id);
            if (!finalDocNo) throw new Error('Auto numbering failed or manual doc_no required');
        }

        const status = action === 'Post' ? 'Posted' : 'Draft';

        const hRes = await client.query(`
            INSERT INTO cm_transaction
            (doc_id, doc_no, doc_date, period_id,
             from_bank_account_id, to_bank_account_id, bank_account_id, gl_account_id, charge_type, counterparty_name,
             currency_id, currency_code, exchange_rate,
             total_amount_fc, total_amount_lc, paid_amount_lc, balance_amount_lc,
             ref_no, ref_doc_id, ref_doc_no, description, status,
             dim1_id, dim2_id, dim3_id, dim4_id, dim5_id, branch_id, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
            RETURNING id
        `, [
            header.doc_id, finalDocNo, header.doc_date, periodId,
            header.from_bank_account_id || null, header.to_bank_account_id || null,
            header.bank_account_id || null, header.gl_account_id || null,
            header.charge_type || null, header.counterparty_name || null,
            header.currency_id || null, header.currency_code || 'THB', header.exchange_rate || 1,
            header.total_amount_fc || 0, header.total_amount_lc || 0,
            0, header.total_amount_lc || 0,
            header.ref_no || null, header.ref_doc_id || null, header.ref_doc_no || null,
            header.description || null, status,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null,
            header.dim4_id || null, header.dim5_id || null, header.branch_id || null,
            header.created_by || null,
        ]);
        const newHeaderId = hRes.rows[0].id;

        let lineNo = 1;
        for (const d of (details || [])) {
            await client.query(`
                INSERT INTO cm_transaction_detail (header_id, line_no, description, expense_account_id, amount_lc, amount_fc)
                VALUES ($1,$2,$3,$4,$5,$6)
            `, [newHeaderId, lineNo++, d.description || null, d.expense_account_id || null, d.amount_lc || 0, d.amount_fc || 0]);
        }

        for (const a of (applies || [])) {
            await client.query(`
                INSERT INTO cm_transaction_apply (transaction_id, applied_to_id, applied_amount_lc, applied_amount_fc, applied_date, created_by)
                VALUES ($1,$2,$3,$4,$5,$6)
            `, [newHeaderId, a.applied_to_id, a.applied_amount_lc || 0, a.applied_amount_fc || 0, header.doc_date, header.created_by || null]);
        }
        const affectedVoucherIds = [...new Set((applies || []).map(a => a.applied_to_id).filter(Boolean))];
        for (const voucherId of affectedVoucherIds) {
            await client.query(`
                UPDATE cm_transaction t SET
                    paid_amount_lc = (SELECT COALESCE(SUM(a.applied_amount_lc),0) FROM cm_transaction_apply a WHERE a.applied_to_id = t.id),
                    balance_amount_lc = t.total_amount_lc -
                        (SELECT COALESCE(SUM(a.applied_amount_lc),0) FROM cm_transaction_apply a WHERE a.applied_to_id = t.id),
                    updated_at = NOW()
                WHERE id = $1
            `, [voucherId]);
        }

        let pmLineNo = 1;
        for (const p of (payments || [])) {
            await client.query(`
                INSERT INTO cm_transaction_payment
                (header_id, line_no, payment_method_id, payment_method_code, payment_method_name, payment_method_type,
                 cm_bank_account_id, gl_account_id, amount_lc, amount_fc, ref_no, payment_date, remark,
                 drawer_bank_name, drawer_bank_branch, drawer_account_no, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            `, [
                newHeaderId, pmLineNo++,
                p.payment_method_id || null, p.payment_method_code || null, p.payment_method_name || null,
                p.payment_method_type || 'CASH', p.cm_bank_account_id || null, p.gl_account_id || null,
                p.amount_lc || 0, p.amount_fc || 0, p.ref_no || null, p.payment_date || header.doc_date, p.remark || null,
                p.drawer_bank_name || null, p.drawer_bank_branch || null, p.drawer_account_no || null,
                header.created_by || null,
            ]);
        }

        let glEntryId = null;
        if (action === 'Post') {
            glEntryId = await postGlEntry(
                client, newHeaderId, { ...header, doc_no: finalDocNo },
                details || [], applies || [], payments || [], finalDocNo
            );
            if (glEntryId) {
                await client.query(`UPDATE cm_transaction SET gl_entry_id=$1 WHERE id=$2`, [glEntryId, newHeaderId]);
            }
        }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, newHeaderId);
        res.status(201).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating cm_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally {
        client.release();
    }
};

// --- PUT update (Draft only) — action:'Post' ในบอดี้เดียวกันนี้ทำการ Post ต่อได้เลย ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, details, applies, payments, action } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureTables(req.dbPool);

        const existing = await client.query(`SELECT status, doc_no FROM cm_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (existing.rows[0].status !== 'Draft') throw new Error('แก้ไขได้เฉพาะเอกสาร Draft เท่านั้น');
        const existingDocNo = existing.rows[0].doc_no;

        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`, [header.doc_date]
        );
        if (periodRes.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        const periodId = periodRes.rows[0].id;

        await client.query(`
            UPDATE cm_transaction SET
                doc_date=$1, period_id=$2,
                from_bank_account_id=$3, to_bank_account_id=$4, bank_account_id=$5, gl_account_id=$6,
                charge_type=$7, counterparty_name=$8,
                currency_id=$9, currency_code=$10, exchange_rate=$11,
                total_amount_fc=$12, total_amount_lc=$13, balance_amount_lc=$13 - paid_amount_lc,
                ref_no=$14, ref_doc_id=$15, ref_doc_no=$16, description=$17,
                dim1_id=$18, dim2_id=$19, dim3_id=$20, dim4_id=$21, dim5_id=$22, branch_id=$23,
                updated_by=$24, updated_at=NOW()
            WHERE id=$25
        `, [
            header.doc_date, periodId,
            header.from_bank_account_id || null, header.to_bank_account_id || null,
            header.bank_account_id || null, header.gl_account_id || null,
            header.charge_type || null, header.counterparty_name || null,
            header.currency_id || null, header.currency_code || 'THB', header.exchange_rate || 1,
            header.total_amount_fc || 0, header.total_amount_lc || 0,
            header.ref_no || null, header.ref_doc_id || null, header.ref_doc_no || null, header.description || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null,
            header.dim4_id || null, header.dim5_id || null, header.branch_id || null,
            header.updated_by || null, id,
        ]);

        await client.query(`DELETE FROM cm_transaction_detail WHERE header_id=$1`, [id]);
        await client.query(`DELETE FROM cm_transaction_apply WHERE transaction_id=$1`, [id]);
        await client.query(`DELETE FROM cm_transaction_payment WHERE header_id=$1`, [id]);

        let lineNo = 1;
        for (const d of (details || [])) {
            await client.query(`
                INSERT INTO cm_transaction_detail (header_id, line_no, description, expense_account_id, amount_lc, amount_fc)
                VALUES ($1,$2,$3,$4,$5,$6)
            `, [id, lineNo++, d.description || null, d.expense_account_id || null, d.amount_lc || 0, d.amount_fc || 0]);
        }
        for (const a of (applies || [])) {
            await client.query(`
                INSERT INTO cm_transaction_apply (transaction_id, applied_to_id, applied_amount_lc, applied_amount_fc, applied_date, created_by)
                VALUES ($1,$2,$3,$4,$5,$6)
            `, [id, a.applied_to_id, a.applied_amount_lc || 0, a.applied_amount_fc || 0, header.doc_date, header.updated_by || null]);
        }
        const affectedVoucherIds = [...new Set((applies || []).map(a => a.applied_to_id).filter(Boolean))];
        for (const voucherId of affectedVoucherIds) {
            await client.query(`
                UPDATE cm_transaction t SET
                    paid_amount_lc = (SELECT COALESCE(SUM(a.applied_amount_lc),0) FROM cm_transaction_apply a WHERE a.applied_to_id = t.id),
                    balance_amount_lc = t.total_amount_lc -
                        (SELECT COALESCE(SUM(a.applied_amount_lc),0) FROM cm_transaction_apply a WHERE a.applied_to_id = t.id),
                    updated_at = NOW()
                WHERE id = $1
            `, [voucherId]);
        }
        let pmLineNo = 1;
        for (const p of (payments || [])) {
            await client.query(`
                INSERT INTO cm_transaction_payment
                (header_id, line_no, payment_method_id, payment_method_code, payment_method_name, payment_method_type,
                 cm_bank_account_id, gl_account_id, amount_lc, amount_fc, ref_no, payment_date, remark,
                 drawer_bank_name, drawer_bank_branch, drawer_account_no, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            `, [
                id, pmLineNo++,
                p.payment_method_id || null, p.payment_method_code || null, p.payment_method_name || null,
                p.payment_method_type || 'CASH', p.cm_bank_account_id || null, p.gl_account_id || null,
                p.amount_lc || 0, p.amount_fc || 0, p.ref_no || null, p.payment_date || header.doc_date, p.remark || null,
                p.drawer_bank_name || null, p.drawer_bank_branch || null, p.drawer_account_no || null,
                header.updated_by || null,
            ]);
        }

        if (action === 'Post') {
            const glEntryId = await postGlEntry(
                client, id, { ...header, doc_no: existingDocNo, created_by: header.updated_by },
                details || [], applies || [], payments || [], existingDocNo
            );
            await client.query(
                `UPDATE cm_transaction SET status='Posted', gl_entry_id=$1 WHERE id=$2`,
                [glEntryId, id]
            );
        }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating cm_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally {
        client.release();
    }
};

// --- Void ---
const voidTransaction = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT * FROM cm_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        const tx = existing.rows[0];
        if (tx.status === 'Void') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'เอกสารถูก Void แล้ว' }); }

        const applies = (await client.query(`SELECT * FROM cm_transaction_apply WHERE transaction_id=$1`, [id])).rows;
        for (const a of applies) {
            await client.query(`
                UPDATE cm_transaction t SET
                    paid_amount_lc = GREATEST(0, t.paid_amount_lc - $1),
                    balance_amount_lc = t.total_amount_lc - GREATEST(0, t.paid_amount_lc - $1),
                    updated_at = NOW()
                WHERE id = $2
            `, [a.applied_amount_lc, a.applied_to_id]);
        }

        if (tx.gl_entry_id) {
            await client.query(`UPDATE gl_entry_header SET status='Void', updated_at=NOW() WHERE id=$1`, [tx.gl_entry_id]);
        }

        await client.query(`UPDATE cm_transaction SET status='Void', updated_at=NOW() WHERE id=$1`, [id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error voiding cm_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally {
        client.release();
    }
};

// --- Delete (Draft only) ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM cm_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (existing.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ลบได้เฉพาะเอกสาร Draft เท่านั้น' }); }
        await client.query(`DELETE FROM cm_transaction WHERE id=$1`, [id]);
        await client.query('COMMIT');
        res.status(204).send();
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting cm_transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

module.exports = {
    fetchRows, fetchRow, fetchReceiptView, fetchPaymentView, fetchOpenVouchers,
    createTransaction, updateTransaction, voidTransaction, deleteTransaction,
};
