// controllers/im/imUomController.js
'use strict';

const ensureImUomTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_uom (
            id            SERIAL PRIMARY KEY,
            uom_code      VARCHAR(10)  NOT NULL UNIQUE,
            uom_name_th   VARCHAR(100) NOT NULL,
            uom_name_en   VARCHAR(100),
            is_active     BOOLEAN      NOT NULL DEFAULT true,
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by    VARCHAR(100),
            updated_by    VARCHAR(100)
        )
    `);
    // ประเภทหน่วย + ทศนิยมที่ยอมให้ป้อน (หน่วยนับหลายหน่วย ขั้นที่ 1)
    await client.query(`ALTER TABLE im_uom ADD COLUMN IF NOT EXISTS uom_dimension  VARCHAR(10) NOT NULL DEFAULT 'COUNT'`);
    await client.query(`ALTER TABLE im_uom ADD COLUMN IF NOT EXISTS decimal_places SMALLINT    NOT NULL DEFAULT 0`);
    await client.query(`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'im_uom_dimension_chk') THEN
                ALTER TABLE im_uom ADD CONSTRAINT im_uom_dimension_chk
                    CHECK (uom_dimension IN ('COUNT','WEIGHT','LENGTH','VOLUME','AREA','TIME'));
            END IF;
            -- ทศนิยม 0-6 (เดิม 0-4) — สร้าง constraint ใหม่ถ้ายังเป็นของเดิม
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'im_uom_decimal_places_chk'
                        AND pg_get_constraintdef(oid) NOT LIKE '%6%') THEN
                ALTER TABLE im_uom DROP CONSTRAINT im_uom_decimal_places_chk;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'im_uom_decimal_places_chk') THEN
                ALTER TABLE im_uom ADD CONSTRAINT im_uom_decimal_places_chk CHECK (decimal_places BETWEEN 0 AND 6);
            END IF;
        END $$`);
};

const UOM_DIMENSIONS = ['COUNT', 'WEIGHT', 'LENGTH', 'VOLUME', 'AREA', 'TIME'];

// ตรวจ + แปลงค่า dimension/decimals จาก body — คืน { error } หรือ { dimension, decimals }
const parseUomSpec = (body) => {
    const dimension = String(body.uom_dimension || 'COUNT').trim().toUpperCase();
    if (!UOM_DIMENSIONS.includes(dimension)) return { error: `ประเภทหน่วยไม่ถูกต้อง: ${dimension}` };
    const decimals = body.decimal_places == null || body.decimal_places === '' ? 0 : Number(body.decimal_places);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) return { error: 'จำนวนทศนิยมต้องเป็น 0-6' };
    return { dimension, decimals };
};

// GET all
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImUomTable(client);
        const result = await client.query(`SELECT * FROM im_uom ORDER BY uom_code`);
        // with_usage=1 (หน้าจอหน่วยนับ): จำนวนสินค้าที่ใช้เป็นหน่วยหลัก/หน่วยรอง
        if (['1', 'true'].includes(String(req.query.with_usage || ''))) {
            const counts = await require('./imUomSummaryController').usageCounts(client);
            return res.status(200).json(result.rows.map(r => ({ ...r, base_item_count: counts[r.id]?.base_count || 0, alt_item_count: counts[r.id]?.alt_count || 0 })));
        }
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_uom:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchActiveRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImUomTable(client);
        const result = await client.query(`SELECT * FROM im_uom WHERE is_active = true ORDER BY uom_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching active im_uom:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImUomTable(client);
        const result = await client.query(`SELECT * FROM im_uom WHERE id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบหน่วยนับ' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching im_uom row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const { uom_code, uom_name_th, uom_name_en, is_active } = req.body;
    const userName = req.headers.username || null;
    const spec = parseUomSpec(req.body);
    if (spec.error) { client.release(); return res.status(400).json({ message: spec.error }); }
    try {
        await ensureImUomTable(client);
        const result = await client.query(
            `INSERT INTO im_uom (uom_code, uom_name_th, uom_name_en, is_active, uom_dimension, decimal_places, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
             RETURNING *`,
            [(uom_code || '').trim().toUpperCase(), uom_name_th || '', uom_name_en || null, is_active ?? true, spec.dimension, spec.decimals, userName]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `รหัสหน่วยนับ '${uom_code}' มีอยู่แล้ว` });
        console.error('Error adding im_uom:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const { uom_name_th, uom_name_en, is_active } = req.body;
    const userName = req.headers.username || null;
    const spec = parseUomSpec(req.body);
    if (spec.error) { client.release(); return res.status(400).json({ message: spec.error }); }
    try {
        await ensureImUomTable(client);
        // เปลี่ยนประเภทหน่วยไม่ได้ ถ้ามีอัตราแปลงมาตรฐานกับหน่วยอีกประเภทอยู่
        const stdReg = await client.query(`SELECT to_regclass('public.im_uom_standard_conversion') AS reg`);
        if (stdReg.rows[0].reg) {
            const clash = await client.query(
                `SELECT u.uom_code FROM im_uom_standard_conversion c
                   JOIN im_uom u ON u.id = CASE WHEN c.from_uom_id = $1 THEN c.to_uom_id ELSE c.from_uom_id END
                  WHERE (c.from_uom_id = $1 OR c.to_uom_id = $1) AND u.uom_dimension <> $2`, [id, spec.dimension]);
            if (clash.rows.length > 0) {
                return res.status(409).json({ message: `เปลี่ยนประเภทหน่วยไม่ได้ เนื่องจากมีอัตราแปลงมาตรฐานกับหน่วย ${clash.rows.map(r => r.uom_code).join(', ')} — ลบอัตราแปลงก่อน` });
            }
        }
        const result = await client.query(
            `UPDATE im_uom SET
                uom_name_th = $1, uom_name_en = $2, is_active = $3,
                uom_dimension = $4, decimal_places = $5,
                updated_by  = $6, updated_at  = NOW()
             WHERE id = $7
             RETURNING *`,
            [uom_name_th || '', uom_name_en || null, is_active ?? true, spec.dimension, spec.decimals, userName, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบหน่วยนับ' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating im_uom:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImUomTable(client);
        const tableCheck = await client.query(`SELECT to_regclass('public.im_item') AS reg`);
        if (tableCheck.rows[0].reg) {
            const inUse = await client.query(`SELECT 1 FROM im_item WHERE base_uom_id = $1 LIMIT 1`, [id]);
            if (inUse.rows.length > 0) {
                return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีสินค้าอ้างอิงหน่วยนับนี้' });
            }
        }
        const result = await client.query(`DELETE FROM im_uom WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบหน่วยนับ' });
        res.status(204).send();
    } catch (error) {
        if (error.code === '23503') return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีข้อมูลอ้างอิงหน่วยนับนี้' });
        console.error('Error deleting im_uom:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImUomTable, UOM_DIMENSIONS, fetchRows, fetchActiveRows, fetchRow, addRow, updateRow, deleteRow };
