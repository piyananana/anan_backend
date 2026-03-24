// controllers/cd/cdBusinessTypeController.js

// GET all rows
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            'SELECT * FROM cd_business_type ORDER BY business_type_code ASC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching business types:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// GET active rows only
const fetchActiveRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            'SELECT * FROM cd_business_type WHERE is_active = TRUE ORDER BY business_type_code ASC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching active business types:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// POST new row
const addRow = async (req, res) => {
    const { business_type_code, business_type_name_thai, business_type_name_eng, description, is_active } = req.body;
    const userId = req.headers.userid;
    try {
        const result = await req.dbPool.query(
            `INSERT INTO cd_business_type
                (business_type_code, business_type_name_thai, business_type_name_eng, description, is_active, created_at, created_by)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)
             RETURNING *`,
            [business_type_code, business_type_name_thai, business_type_name_eng, description, is_active, userId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating business type:', err);
        if (err.code === '23505') {
            return res.status(409).json({ error: 'รหัสประเภทธุรกิจนี้มีอยู่แล้ว' });
        }
        res.status(500).json({ error: 'Internal server error' });
    }
};

// PUT update row
const updateRow = async (req, res) => {
    const { id } = req.params;
    const { business_type_code, business_type_name_thai, business_type_name_eng, description, is_active } = req.body;
    const userId = req.headers.userid;
    try {
        const result = await req.dbPool.query(
            `UPDATE cd_business_type SET
                business_type_code = $1,
                business_type_name_thai = $2,
                business_type_name_eng = $3,
                description = $4,
                is_active = $5,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = $6
             WHERE id = $7
             RETURNING *`,
            [business_type_code, business_type_name_thai, business_type_name_eng, description, is_active, userId, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Not found.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating business type:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// DELETE single row
const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            'DELETE FROM cd_business_type WHERE id = $1 RETURNING *', [id]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Not found.' });
        }
        await client.query('COMMIT');
        res.status(204).send();
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting business type:', err);
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
        await client.query('DELETE FROM cd_business_type');
        await client.query('COMMIT');
        res.status(204).send();
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting all business types:', err);
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
