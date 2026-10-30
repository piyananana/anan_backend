// controllers/mo/moGlAccountSetupController.js — บัญชีของประเภทเอกสารใบสั่งผลิต (sys_module='61')
// ชุดบัญชีเดียวต่อใบสั่งผลิต (user-approved 2026-10-30): MOI/MOR ที่อ้างอิงใบสั่งผลิต, บันทึกเวลาปฏิบัติงาน และปิดใบสั่งผลิต
// ใช้บัญชี WIP/ผลต่าง/ค่าแรงและโสหุ้ยที่ปันเข้างาน จากที่นี่ทั้งหมด เพื่อให้ WIP ของใบสั่งผลิตอยู่ในบัญชีเดียวเสมอ
'use strict';

const ensureMoGlAccountSetupTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS mo_gl_account_setup (
            id                          SERIAL PRIMARY KEY,
            doc_code                    VARCHAR(10) NOT NULL UNIQUE,
            gl_doc_id                   INTEGER REFERENCES sa_module_document(id), -- เอกสาร GL ของบันทึกเวลา/ปิดใบสั่งผลิต
            wip_account_id              INTEGER REFERENCES gl_account(id),
            variance_account_id         INTEGER REFERENCES gl_account(id),        -- ผลต่างต้นทุนการผลิต (มาตรฐาน/ปิดใบสั่งผลิต)
            applied_labor_account_id    INTEGER REFERENCES gl_account(id),        -- ค่าแรงที่ปันเข้างาน
            applied_overhead_account_id INTEGER REFERENCES gl_account(id),        -- โสหุ้ยการผลิต (รวมเครื่องจักร) ที่ปันเข้างาน
            created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by                  VARCHAR(100),
            updated_by                  VARCHAR(100)
        )
    `);
    // ครั้งแรก: ตั้งค่าเริ่มต้นจากบัญชี WIP/ผลต่าง/เอกสาร GL ของ MOR (sys_doc_type '95') ที่ใช้อยู่เดิม ให้ใบสั่งผลิตเดิมทำงานต่อได้
    const has = await client.query(`SELECT 1 FROM mo_gl_account_setup LIMIT 1`);
    if (has.rows.length === 0) {
        await client.query(`
            INSERT INTO mo_gl_account_setup (doc_code, gl_doc_id, wip_account_id, variance_account_id, created_by, updated_by)
            SELECT d.doc_code, s.gl_doc_id, s.wip_account_id, s.variance_account_id, 'system', 'system'
              FROM sa_module_document d
              CROSS JOIN LATERAL (
                  SELECT s.* FROM im_gl_account_setup s JOIN sa_module_document m ON m.doc_code = s.doc_code
                   WHERE m.sys_module = '31' AND m.sys_doc_type = '95' AND m.is_doc_type = true AND s.wip_account_id IS NOT NULL
                   ORDER BY m.sort_order LIMIT 1) s
             WHERE d.sys_module = '61' AND d.is_doc_type = true
            ON CONFLICT (doc_code) DO NOTHING
        `).catch(() => {}); // im_gl_account_setup ยังไม่มี = ไม่มีอะไรให้คัดลอก
    }
};

const ACC = (alias, col) => `s.${col}, ${alias}.account_code AS ${col.replace('_id', '_code')}, ${alias}.account_name_thai AS ${col.replace('_id', '_name')}`;
const SETUP_SELECT = `
    SELECT d.doc_code, d.doc_name_thai, d.doc_name_eng, d.sys_doc_type, d.is_active AS doc_is_active,
           s.id,
           ${ACC('wip', 'wip_account_id')},
           ${ACC('var', 'variance_account_id')},
           ${ACC('lab', 'applied_labor_account_id')},
           ${ACC('ovh', 'applied_overhead_account_id')},
           s.gl_doc_id, gl_d.doc_code AS gl_doc_code, gl_d.doc_name_thai AS gl_doc_name,
           s.updated_at, s.updated_by
      FROM sa_module_document d
      LEFT JOIN mo_gl_account_setup s ON s.doc_code = d.doc_code
      LEFT JOIN gl_account wip ON wip.id = s.wip_account_id
      LEFT JOIN gl_account var ON var.id = s.variance_account_id
      LEFT JOIN gl_account lab ON lab.id = s.applied_labor_account_id
      LEFT JOIN gl_account ovh ON ovh.id = s.applied_overhead_account_id
      LEFT JOIN sa_module_document gl_d ON gl_d.id = s.gl_doc_id
     WHERE d.sys_module = '61' AND d.is_doc_type = true
`;

const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureMoGlAccountSetupTable(client);
        const r = await client.query(`${SETUP_SELECT} ORDER BY d.sort_order, d.doc_code`);
        res.status(200).json(r.rows);
    } catch (error) {
        console.error('Error fetching mo_gl_account_setup:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const upsertRow = async (req, res) => {
    const { doc_code } = req.params;
    const { gl_doc_id, wip_account_id, variance_account_id, applied_labor_account_id, applied_overhead_account_id } = req.body;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await ensureMoGlAccountSetupTable(client);
        const doc = await client.query(
            `SELECT 1 FROM sa_module_document WHERE doc_code = $1 AND sys_module = '61' AND is_doc_type = true`, [doc_code]);
        if (doc.rows.length === 0) return res.status(404).json({ message: `doc_code '${doc_code}' ไม่พบในระบบใบสั่งผลิต` });
        await client.query(`
            INSERT INTO mo_gl_account_setup
                (doc_code, gl_doc_id, wip_account_id, variance_account_id, applied_labor_account_id, applied_overhead_account_id, created_by, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
            ON CONFLICT (doc_code) DO UPDATE SET
                gl_doc_id = EXCLUDED.gl_doc_id, wip_account_id = EXCLUDED.wip_account_id,
                variance_account_id = EXCLUDED.variance_account_id,
                applied_labor_account_id = EXCLUDED.applied_labor_account_id,
                applied_overhead_account_id = EXCLUDED.applied_overhead_account_id,
                updated_by = EXCLUDED.updated_by, updated_at = NOW()
        `, [doc_code, gl_doc_id || null, wip_account_id || null, variance_account_id || null,
            applied_labor_account_id || null, applied_overhead_account_id || null, userName]);
        const r = await client.query(`${SETUP_SELECT} AND d.doc_code = $1`, [doc_code]);
        res.status(200).json(r.rows[0]);
    } catch (error) {
        console.error('Error upserting mo_gl_account_setup:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// ชุดบัญชีของใบสั่งผลิต (ตามประเภทเอกสารของใบสั่งผลิต) — required = ชื่อคอลัมน์ที่ต้องมีค่า ไม่งั้น throw
const LABELS = {
    gl_doc_id: 'ประเภทเอกสาร GL', wip_account_id: 'บัญชีงานระหว่างผลิต (WIP)', variance_account_id: 'บัญชีผลต่างต้นทุนการผลิต',
    applied_labor_account_id: 'บัญชีค่าแรงที่ปันเข้างาน', applied_overhead_account_id: 'บัญชีโสหุ้ยการผลิตที่ปันเข้างาน',
};
const LABELS_EN = {
    gl_doc_id: 'GL document type', wip_account_id: 'WIP account', variance_account_id: 'manufacturing cost variance account',
    applied_labor_account_id: 'applied labor account', applied_overhead_account_id: 'applied overhead account',
};
const fetchMoGlSetup = async (client, moId, required = []) => {
    await ensureMoGlAccountSetupTable(client);
    const r = await client.query(`
        SELECT d.doc_code, s.* FROM mo_header h
          JOIN sa_module_document d ON d.id = h.doc_id
          LEFT JOIN mo_gl_account_setup s ON s.doc_code = d.doc_code
         WHERE h.id = $1`, [moId]);
    const row = r.rows[0];
    if (!row) throw new Error('ไม่พบใบสั่งผลิต');
    const missing = required.filter(k => !row[k]);
    if (missing.length) {
        throw new Error(`ยังไม่ได้ตั้งค่า${missing.map(k => LABELS[k]).join(', ')} ของประเภทเอกสารใบสั่งผลิต ${row.doc_code} — ตั้งค่าที่หน้าตั้งค่าบัญชีใบสั่งผลิต`);
    }
    return row;
};

module.exports = { ensureMoGlAccountSetupTable, fetchRows, upsertRow, fetchMoGlSetup, MO_GL_LABELS: LABELS, MO_GL_LABELS_EN: LABELS_EN };
