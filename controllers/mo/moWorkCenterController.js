// controllers/mo/moWorkCenterController.js — ศูนย์งาน (Work Center) สำหรับ Routing ของสูตรการผลิต (mo_bom)
// และใบสั่งผลิต (mo_header) — เก็บอัตราค่าแรง/ค่าเครื่องจักร/overhead ต่อชั่วโมง ใช้คำนวณต้นทุนตอนรับสินค้าเข้าคลัง
// จากการผลิต (costing_mode='ROUTING') มิเรอร์ imPriceGroupController.js ทุกประการ — เป็นข้อมูลหลักระดับ "อัตรา
// ค่าใช้จ่าย" ควรจำกัดสิทธิ์แก้ไขไว้ที่กลุ่มผู้ใช้ Costing เท่านั้น (ดูแผนออกแบบโมดูล MO)
'use strict';

const ensureMoWorkCenterTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS mo_work_center (
            id                      SERIAL PRIMARY KEY,
            work_center_code        VARCHAR(20)  NOT NULL UNIQUE,
            work_center_name_th     VARCHAR(100) NOT NULL,
            work_center_name_en     VARCHAR(100),
            labor_rate_per_hour     NUMERIC(18,4) NOT NULL DEFAULT 0,
            machine_rate_per_hour   NUMERIC(18,4) NOT NULL DEFAULT 0,
            overhead_rate_per_hour  NUMERIC(18,4) NOT NULL DEFAULT 0,
            is_active               BOOLEAN      NOT NULL DEFAULT true,
            created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by              VARCHAR(100),
            updated_by              VARCHAR(100)
        )
    `);
};

// GET all
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureMoWorkCenterTable(client);
        const result = await client.query(`SELECT * FROM mo_work_center ORDER BY work_center_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching mo_work_center:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchActiveRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureMoWorkCenterTable(client);
        const result = await client.query(`SELECT * FROM mo_work_center WHERE is_active = true ORDER BY work_center_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching active mo_work_center:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureMoWorkCenterTable(client);
        const result = await client.query(`SELECT * FROM mo_work_center WHERE id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบศูนย์งาน' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching mo_work_center row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const {
        work_center_code, work_center_name_th, work_center_name_en,
        labor_rate_per_hour, machine_rate_per_hour, overhead_rate_per_hour, is_active,
    } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureMoWorkCenterTable(client);
        const result = await client.query(
            `INSERT INTO mo_work_center
                (work_center_code, work_center_name_th, work_center_name_en,
                 labor_rate_per_hour, machine_rate_per_hour, overhead_rate_per_hour, is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
             RETURNING *`,
            [
                (work_center_code || '').trim().toUpperCase(), work_center_name_th || '', work_center_name_en || null,
                labor_rate_per_hour ?? 0, machine_rate_per_hour ?? 0, overhead_rate_per_hour ?? 0,
                is_active ?? true, userName,
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `รหัสศูนย์งาน '${work_center_code}' มีอยู่แล้ว` });
        console.error('Error adding mo_work_center:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const {
        work_center_name_th, work_center_name_en,
        labor_rate_per_hour, machine_rate_per_hour, overhead_rate_per_hour, is_active,
    } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureMoWorkCenterTable(client);
        const result = await client.query(
            `UPDATE mo_work_center SET
                work_center_name_th    = $1,
                work_center_name_en    = $2,
                labor_rate_per_hour     = $3,
                machine_rate_per_hour   = $4,
                overhead_rate_per_hour  = $5,
                is_active               = $6,
                updated_by              = $7,
                updated_at              = NOW()
             WHERE id = $8
             RETURNING *`,
            [
                work_center_name_th || '', work_center_name_en || null,
                labor_rate_per_hour ?? 0, machine_rate_per_hour ?? 0, overhead_rate_per_hour ?? 0,
                is_active ?? true, userName, id,
            ]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบศูนย์งาน' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating mo_work_center:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureMoWorkCenterTable(client);
        const result = await client.query(`DELETE FROM mo_work_center WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบศูนย์งาน' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting mo_work_center:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureMoWorkCenterTable, fetchRows, fetchActiveRows, fetchRow, addRow, updateRow, deleteRow };
