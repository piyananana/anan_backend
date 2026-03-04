// controllers/cd/cdZipcodeController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้

const xlsx = require('xlsx'); // Import xlsx

// Helper function to handle locking
const lock = async (req, id, userId, userName) => {
    try {
        const result = await req.dbPool.query(
            `UPDATE cd_zipcode
             SET locked_by_user_id = $2, locked_by_user_name = $3
             WHERE id = $1 AND locked_by_user_id IS NULL
             RETURNING *;`,
            [id, userId, userName]
        );

        if (result.rows.length === 0) {
            const currentLock = await req.dbPool.query(
                `SELECT locked_by_user_id, locked_by_user_name FROM cd_zipcode WHERE id = $1;`,
                [id]
            );
            const lockedById = currentLock.rows[0]?.locked_by_user_id;
            const lockedByName = currentLock.rows[0]?.locked_by_user_name;
            return { success: false, message: `This zipcode is already locked by another user. User ID: ${lockedById}, User Name: ${lockedByName}` };
        }
        return { success: true };
    } catch (error) {
        throw new Error(`Error acquiring lock of this zipcode: ${error.message}`);
    }
};

// Helper function to handle unlocking
const unlock = async (req, id, userId) => {
    try {
        await req.dbPool.query(
            `UPDATE cd_zipcode
             SET locked_by_user_id = NULL, locked_by_user_name = NULL
             WHERE id = $1 AND locked_by_user_id = $2;`,
            [id, userId]
        );
    } catch (error) {
        throw new Error(`Error releasing lock of this zipcode: ${error.message}`);
    }
};

// GET all rows with lock info
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            'SELECT * FROM cd_zipcode ORDER BY province ASC, district ASC, sub_district ASC'
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching all zipcodes:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST new row
const addRow = async (req, res) => {
    const { sub_district, district, province, zipcode } = req.body;
    const userName = req.headers.username;

    try {
        const result = await req.dbPool.query(
            `INSERT INTO cd_zipcode (sub_district, district, province, zipcode, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $5)
             RETURNING *;`,
            [sub_district, district, province, zipcode, userName]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// PUT update row
const updateRow = async (req, res) => {
    const { id } = req.params;
    const { sub_district, district, province, zipcode } = req.body;
    const userId = req.headers.userid;
    const userName = req.headers.username;

    try {
        const lockResult = await lock(req, id, userId, userName);
        if (!lockResult.success) {
            return res.status(409).json({ message: lockResult.message });
        }

        const result = await req.dbPool.query(
            `UPDATE cd_zipcode
             SET sub_district = $1, district = $2, province = $3, zipcode = $4, updated_at = NOW(), updated_by = $7
             WHERE id = $5 AND locked_by_user_id = $6
             RETURNING *;`,
            [sub_district, district, province, zipcode, id, userId, userName]
        );

        await unlock(req, id, userId);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Not found or already unlocked.' });
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE row
const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect(); // ใช้ transaction เพื่อความปลอดภัย
    try {
        await client.query('BEGIN');

        const deleteResult = await client.query('DELETE FROM cd_zipcode WHERE id = $1 RETURNING *', [id]);

        if (deleteResult.rows.length === 0) {
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
    try {
        await req.dbPool.query('DELETE FROM cd_zipcode;');
        res.status(200).json({ message: 'All rows has been deleted.' });
    } catch (error) {
        console.error('Error deleting all:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST import from Excel
const importDataExcel = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No Excel file uploaded.' });
    }
    const userName = req.headers.username;
    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = xlsx.utils.sheet_to_json(worksheet);

        const client = await req.dbPool.connect();
        
        await client.query('BEGIN'); // เริ่ม transaction

        const importedZipcode = [];

        for (const row of jsonData) {
            try {
                const subDistrict = row.subDistrict;
                const district = row.district;
                const province = row.province;
                const zipcode = row.zipcode;
                // ตรวจสอบค่าที่จำเป็นก่อนการ INSERT
                if (!subDistrict || !district || !province || !zipcode) {
                    throw new Error('Missing required data: subDistrict, district, province, zipcode.');
                }

                // เพิ่มเมนู
                const insertResult = await client.query(
                    `INSERT INTO cd_zipcode (sub_district, district, province, zipcode, created_by, updated_by)
                     VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
                    [subDistrict, district, province, zipcode, userName]
                );
                const newZipcode = insertResult.rows[0];

                importedZipcode.push(newZipcode);

            } catch (innerErr) {
                // บันทึก error ของแต่ละแถวและโยน error เพื่อ rollback ทั้งหมด
                console.error(`Error processing row ${JSON.stringify(row)}: ${innerErr.message}`);
                throw new Error(`Error processing row (sub district: ${row.subDistrict || 'N/A'}): ${innerErr.message}`);
            }
        }

        await client.query('COMMIT'); // Commit transaction
        if (client) client.release();
        res.status(200).json({ message: 'Imported successfully.', importedCount: importedZipcode.length });

    } catch (err) {
        if (client) await client.query('ROLLBACK'); // Rollback ถ้ามี error
        console.error('Error importing:', err);
        res.status(500).json({ error: 'Failed to import.', details: err.message });
    } finally {
        if (req.file) {
            // ลบไฟล์ชั่วคราว
            const fs = require('fs');
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting uploaded file:', err);
            });
        }
        // if (client) client.release();
    }
    // res.status(501).json({ message: 'Not yet implemented' });
};

// GET export to Excel
const exportDataExcel = async (req, res) => {
    try {
        const result = await req.dbPool.query('SELECT * FROM cd_zipcode ORDER BY province ASC, zipcode ASC, district ASC, sub_district ASC');

        const zipcodes = result.rows;

        const dataForExcel = zipcodes.map(zip => {
            return {
                // id: zip.id,
                subDistrict: zip.sub_district,
                district: zip.district,
                province: zip.province,
                zipcode: zip.zipcode
            };
        });

        const worksheet = xlsx.utils.json_to_sheet(dataForExcel);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Zipcodes');

        // สร้าง Buffer จากไฟล์ Excel
        const excelBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });

        // ตั้งค่า Response Headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=zipcode_export.xlsx');
        res.send(excelBuffer);

    } catch (err) {
        console.error('Error exporting:', err);
        res.status(500).json({ error: 'Failed to export.', details: err.message });
    }
};

module.exports = {
    lock,
    unlock,
    fetchRows,
    addRow,
    updateRow,
    deleteRow,
    deleteRows,
    importDataExcel,
    exportDataExcel
};
