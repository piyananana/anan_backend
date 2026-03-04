// controllers/gl/glAccountController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้

const xlsx = require('xlsx'); // Import xlsx

// Get Allowed Doc Types (Dropdown) ---
const getDocTypesByUserId = async (req, res) => {
    const { userId } = req.params; // รับ User ID
    try {
        // Join กับ sa_user_document เพื่อเช็คสิทธิ์
        const sql = `
            SELECT m.* FROM sa_module_document m
            JOIN sa_user_document u ON m.id = u.doc_id
            WHERE u.user_id = $1 AND m.is_doc_type = TRUE AND m.is_active = TRUE
            ORDER BY m.doc_code
        `;
        const result = await req.dbPool.query(sql, [userId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// // --- Helper: Format เลขที่รัน ---
// const formatRunningNumber = (number, length) => {
//     return String(number).padStart(length, '0');
// };

// // --- Helper: Format วันที่ตามที่ตั้งค่า ---
// const formatDateSuffix = (format) => {
//     const now = new Date();
//     const year = String(now.getFullYear());
//     const month = String(now.getMonth() + 1).padStart(2, '0');
//     const day = String(now.getDate()).padStart(2, '0');

//     if (format === 'YY') return year.substring(2);
//     if (format === 'YYYY') return year;
//     if (format === 'YYMM') return year.substring(2) + month;
//     if (format === 'YYYYMM') return year + month;
//     if (format === 'YYYYMMDD') return year + month + day;
//     return '';
// };

// /**
//  * ฟังก์ชันนี้ใช้สำหรับสร้างเลขที่เอกสารถัดไปและอัปเดตเลขที่รันในตาราง
//  */
// const getDocNumber = async (req, res) => {
//     const { docCode } = req.params;
//     const { updated_by } = req.body; // ต้องส่ง updated_by มาเพื่อบันทึกว่าใครใช้งาน

//     const client = await req.dbPool.connect();
    
//     try {
//         await client.query('BEGIN'); // เริ่ม Transaction เพื่อล็อคแถว (Prevent Concurrent Access)

//         // 1. SELECT FOR UPDATE: ล็อคแถวเพื่อป้องกันการรันเลขที่ซ้ำซ้อน
//         const selectSql = `
//             SELECT * FROM sa_module_document 
//             WHERE doc_code = $1 AND is_auto_numbering = TRUE
//             FOR UPDATE`;
        
//         const docTypeResult = await client.query(selectSql, [docCode]);

//         if (docTypeResult.rows.length === 0) {
//             await client.query('ROLLBACK');
//             return res.status(400).json({ message: `Auto numbering is disabled or Doc Code ${docCode} not found.` });
//         }

//         const docType = docTypeResult.rows[0];
//         const nextNumber = docType.next_running_number;
        
//         // 2. สร้างเลขที่เอกสารใหม่
//         const formattedNumber = formatRunningNumber(nextNumber, docType.running_length);
//         const dateSuffix = formatDateSuffix(docType.format_suffix_date);
        
//         const docNumber = [
//             docType.format_prefix,
//             dateSuffix,
//             formattedNumber
//         ].filter(Boolean).join(docType.format_separator || ''); // รวมส่วนประกอบด้วยตัวคั่น

//         // 3. อัปเดตเลขที่รันถัดไปในตาราง
//         const updateSql = `
//             UPDATE sa_module_document 
//             SET next_running_number = next_running_number + 1,
//                 updated_at = NOW(),
//                 updated_by = $2
//             WHERE id = $1`;
            
//         await client.query(updateSql, [docType.id, updated_by || 1]);
        
//         await client.query('COMMIT'); // Commit Transaction

//         // 4. ส่งเลขที่เอกสารที่สร้างขึ้นใหม่กลับไป
//         res.status(200).json({ doc_number: docNumber });

//     } catch (error) {
//         await client.query('ROLLBACK');
//         console.error('Error generating document number:', error);
//         res.status(500).json({ message: 'Error generating document number.' });
//     } finally {
//         client.release();
//     }
// };

// Helper function to handle locking
// GET all rows with lock info
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query('SELECT * FROM sa_module_document WHERE is_active = TRUE ORDER BY parent_id ASC, doc_code ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching all module documents:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const fetchRowsByUserId = async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await req.dbPool.query(
            'SELECT m.* FROM sa_module_document m INNER JOIN sa_user_document u ON m.id = u.doc_id WHERE u.user_id = $1 AND m.is_active = TRUE AND m.is_doc_type = TRUE ORDER BY m.parent_id ASC, m.sort_order ASC',
            [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching User document:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const fetchRowsByModuleUserId = async (req, res) => {
    const { docCode, userId } = req.params;
    try {
        const result = await req.dbPool.query(
            `SELECT md.* 
                FROM sa_module_document md
                LEFT OUTER JOIN sa_module_document m
                ON md.parent_id = m.id
                INNER JOIN sa_user_document u
                ON md.id = u.doc_id
                WHERE m.doc_code = $1 AND u.user_id = $2 AND md.is_active = TRUE
                ORDER BY md.parent_id ASC, md.sort_order ASC`,
            [docCode, userId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching User document:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// POST new row
const addRow = async (req, res) => {
    const { doc_code, doc_name_thai, doc_name_eng, parent_id, sort_order, is_doc_type, is_auto_numbering, 
        format_prefix, format_separator, format_suffix_date, next_running_number, running_length, is_active,
        sys_module, sys_doc_type} = req.body;
    const userId = req.headers.userid;
    // const userName = req.headers.username;
    try {
        const result = await req.dbPool.query(
            `INSERT INTO sa_module_document (doc_code, doc_name_thai, doc_name_eng, parent_id, sort_order, is_doc_type,
             is_auto_numbering, format_prefix, format_separator, format_suffix_date, next_running_number, running_length,
             is_active, created_at, created_by, sys_module, sys_doc_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, $14, $15, $16) RETURNING *`,
            [doc_code, doc_name_thai, doc_name_eng, parent_id, sort_order, is_doc_type, is_auto_numbering, 
            format_prefix, format_separator, format_suffix_date, next_running_number, running_length, is_active, 
            userId, sys_module, sys_doc_type]
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
    const { doc_code, doc_name_thai, doc_name_eng, parent_id, sort_order, is_doc_type, is_auto_numbering, 
        format_prefix, format_separator, format_suffix_date, next_running_number, running_length, is_active,
        sys_module, sys_doc_type} = req.body;
    const userId = req.headers.userid;
    // const userName = req.headers.username;

    const client = await req.dbPool.connect();
    
    try {
        await client.query('BEGIN'); 

        // const selectSql = `
        //     SELECT * FROM sa_module_document 
        //     WHERE id = $1 
        //     FOR UPDATE`;
        
        const docTypeResult = await client.query(
            `SELECT * FROM sa_module_document 
            WHERE id = $1 
            FOR UPDATE`, 
            [id]
        );

        if (docTypeResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Doc.Code ${doc_code} not found.` });
        }

        const result = await client.query(
            `UPDATE sa_module_document SET
                doc_code = $1,
                doc_name_thai = $2,
                doc_name_eng = $3,
                parent_id = $4,
                sort_order = $5,
                is_doc_type = $6,
                is_auto_numbering = $7,
                format_prefix = $8,
                format_separator = $9,
                format_suffix_date = $10,
                next_running_number = $11,
                running_length = $12,
                is_active = $13,
                sys_module = $14,
                sys_doc_type = $15,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = $16
             WHERE id = $17 RETURNING *`,
            [doc_code, doc_name_thai, doc_name_eng, parent_id, sort_order, is_doc_type,
                is_auto_numbering, format_prefix, format_separator, format_suffix_date, next_running_number, running_length,
                is_active, sys_module, sys_doc_type, userId, id]
        );

        await client.query('COMMIT'); // Commit Transaction

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
        const result = await client.query('DELETE FROM sa_module_document WHERE id = $1 RETURNING *', [id]);

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
        await client.query('DELETE FROM sa_module_document');
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
        const result = await req.dbPool.query('SELECT * FROM sa_module_document ORDER BY parent_id ASC, doc_code ASC');

        const dataRows = result.rows;

        const dataForExcel = dataRows.map(row => {
            return {
                id: row.id,
                parentId: row.parent_id,
                docCode: row.doc_code,
                docNameThai: row.doc_name_thai,
                docNameEng: row.doc_name_eng,
                sortOrder: row.sort_order,
                isAutoNumbering: row.is_auto_numbering,
                formatPrefix: row.format_prefix,
                formatSeparator: row.format_separator,
                formatSuffixDate: row.format_suffix_date,
                nextRunningNumber: row.next_running_number,
                runningLength: row.running_length,
                isActive: row.is_active,
                sys_module: row.sys_module,
                sys_doc_type: row.sys_doc_type
            };
        });

        const worksheet = xlsx.utils.json_to_sheet(dataForExcel);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'COA');

        // สร้าง Buffer จากไฟล์ Excel
        const excelBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });

        // ตั้งค่า Response Headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=module_document_export.xlsx');
        res.send(excelBuffer);

    } catch (err) {
        console.error('Error exporting:', err);
        res.status(500).json({ error: 'Failed to export.', details: err.message });
    }
};

module.exports = {
    getDocTypesByUserId,
    // getDocNumber,
    fetchRows,
    fetchRowsByUserId,
    fetchRowsByModuleUserId,
    addRow,
    updateRow,
    deleteRow,
    deleteRows,
    importDataExcel,
    exportDataExcel,
};