// controllers/sa/saGroupController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้

// GET all groups (or by parent_id)
// Example: GET /api/org-units -> returns all root units
// Example: GET /api/org-units?parentId=some-uuid -> returns children of that parent
const getAllGroup = async (req, res) => {
    try {
        const result = await req.dbPool.query('SELECT * FROM sa_group WHERE is_active = TRUE ORDER BY parent_id ASC, name ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching sa_group:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// GET a single groupal unit by ID
const getGroupById = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query('SELECT * FROM sa_group WHERE id = $1', [id]);
        if (result.rows.length > 0) {
            res.status(200).json(result.rows[0]);
        } else {
            res.status(404).json({ message: 'Group not found' });
        }
    } catch (error) {
        console.error('Error fetching group by ID:', error);
        res.status(500).json({ message: 'Failed to fetch group', error: error.message });
    }
};

// POST a new groupal unit
const createGroup = async (req, res) => {
    const { name, parent_id, is_active, have_sub_group, description } = req.body;

    if (!name) {
        return res.status(400).json({ message: 'Name is required' });
    }

    try {
        const result = await req.dbPool.query(
            `INSERT INTO sa_group (
                name, parent_id, is_active, have_sub_group,
                description
            ) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [
                name,
                parent_id || null, // Ensure parent_id is null if empty string or undefined
                is_active !== undefined ? is_active : true, // Default to true if not provided
                have_sub_group !== undefined ? have_sub_group : true, // Default to true if not provided
                description || null
            ]
        );
        res.status(201).json({ message: 'Group created successfully', rowResult: result.rows[0] });
    } catch (error) {
        console.error('Error creating group:', error);
        res.status(500).json({ message: 'Failed to create group', error: error.message });
    }
};

// PUT (update) an groupal unit by ID
const updateGroup = async (req, res) => {
    const { id } = req.params;
    const { name, parent_id, is_active, have_sub_group, description } = req.body;

    if (!name) {
        return res.status(400).json({ message: 'Name is required' });
    }

    try {
        const result = await req.dbPool.query(
            `UPDATE sa_group SET
                name = $1,
                parent_id = $2,
                is_active = $3,
                have_sub_group = $4,
                description = $5,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $6 RETURNING *`,
            [
                name,
                parent_id, // Ensure parent_id is null if empty string or undefined
                is_active,
                have_sub_group,
                description,
                id
            ]
        );
        if (result.rows.length > 0) {
            res.status(200).json({ message: 'Group updated successfully', rowResult: result.rows[0] });
        } else {
            res.status(404).json({ message: 'Group not found' });
        }
    } catch (error) {
        console.error('Error updating group:', error);
        res.status(500).json({ message: 'Failed to update group', error: error.message });
    }
};

// DELETE an groupal unit by ID
const deleteGroup = async (req, res) => {
    const { id } = req.params;
    try {
        // ก่อนลบ ตรวจสอบว่ามีหน่วยงานย่อยหรือไม่
        const childUnits = await req.dbPool.query('SELECT COUNT(*) FROM sa_group WHERE parent_id = $1', [id]);
        if (parseInt(childUnits.rows[0].count) > 0) {
            return res.status(400).json({ message: 'Cannot delete unit with sub-units. Please delete sub-units first.' });
        }

        const result = await req.dbPool.query('DELETE FROM sa_group WHERE id = $1 RETURNING *', [id]);
        if (result.rows.length > 0) {
            res.status(200).json({ message: 'Group deleted successfully' });
        } else {
            res.status(404).json({ message: 'Group not found' });
        }
    } catch (error) {
        console.error('Error deleting group:', error);
        res.status(500).json({ message: 'Failed to delete group', error: error.message });
    }
};

module.exports = {
    getAllGroup,
    getGroupById,
    createGroup,
    updateGroup,
    deleteGroup
};