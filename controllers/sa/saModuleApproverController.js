// controllers/sa/saModuleApproverController.js

const APPROVER_SELECT = `
    SELECT a.*,
           u.user_name  AS approver_username,
           u.first_name AS approver_first_name,
           u.last_name  AS approver_last_name,
           u.email      AS approver_email
    FROM sa_module_approver a
    LEFT JOIN sa_user u ON u.id = a.approver_user_id
`;

// GET /sa_module_approver?module_code=AP&doc_category=payment_run
const fetchRows = async (req, res) => {
    const { module_code, doc_category } = req.query;
    try {
        let sql = APPROVER_SELECT + ' WHERE 1=1';
        const params = [];
        if (module_code)   { params.push(module_code);   sql += ` AND a.module_code = $${params.length}`; }
        if (doc_category)  { params.push(doc_category);  sql += ` AND a.doc_category = $${params.length}`; }
        sql += ' ORDER BY a.module_code, a.doc_category, a.approval_level';
        const result = await req.dbPool.query(sql, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching sa_module_approver:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /sa_module_approver/:id
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(APPROVER_SELECT + ' WHERE a.id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบข้อมูล' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching sa_module_approver row:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// POST /sa_module_approver
const addRow = async (req, res) => {
    const { module_code, doc_category, approval_level, approver_user_id, signature_image, is_active } = req.body;
    const userName = req.headers.username;
    try {
        const result = await req.dbPool.query(
            `INSERT INTO sa_module_approver
               (module_code, doc_category, approval_level, approver_user_id, signature_image, is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
             RETURNING id`,
            [module_code, doc_category, approval_level ?? 1, approver_user_id,
             signature_image || null, is_active ?? true, userName]
        );
        const newId = result.rows[0].id;
        const newRow = await req.dbPool.query(APPROVER_SELECT + ' WHERE a.id = $1', [newId]);
        res.status(201).json(newRow.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ message: 'ลำดับผู้อนุมัตินี้มีอยู่แล้วในโมดูลและประเภทงานนี้' });
        }
        console.error('Error adding sa_module_approver:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// PUT /sa_module_approver/:id
const updateRow = async (req, res) => {
    const { id } = req.params;
    const { module_code, doc_category, approval_level, approver_user_id, signature_image, is_active } = req.body;
    const userName = req.headers.username;
    try {
        const result = await req.dbPool.query(
            `UPDATE sa_module_approver SET
               module_code      = $1, doc_category     = $2,
               approval_level   = $3, approver_user_id = $4,
               signature_image  = $5, is_active        = $6,
               updated_by = $7, updated_at = NOW()
             WHERE id = $8
             RETURNING id`,
            [module_code, doc_category, approval_level, approver_user_id,
             signature_image || null, is_active ?? true, userName, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบข้อมูล' });
        const updated = await req.dbPool.query(APPROVER_SELECT + ' WHERE a.id = $1', [id]);
        res.status(200).json(updated.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ message: 'ลำดับผู้อนุมัตินี้มีอยู่แล้วในโมดูลและประเภทงานนี้' });
        }
        console.error('Error updating sa_module_approver:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /sa_module_approver/:id
const deleteRow = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            'DELETE FROM sa_module_approver WHERE id = $1 RETURNING id', [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบข้อมูล' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting sa_module_approver:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /sa_module_approver/by_module/:module_code/:doc_category — สำหรับใช้ตอน approval process
const fetchByModuleCategory = async (req, res) => {
    const { module_code, doc_category } = req.params;
    try {
        const result = await req.dbPool.query(
            APPROVER_SELECT +
            ' WHERE a.module_code=$1 AND a.doc_category=$2 AND a.is_active=true ORDER BY a.approval_level',
            [module_code, doc_category]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching approvers by module/category:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = { fetchRows, fetchRow, addRow, updateRow, deleteRow, fetchByModuleCategory };
