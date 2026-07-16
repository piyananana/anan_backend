// controllers/ap/apVendorGroupController.js

const formatGroupCode = (g) => {
    let code = g.running_prefix || '';
    if (g.running_suffix_date) {
        const now = new Date();
        const year  = now.getFullYear().toString();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day   = now.getDate().toString().padStart(2, '0');
        switch (g.running_suffix_date) {
            case 'YY':     code += year.substring(2); break;
            case 'YYYY':   code += year; break;
            case 'YYMM':   code += year.substring(2) + month; break;
            case 'YYYYMM': code += year + month; break;
            case 'YYMMDD': code += year.substring(2) + month + day; break;
        }
    }
    if (g.running_separator) code += g.running_separator;
    code += g.running_next_number.toString().padStart(g.running_length, '0');
    return code;
};

// สำหรับใช้ภายใน apVendorImportController (atomic increment ภายใน transaction)
const generateNextCodeForGroup = async (client, groupId) => {
    const result = await client.query(
        `SELECT * FROM ap_vendor_group WHERE id = $1 FOR UPDATE`, [groupId]
    );
    if (result.rows.length === 0 || !result.rows[0].is_auto_number) return null;
    const g = result.rows[0];
    const code = formatGroupCode(g);
    await client.query(
        `UPDATE ap_vendor_group SET running_next_number = running_next_number + 1 WHERE id = $1`,
        [groupId]
    );
    return code;
};

const GROUP_SELECT = `
    SELECT g.*,
           a.account_code      AS ap_account_code,
           a.account_name_thai AS ap_account_name_thai
    FROM ap_vendor_group g
    LEFT JOIN gl_account a ON a.id = g.ap_account_id
`;

// GET all
const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(GROUP_SELECT + ` ORDER BY g.group_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching ap_vendor_group:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET active only
const fetchActiveRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(GROUP_SELECT + ` WHERE g.is_active = true ORDER BY g.group_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching active ap_vendor_group:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET one by id
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(GROUP_SELECT + ` WHERE g.id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบกลุ่มผู้ขาย' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching ap_vendor_group row:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST create
const addRow = async (req, res) => {
    const {
        group_code, group_name_thai, group_name_eng, description,
        credit_term_months, credit_term_days, currency_code,
        ap_account_id,
        is_auto_number, running_prefix, running_separator,
        running_suffix_date, running_length, running_next_number,
        is_active,
    } = req.body;
    const userName = req.headers.username;

    try {
        const result = await req.dbPool.query(
            `INSERT INTO ap_vendor_group
               (group_code, group_name_thai, group_name_eng, description,
                credit_term_months, credit_term_days, currency_code,
                ap_account_id,
                is_auto_number, running_prefix, running_separator,
                running_suffix_date, running_length, running_next_number,
                is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
             RETURNING id`,
            [
                (group_code || '').trim().toUpperCase(),
                group_name_thai || '', group_name_eng || '', description || null,
                credit_term_months ?? 0, credit_term_days ?? 30,
                currency_code || 'THB',
                ap_account_id || null,
                is_auto_number ?? false,
                (running_prefix || 'VEND').trim(),
                running_separator ?? '-',
                running_suffix_date || '',
                running_length ?? 4, running_next_number ?? 1,
                is_active ?? true, userName,
            ]
        );
        const newId = result.rows[0].id;
        const newRow = await req.dbPool.query(GROUP_SELECT + ` WHERE g.id = $1`, [newId]);
        res.status(201).json(newRow.rows[0]);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `รหัสกลุ่ม '${group_code}' มีอยู่แล้ว` });
        console.error('Error adding ap_vendor_group:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// PUT update
const updateRow = async (req, res) => {
    const { id } = req.params;
    const {
        group_name_thai, group_name_eng, description,
        credit_term_months, credit_term_days, currency_code,
        ap_account_id,
        is_auto_number, running_prefix, running_separator,
        running_suffix_date, running_length, running_next_number,
        is_active,
    } = req.body;
    const userName = req.headers.username;

    try {
        const result = await req.dbPool.query(
            `UPDATE ap_vendor_group SET
                group_name_thai    = $1,
                group_name_eng     = $2,
                description        = $3,
                credit_term_months = $4,
                credit_term_days   = $5,
                currency_code      = $6,
                ap_account_id      = $7,
                is_auto_number     = $8,
                running_prefix     = $9,
                running_separator  = $10,
                running_suffix_date = $11,
                running_length     = $12,
                running_next_number = $13,
                is_active          = $14,
                updated_by         = $15,
                updated_at         = NOW()
             WHERE id = $16
             RETURNING id`,
            [
                group_name_thai || '', group_name_eng || '', description || null,
                credit_term_months ?? 0, credit_term_days ?? 30,
                currency_code || 'THB',
                ap_account_id || null,
                is_auto_number ?? false,
                (running_prefix || 'VEND').trim(),
                running_separator ?? '-',
                running_suffix_date || '',
                running_length ?? 4, running_next_number ?? 1,
                is_active ?? true, userName, id,
            ]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบกลุ่มผู้ขาย' });
        const updated = await req.dbPool.query(GROUP_SELECT + ` WHERE g.id = $1`, [id]);
        res.status(200).json(updated.rows[0]);
    } catch (error) {
        console.error('Error updating ap_vendor_group:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE
const deleteRow = async (req, res) => {
    const { id } = req.params;
    try {
        const inUse = await req.dbPool.query(
            `SELECT 1 FROM ap_vendor WHERE vendor_group_id = $1 LIMIT 1`, [id]
        );
        if (inUse.rows.length > 0) {
            return res.status(409).json({ error: 'ไม่สามารถลบได้ เนื่องจากมีผู้ขายอ้างอิงกลุ่มนี้' });
        }
        const result = await req.dbPool.query(`DELETE FROM ap_vendor_group WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบกลุ่มผู้ขาย' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting ap_vendor_group:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = { fetchRows, fetchActiveRows, fetchRow, addRow, updateRow, deleteRow, generateNextCodeForGroup };
