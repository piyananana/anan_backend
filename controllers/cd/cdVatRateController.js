// controllers/cd/cdVatRateController.js

// GET all rows
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            `SELECT * FROM cd_vat_rate ORDER BY vat_code ASC, effective_date DESC`
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching vat rates:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET effective rate by vat_code and date
// GET /cd_vat_rate/effective?vat_code=VAT&date=2026-03-12
const fetchEffectiveRate = async (req, res) => {
    const { vat_code, date } = req.query;
    if (!vat_code || !date) {
        return res.status(400).json({ message: 'vat_code and date are required.' });
    }
    try {
        const result = await req.dbPool.query(
            `SELECT * FROM cd_vat_rate
             WHERE vat_code = $1
               AND effective_date <= $2::date
               AND (end_date IS NULL OR end_date >= $2::date)
               AND is_active = TRUE
             ORDER BY effective_date DESC
             LIMIT 1`,
            [vat_code, date]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: `ไม่พบอัตราภาษี ${vat_code} ณ วันที่ ${date}` });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching effective vat rate:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET all distinct vat_code + name for dropdown
const fetchVatCodes = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            `SELECT DISTINCT ON (vat_code) vat_code, vat_name_th, vat_name_en
             FROM cd_vat_rate
             ORDER BY vat_code ASC`
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching vat codes:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST new row
const addRow = async (req, res) => {
    const { vat_code, vat_name_th, vat_name_en, rate, effective_date, end_date, is_active, remark } = req.body;
    const userName = req.headers.username;
    try {
        const result = await req.dbPool.query(
            `INSERT INTO cd_vat_rate
                (vat_code, vat_name_th, vat_name_en, rate, effective_date, end_date, is_active, remark, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
             RETURNING *`,
            [
                vat_code.toUpperCase(),
                vat_name_th,
                vat_name_en || null,
                rate,
                effective_date,
                end_date || null,
                is_active !== undefined ? is_active : true,
                remark || null,
                userName,
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating vat rate:', error);
        if (error.code === '23505') {
            return res.status(409).json({ message: `รหัส ${vat_code} มีอัตราภาษีสำหรับวันที่ ${effective_date} อยู่แล้ว` });
        }
        res.status(500).json({ message: 'Internal server error' });
    }
};

// PUT update row
const updateRow = async (req, res) => {
    const { id } = req.params;
    const { vat_code, vat_name_th, vat_name_en, rate, effective_date, end_date, is_active, remark } = req.body;
    const userName = req.headers.username;
    try {
        const result = await req.dbPool.query(
            `UPDATE cd_vat_rate SET
                vat_code = $1,
                vat_name_th = $2,
                vat_name_en = $3,
                rate = $4,
                effective_date = $5,
                end_date = $6,
                is_active = $7,
                remark = $8,
                updated_by = $9,
                updated_at = NOW()
             WHERE id = $10
             RETURNING *`,
            [
                vat_code.toUpperCase(),
                vat_name_th,
                vat_name_en || null,
                rate,
                effective_date,
                end_date || null,
                is_active,
                remark || null,
                userName,
                id,
            ]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating vat rate:', error);
        if (error.code === '23505') {
            return res.status(409).json({ message: `รหัส ${vat_code} มีอัตราภาษีสำหรับวันที่ ${effective_date} อยู่แล้ว` });
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
        const result = await client.query('DELETE FROM cd_vat_rate WHERE id = $1 RETURNING *', [id]);
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Not found.' });
        }
        await client.query('COMMIT');
        res.status(204).send();
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting vat rate:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

module.exports = {
    fetchRows,
    fetchEffectiveRate,
    fetchVatCodes,
    addRow,
    updateRow,
    deleteRow,
};
