// controllers/cd/cdWhtTypeController.js

const SELECT_WITH_ACCOUNT = `
    SELECT w.*,
           a.account_code    AS gl_account_code,
           a.account_name_thai AS gl_account_name
    FROM   cd_wht_type w
    LEFT JOIN gl_account a ON a.id = w.gl_account_id
`;

// GET all rows
const fetchRows = async (req, res) => {
    try {
        await req.dbPool.query(
            `ALTER TABLE cd_wht_type ADD COLUMN IF NOT EXISTS wht_name_en VARCHAR(200)`
        ).catch(() => {});
        const result = await req.dbPool.query(
            SELECT_WITH_ACCOUNT + ` ORDER BY w.wht_code ASC`
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching wht types:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET active rows (for pickers)
const fetchActiveRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            SELECT_WITH_ACCOUNT + ` WHERE w.is_active = true ORDER BY w.wht_code ASC`
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching active wht types:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET one row
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            SELECT_WITH_ACCOUNT + ` WHERE w.id = $1`, [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching wht type:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST new row
const addRow = async (req, res) => {
    const { wht_code, wht_name, wht_name_en, income_type, wht_rate, gl_account_id, description, is_active, effective_date, end_date } = req.body;
    const userName = req.headers.username;
    try {
        await req.dbPool.query(
            `ALTER TABLE cd_wht_type ADD COLUMN IF NOT EXISTS wht_name_en VARCHAR(200)`
        ).catch(() => {});
        const result = await req.dbPool.query(
            `INSERT INTO cd_wht_type
                (wht_code, wht_name, wht_name_en, income_type, wht_rate, gl_account_id, description, is_active, effective_date, end_date, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
             RETURNING id`,
            [
                wht_code?.toUpperCase()?.trim(),
                wht_name?.trim(),
                wht_name_en?.trim() || null,
                income_type || null,
                wht_rate || 0,
                gl_account_id || null,
                description || null,
                is_active !== undefined ? is_active : true,
                effective_date || null,
                end_date || null,
                userName,
            ]
        );
        const row = await req.dbPool.query(SELECT_WITH_ACCOUNT + ` WHERE w.id = $1`, [result.rows[0].id]);
        res.status(201).json(row.rows[0]);
    } catch (error) {
        console.error('Error creating wht type:', error);
        if (error.code === '23505') {
            return res.status(409).json({ message: `รหัส ${wht_code} มีอยู่แล้ว` });
        }
        res.status(500).json({ message: 'Internal server error' });
    }
};

// PUT update row
const updateRow = async (req, res) => {
    const { id } = req.params;
    const { wht_code, wht_name, wht_name_en, income_type, wht_rate, gl_account_id, description, is_active, effective_date, end_date } = req.body;
    const userName = req.headers.username;
    try {
        await req.dbPool.query(
            `ALTER TABLE cd_wht_type ADD COLUMN IF NOT EXISTS wht_name_en VARCHAR(200)`
        ).catch(() => {});
        const result = await req.dbPool.query(
            `UPDATE cd_wht_type SET
                wht_code       = $1,
                wht_name       = $2,
                wht_name_en    = $3,
                income_type    = $4,
                wht_rate       = $5,
                gl_account_id  = $6,
                description    = $7,
                is_active      = $8,
                effective_date = $9,
                end_date       = $10,
                updated_by     = $11,
                updated_at     = NOW()
             WHERE id = $12
             RETURNING id`,
            [
                wht_code?.toUpperCase()?.trim(),
                wht_name?.trim(),
                wht_name_en?.trim() || null,
                income_type || null,
                wht_rate || 0,
                gl_account_id || null,
                description || null,
                is_active,
                effective_date || null,
                end_date || null,
                userName,
                id,
            ]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Not found.' });
        const row = await req.dbPool.query(SELECT_WITH_ACCOUNT + ` WHERE w.id = $1`, [id]);
        res.status(200).json(row.rows[0]);
    } catch (error) {
        console.error('Error updating wht type:', error);
        if (error.code === '23505') {
            return res.status(409).json({ message: `รหัส ${wht_code} มีอยู่แล้ว` });
        }
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE row
const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        // ตรวจสอบว่ามีการใช้งานใน ar_transaction_wht หรือไม่
        const inUse = await client.query(
            `SELECT 1 FROM ar_transaction_wht WHERE wht_type_id = $1 LIMIT 1`, [id]
        );
        if (inUse.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีการใช้งานในเอกสาร AR' });
        }
        const result = await client.query('DELETE FROM cd_wht_type WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Not found.' });
        }
        await client.query('COMMIT');
        res.status(204).send();
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting wht type:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

module.exports = { fetchRows, fetchActiveRows, fetchRow, addRow, updateRow, deleteRow };
