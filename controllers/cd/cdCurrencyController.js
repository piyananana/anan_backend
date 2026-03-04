// controllers/cd/cdCurrencyController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้

const xlsx = require('xlsx'); // Import xlsx

// Helper function to handle locking
const lock = async (req, id, userId, userName) => {
    try {
        const result = await req.dbPool.query(
            `UPDATE cd_currency
             SET locked_by_user_id = $2, locked_by_user_name = $3
             WHERE id = $1 AND locked_by_user_id IS NULL
             RETURNING *;`,
            [id, userId, userName]
        );

        if (result.rows.length === 0) {
            const currentLock = await req.dbPool.query(
                `SELECT locked_by_user_id, locked_by_user_name FROM cd_currency WHERE id = $1;`,
                [id]
            );
            const lockedById = currentLock.rows[0]?.locked_by_user_id;
            const lockedByName = currentLock.rows[0]?.locked_by_user_name;
            return { success: false, message: `This currency is already locked by another user. User ID: ${lockedById}, User Name: ${lockedByName}` };
        }
        return { success: true };
    } catch (error) {
        throw new Error(`Error acquiring lock: ${error.message}`);
    }
};

// Helper function to handle unlocking
const unlock = async (req, id, userId) => {
    try {
        await req.dbPool.query(
            `UPDATE cd_currency
             SET locked_by_user_id = NULL, locked_by_user_name = NULL
             WHERE id = $1 AND locked_by_user_id = $2;`,
            [id, userId]
        );
    } catch (error) {
        throw new Error(`Error releasing lock of this currency: ${error.message}`);
    }
};

// GET all rows with lock info
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            'SELECT * FROM cd_currency ORDER BY base_currency_flag DESC, currency_code ASC'
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching all currency:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const fetchActiveRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            'SELECT * FROM cd_currency WHERE is_active IS TRUE ORDER BY base_currency_flag DESC, currency_code ASC'
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching all active currency:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST new row
const addRow = async (req, res) => {
    const { currency_code, currency_name_th, currency_name_en, base_rate, 
        base_currency_flag, symbol, num_of_decimal } = req.body;
    const userName = req.headers.username;

    try {
        // Validation: ตรวจสอบว่ามีสกุลเงินหลัก (base_currency_flag = TRUE) ได้เพียงตัวเดียว
        if (base_currency_flag === true) {
            await req.dbPool.query('UPDATE cd_currency SET base_currency_flag = FALSE WHERE base_currency_flag IS TRUE');
        }

        const result = await req.dbPool.query(
            `INSERT INTO cd_currency (
                currency_code, currency_name_th, currency_name_en, base_rate, 
                base_currency_flag, symbol, num_of_decimal, created_by, updated_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
            [currency_code.toUpperCase(), currency_name_th, currency_name_en, base_rate, 
            base_currency_flag, symbol, num_of_decimal, userName]
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
    const { currency_code, currency_name_th, currency_name_en, base_rate, 
        base_currency_flag, symbol, num_of_decimal, is_active } = req.body;    
    const userId = req.headers.userid;
    const userName = req.headers.username;

    try {
        const lockResult = await lock(req, id, userId, userName);
        if (!lockResult.success) {
            return res.status(409).json({ message: lockResult.message });
        }
        // Validation: ตรวจสอบว่ามีสกุลเงินหลักได้เพียงตัวเดียว
        if (base_currency_flag === true) {
            await req.dbPool.query(
                'UPDATE cd_currency SET base_currency_flag = FALSE WHERE base_currency_flag IS TRUE AND id != $1', [id]);
        }
        const result = await req.dbPool.query(
            `UPDATE cd_currency SET 
                currency_code = $1, 
                currency_name_th = $2, 
                currency_name_en = $3, 
                base_rate = $4, 
                base_currency_flag = $5, 
                symbol = $6, 
                num_of_decimal = $7,
                is_active = $8,
                updated_by = $9,
                updated_at = NOW()
            WHERE id = $10
            RETURNING *`,
            [currency_code.toUpperCase(), currency_name_th, currency_name_en, base_rate, 
            base_currency_flag, symbol, num_of_decimal, is_active, userId, id]
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

        const deleteResult = await client.query('DELETE FROM cd_currency WHERE id = $1 RETURNING *', [id]);

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
        await req.dbPool.query('DELETE FROM cd_currency;');
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

        const importedData = [];

        for (const row of jsonData) {
            try {
                const currency_code = row.currency_code;
                const currency_name_th = row.currency_name_th;
                const currency_name_en = row.currency_name_en;
                const base_rate = row.base_rate;
                const base_currency_flag = row.base_currency_flag;
                const symbol = row.symbol;
                const num_of_decimal = row.num_of_decimal;
                const is_active = row.is_active;
                // ตรวจสอบค่าที่จำเป็นก่อนการ INSERT
                if (!currency_code || !currency_name_th || !currency_name_en || !base_rate || 
                    base_currency_flag === '' || num_of_decimal === '' || is_active === '') {
                    throw new Error('Missing required data: subDistrict, district, province, zipcode.');
                }

                // เพิ่มเมนู
                const insertResult = await client.query(
                    `INSERT INTO cd_currency (currency_code, currency_name_th, currency_name_en, base_rate, 
                        base_currency_flag, symbol, num_of_decimal, created_by, updated_by
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
                    [currency_code, currency_name_th, currency_name_en, base_rate, 
                        base_currency_flag, symbol, num_of_decimal, userName]
                );
                const newZipcode = insertResult.rows[0];

                importedData.push(newZipcode);

            } catch (innerErr) {
                // บันทึก error ของแต่ละแถวและโยน error เพื่อ rollback ทั้งหมด
                console.error(`Error processing row ${JSON.stringify(row)}: ${innerErr.message}`);
                throw new Error(`Error processing row (sub district: ${row.subDistrict || 'N/A'}): ${innerErr.message}`);
            }
        }

        await client.query('COMMIT'); // Commit transaction
        if (client) client.release();
        res.status(200).json({ message: 'Imported successfully.', importedCount: importedData.length });

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
        const result = await req.dbPool.query('SELECT * FROM cd_currency ORDER BY province ASC, zipcode ASC, district ASC, sub_district ASC');

        const exportRow = result.rows;

        const dataForExcel = exportRow.map(row => {
            return {
                // id: row.id,
                currency_code: row.currency_code,
                currency_name_th: row.currency_nme_th,
                currency_name_en: row.currency_name_en,
                base_rate: row.base_rate,
                base_currency_flag: row.base_currency_flag,
                symbol: row.symbol,
                num_of_decimal: row.num_of_decimal,
                is_active: row.is_active
            };
        });

        const worksheet = xlsx.utils.json_to_sheet(dataForExcel);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Currencys');

        // สร้าง Buffer จากไฟล์ Excel
        const excelBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });

        // ตั้งค่า Response Headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=currency_export.xlsx');
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
    fetchActiveRows,
    addRow,
    updateRow,
    deleteRow,
    deleteRows,
    importDataExcel,
    exportDataExcel
};
