// // controllers/sa/saOrganizationController.js
// // อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้
// const pool = require('../../config/db');

// // GET all organizational units (or by parent_id)
// // Example: GET /api/org-units -> returns all root units
// // Example: GET /api/org-units?parentId=some-uuid -> returns children of that parent
// const getAllOrganization = async (req, res) => {
//     try {
//         const result = await pool.query('SELECT * FROM sa_organization WHERE is_active = TRUE ORDER BY parent_id ASC, name ASC');
//         res.json(result.rows);
//     } catch (err) {
//         console.error('Error fetching sa_organization:', err);
//         res.status(500).json({ error: 'Internal server error' });
//     }
//     // const { parentId } = req.query;
//     // let query = 'SELECT * FROM sa_organization';
//     // const params = [];

//     // if (parentId) {
//     //     query += ' WHERE parent_id = $1';
//     //     params.push(parentId);
//     // } else {
//     //     query += ' WHERE parent_id IS NULL'; // ดึงหน่วยงานหลัก (root units)
//     // }
//     // query += ' ORDER BY name ASC'; // เรียงตามชื่อ

//     // const client = await pool.connect();
//     // try {
//     //     const result = await client.query(query, params);
//     //     res.status(200).json(result.rows);
//     // } catch (error) {
//     //     console.error('Error fetching organization:', error);
//     //     res.status(500).json({ message: 'Failed to fetch organization', error: error.message });
//     // } finally {
//     //     client.release();
//     // }
// };

// // GET a single organizational unit by ID
// const getOrganizationById = async (req, res) => {
//     const { id } = req.params;
//     const client = await pool.connect();
//     try {
//         const result = await client.query('SELECT * FROM sa_organization WHERE id = $1', [id]);
//         if (result.rows.length > 0) {
//             res.status(200).json(result.rows[0]);
//         } else {
//             res.status(404).json({ message: 'Organization not found' });
//         }
//     } catch (error) {
//         console.error('Error fetching organization by ID:', error);
//         res.status(500).json({ message: 'Failed to fetch organization', error: error.message });
//     } finally {
//         client.release();
//     }
// };

// // POST a new organizational unit
// const createOrganization = async (req, res) => {
//     const {
//         name, parent_id, is_active, can_have_sub_units,
//         description, contact_person, phone_number, email
//     } = req.body;

//     if (!name) {
//         return res.status(400).json({ message: 'Name is required' });
//     }

//     const client = await pool.connect();
//     try {
//         const result = await client.query(
//             `INSERT INTO sa_organization (
//                 name, parent_id, is_active, can_have_sub_units,
//                 description, contact_person, phone_number, email
//             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
//             [
//                 name,
//                 parent_id || null, // Ensure parent_id is null if empty string or undefined
//                 is_active !== undefined ? is_active : true, // Default to true if not provided
//                 can_have_sub_units !== undefined ? can_have_sub_units : true, // Default to true if not provided
//                 description || null,
//                 contact_person || null,
//                 phone_number || null,
//                 email || null
//             ]
//         );
//         res.status(201).json({ message: 'Organization created successfully', rowResult: result.rows[0] });
//     } catch (error) {
//         console.error('Error creating organization:', error);
//         res.status(500).json({ message: 'Failed to create organization', error: error.message });
//     } finally {
//         client.release();
//     }
// };

// // PUT (update) an organizational unit by ID
// const updateOrganization = async (req, res) => {
//     const { id } = req.params;
//     const {
//         name, parent_id, is_active, can_have_sub_units,
//         description, contact_person, phone_number, email
//     } = req.body;

//     if (!name) {
//         return res.status(400).json({ message: 'Name is required' });
//     }

//     const client = await pool.connect();
//     try {
//         const result = await client.query(
//             `UPDATE sa_organization SET
//                 name = $1,
//                 parent_id = $2,
//                 is_active = $3,
//                 can_have_sub_units = $4,
//                 description = $5,
//                 contact_person = $6,
//                 phone_number = $7,
//                 email = $8,
//                 updated_at = CURRENT_TIMESTAMP
//             WHERE id = $9 RETURNING *`,
//             [
//                 name,
//                 parent_id, // Ensure parent_id is null if empty string or undefined
//                 is_active,
//                 can_have_sub_units,
//                 description,
//                 contact_person,
//                 phone_number,
//                 email,
//                 id
//             ]
//         );
//         if (result.rows.length > 0) {
//             res.status(200).json({ message: 'Organization updated successfully', rowResult: result.rows[0] });
//         } else {
//             res.status(404).json({ message: 'Organization not found' });
//         }
//     } catch (error) {
//         console.error('Error updating organization:', error);
//         res.status(500).json({ message: 'Failed to update organization', error: error.message });
//     } finally {
//         client.release();
//     }
// };

// // DELETE an organizational unit by ID
// const deleteOrganization = async (req, res) => {
//     const { id } = req.params;
//     const client = await pool.connect();
//     try {
//         // ก่อนลบ ตรวจสอบว่ามีหน่วยงานย่อยหรือไม่
//         const childUnits = await client.query('SELECT COUNT(*) FROM sa_organization WHERE parent_id = $1', [id]);
//         if (parseInt(childUnits.rows[0].count) > 0) {
//             return res.status(400).json({ message: 'Cannot delete unit with sub-units. Please delete sub-units first.' });
//         }

//         const result = await client.query('DELETE FROM sa_organization WHERE id = $1 RETURNING *', [id]);
//         if (result.rows.length > 0) {
//             res.status(200).json({ message: 'Organization deleted successfully' });
//         } else {
//             res.status(404).json({ message: 'Organization not found' });
//         }
//     } catch (error) {
//         console.error('Error deleting organization:', error);
//         res.status(500).json({ message: 'Failed to delete organization', error: error.message });
//     } finally {
//         client.release();
//     }
// };

// module.exports = {
//     getAllOrganization,
//     getOrganizationById,
//     createOrganization,
//     updateOrganization,
//     deleteOrganization
// };