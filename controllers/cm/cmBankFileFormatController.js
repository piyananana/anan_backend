// controllers/cm/cmBankFileFormatController.js

// GET all formats (list, no columns JSON for performance)
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            `SELECT id, format_code, format_name, bank_code, file_extension,
                    delimiter, has_header, has_footer, is_active, updated_at
             FROM cm_bank_file_format
             ORDER BY format_code`
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching cm_bank_file_format:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET one by id (includes full columns JSON)
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            `SELECT * FROM cm_bank_file_format WHERE id = $1`, [id]
        );
        if (result.rows.length === 0)
            return res.status(404).json({ message: 'ไม่พบข้อมูลรูปแบบไฟล์' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching cm_bank_file_format row:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST create
const addRow = async (req, res) => {
    const {
        format_code, format_name, bank_code, file_extension,
        delimiter, has_header, has_footer, columns, is_active
    } = req.body;
    const userName = req.headers.username;
    try {
        const result = await req.dbPool.query(
            `INSERT INTO cm_bank_file_format
               (format_code, format_name, bank_code, file_extension,
                delimiter, has_header, has_footer, columns, is_active,
                created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
             RETURNING *`,
            [
                format_code, format_name, bank_code || null,
                file_extension || 'txt', delimiter || '',
                has_header ?? false, has_footer ?? false,
                JSON.stringify(columns || []),
                is_active ?? true, userName
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505')
            return res.status(409).json({ message: 'รหัสรูปแบบไฟล์นี้มีอยู่แล้ว' });
        console.error('Error adding cm_bank_file_format:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// PUT update
const updateRow = async (req, res) => {
    const { id } = req.params;
    const {
        format_code, format_name, bank_code, file_extension,
        delimiter, has_header, has_footer, columns, is_active
    } = req.body;
    const userName = req.headers.username;
    try {
        const result = await req.dbPool.query(
            `UPDATE cm_bank_file_format SET
               format_code    = $1, format_name    = $2,
               bank_code      = $3, file_extension = $4,
               delimiter      = $5, has_header     = $6,
               has_footer     = $7, columns        = $8,
               is_active      = $9, updated_by     = $10,
               updated_at     = NOW()
             WHERE id = $11
             RETURNING *`,
            [
                format_code, format_name, bank_code || null,
                file_extension || 'txt', delimiter || '',
                has_header ?? false, has_footer ?? false,
                JSON.stringify(columns || []),
                is_active ?? true, userName, id
            ]
        );
        if (result.rows.length === 0)
            return res.status(404).json({ message: 'ไม่พบข้อมูลรูปแบบไฟล์' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505')
            return res.status(409).json({ message: 'รหัสรูปแบบไฟล์นี้มีอยู่แล้ว' });
        console.error('Error updating cm_bank_file_format:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE
const deleteRow = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            'DELETE FROM cm_bank_file_format WHERE id = $1 RETURNING id', [id]
        );
        if (result.rows.length === 0)
            return res.status(404).json({ message: 'ไม่พบข้อมูลรูปแบบไฟล์' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting cm_bank_file_format:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = { fetchRows, fetchRow, addRow, updateRow, deleteRow };
