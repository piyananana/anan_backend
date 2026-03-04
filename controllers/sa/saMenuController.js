// controllers/sa/saMenuController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้

const xlsx = require('xlsx'); // Import xlsx

// API เพื่อดึงรายการเมนูทั้งหมด (สำหรับสร้าง Tree View)
// ไม่ต้องใช้ verifyToken เพราะเป็น public view
const getAllMenu = async (req, res) => {
    try {
        const result = await req.dbPool.query('SELECT * FROM sa_menu WHERE is_active = TRUE ORDER BY parent_id ASC, sort_order ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching sa_menu:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// API เพื่อดึงรายการเมนูเฉพาะผู้ใช้ (สำหรับสร้าง Tree View)
// ไม่ต้องใช้ verifyToken เพราะเป็น public view
const getMenuByUserId = async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await req.dbPool.query(
            'SELECT m.* FROM sa_menu m INNER JOIN sa_user_menu um ON m.id = um.menu_id WHERE um.user_id = $1 AND m.is_active = TRUE ORDER BY m.parent_id ASC, m.sort_order ASC',
            [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching User menus:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// API เพื่อดึงรายการเมนูเฉพาะกลุ่ม (สำหรับสร้าง Tree View)
const getMenuByGroupId = async (req, res) => {
    const groupId = req.params.groupId;
    try {
        // ดึงข้อมูลเมนูของกลุ่มจากฐานข้อมูล
        const result = await req.dbPool.query(
            // 'SELECT m.menu_name, m.menu_type, m.target_path, m.sort_order FROM sa_menu m INNER JOIN sa_users_menus um ON m.id = um.menu_id WHERE um.user_id = $1',
            'SELECT m.* FROM sa_menu m INNER JOIN sa_group_menu gm ON m.id = gm.menu_id WHERE gm.group_id = $1 AND m.is_active = TRUE ORDER BY m.parent_id ASC, m.sort_order ASC',
            [groupId]
        );
        if (result.rows.length > 0) {
            res.json(result.rows);
        } else {
            res.status(404).json({ message: 'Group menu not found' });
        }
    } catch (err) {
        console.error('Error fetching group menu ${groupId}:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// API เพื่อดึงข้อมูล Content ของเมนูที่เลือก (ถ้ามี)
// ไม่ต้องใช้ verifyToken เพราะเป็น public view
const getMenuContentById = async (req, res) => {
    const { id } = req.params;
    try {
        // ดึงข้อมูล content จากตาราง sa_menu_content หรือ target_path จากตาราง sa_menu
        const result = await req.dbPool.query(
            `SELECT
                m.menu_name,
                m.menu_type,
                m.target_path,
                mc.content_type,
                mc.content_data
            FROM
                sa_menu m
            LEFT JOIN
                sa_menu_content mc ON m.id = mc.menu_id
            WHERE
                m.id = $1`,
            [id]
        );

        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } else {
            res.status(404).json({ message: 'Menu or content not found' });
        }
    } catch (err) {
        console.error(`Error fetching content for menu ${id}:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// *** API สำหรับ CRUD เมนู (ต้องการ authentication) ***

// API สำหรับเพิ่มเมนูใหม่
const createMenu = async (req, res) => {
    const { parent_id, menu_name, menu_type, target_path, sort_order, content_type, content_data } = req.body;
    try {
        // Find max sort_order if not provided
        let actual_sort_order = sort_order;
        if (actual_sort_order === undefined || actual_sort_order === null) {
            const maxOrderResult = await req.dbPool.query(
                'SELECT MAX(sort_order) FROM sa_menu WHERE parent_id = $1',
                [parent_id]
            );
            actual_sort_order = (maxOrderResult.rows[0].max || 0) + 1;
        }

        const menuResult = await req.dbPool.query(
            `INSERT INTO sa_menu (parent_id, menu_name, menu_type, target_path, sort_order, is_active)
             VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *`,
            [parent_id, menu_name, menu_type, target_path, actual_sort_order]
        );
        const newMenu = menuResult.rows[0];

        // ถ้ามี content_type/content_data ให้บันทึกลง sa_menu_content ด้วย
        if (content_type && content_data) {
            await req.dbPool.query(
                `INSERT INTO sa_menu_content (menu_id, content_type, content_data)
                 VALUES ($1, $2, $3)`,
                [newMenu.id, content_type, content_data]
            );
        }

        res.status(201).json(newMenu);
    } catch (err) {
        console.error('Error adding menu:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// API สำหรับแก้ไขเมนู
const updateMenu = async (req, res) => {
    const { id } = req.params;
    const { menu_name, menu_type, target_path, sort_order, is_active, content_type, content_data } = req.body;
    try {
        const menuResult = await req.dbPool.query(
            `UPDATE sa_menu SET
                menu_name = $1,
                menu_type = $2,
                target_path = $3,
                sort_order = $4,
                is_active = $5,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $6 RETURNING *`,
            [menu_name, menu_type, target_path, sort_order, is_active, id]
        );

        if (menuResult.rows.length === 0) {
            return res.status(404).json({ message: 'Menu not found.' });
        }

        // อัปเดตหรือสร้าง content ใน sa_menu_content
        if (content_type !== undefined && content_data !== undefined) {
             // ตรวจสอบว่ามี content เก่าอยู่แล้วหรือไม่
            const existingContent = await req.dbPool.query('SELECT * FROM sa_menu_content WHERE menu_id = $1', [id]);
            if (existingContent.rows.length > 0) {
                await req.dbPool.query(
                    `UPDATE sa_menu_content SET content_type = $1, content_data = $2, updated_at = CURRENT_TIMESTAMP WHERE menu_id = $3`,
                    [content_type, content_data, id]
                );
            } else {
                await req.dbPool.query(
                    `INSERT INTO sa_menu_content (menu_id, content_type, content_data) VALUES ($1, $2, $3)`,
                    [id, content_type, content_data]
                );
            }
        } else {
            // ถ้าไม่ได้ส่ง content มา อาจจะลบ content เก่าทิ้ง หรือปล่อยไว้ (ขึ้นอยู่กับ business logic)
            // ตัวอย่าง: ลบถ้าไม่ได้ระบุมา
            await req.dbPool.query('DELETE FROM sa_menu_content WHERE menu_id = $1', [id]);
        }

        res.json(menuResult.rows[0]);
    } catch (err) {
        console.error('Error updating menu:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// API สำหรับลบเมนู (และเมนูย่อยทั้งหมด)
const deleteMenu = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect(); // ใช้ transaction เพื่อความปลอดภัย
    try {
        await client.query('BEGIN');

        // ลบ content ที่เกี่ยวข้องก่อน
        await client.query('DELETE FROM sa_menu_content WHERE menu_id = $1', [id]);

        // ลบเมนูหลักและเมนูย่อยทั้งหมดที่เป็นลูกหลาน (recursive delete)
        // นี่คือเวอร์ชันง่ายๆ ที่ลบเฉพาะเมนูที่ระบุ
        // ถ้าต้องการลบลูกหลานทั้งหมดจริงๆ ต้องใช้ CTE (Common Table Expression) หรือ Logic ที่ซับซ้อนกว่านี้
        // สำหรับตอนนี้ ให้ Flutter จัดการไม่ให้ลบ folder ที่มีลูก
        const deleteResult = await client.query('DELETE FROM sa_menu WHERE id = $1 RETURNING *', [id]);

        if (deleteResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Menu not found.' });
        }

        await client.query('COMMIT');
        res.status(204).send(); // No Content
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting menu:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

// API สำหรับลบเมนูทั้งหมด
const deleteAllMenu = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM sa_menu_content');
        await client.query('DELETE FROM sa_menu');
        await client.query('COMMIT');
        res.status(204).send();
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting all sa_menu:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

// *** NEW: API สำหรับ Import เมนูจาก Excel ***
const importMenu = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No Excel file uploaded.' });
    }

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = xlsx.utils.sheet_to_json(worksheet);

        const client = await req.dbPool.connect();
        
        await client.query('BEGIN'); // เริ่ม transaction

        const importedMenu = [];

        for (const row of jsonData) {
            try {
                // --- ปรับปรุงการแปลงค่าจาก Excel ที่นี่ ---

                // parentId: ควรจะเป็น null ถ้าว่างเปล่า หรือเป็นตัวเลข
                // ตรวจสอบให้แน่ใจว่าค่าที่ได้จาก Excel ไม่ใช่ String "NULL" แต่เป็นค่าที่ว่างเปล่า (undefined, null, "")
                let parentId = null;
                if (row.parentId !== undefined && row.parentId !== null && String(row.parentId).trim() !== '' && String(row.parentId).trim().toLowerCase() !== 'null') {
                    parentId = parseInt(row.parentId, 10);
                    if (isNaN(parentId)) {
                        throw new Error(`Invalid parentId: "${row.parentId}". Must be a number or blank.`);
                    }
                }

                const menuName = row.menuName;
                const menuType = row.menuType;
                const targetPath = (row.targetPath === undefined || String(row.targetPath).trim() === '' || String(row.targetPath).trim().toLowerCase() === 'null') ? null : String(row.targetPath);

                // sortOrder: ต้องเป็นตัวเลข และต้องมีค่า
                let sortOrder = parseInt(row.sortOrder, 10);
                if (isNaN(sortOrder)) {
                    throw new Error(`Invalid sortOrder: "${row.sortOrder}". Must be a number.`);
                }

                // isActive: แปลง 'TRUE'/'FALSE' (ไม่สนใจ case) เป็น boolean
                const isActive = String(row.isActive).toLowerCase() === 'true';

                // contentType: ควรเป็น null ถ้าว่างเปล่า
                const contentType = (row.contentType === undefined || String(row.contentType).trim() === '' || String(row.contentType).trim().toLowerCase() === 'null') ? null : String(row.contentType);

                // contentData: ควรเป็น null ถ้าว่างเปล่า
                const contentData = (row.contentData === undefined || String(row.contentData).trim() === '' || String(row.contentData).trim().toLowerCase() === 'null') ? null : String(row.contentData);


                // ตรวจสอบค่าที่จำเป็นก่อนการ INSERT
                if (!menuName || !menuType || isNaN(sortOrder)) { // isNaN(sortOrder) ควรจะถูกดักไปตั้งแต่ด้านบนแล้ว
                    throw new Error('Missing required data: menuName, menuType, or sortOrder.');
                }

                // เพิ่มเมนู
                const menuInsertResult = await client.query(
                    `INSERT INTO sa_menu (parent_id, menu_name, menu_type, target_path, sort_order, is_active)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                    [parentId, menuName, menuType, targetPath, sortOrder, isActive]
                );
                const newMenu = menuInsertResult.rows[0];

                // เพิ่ม content ถ้ามี
                if (contentType && contentData) {
                    await client.query(
                        `INSERT INTO sa_menu_content (menu_id, content_type, content_data)
                         VALUES ($1, $2, $3)`,
                        [newMenu.id, contentType, contentData]
                    );
                }
                importedMenu.push(newMenu);

            } catch (innerErr) {
                // บันทึก error ของแต่ละแถวและโยน error เพื่อ rollback ทั้งหมด
                console.error(`Error processing row ${JSON.stringify(row)}: ${innerErr.message}`);
                throw new Error(`Error processing row (Menu Name: ${row.menuName || 'N/A'}): ${innerErr.message}`);
            }
        }

        await client.query('COMMIT'); // Commit transaction
        res.status(200).json({ message: 'Menu imported successfully.', importedCount: importedMenu.length });

    } catch (err) {
        if (client) await client.query('ROLLBACK'); // Rollback ถ้ามี error
        console.error('Error importing sa_menu:', err);
        res.status(500).json({ error: 'Failed to import sa_menu.', details: err.message });
    } finally {
        if (req.file) {
            // ลบไฟล์ชั่วคราว
            const fs = require('fs');
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting uploaded file:', err);
            });
        }
        if (client) client.release();
    }
};

// *** NEW: API สำหรับ Export เมนูเป็น Excel ***
const exportMenu = async (req, res) => {
    try {
        // ดึงข้อมูลเมนูทั้งหมด
        const menusResult = await req.dbPool.query('SELECT * FROM sa_menu ORDER BY parent_id ASC, sort_order ASC');
        const contentsResult = await req.dbPool.query('SELECT * FROM sa_menu_content');

        const menus = menusResult.rows;
        const contents = contentsResult.rows;

        // รวมข้อมูล content เข้ากับ menu
        const dataForExcel = menus.map(menu => {
            const content = contents.find(c => c.menu_id === menu.id);
            return {
                id: menu.id,
                parentId: menu.parent_id,
                menuName: menu.menu_name,
                menuType: menu.menu_type,
                targetPath: menu.target_path,
                sortOrder: menu.sort_order,
                isActive: menu.is_active,
                contentType: content ? content.content_type : null,
                contentData: content ? content.content_data : null,
            };
        });

        const worksheet = xlsx.utils.json_to_sheet(dataForExcel);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Menu');

        // สร้าง Buffer จากไฟล์ Excel
        const excelBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });

        // ตั้งค่า Response Headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=menus_export.xlsx');
        res.send(excelBuffer);

    } catch (err) {
        console.error('Error exporting sa_menu:', err);
        res.status(500).json({ error: 'Failed to export sa_menu.', details: err.message });
    }
};

module.exports = {
    getAllMenu,
    getMenuByUserId,
    getMenuByGroupId,
    getMenuContentById,
    createMenu,
    updateMenu,
    deleteMenu,
    deleteAllMenu,
    importMenu,
    exportMenu
};