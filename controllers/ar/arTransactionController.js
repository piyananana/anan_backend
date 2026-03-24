// controllers/ar/arTransactionController.js

// --- Helper: Generate Document Number (same pattern as GL) ---
const generateDocNo = async (client, docId, date) => {
    const docConfigRes = await client.query(
        `SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]
    );
    const config = docConfigRes.rows[0];
    if (!config.is_auto_numbering) return null;

    let docNo = config.format_prefix || '';
    if (config.format_suffix_date) {
        const d = new Date(date);
        const year = d.getFullYear().toString();
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const day = d.getDate().toString().padStart(2, '0');
        if (config.format_suffix_date === 'YY') docNo += year.substring(2);
        else if (config.format_suffix_date === 'YYYY') docNo += year;
        else if (config.format_suffix_date === 'YYMM') docNo += year.substring(2) + month;
        else if (config.format_suffix_date === 'YYYYMM') docNo += year + month;
        else if (config.format_suffix_date === 'YYYYMMDD') docNo += year + month + day;
    }
    if (config.format_separator) docNo += config.format_separator;
    const running = config.next_running_number.toString().padStart(config.running_length, '0');
    docNo += running;
    await client.query(
        `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
        [docId]
    );
    return docNo;
};

// --- Helper: Insert VAT records ---
const insertVtRecords = async (client, headerId, header, details) => {
    const vatDetails = details.filter(d => d.vat_type && d.vat_type !== 'NOVAT' && Number(d.vat_amount_fc) !== 0);
    for (const d of vatDetails) {
        await client.query(`
            INSERT INTO vt_transaction
            (module_code, vat_type, doc_id, source_header_id, source_detail_id,
             doc_no, doc_date, vat_rate,
             base_amount_lc, vat_amount_lc, base_amount_fc, vat_amount_fc,
             currency_id, exchange_rate,
             customer_id, entity_name, entity_tax_id,
             created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        `, [
            'AR', 'OUTPUT_VAT', header.doc_id, headerId, d.id || null,
            header.doc_no, header.doc_date, d.vat_rate || 7,
            d.subtotal_lc || 0, d.vat_amount_lc || 0,
            d.subtotal_fc || 0, d.vat_amount_fc || 0,
            header.currency_id || null, header.exchange_rate || 1,
            header.customer_id, header.customer_name_th || '',
            header.customer_tax_id || null,
            header.created_by || null
        ]);
    }
};

// --- Helper: Post GL Entry for AR transaction ---
const postGlEntry = async (client, headerId, header, details, docNo) => {
    // Find open period
    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period
         WHERE $1::date BETWEEN period_start_date AND period_end_date
         AND gl_status = 'OPEN' LIMIT 1`,
        [header.doc_date]
    );
    if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.doc_date}`);
    const periodId = periodRes.rows[0].id;

    // Find doc_id for GL module that represents AR posting (sys_module=1 or similar)
    // We'll create a minimal GL entry referencing the AR transaction
    const glHeaderSql = `
        INSERT INTO gl_entry_header
        (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
         currency_id, exchange_rate, status,
         total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
         created_by, ref_doc_id, ref_doc_no, external_source_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Posted',$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING id
    `;
    const totalDebit = Number(header.total_amount_lc) || 0;
    const glHeaderRes = await client.query(glHeaderSql, [
        header.doc_id, docNo, header.doc_date, header.doc_date, periodId,
        header.ref_no || null, header.description || null,
        header.currency_id || 1, header.exchange_rate || 1,
        totalDebit, totalDebit,  // debit = credit (balanced)
        Number(header.total_amount_fc) || 0, Number(header.total_amount_fc) || 0,
        header.created_by || null, header.doc_id, docNo, headerId
    ]);
    const glEntryId = glHeaderRes.rows[0].id;

    // Build GL detail lines
    const glDetails = [];
    // DR: AR Account (total_amount_lc)
    if (header.ar_account_id) {
        glDetails.push({
            account_id: header.ar_account_id,
            description: `AR ${docNo}`,
            debit_lc: totalDebit,
            credit_lc: 0,
            debit_fc: Number(header.total_amount_fc) || 0,
            credit_fc: 0,
        });
    }
    // CR: Revenue per line + VAT
    for (const d of details) {
        if (d.revenue_account_id && Number(d.subtotal_lc) !== 0) {
            glDetails.push({
                account_id: d.revenue_account_id,
                description: d.description || d.item_name || '',
                debit_lc: 0,
                credit_lc: Number(d.subtotal_lc) || 0,
                debit_fc: 0,
                credit_fc: Number(d.subtotal_fc) || 0,
            });
        }
        if (header.vat_account_id && Number(d.vat_amount_lc) !== 0) {
            glDetails.push({
                account_id: header.vat_account_id,
                description: `VAT ${docNo}`,
                debit_lc: 0,
                credit_lc: Number(d.vat_amount_lc) || 0,
                debit_fc: 0,
                credit_fc: Number(d.vat_amount_fc) || 0,
            });
        }
    }

    const detailSql = `
        INSERT INTO gl_entry_detail
        (header_id, line_no, account_id, description,
         debit_lc, credit_lc, debit_fc, credit_fc,
         branch_id, project_id, business_unit_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `;
    let lineNo = 1;
    for (const row of glDetails) {
        await client.query(detailSql, [
            glEntryId, lineNo++, row.account_id, row.description,
            row.debit_lc, row.credit_lc, row.debit_fc, row.credit_fc,
            null, null, null
        ]);
    }

    return glEntryId;
};

// --- 1. Create Transaction (Draft/Post) ---
const createTransaction = async (req, res) => {
    const { header, details, applies, action } = req.body; // action: 'Draft' | 'Post'
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // Validate period for Post
        if (action === 'Post') {
            const periodRes = await client.query(
                `SELECT id FROM gl_posting_period
                 WHERE $1::date BETWEEN period_start_date AND period_end_date
                 AND gl_status = 'OPEN' LIMIT 1`,
                [header.doc_date]
            );
            if (periodRes.rows.length === 0)
                throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        }

        // Find period_id (always needed)
        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`,
            [header.doc_date]
        );
        if (periodRes.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        const periodId = periodRes.rows[0].id;

        // Generate doc_no
        let finalDocNo = header.doc_no;
        if (!finalDocNo || finalDocNo === 'AUTO') {
            finalDocNo = await generateDocNo(client, header.doc_id, header.doc_date);
            if (!finalDocNo) throw new Error('Auto numbering failed or manual doc_no required');
        }

        const status = action === 'Post' ? 'Posted' : 'Draft';

        // Insert header
        const headerSql = `
            INSERT INTO ar_transaction
            (doc_id, doc_no, doc_date, due_date, period_id,
             customer_id, customer_code, customer_name_th,
             ar_account_id, currency_id, currency_code, exchange_rate,
             subtotal_fc, discount_amount_fc, before_vat_fc, vat_amount_fc, total_amount_fc,
             subtotal_lc, discount_amount_lc, before_vat_lc, vat_amount_lc, total_amount_lc,
             paid_amount_lc, balance_amount_lc,
             ref_no, ref_doc_id, ref_doc_no, description, status,
             created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                    $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                    $25,$26,$27,$28,$29,$30)
            RETURNING id
        `;
        const hRes = await client.query(headerSql, [
            header.doc_id, finalDocNo, header.doc_date, header.due_date || null, periodId,
            header.customer_id, header.customer_code || null, header.customer_name_th || null,
            header.ar_account_id || null, header.currency_id || null, header.currency_code || 'THB',
            header.exchange_rate || 1,
            header.subtotal_fc || 0, header.discount_amount_fc || 0,
            header.before_vat_fc || 0, header.vat_amount_fc || 0, header.total_amount_fc || 0,
            header.subtotal_lc || 0, header.discount_amount_lc || 0,
            header.before_vat_lc || 0, header.vat_amount_lc || 0, header.total_amount_lc || 0,
            0, header.total_amount_lc || 0,  // paid=0, balance=total
            header.ref_no || null, header.ref_doc_id || null, header.ref_doc_no || null,
            header.description || null, status,
            header.created_by || null
        ]);
        const newHeaderId = hRes.rows[0].id;

        // Insert details
        const detailSql = `
            INSERT INTO ar_transaction_detail
            (header_id, line_no, item_code, item_name, description,
             quantity, unit_code, unit_price_fc, discount_percent, discount_amount_fc,
             subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
             revenue_account_id, subtotal_lc, vat_amount_lc, total_amount_lc)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            RETURNING id
        `;
        let lineNo = 1;
        for (const d of (details || [])) {
            await client.query(detailSql, [
                newHeaderId, lineNo++,
                d.item_code || null, d.item_name || null, d.description || null,
                d.quantity || 1, d.unit_code || null,
                d.unit_price_fc || 0, d.discount_percent || 0, d.discount_amount_fc || 0,
                d.subtotal_fc || 0, d.vat_type || 'VAT7', d.vat_rate || 7,
                d.vat_amount_fc || 0, d.total_amount_fc || 0,
                d.revenue_account_id || null,
                d.subtotal_lc || 0, d.vat_amount_lc || 0, d.total_amount_lc || 0
            ]);
        }

        // Insert apply records (for Receipt/CN)
        for (const a of (applies || [])) {
            await client.query(`
                INSERT INTO ar_transaction_apply
                (transaction_id, applied_to_id, applied_amount_lc, applied_amount_fc, applied_date, created_by)
                VALUES ($1,$2,$3,$4,$5,$6)
            `, [newHeaderId, a.applied_to_id, a.applied_amount_lc || 0, a.applied_amount_fc || 0,
                header.doc_date, header.created_by || null]);

            // Update paid_amount_lc and balance_amount_lc on target invoice
            await client.query(`
                UPDATE ar_transaction SET
                    paid_amount_lc = paid_amount_lc + $1,
                    balance_amount_lc = balance_amount_lc - $1,
                    updated_at = NOW()
                WHERE id = $2
            `, [a.applied_amount_lc || 0, a.applied_to_id]);
        }

        // Post: create GL entry & VAT records
        let glEntryId = null;
        if (action === 'Post') {
            const headerWithDocNo = { ...header, doc_no: finalDocNo };
            glEntryId = await postGlEntry(client, newHeaderId, headerWithDocNo, details || [], finalDocNo);
            await insertVtRecords(client, newHeaderId, { ...header, doc_no: finalDocNo }, details || []);
            // Update GL entry reference
            await client.query(`UPDATE ar_transaction SET gl_entry_id=$1 WHERE id=$2`, [glEntryId, newHeaderId]);
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'Success', id: newHeaderId, doc_no: finalDocNo });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- 2. Update Transaction (Draft only) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, details, applies, action } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // Check status
        const checkRes = await client.query('SELECT status FROM ar_transaction WHERE id=$1', [id]);
        if (!checkRes.rows[0]) return res.status(404).json({ error: 'Not found' });
        if (checkRes.rows[0].status !== 'Draft') throw new Error('Only Draft can be edited');

        // Find period_id
        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`,
            [header.doc_date]
        );
        if (periodRes.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        const periodId = periodRes.rows[0].id;

        const status = action === 'Post' ? 'Posted' : 'Draft';

        await client.query(`
            UPDATE ar_transaction SET
            doc_date=$1, due_date=$2, period_id=$3,
            ar_account_id=$4, currency_id=$5, currency_code=$6, exchange_rate=$7,
            subtotal_fc=$8, discount_amount_fc=$9, before_vat_fc=$10, vat_amount_fc=$11, total_amount_fc=$12,
            subtotal_lc=$13, discount_amount_lc=$14, before_vat_lc=$15, vat_amount_lc=$16, total_amount_lc=$17,
            balance_amount_lc=$18,
            ref_no=$19, ref_doc_id=$20, ref_doc_no=$21, description=$22, status=$23,
            updated_by=$24, updated_at=NOW()
            WHERE id=$25
        `, [
            header.doc_date, header.due_date || null, periodId,
            header.ar_account_id || null, header.currency_id || null, header.currency_code || 'THB',
            header.exchange_rate || 1,
            header.subtotal_fc || 0, header.discount_amount_fc || 0,
            header.before_vat_fc || 0, header.vat_amount_fc || 0, header.total_amount_fc || 0,
            header.subtotal_lc || 0, header.discount_amount_lc || 0,
            header.before_vat_lc || 0, header.vat_amount_lc || 0, header.total_amount_lc || 0,
            header.total_amount_lc || 0,
            header.ref_no || null, header.ref_doc_id || null, header.ref_doc_no || null,
            header.description || null, status,
            header.updated_by || null, id
        ]);

        // Replace details
        await client.query('DELETE FROM ar_transaction_detail WHERE header_id=$1', [id]);
        const detailSql = `
            INSERT INTO ar_transaction_detail
            (header_id, line_no, item_code, item_name, description,
             quantity, unit_code, unit_price_fc, discount_percent, discount_amount_fc,
             subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
             revenue_account_id, subtotal_lc, vat_amount_lc, total_amount_lc)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        `;
        let lineNo = 1;
        for (const d of (details || [])) {
            await client.query(detailSql, [
                id, lineNo++,
                d.item_code || null, d.item_name || null, d.description || null,
                d.quantity || 1, d.unit_code || null,
                d.unit_price_fc || 0, d.discount_percent || 0, d.discount_amount_fc || 0,
                d.subtotal_fc || 0, d.vat_type || 'VAT7', d.vat_rate || 7,
                d.vat_amount_fc || 0, d.total_amount_fc || 0,
                d.revenue_account_id || null,
                d.subtotal_lc || 0, d.vat_amount_lc || 0, d.total_amount_lc || 0
            ]);
        }

        // Replace applies (for Receipt/CN)
        await client.query('DELETE FROM ar_transaction_apply WHERE transaction_id=$1', [id]);
        for (const a of (applies || [])) {
            await client.query(`
                INSERT INTO ar_transaction_apply
                (transaction_id, applied_to_id, applied_amount_lc, applied_amount_fc, applied_date, created_by)
                VALUES ($1,$2,$3,$4,$5,$6)
            `, [id, a.applied_to_id, a.applied_amount_lc || 0, a.applied_amount_fc || 0,
                header.doc_date, header.updated_by || null]);
        }

        // If Post: recalculate balances on applied invoices and create GL + VAT
        let glEntryId = null;
        if (action === 'Post') {
            // Recalculate paid_amount_lc for all applied invoices
            for (const a of (applies || [])) {
                await client.query(`
                    UPDATE ar_transaction t SET
                        paid_amount_lc = (
                            SELECT COALESCE(SUM(applied_amount_lc),0)
                            FROM ar_transaction_apply WHERE applied_to_id = t.id
                        ),
                        balance_amount_lc = total_amount_lc - (
                            SELECT COALESCE(SUM(applied_amount_lc),0)
                            FROM ar_transaction_apply WHERE applied_to_id = t.id
                        ),
                        updated_at = NOW()
                    WHERE id = $1
                `, [a.applied_to_id]);
            }

            const docNoRes = await client.query('SELECT doc_no FROM ar_transaction WHERE id=$1', [id]);
            const docNo = docNoRes.rows[0].doc_no;
            const headerWithDocNo = { ...header, doc_no: docNo };
            glEntryId = await postGlEntry(client, id, headerWithDocNo, details || [], docNo);
            await insertVtRecords(client, id, headerWithDocNo, details || []);
            await client.query(`UPDATE ar_transaction SET gl_entry_id=$1 WHERE id=$2`, [glEntryId, id]);
        }

        await client.query('COMMIT');
        res.json({ message: 'Updated', id: Number(id) });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- 3. Void Transaction (Posted only) ---
const voidTransaction = async (req, res) => {
    const { id } = req.params;
    const { void_reason, updated_by } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        const checkRes = await client.query('SELECT status, gl_entry_id FROM ar_transaction WHERE id=$1', [id]);
        if (!checkRes.rows[0]) return res.status(404).json({ error: 'Not found' });
        if (checkRes.rows[0].status !== 'Posted') throw new Error('Only Posted can be voided');

        await client.query(`
            UPDATE ar_transaction SET status='Void', description=COALESCE(description,'')||' [VOID: '||$1||']',
            updated_by=$2, updated_at=NOW() WHERE id=$3
        `, [void_reason || '', updated_by || null, id]);

        // Mark vt_transaction as voided
        await client.query(`UPDATE vt_transaction SET is_voided=TRUE WHERE source_header_id=$1 AND module_code='AR'`, [id]);

        // Mark GL entry as Deleted (soft)
        if (checkRes.rows[0].gl_entry_id) {
            await client.query(`UPDATE gl_entry_header SET status='Deleted' WHERE id=$1`, [checkRes.rows[0].gl_entry_id]);
        }

        // Reverse applied amounts on invoices
        const appliesRes = await client.query(`SELECT * FROM ar_transaction_apply WHERE transaction_id=$1`, [id]);
        for (const a of appliesRes.rows) {
            await client.query(`
                UPDATE ar_transaction t SET
                    paid_amount_lc = (
                        SELECT COALESCE(SUM(applied_amount_lc),0)
                        FROM ar_transaction_apply
                        WHERE applied_to_id = t.id AND transaction_id != $1
                    ),
                    balance_amount_lc = total_amount_lc - (
                        SELECT COALESCE(SUM(applied_amount_lc),0)
                        FROM ar_transaction_apply
                        WHERE applied_to_id = t.id AND transaction_id != $1
                    ),
                    updated_at = NOW()
                WHERE id = $2
            `, [id, a.applied_to_id]);
        }

        await client.query('COMMIT');
        res.json({ message: 'Voided' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- 4. Delete Draft ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            `UPDATE ar_transaction SET status='Deleted' WHERE id=$1 AND status='Draft' RETURNING id`, [id]
        );
        if (result.rowCount === 0) return res.status(400).json({ error: 'Cannot delete: Not Draft or not found' });
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 5. Fetch List ---
const fetchRows = async (req, res) => {
    const { search, status, doc_type, customer_id, date_from, date_to } = req.query;
    let sql = `
        SELECT t.id, t.doc_no, t.doc_date, t.due_date, t.status,
               t.customer_code, t.customer_name_th,
               t.total_amount_lc, t.paid_amount_lc, t.balance_amount_lc,
               t.currency_code, t.ref_no,
               d.doc_code, d.doc_name_thai, d.sys_doc_type
        FROM ar_transaction t
        JOIN sa_module_document d ON t.doc_id = d.id
        WHERE t.status != 'Deleted' AND d.sys_module = 11
    `;
    const params = [];

    if (doc_type) {
        sql += ` AND d.sys_doc_type = $${params.length + 1}`;
        params.push(doc_type);
    }
    if (customer_id) {
        sql += ` AND t.customer_id = $${params.length + 1}`;
        params.push(customer_id);
    }
    if (date_from) {
        sql += ` AND t.doc_date >= $${params.length + 1}`;
        params.push(date_from);
    }
    if (date_to) {
        sql += ` AND t.doc_date <= $${params.length + 1}`;
        params.push(date_to);
    }
    if (search) {
        sql += ` AND (t.doc_no ILIKE $${params.length + 1} OR t.customer_code ILIKE $${params.length + 1} OR t.customer_name_th ILIKE $${params.length + 1} OR COALESCE(t.ref_no,'') ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
    }
    if (status) {
        sql += ` AND t.status = $${params.length + 1}`;
        params.push(status);
    }

    sql += ` ORDER BY CASE WHEN t.status='Draft' THEN 0 ELSE 1 END, t.doc_date DESC, t.doc_no DESC LIMIT 200`;

    try {
        const result = await req.dbPool.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 6. Fetch Single Transaction ---
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        const hRes = await req.dbPool.query(`
            SELECT t.*, d.doc_code, d.doc_name_thai, d.sys_doc_type, d.is_auto_numbering
            FROM ar_transaction t
            JOIN sa_module_document d ON t.doc_id = d.id
            WHERE t.id = $1
        `, [id]);
        if (hRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

        const [detailsRes, appliesRes] = await Promise.all([
            req.dbPool.query(`SELECT * FROM ar_transaction_detail WHERE header_id=$1 ORDER BY line_no`, [id]),
            req.dbPool.query(`
                SELECT a.*, inv.doc_no AS applied_to_doc_no, inv.doc_date AS applied_to_doc_date,
                       inv.total_amount_lc AS applied_to_total
                FROM ar_transaction_apply a
                JOIN ar_transaction inv ON a.applied_to_id = inv.id
                WHERE a.transaction_id=$1 ORDER BY a.id
            `, [id]),
        ]);

        res.json({ header: hRes.rows[0], details: detailsRes.rows, applies: appliesRes.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 7. Fetch open invoices for a customer (for Receipt application) ---
const fetchOpenInvoices = async (req, res) => {
    const { customer_id } = req.query;
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
    try {
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.due_date,
                   t.total_amount_lc, t.paid_amount_lc, t.balance_amount_lc,
                   d.doc_name_thai, d.sys_doc_type
            FROM ar_transaction t
            JOIN sa_module_document d ON t.doc_id = d.id
            WHERE t.customer_id = $1
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0
              AND d.sys_doc_type IN (10, 30)
            ORDER BY t.doc_date ASC, t.doc_no ASC
        `, [customer_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    createTransaction,
    updateTransaction,
    voidTransaction,
    deleteTransaction,
    fetchRows,
    fetchRow,
    fetchOpenInvoices,
};
