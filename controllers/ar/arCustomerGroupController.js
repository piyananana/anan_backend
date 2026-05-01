// controllers/ar/arCustomerGroupController.js

const GROUP_SELECT = `
    SELECT g.*,
           a.account_code  AS gl_account_code,
           a.account_name_thai AS gl_account_name_thai
    FROM ar_customer_group g
    LEFT JOIN gl_account a ON a.id = g.gl_account_id
`;

const formatGroupCode = (g) => {
    let code = g.running_prefix || '';
    if (g.running_suffix_date) {
        const now = new Date();
        const year = now.getFullYear().toString();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        switch (g.running_suffix_date) {
            case 'YY':     code += year.substring(2); break;
            case 'YYYY':   code += year; break;
            case 'YYMM':   code += year.substring(2) + month; break;
            case 'YYYYMM': code += year + month; break;
            case 'YYMMDD': code += year.substring(2) + month + day; break;
        }
    }
    if (g.running_separator) code += g.running_separator;
    code += g.running_next_number.toString().padStart(g.running_length, '0');
    return code;
};

// Helper: fetch full group row (with conditions)
const fetchGroupById = async (pool, id) => {
    const [groupResult, billingConds, paymentConds] = await Promise.all([
        pool.query(GROUP_SELECT + ' WHERE g.id = $1', [id]),
        pool.query(`SELECT * FROM ar_customer_group_billing_condition  WHERE group_id=$1 ORDER BY sort_order, id`, [id]),
        pool.query(`SELECT * FROM ar_customer_group_payment_condition  WHERE group_id=$1 ORDER BY sort_order, id`, [id]),
    ]);
    if (groupResult.rows.length === 0) return null;
    return {
        ...groupResult.rows[0],
        billing_conditions:  billingConds.rows,
        payment_conditions:  paymentConds.rows,
    };
};

// Helper: insert billing/payment conditions for a group
const insertGroupConditions = async (client, gid, billingConditions, paymentConditions) => {
    for (const bc of (billingConditions || [])) {
        await client.query(
            `INSERT INTO ar_customer_group_billing_condition
               (group_id, sort_order, bill_with_delivery,
                billing_day_of_month, billing_day_of_week, billing_week_of_month,
                billing_time_from, billing_time_to, due_from_billing_date, remark)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [gid,
             bc.sort_order ?? 1,
             bc.bill_with_delivery ?? false,
             bc.billing_day_of_month?.length ? bc.billing_day_of_month : null,
             bc.billing_day_of_week?.length  ? bc.billing_day_of_week  : null,
             bc.billing_week_of_month?.length ? bc.billing_week_of_month : null,
             bc.billing_time_from || null,
             bc.billing_time_to   || null,
             bc.due_from_billing_date ?? false,
             bc.remark || null]
        );
    }
    for (const pc of (paymentConditions || [])) {
        await client.query(
            `INSERT INTO ar_customer_group_payment_condition
               (group_id, sort_order,
                payment_day_of_month, payment_day_of_week, payment_week_of_month,
                payment_time_from, payment_time_to,
                within_months_from_billing, additional_days, remark)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [gid,
             pc.sort_order ?? 1,
             pc.payment_day_of_month?.length ? pc.payment_day_of_month : null,
             pc.payment_day_of_week?.length  ? pc.payment_day_of_week  : null,
             pc.payment_week_of_month?.length ? pc.payment_week_of_month : null,
             pc.payment_time_from || null,
             pc.payment_time_to   || null,
             pc.within_months_from_billing ?? 0,
             pc.additional_days ?? 0,
             pc.remark || null]
        );
    }
};

// GET all rows
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            GROUP_SELECT + ' ORDER BY g.group_code ASC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching customer groups:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// GET active rows only
const fetchActiveRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            GROUP_SELECT + ' WHERE g.is_active = TRUE ORDER BY g.group_code ASC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching active customer groups:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// GET /ar_customer_group/:id
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        const data = await fetchGroupById(req.dbPool, id);
        if (!data) return res.status(404).json({ message: 'Not found.' });
        res.json(data);
    } catch (err) {
        console.error('Error fetching customer group:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// GET /ar_customer_group/:id/preview_code
const previewGroupCode = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            `SELECT * FROM ar_customer_group WHERE id = $1`, [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'ไม่พบกลุ่มลูกค้า' });
        }
        const g = result.rows[0];
        if (!g.is_auto_number) {
            return res.status(400).json({ error: 'กลุ่มนี้ไม่ได้เปิดใช้รหัสอัตโนมัติ' });
        }
        res.json({ customer_code: formatGroupCode(g) });
    } catch (err) {
        console.error('Error previewing group code:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// POST new row
const addRow = async (req, res) => {
    const {
        group_code,
        group_name_thai,
        group_name_eng,
        description,
        credit_term_months,
        credit_term_days,
        credit_limit,
        discount_percent,
        gl_account_id,
        is_auto_number,
        running_prefix,
        running_separator,
        running_suffix_date,
        running_length,
        running_next_number,
        is_active,
        requires_billing,
        billing_conditions,
        payment_conditions,
    } = req.body;
    const userId = req.headers.userid;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `INSERT INTO ar_customer_group
                (group_code, group_name_thai, group_name_eng, description,
                 credit_term_months, credit_term_days, credit_limit, discount_percent, gl_account_id,
                 is_auto_number, running_prefix, running_separator, running_suffix_date,
                 running_length, running_next_number,
                 is_active, requires_billing, created_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP, $18)
             RETURNING id`,
            [
                group_code, group_name_thai, group_name_eng, description,
                credit_term_months ?? 0, credit_term_days ?? 30,
                credit_limit ?? 0, discount_percent ?? 0,
                gl_account_id ?? null,
                is_auto_number ?? false,
                running_prefix ?? 'CUST',
                running_separator ?? '-',
                running_suffix_date ?? '',
                running_length ?? 4,
                running_next_number ?? 1,
                is_active ?? true,
                requires_billing ?? false,
                userId,
            ]
        );
        const gid = result.rows[0].id;
        await insertGroupConditions(client, gid, billing_conditions, payment_conditions);
        await client.query('COMMIT');
        const full = await fetchGroupById(req.dbPool, gid);
        res.status(201).json(full);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creating customer group:', err);
        if (err.code === '23505') {
            return res.status(409).json({ error: 'รหัสกลุ่มลูกค้านี้มีอยู่แล้ว' });
        }
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

// PUT update row
const updateRow = async (req, res) => {
    const { id } = req.params;
    const {
        group_code,
        group_name_thai,
        group_name_eng,
        description,
        credit_term_months,
        credit_term_days,
        credit_limit,
        discount_percent,
        gl_account_id,
        is_auto_number,
        running_prefix,
        running_separator,
        running_suffix_date,
        running_length,
        running_next_number,
        is_active,
        requires_billing,
        billing_conditions,
        payment_conditions,
    } = req.body;
    const userId = req.headers.userid;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE ar_customer_group SET
                group_code          = $1,
                group_name_thai     = $2,
                group_name_eng      = $3,
                description         = $4,
                credit_term_months  = $5,
                credit_term_days    = $6,
                credit_limit        = $7,
                discount_percent    = $8,
                gl_account_id       = $9,
                is_auto_number      = $10,
                running_prefix      = $11,
                running_separator   = $12,
                running_suffix_date = $13,
                running_length      = $14,
                running_next_number = $15,
                is_active           = $16,
                requires_billing    = $17,
                updated_at          = CURRENT_TIMESTAMP,
                updated_by          = $18
             WHERE id = $19
             RETURNING id`,
            [
                group_code, group_name_thai, group_name_eng, description,
                credit_term_months ?? 0, credit_term_days ?? 30,
                credit_limit ?? 0, discount_percent ?? 0,
                gl_account_id ?? null,
                is_auto_number ?? false,
                running_prefix ?? 'CUST',
                running_separator ?? '-',
                running_suffix_date ?? '',
                running_length ?? 4,
                running_next_number ?? 1,
                is_active,
                requires_billing ?? false,
                userId, id,
            ]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Not found.' });
        }
        await client.query(`DELETE FROM ar_customer_group_billing_condition  WHERE group_id=$1`, [id]);
        await client.query(`DELETE FROM ar_customer_group_payment_condition  WHERE group_id=$1`, [id]);
        await insertGroupConditions(client, id, billing_conditions, payment_conditions);
        await client.query('COMMIT');
        const full = await fetchGroupById(req.dbPool, id);
        res.status(200).json(full);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error updating customer group:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

// DELETE single row
const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        // ตรวจสอบว่ามีลูกค้าอ้างอิงกลุ่มนี้อยู่หรือไม่
        const checkResult = await client.query(
            'SELECT COUNT(*) FROM ar_customer WHERE customer_group_id = $1', [id]
        );
        if (parseInt(checkResult.rows[0].count) > 0) {
            return res.status(409).json({
                error: 'ไม่สามารถลบได้ เนื่องจากมีลูกค้าอ้างอิงกลุ่มนี้อยู่',
            });
        }

        await client.query('BEGIN');
        const result = await client.query(
            'DELETE FROM ar_customer_group WHERE id = $1 RETURNING *', [id]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Not found.' });
        }
        await client.query('COMMIT');
        res.status(204).send();
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting customer group:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

// DELETE all rows
const deleteRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM ar_customer_group');
        await client.query('COMMIT');
        res.status(204).send();
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting all customer groups:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

// ฟังก์ชัน export สำหรับใช้ใน arCustomerController (atomic increment ภายใน transaction)
const generateNextCodeForGroup = async (client, groupId) => {
    const result = await client.query(
        `SELECT * FROM ar_customer_group WHERE id = $1 FOR UPDATE`, [groupId]
    );
    if (result.rows.length === 0 || !result.rows[0].is_auto_number) return null;
    const g = result.rows[0];
    const code = formatGroupCode(g);
    await client.query(
        `UPDATE ar_customer_group SET running_next_number = running_next_number + 1 WHERE id = $1`,
        [groupId]
    );
    return code;
};

module.exports = {
    fetchRows,
    fetchActiveRows,
    fetchRow,
    previewGroupCode,
    addRow,
    updateRow,
    deleteRow,
    deleteRows,
    generateNextCodeForGroup,
};
