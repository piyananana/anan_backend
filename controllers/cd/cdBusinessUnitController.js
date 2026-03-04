// controllers/gl/glAccountController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้

const xlsx = require('xlsx'); // Import xlsx

// Helper function to handle locking
const lock = async (req, id, userId, userName) => {
    try {
        const result = await req.dbPool.query(
            `UPDATE cd_business_unit
             SET locked_by_user_id = $2, locked_by_user_name = $3
             WHERE id = $1 AND locked_by_user_id IS NULL
             RETURNING *;`,
            [id, userId, userName]
        );

        if (result.rows.length === 0) {
            const currentLock = await req.dbPool.query(
                `SELECT locked_by_user_id, locked_by_user_name FROM cd_business_unit WHERE id = $1;`,
                [id]
            );
            const lockedById = currentLock.rows[0]?.locked_by_user_id;
            const lockedByName = currentLock.rows[0]?.locked_by_user_name;
            return { success: false, message: `This bu is already locked by another user. User ID: ${lockedById}, User Name: ${lockedByName}` };
        }
        return { success: true };
    } catch (error) {
        throw new Error(`Error acquiring lock of this bu: ${error.message}`);
    }
};

// Helper function to handle unlocking
const unlock = async (req, id, userId) => {
    try {
        await req.dbPool.query(
            `UPDATE cd_business_unit
             SET locked_by_user_id = NULL, locked_by_user_name = NULL
             WHERE id = $1 AND locked_by_user_id = $2;`,
            [id, userId]
        );
    } catch (error) {
        throw new Error(`Error releasing lock of this bu: ${error.message}`);
    }
};

// GET all rows with lock info
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query('SELECT * FROM cd_business_unit WHERE is_active = TRUE ORDER BY parent_id ASC, bu_code ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching all bu:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// POST new row
const addRow = async (req, res) => {
    const { bu_code, bu_name_thai, bu_name_eng, parent_id, is_control_bu, is_active } = req.body;
    const userName = req.headers.username;
    try {
        const result = await req.dbPool.query(
            `INSERT INTO cd_business_unit (bu_code, bu_name_thai, bu_name_eng, parent_id, is_control_bu, is_active, created_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7) RETURNING *`,
            [bu_code, bu_name_thai, bu_name_eng, parent_id, is_control_bu, is_active, userName]
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
    const { bu_code, bu_name_thai, bu_name_eng, parent_id, is_control_bu, is_active } = req.body;
    const userId = req.headers.userid;
    const userName = req.headers.username;

    try {
        const lockResult = await lock(req, id, userId, userName);
        if (!lockResult.success) {
            return res.status(409).json({ message: lockResult.message });
        }

        const result = await req.dbPool.query(
            `UPDATE cd_business_unit SET
                bu_code = $1,
                bu_name_thai = $2,
                bu_name_eng = $3,
                parent_id = $4,
                is_control_bu = $5,
                is_active = $6,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = $7
             WHERE id = $8 RETURNING *`,
            [bu_code, bu_name_thai, bu_name_eng, parent_id, is_control_bu, is_active, userName, id]
        );

        await unlock(req, id, userId);

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
        const result = await client.query('DELETE FROM cd_business_unit WHERE id = $1 RETURNING *', [id]);

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
        await client.query('DELETE FROM cd_business_unit');
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

// POST import from Excel
const importDataExcel = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No Excel file uploaded.' });
    }

//     try {
//         const workbook = xlsx.readFile(req.file.path);
//         const sheetName = workbook.SheetNames[0];
//         const worksheet = workbook.Sheets[sheetName];
//         const jsonData = xlsx.utils.sheet_to_json(worksheet);

//         const client = await req.dbPool.connect();
        
//         await client.query('BEGIN'); // เริ่ม transaction

//         const importedMenu = [];

//         for (const row of jsonData) {
//             try {
//                 // --- ปรับปรุงการแปลงค่าจาก Excel ที่นี่ ---

//                 // parentId: ควรจะเป็น null ถ้าว่างเปล่า หรือเป็นตัวเลข
//                 // ตรวจสอบให้แน่ใจว่าค่าที่ได้จาก Excel ไม่ใช่ String "NULL" แต่เป็นค่าที่ว่างเปล่า (undefined, null, "")
//                 let parentId = null;
//                 if (row.parentId !== undefined && row.parentId !== null && String(row.parentId).trim() !== '' && String(row.parentId).trim().toLowerCase() !== 'null') {
//                     parentId = parseInt(row.parentId, 10);
//                     if (isNaN(parentId)) {
//                         throw new Error(`Invalid parentId: "${row.parentId}". Must be a number or blank.`);
//                     }
//                 }

//                 const menuName = row.menuName;
//                 const menuType = row.menuType;
//                 const targetPath = (row.targetPath === undefined || String(row.targetPath).trim() === '' || String(row.targetPath).trim().toLowerCase() === 'null') ? null : String(row.targetPath);

//                 // sortOrder: ต้องเป็นตัวเลข และต้องมีค่า
//                 let sortOrder = parseInt(row.sortOrder, 10);
//                 if (isNaN(sortOrder)) {
//                     throw new Error(`Invalid sortOrder: "${row.sortOrder}". Must be a number.`);
//                 }

//                 // isActive: แปลง 'TRUE'/'FALSE' (ไม่สนใจ case) เป็น boolean
//                 const isActive = String(row.isActive).toLowerCase() === 'true';

//                 // contentType: ควรเป็น null ถ้าว่างเปล่า
//                 const contentType = (row.contentType === undefined || String(row.contentType).trim() === '' || String(row.contentType).trim().toLowerCase() === 'null') ? null : String(row.contentType);

//                 // contentData: ควรเป็น null ถ้าว่างเปล่า
//                 const contentData = (row.contentData === undefined || String(row.contentData).trim() === '' || String(row.contentData).trim().toLowerCase() === 'null') ? null : String(row.contentData);


//                 // ตรวจสอบค่าที่จำเป็นก่อนการ INSERT
//                 if (!menuName || !menuType || isNaN(sortOrder)) { // isNaN(sortOrder) ควรจะถูกดักไปตั้งแต่ด้านบนแล้ว
//                     throw new Error('Missing required data: menuName, menuType, or sortOrder.');
//                 }

//                 // เพิ่มเมนู
//                 const menuInsertResult = await client.query(
//                     `INSERT INTO sa_menu (parent_id, menu_name, menu_type, target_path, sort_order, is_active)
//                      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
//                     [parentId, menuName, menuType, targetPath, sortOrder, isActive]
//                 );
//                 const newMenu = menuInsertResult.rows[0];

//                 // เพิ่ม content ถ้ามี
//                 if (contentType && contentData) {
//                     await client.query(
//                         `INSERT INTO sa_menu_content (menu_id, content_type, content_data)
//                          VALUES ($1, $2, $3)`,
//                         [newMenu.id, contentType, contentData]
//                     );
//                 }
//                 importedMenu.push(newMenu);

//             } catch (innerErr) {
//                 // บันทึก error ของแต่ละแถวและโยน error เพื่อ rollback ทั้งหมด
//                 console.error(`Error processing row ${JSON.stringify(row)}: ${innerErr.message}`);
//                 throw new Error(`Error processing row (Menu Name: ${row.menuName || 'N/A'}): ${innerErr.message}`);
//             }
//         }

//         await client.query('COMMIT'); // Commit transaction
//         res.status(200).json({ message: 'Menu imported successfully.', importedCount: importedMenu.length });

//     } catch (err) {
//         if (client) await client.query('ROLLBACK'); // Rollback ถ้ามี error
//         console.error('Error importing sa_menu:', err);
//         res.status(500).json({ error: 'Failed to import sa_menu.', details: err.message });
//     } finally {
//         if (req.file) {
//             // ลบไฟล์ชั่วคราว
//             const fs = require('fs');
//             fs.unlink(req.file.path, (err) => {
//                 if (err) console.error('Error deleting uploaded file:', err);
//             });
//         }
//         if (client) client.release();
//     }
};

// GET export to Excel
const exportDataExcel = async (req, res) => {
    try {
        // ดึงข้อมูลทั้งหมด
        const result = await req.dbPool.query('SELECT * FROM cd_business_unit ORDER BY bu_code ASC');

        const dataRows = result.rows;

        const dataForExcel = dataRows.map(row => {
            return {
                id: row.id,
                buCode: row.bu_code,
                buNameThai: row.bu_name_thai,
                buNameEng: row.bu_name_eng,
                parentId: row.parent_id,
                isControlBU: row.is_control_bu,
                isActive: menu.is_active,
            };
        });

        const worksheet = xlsx.utils.json_to_sheet(dataForExcel);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'BU');

        // สร้าง Buffer จากไฟล์ Excel
        const excelBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });

        // ตั้งค่า Response Headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=bu_export.xlsx');
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
    exportDataExcel,
};