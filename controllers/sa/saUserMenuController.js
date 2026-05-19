// controllers/sa/saUserMenuController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้

// *** API สำหรับ CRUD เมนู (ต้องการ authentication) ***

// API สำหรับอัปเดตเมนูของผู้ใช้
const updateUserMenu = async (req, res) => {
    const userId = parseInt(req.params.userId);

    if (isNaN(userId)) {
        return res.status(400).json({ message: 'Invalid User ID' });
    }

    const client = await req.dbPool.connect();
    try {
        // Ensure permission columns exist
        await client.query(`
            ALTER TABLE sa_user_menu ADD COLUMN IF NOT EXISTS can_view BOOLEAN DEFAULT TRUE;
            ALTER TABLE sa_user_menu ADD COLUMN IF NOT EXISTS can_create BOOLEAN DEFAULT FALSE;
            ALTER TABLE sa_user_menu ADD COLUMN IF NOT EXISTS can_edit BOOLEAN DEFAULT FALSE;
            ALTER TABLE sa_user_menu ADD COLUMN IF NOT EXISTS can_delete BOOLEAN DEFAULT FALSE;
            ALTER TABLE sa_user_menu ADD COLUMN IF NOT EXISTS can_approve BOOLEAN DEFAULT FALSE;
            ALTER TABLE sa_user_menu ADD COLUMN IF NOT EXISTS can_print BOOLEAN DEFAULT FALSE;
            ALTER TABLE sa_user_menu ADD COLUMN IF NOT EXISTS can_export BOOLEAN DEFAULT FALSE;
        `);

        // Support both new format { menus: [...] } and old format { menuIds: [...] }
        let menus = req.body.menus;
        if (!menus && req.body.menuIds) {
            // backward compat: convert old format
            menus = req.body.menuIds.map(id => ({
                id,
                canView: true,
                canCreate: false,
                canEdit: false,
                canDelete: false,
                canApprove: false,
                canPrint: false,
                canExport: false
            }));
        }
        if (!Array.isArray(menus)) {
            return res.status(400).json({ message: 'Invalid menus array provided' });
        }

        await client.query('BEGIN');

        // ขั้นตอนที่ 1: ลบสิทธิ์เก่าทั้งหมดของผู้ใช้คนนี้
        await client.query('DELETE FROM sa_user_menu WHERE user_id = $1', [userId]);

        // ขั้นตอนที่ 2: เพิ่มสิทธิ์ใหม่ทั้งหมด
        if (menus.length > 0) {
            const valuePlaceholders = [];
            const queryParams = [userId];
            let paramIndex = 2;
            for (const m of menus) {
                valuePlaceholders.push(
                    `($1, $${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7})`
                );
                queryParams.push(
                    m.id,
                    m.canView ?? true,
                    m.canCreate ?? false,
                    m.canEdit ?? false,
                    m.canDelete ?? false,
                    m.canApprove ?? false,
                    m.canPrint ?? false,
                    m.canExport ?? false
                );
                paramIndex += 8;
            }
            const insertQuery = `INSERT INTO sa_user_menu (user_id, menu_id, can_view, can_create, can_edit, can_delete, can_approve, can_print, can_export) VALUES ${valuePlaceholders.join(', ')}`;
            await client.query(insertQuery, queryParams);
        }

        await client.query('COMMIT');
        return res.status(200).json({ message: 'User menu updated successfully' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating user menu:', error);
        return res.status(500).json({ message: 'Failed to update user menu', error: error.message });
    } finally {
        client.release();
    }
};

const deleteUserMenu = async (req, res) => {
    const { userId } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query('DELETE FROM sa_user_menu WHERE user_id = $1 RETURNING *', [userId]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'User menu not found.' });
        }
        await client.query('COMMIT');
        res.status(204).send(); // No Content
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error deleting user menu:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
};

module.exports = {
    updateUserMenu,
    deleteUserMenu
};
