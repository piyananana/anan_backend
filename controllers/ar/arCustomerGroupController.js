// controllers/ar/arCustomerGroupController.js

const GROUP_SELECT = `
    SELECT g.*,
           a.account_code  AS gl_account_code,
           a.account_name_thai AS gl_account_name_thai
    FROM ar_customer_group g
    LEFT JOIN gl_account a ON a.id = g.gl_account_id
`;

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

// POST new row
const addRow = async (req, res) => {
    const {
        group_code,
        group_name_thai,
        group_name_eng,
        description,
        credit_days,
        credit_limit,
        discount_percent,
        gl_account_id,
        is_active,
    } = req.body;
    const userId = req.headers.userid;
    try {
        const result = await req.dbPool.query(
            `INSERT INTO ar_customer_group
                (group_code, group_name_thai, group_name_eng, description,
                 credit_days, credit_limit, discount_percent, gl_account_id,
                 is_active, created_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, $10)
             RETURNING *`,
            [
                group_code, group_name_thai, group_name_eng, description,
                credit_days ?? 30, credit_limit ?? 0, discount_percent ?? 0,
                gl_account_id ?? null, is_active ?? true, userId,
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating customer group:', err);
        if (err.code === '23505') {
            return res.status(409).json({ error: 'รหัสกลุ่มลูกค้านี้มีอยู่แล้ว' });
        }
        res.status(500).json({ error: 'Internal server error' });
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
        credit_days,
        credit_limit,
        discount_percent,
        gl_account_id,
        is_active,
    } = req.body;
    const userId = req.headers.userid;
    try {
        const result = await req.dbPool.query(
            `UPDATE ar_customer_group SET
                group_code          = $1,
                group_name_thai     = $2,
                group_name_eng      = $3,
                description         = $4,
                credit_days         = $5,
                credit_limit        = $6,
                discount_percent    = $7,
                gl_account_id       = $8,
                is_active           = $9,
                updated_at          = CURRENT_TIMESTAMP,
                updated_by          = $10
             WHERE id = $11
             RETURNING *`,
            [
                group_code, group_name_thai, group_name_eng, description,
                credit_days, credit_limit, discount_percent,
                gl_account_id ?? null, is_active, userId, id,
            ]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Not found.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating customer group:', err);
        res.status(500).json({ error: 'Internal server error' });
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

module.exports = {
    fetchRows,
    fetchActiveRows,
    addRow,
    updateRow,
    deleteRow,
    deleteRows,
};
