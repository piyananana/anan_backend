// controllers/gl/glDimensionTypeController.js
// จัดการ GL Dimension Type (slot 1-5 ที่บริษัทตั้งค่าเอง)

const fetchRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(`
            SELECT slot_no, type_code, name_thai, name_eng, is_active, sort_order,
                   created_at, updated_at
            FROM gl_dimension_type
            ORDER BY sort_order ASC, slot_no ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const fetchActiveRows = async (req, res) => {
    try {
        const result = await req.dbPool.query(`
            SELECT slot_no, type_code, name_thai, name_eng, is_active, sort_order
            FROM gl_dimension_type
            WHERE is_active = TRUE
            ORDER BY sort_order ASC, slot_no ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

const fetchRow = async (req, res) => {
    const { slot_no } = req.params;
    try {
        const result = await req.dbPool.query(
            `SELECT * FROM gl_dimension_type WHERE slot_no = $1`, [slot_no]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// upsert: สร้างหรืออัพเดต slot (slot_no เป็น PK)
const upsert = async (req, res) => {
    const { slot_no, type_code, name_thai, name_eng, is_active, sort_order } = req.body;
    if (!slot_no || !type_code || !name_thai) {
        return res.status(400).json({ error: 'slot_no, type_code, name_thai required' });
    }
    try {
        // รหัสเดิมที่มีค่ามิติหรือบัญชีอ้างอยู่แล้ว เปลี่ยนไม่ได้ (ค่า/กฎบัญชีอ้างด้วย type_code)
        const cur = (await req.dbPool.query(`SELECT type_code FROM gl_dimension_type WHERE slot_no = $1`, [slot_no])).rows[0];
        if (cur && cur.type_code !== type_code) {
            const used = (await req.dbPool.query(`
                SELECT EXISTS (SELECT 1 FROM gl_dimension_value WHERE type_code = $1)
                    OR EXISTS (SELECT 1 FROM gl_account_dim_rule WHERE type_code = $1) AS used`, [cur.type_code])).rows[0].used;
            if (used) return res.status(409).json({ error: `เปลี่ยนรหัส ${cur.type_code} ไม่ได้ เพราะมีค่ามิติหรือบัญชีที่อ้างอยู่แล้ว` });
        }
        const result = await req.dbPool.query(`
            INSERT INTO gl_dimension_type (slot_no, type_code, name_thai, name_eng, is_active, sort_order, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (slot_no) DO UPDATE SET
                type_code  = EXCLUDED.type_code,
                name_thai  = EXCLUDED.name_thai,
                name_eng   = EXCLUDED.name_eng,
                is_active  = EXCLUDED.is_active,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW()
            RETURNING *
        `, [slot_no, type_code, name_thai, name_eng || null,
            is_active !== undefined ? is_active : true,
            sort_order || slot_no]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = { fetchRows, fetchActiveRows, fetchRow, upsert };
