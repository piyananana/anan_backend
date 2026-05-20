// controllers/gl/glDimensionValueController.js
// จัดการ GL Dimension Value (master data สำหรับทุก dimension type)

const fetchRows = async (req, res) => {
    const { type_code, include_inactive } = req.query;
    let sql = `
        SELECT v.id, v.type_code, v.value_code, v.value_name_thai, v.value_name_eng,
               v.parent_id, v.is_active, v.sort_order, v.created_at, v.updated_at,
               p.value_code AS parent_code, p.value_name_thai AS parent_name
        FROM gl_dimension_value v
        LEFT JOIN gl_dimension_value p ON p.id = v.parent_id
        WHERE 1=1
    `;
    const params = [];
    if (type_code) {
        sql += ` AND v.type_code = $${params.length + 1}`;
        params.push(type_code);
    }
    if (!include_inactive || include_inactive === 'false') {
        sql += ` AND v.is_active = TRUE`;
    }
    sql += ` ORDER BY v.type_code ASC, v.sort_order ASC, v.value_code ASC`;
    try {
        const result = await req.dbPool.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            `SELECT * FROM gl_dimension_value WHERE id = $1`, [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const addRow = async (req, res) => {
    const { type_code, value_code, value_name_thai, value_name_eng, parent_id, is_active, sort_order } = req.body;
    if (!type_code || !value_code || !value_name_thai) {
        return res.status(400).json({ error: 'type_code, value_code, value_name_thai required' });
    }
    try {
        const result = await req.dbPool.query(`
            INSERT INTO gl_dimension_value
                (type_code, value_code, value_name_thai, value_name_eng, parent_id,
                 is_active, sort_order, created_by, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
            RETURNING *
        `, [type_code, value_code.toUpperCase(), value_name_thai,
            value_name_eng || null, parent_id || null,
            is_active !== undefined ? is_active : true,
            sort_order || 0,
            req.headers['username'] || null]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'รหัสซ้ำในประเภทนี้' });
        res.status(500).json({ error: err.message });
    }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const { value_code, value_name_thai, value_name_eng, parent_id, is_active, sort_order } = req.body;
    try {
        const result = await req.dbPool.query(`
            UPDATE gl_dimension_value SET
                value_code      = COALESCE($1, value_code),
                value_name_thai = COALESCE($2, value_name_thai),
                value_name_eng  = $3,
                parent_id       = $4,
                is_active       = COALESCE($5, is_active),
                sort_order      = COALESCE($6, sort_order),
                updated_by      = $7,
                updated_at      = NOW()
            WHERE id = $8
            RETURNING *
        `, [value_code ? value_code.toUpperCase() : null,
            value_name_thai || null,
            value_name_eng !== undefined ? value_name_eng : null,
            parent_id !== undefined ? parent_id : null,
            is_active !== undefined ? is_active : null,
            sort_order !== undefined ? sort_order : null,
            req.headers['username'] || null,
            id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'รหัสซ้ำในประเภทนี้' });
        res.status(500).json({ error: err.message });
    }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const dimId = parseInt(id);
    try {
        // 1. ตรวจว่ามีข้อมูลย่อย (children) หรือไม่
        const childCheck = await req.dbPool.query(
            `SELECT COUNT(*) FROM gl_dimension_value WHERE parent_id = $1`,
            [dimId]
        );
        if (parseInt(childCheck.rows[0].count) > 0) {
            return res.status(409).json({ error: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลย่อยอยู่ภายใต้ กรุณาลบข้อมูลย่อยก่อน' });
        }

        // 2. ตรวจว่าถูกใช้งานใน gl_dim_combination (= มีในธุรกรรม GL)
        try {
            const usedCheck = await req.dbPool.query(
                `SELECT COUNT(*) FROM gl_dim_combination
                 WHERE dim1_id = $1 OR dim2_id = $1 OR dim3_id = $1 OR dim4_id = $1 OR dim5_id = $1`,
                [dimId]
            );
            if (parseInt(usedCheck.rows[0].count) > 0) {
                return res.status(409).json({ error: 'ไม่สามารถลบได้ เนื่องจากมีการใช้งานในธุรกรรม GL' });
            }
        } catch (_) {
            // gl_dim_combination อาจยังไม่มี — ข้ามไปได้
        }

        // 3. Hard delete
        const result = await req.dbPool.query(
            `DELETE FROM gl_dimension_value WHERE id = $1 RETURNING id`,
            [dimId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = { fetchRows, fetchRow, addRow, updateRow, deleteRow };
