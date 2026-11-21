// controllers/im/imUomStandardConversionController.js
// อัตราแปลงมาตรฐานระหว่างหน่วยนับ ที่ไม่ขึ้นกับสินค้า (เช่น 1 กก. = 1000 กรัม, 1 โหล = 12 ชิ้น)
// ใช้ได้เฉพาะหน่วยประเภทเดียวกัน (im_uom.uom_dimension) — 1 คู่หน่วยเก็บทิศเดียว ตัวแปลงย้อนกลับคิดจาก 1/factor
// แก้ไขจากหน้าจอหน่วยนับ (ส่วน "อัตราแปลงมาตรฐาน" ของหน่วยที่เลือก)
'use strict';

const { ensureImUomTable } = require('./imUomController');

const ensureImUomStdConversionTable = async (client) => {
    await ensureImUomTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_uom_standard_conversion (
            id                 SERIAL PRIMARY KEY,
            from_uom_id        INTEGER NOT NULL REFERENCES im_uom(id),
            to_uom_id          INTEGER NOT NULL REFERENCES im_uom(id),
            conversion_factor  NUMERIC(18,6) NOT NULL CHECK (conversion_factor > 0),
            created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by         VARCHAR(100),
            updated_by         VARCHAR(100),
            CHECK (from_uom_id <> to_uom_id)
        )
    `);
    // คู่หน่วยเดียวกันห้ามซ้ำ ไม่ว่าทิศไหน
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_im_uom_std_conv_pair
        ON im_uom_standard_conversion (LEAST(from_uom_id, to_uom_id), GREATEST(from_uom_id, to_uom_id))`);
};

const SELECT_SQL = `
    SELECT c.*,
           f.uom_code AS from_uom_code, f.uom_name_th AS from_uom_name_th, f.uom_name_en AS from_uom_name_en,
           t.uom_code AS to_uom_code,   t.uom_name_th AS to_uom_name_th,   t.uom_name_en AS to_uom_name_en
    FROM im_uom_standard_conversion c
    JOIN im_uom f ON f.id = c.from_uom_id
    JOIN im_uom t ON t.id = c.to_uom_id`;

// GET /im_uom_standard_conversion[?uom_id=] — ทั้งหมด หรือเฉพาะคู่ที่มีหน่วยนี้
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImUomStdConversionTable(client);
        const uomId = req.query.uom_id ? Number(req.query.uom_id) : null;
        const result = uomId
            ? await client.query(`${SELECT_SQL} WHERE c.from_uom_id = $1 OR c.to_uom_id = $1 ORDER BY f.uom_code, t.uom_code`, [uomId])
            : await client.query(`${SELECT_SQL} ORDER BY f.uom_code, t.uom_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_uom_standard_conversion:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// ตรวจข้อมูล — คืนข้อความ error หรือ null
const validate = async (client, fromId, toId, factor) => {
    if (!fromId || !toId) return 'กรุณาเลือกหน่วยนับทั้งสองหน่วย';
    if (fromId === toId) return 'หน่วยต้นทางและปลายทางต้องไม่ใช่หน่วยเดียวกัน';
    if (!Number.isFinite(factor) || factor <= 0) return 'อัตราแปลงต้องมากกว่า 0';
    if (factor >= 1e12) return 'อัตราแปลงมากเกินไป';
    const u = await client.query(`SELECT id, uom_code, uom_dimension FROM im_uom WHERE id = ANY($1::int[])`, [[fromId, toId]]);
    if (u.rows.length !== 2) return 'ไม่พบหน่วยนับ';
    if (u.rows[0].uom_dimension !== u.rows[1].uom_dimension) {
        return `หน่วย ${u.rows[0].uom_code} และ ${u.rows[1].uom_code} เป็นคนละประเภท แปลงกันไม่ได้`;
    }
    return null;
};

const saveError = (res, error, label) => {
    if (error.code === '23505') return res.status(409).json({ message: 'คู่หน่วยนับนี้มีอัตราแปลงอยู่แล้ว' });
    console.error(`Error ${label} im_uom_standard_conversion:`, error);
    return res.status(500).json({ message: 'Internal server error' });
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const userName = req.headers.username || null;
    const fromId = Number(req.body.from_uom_id) || null;
    const toId = Number(req.body.to_uom_id) || null;
    const factor = Number(req.body.conversion_factor);
    try {
        await ensureImUomStdConversionTable(client);
        const err = await validate(client, fromId, toId, factor);
        if (err) return res.status(400).json({ message: err });
        const ins = await client.query(
            `INSERT INTO im_uom_standard_conversion (from_uom_id, to_uom_id, conversion_factor, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$4) RETURNING id`, [fromId, toId, factor, userName]);
        const row = await client.query(`${SELECT_SQL} WHERE c.id = $1`, [ins.rows[0].id]);
        res.status(201).json(row.rows[0]);
    } catch (error) {
        saveError(res, error, 'adding');
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const userName = req.headers.username || null;
    const fromId = Number(req.body.from_uom_id) || null;
    const toId = Number(req.body.to_uom_id) || null;
    const factor = Number(req.body.conversion_factor);
    try {
        await ensureImUomStdConversionTable(client);
        const err = await validate(client, fromId, toId, factor);
        if (err) return res.status(400).json({ message: err });
        const upd = await client.query(
            `UPDATE im_uom_standard_conversion SET from_uom_id = $1, to_uom_id = $2, conversion_factor = $3,
                    updated_by = $4, updated_at = NOW()
             WHERE id = $5 RETURNING id`, [fromId, toId, factor, userName, id]);
        if (upd.rows.length === 0) return res.status(404).json({ message: 'ไม่พบอัตราแปลง' });
        const row = await client.query(`${SELECT_SQL} WHERE c.id = $1`, [id]);
        res.status(200).json(row.rows[0]);
    } catch (error) {
        saveError(res, error, 'updating');
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImUomStdConversionTable(client);
        const result = await client.query(`DELETE FROM im_uom_standard_conversion WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบอัตราแปลง' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting im_uom_standard_conversion:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImUomStdConversionTable, fetchRows, addRow, updateRow, deleteRow };
