// controllers/sa/saCompanyController.js
// อย่าลืม แก้ไข module.exports ในไฟล์นี้เพื่อให้สามารถเข้าถึงฟังก์ชันได้
const path = require('path');    // สำหรับจัดการ path ของไฟล์
const fs = require('fs');        // สำหรับจัดการไฟล์ในระบบ

// Helper function เพื่อแปลง String ว่าง หรือ 'null' เป็น null จริงๆ
function parseNullableDate(dateString) {
    if (!dateString || dateString === 'null') { // ตรวจสอบ String ว่าง หรือ 'null'
        return null;
    }
    return dateString; // ถ้ามีค่า ให้ส่งเป็น String วันที่ไป
}

// GET Company Info (ปกติจะมีแค่ 1 บริษัทที่ใช้แอปนี้)
const getCompanyInfo = async (req, res) => {
    try {
        const result = await req.dbPool.query('SELECT * FROM sa_company WHERE is_active = TRUE LIMIT 1'); // ดึงข้อมูลบริษัทเดียว
        if (result.rows.length > 0) {
            // ปรับ logo_url ให้เป็น full URL
            if (result.rows[0].logo_url) {
                result.rows[0].logo_url = `http://${req.headers.host}/public/sa/${path.basename(result.rows[0].logo_url)}`;
            }
            return res.status(200).json(result.rows[0]);
        } else {
            return res.status(404).json({ message: 'Company information not found' });
        }
    } catch (error) {
        console.error('Error fetching company info:', error);
        return res.status(500).json({ message: 'Failed to fetch company info', error: error.message });
    }
};

// POST Company Info (สำหรับเพิ่มข้อมูลบริษัทครั้งแรก)
const createCompanyInfo = async (req, res) => {
    const {
        thai_name, english_name, address_no, address_building_village,
        address_soi, address_road, address_sub_district, address_district,
        address_province, address_country, address_zip_code, tax_id_number,
        start_date, maintenance_contract_date, serial_number,
        phone_number, fax_number, email, website, primary_contact_person, is_active
    } = req.body;

    const logo_url = req.file ? req.file.path : null; // Path ของไฟล์ที่อัปโหลด

    const parsed_start_date = parseNullableDate(start_date);
    const parsed_maintenance_contract_date = parseNullableDate(maintenance_contract_date);

    // Validation (ขั้นต้น)
    if (!thai_name || !tax_id_number) {
        // ถ้ามีไฟล์โลโก้อัปโหลดมาแล้วแต่ข้อมูลไม่สมบูรณ์ ให้ลบไฟล์นั้นทิ้ง
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ message: 'Thai Name and Tax ID Number are required' });
    }

    try {
        const client = req.dbPool;
        await client.query('BEGIN');

        const result = await client.query(
            'INSERT INTO sa_company ( '+
                'thai_name, english_name, address_no, address_building_village, '+
                'address_soi, address_road, address_sub_district, address_district, '+
                'address_province, address_country, address_zip_code, tax_id_number, '+
                'logo_url, start_date, maintenance_contract_date, serial_number, '+
                'phone_number, fax_number, email, website, primary_contact_person, is_active )'+
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) '+
            'RETURNING *',
            [
                thai_name, english_name, address_no, address_building_village,
                address_soi, address_road, address_sub_district, address_district,
                address_province, address_country, address_zip_code, tax_id_number,
                logo_url, parsed_start_date, parsed_maintenance_contract_date, serial_number,
                phone_number, fax_number, email, website, primary_contact_person, is_active === 'true'
            ]
        );
        await client.query('COMMIT');

        res.status(201).json({ message: 'Company information added successfully', company: result.rows[0] });
    } catch (error) {
        console.error('Error adding company info:', error);
        // ถ้ามีไฟล์โลโก้อัปโหลดมาแล้วและเกิดข้อผิดพลาดในการบันทึกลง DB ให้ลบไฟล์นั้นทิ้ง
        if (req.file) fs.unlinkSync(req.file.path);
        if (error.code === '23505' && error.constraint === 'company_tax_id_number_key') {
            return res.status(409).json({ message: 'Tax ID Number already exists' });
        }
        return res.status(500).json({ message: 'Failed to add company info', error: error.message });
    }
};

// PUT Company Info (สำหรับอัปเดตข้อมูลบริษัท)
const updateCompanyInfo = async (req, res) => {
    const companyId = parseInt(req.params.id);
    const {
        thai_name, english_name, address_no, address_building_village,
        address_soi, address_road, address_sub_district, address_district,
        address_province, address_country, address_zip_code, tax_id_number,
        start_date, maintenance_contract_date, serial_number,
        phone_number, fax_number, email, website, primary_contact_person, is_active
    } = req.body;

    const new_logo_url = req.file ? req.file.path : null; // Path ของไฟล์ใหม่ที่อัปโหลด

    // VVVV ใช้ Helper function VVVV
    const parsed_start_date = parseNullableDate(start_date);
    const parsed_maintenance_contract_date = parseNullableDate(maintenance_contract_date);

    // Validation (ขั้นต้น)
    if (!thai_name || !tax_id_number || isNaN(companyId)) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ message: 'Thai Name, Tax ID Number and valid Company ID are required' });
    }

    try {
        // ดึง logo_url เก่ามาเพื่อลบถ้ามีการอัปโหลดรูปใหม่
        const client = req.dbPool;
        await client.query('BEGIN');

        const oldCompany = await client.query('SELECT logo_url FROM sa_company WHERE id = $1', [companyId]);
        let oldLogoPath = null;
        if (oldCompany.rows.length > 0 && oldCompany.rows[0].logo_url) {
            oldLogoPath = oldCompany.rows[0].logo_url;
        }

        const updateFields = [
            'thai_name=$1', 'english_name=$2', 'address_no=$3', 'address_building_village=$4',
            'address_soi=$5', 'address_road=$6', 'address_sub_district=$7', 'address_district=$8',
            'address_province=$9', 'address_country=$10', 'address_zip_code=$11', 'tax_id_number=$12',
            'start_date=$13', 'maintenance_contract_date=$14', 'serial_number=$15',
            'phone_number=$16', 'fax_number=$17', 'email=$18', 'website=$19',
            'primary_contact_person=$20', 'is_active=$21', 'updated_at=NOW()'
        ];
        const queryParams = [
            thai_name, english_name, address_no, address_building_village,
            address_soi, address_road, address_sub_district, address_district,
            address_province, address_country, address_zip_code, tax_id_number,
            parsed_start_date, parsed_maintenance_contract_date, serial_number,
            phone_number, fax_number, email, website,
            primary_contact_person, is_active === 'true'
        ];

        // let logoUpdate = '';
        if (new_logo_url) {
            updateFields.push('logo_url=$22'); // เพิ่ม logo_url ใน update
            queryParams.push(new_logo_url);
        }

        queryParams.push(companyId); // id ของบริษัทสำหรับ WHERE clause

        const result = await client.query(
            `UPDATE sa_company SET ${updateFields.join(', ')} WHERE id = $${queryParams.length} RETURNING *`,
            queryParams
        );

        await client.query('COMMIT');

        if (result.rows.length > 0) {
            // ถ้ามีการอัปโหลดรูปใหม่ และมีรูปเก่าอยู่ ให้ลบรูปเก่าทิ้ง
            if (new_logo_url && oldLogoPath && fs.existsSync(oldLogoPath)) {
                fs.unlink(oldLogoPath, (err) => {
                    if (err) console.error('Error deleting old logo file:', err);
                });
            }
            // ปรับ logo_url ให้เป็น full URL ก่อนส่งกลับ
            if (result.rows[0].logo_url) {
                result.rows[0].logo_url = `http://${req.headers.host}/public/sa/${path.basename(result.rows[0].logo_url)}`;
            }
            res.status(200).json({ message: 'Company information updated successfully', company: result.rows[0] });
        } else {
            if (req.file) fs.unlinkSync(req.file.path); // ลบไฟล์ที่อัปโหลดถ้าไม่มีการอัปเดต DB
            return res.status(404).json({ message: 'Company not found' });
        }
    } catch (error) {
        console.error('Error updating company info:', error);
        if (req.file) fs.unlinkSync(req.file.path); // ลบไฟล์ที่อัปโหลดถ้ามีข้อผิดพลาด
        if (error.code === '23505' && error.constraint === 'company_tax_id_number_key') {
            return res.status(409).json({ message: 'Tax ID Number already exists' });
        }
        return res.status(500).json({ message: 'Failed to update company info', error: error.message });
    }
};

module.exports = {
    parseNullableDate,
    getCompanyInfo,
    createCompanyInfo,
    updateCompanyInfo
};