// controllers/cd/cdProjectController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้

const xlsx = require('xlsx'); // Import xlsx

// GET all rows with lock info
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query('SELECT * FROM cd_project WHERE is_active = TRUE ORDER BY project_code ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching all project:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// POST new row
const addRow = async (req, res) => {
    const { project_code, project_name_thai, project_name_eng, is_active, start_date, end_date } = req.body;
    const userId = req.headers.userid;
    try {
        const result = await req.dbPool.query(
            `INSERT INTO cd_project (project_code, project_name_thai, project_name_eng, is_active, start_date, end_date, created_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7) RETURNING *`,
            [project_code, project_name_thai, project_name_eng, is_active, start_date, end_date, userId]
        );
        const newRow = result.rows[0];

        res.status(201).json(newRow);
    } catch (err) {
        console.error('Error creating:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// PUT update row
const updateRow = async (req, res) => {
    const { id } = req.params;
    const { project_code, project_name_thai, project_name_eng, is_active, start_date, end_date } = req.body;
    const userId = req.headers.userid;

    try {
        const result = await req.dbPool.query(
            `UPDATE cd_project SET
                project_code = $1,
                project_name_thai = $2,
                project_name_eng = $3,
                is_active = $4,
                start_date = $5,
                end_date = $6,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = $7
             WHERE id = $8 RETURNING *`,
            [project_code, project_name_thai, project_name_eng, is_active, start_date, end_date, userId, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Not found.' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// DELETE row
const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect(); // ใช้ transaction เพื่อความปลอดภัย
    try {
        await client.query('BEGIN');
        const result = await client.query('DELETE FROM cd_project WHERE id = $1 RETURNING *', [id]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Not found.' });
        }

        await client.query('COMMIT');
        res.status(204).send(); // No Content
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting:', err);
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
        await client.query('DELETE FROM cd_project');
        await client.query('COMMIT');
        res.status(204).send();
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting all:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

// GET export to Excel
const exportDataExcel = async (req, res) => {
    try {
        // ดึงข้อมูลทั้งหมด
        const result = await req.dbPool.query('SELECT * FROM cd_project ORDER BY project_code ASC');

        const dataRows = result.rows;

        const dataForExcel = dataRows.map(row => {
            return {
                id: row.id,
                projectCode: row.project_code,
                projectNameThai: row.project_name_thai,
                projectNameEng: row.project_name_eng,
                isActive: row.is_active,
                startDate: row.startDate,
                endDate: row.endDate
            };
        });

        const worksheet = xlsx.utils.json_to_sheet(dataForExcel);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'project');

        // สร้าง Buffer จากไฟล์ Excel
        const excelBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });

        // ตั้งค่า Response Headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=project_export.xlsx');
        res.send(excelBuffer);

    } catch (err) {
        console.error('Error exporting:', err);
        res.status(500).json({ error: 'Failed to export.', details: err.message });
    }
};

module.exports = {
    fetchRows,
    addRow,
    updateRow,
    deleteRow,
    deleteRows,
    exportDataExcel,
};