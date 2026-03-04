// controllers/cd/cdBranchController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้

const xlsx = require('xlsx'); // Import xlsx

// GET all rows with lock info
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query('SELECT * FROM cd_branch WHERE is_active = TRUE ORDER BY branch_code ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching all branch:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// POST new row
const addRow = async (req, res) => {
    const { branch_code, branch_name_thai, branch_name_eng, is_active, address_no, address_building_village,
        address_soi, address_road, address_sub_district, address_district, address_province, address_country, 
        address_zip_code, phone_number, fax_number, primary_contact_person
     } = req.body;
    const userId = req.headers.userid;
    try {
        const result = await req.dbPool.query(
            `INSERT INTO cd_branch (branch_code, branch_name_thai, branch_name_eng, is_active, address_no, address_building_village, 
                address_soi, address_road, address_sub_district, address_district, address_province, address_country, 
                address_zip_code, phone_number, fax_number, primary_contact_person, created_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP, $17) RETURNING *`,
            [branch_code, branch_name_thai, branch_name_eng, is_active, address_no, address_building_village, 
                address_soi, address_road, address_sub_district, address_district, address_province, address_country, 
                address_zip_code, phone_number, fax_number, primary_contact_person, userId]
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
    const { branch_code, branch_name_thai, branch_name_eng, is_active, address_no, address_building_village, 
        address_soi, address_road, address_sub_district, address_district, address_province, address_country, 
        address_zip_code, phone_number, fax_number, primary_contact_person
    } = req.body;
    const userId = req.headers.userid;

    try {
        const result = await req.dbPool.query(
            `UPDATE cd_branch SET
                branch_code = $1,
                branch_name_thai = $2,
                branch_name_eng = $3,
                is_active = $4,
                address_no = $5,
                address_building_village = $6,
                address_soi = $7,
                address_road = $8,
                address_sub_district = $9,
                address_district = $10,
                address_province = $11,
                address_country = $12,
                address_zip_code = $13,
                phone_number = $14,
                fax_number = $15,
                primary_contact_person = $16,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = $17
             WHERE id = $18 RETURNING *`,
            [branch_code, branch_name_thai, branch_name_eng, is_active, address_no, address_building_village, 
                address_soi, address_road, address_sub_district, address_district, address_province, address_country, 
                address_zip_code, phone_number, fax_number, primary_contact_person, userId, id]
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
        const result = await client.query('DELETE FROM cd_branch WHERE id = $1 RETURNING *', [id]);

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
        await client.query('DELETE FROM cd_branch');
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
        const result = await req.dbPool.query('SELECT * FROM cd_branch ORDER BY branch_code ASC');

        const dataRows = result.rows;

        const dataForExcel = dataRows.map(row => {
            return {
                id: row.id,
                branchCode: row.branch_code,
                branchNameThai: row.branch_name_thai,
                branchNameEng: row.branch_name_eng,
                isActive: row.is_active,
                addressNo: row.address_no,
                addressBuildingVillage: row.address_building_village,
                addressSoi: row.address_soi,
                addressRoad: row.address_road,
                addressSubDistrict: row.address_sub_district,
                addressDistrict: row.address_district,
                addressProvince: row.address_province,
                addressCountry: row.address_country,
                addressZipCode: row.address_zip_code,
                phoneNumber: row.phone_number,
                faxNumber: row.fax_number,
                primaryContactPerson: row.primary_contact_person,
            };
        });

        const worksheet = xlsx.utils.json_to_sheet(dataForExcel);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'branch');

        // สร้าง Buffer จากไฟล์ Excel
        const excelBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });

        // ตั้งค่า Response Headers
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=branch_export.xlsx');
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