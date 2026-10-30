// controllers/im/imGlAccountSetupController.js
'use strict';

// Fixed structural mapping from IM sys_doc_type (the standard enum in imSysDocType,
// lib/sa/models/sa_anan_module.dart) -> which module/doc_code it pushes to when posted.
// Keyed by sys_doc_type, NOT doc_code — each sys_doc_type may have multiple doc_code
// instances configured under it (e.g. 'GRN1', 'GRN2' both sys_doc_type='10'), each with
// its own GL account setup row, but all sharing the same structural routing behavior:
//   10=GRN 15=RTS 20=CNS 25=DNS 30=DLN 35=RTC 40=CNC 45=DNC 60=ISS 70=TRF 80=AJS
// This is architecture, not admin-editable config — computed on read, never stored.
// target_doc_code = sys_doc_type ของเอกสาร AR/AP ปลายทาง, auto = สร้างเอกสารนั้นอัตโนมัติตอน Post (ต้องตั้งประเภทเอกสาร
// ปลายทางใน target_doc_id ก่อนใช้ — user-mandated 2026-10-30) ส่วน auto=false คือผู้ใช้ไปตั้งหนี้เองภายหลังที่ AR/AP
// AP: 10 ตั้งหนี้, 30 ลดหนี้, 50 เพิ่มหนี้ / AR: 10 ตั้งหนี้, 50 ลดหนี้, 30 เพิ่มหนี้ (apSysDocType/arSysDocType)
const DOC_TYPE_TARGET = {
    '10': { target_module: 'AP',   target_doc_code: '10', auto: false }, // รับสินค้า (GRN) -> AP ตั้งหนี้เองภายหลัง (ล้าง GR/IR)
    '11': { target_module: 'AP',   target_doc_code: '10', auto: true },  // รับสินค้า+ตั้งหนี้อัตโนมัติ -> AP ตั้งหนี้
    '12': { target_module: 'AP',   target_doc_code: '10', auto: true },  // รับสินค้า รอตั้งหนี้ -> AP ตั้งหนี้ตอน Post AP/GL
    '13': { target_module: 'NONE', target_doc_code: null, auto: false }, // รับฝากขาย -> ตั้งหนี้ผ่าน Consignment Settlement
    '15': { target_module: 'AP',   target_doc_code: '30', auto: true },  // คืนสินค้า (RTS)      -> AP ลดหนี้
    '20': { target_module: 'AP',   target_doc_code: '30', auto: true },  // ลดหนี้เจ้าหนี้ (CNS)  -> AP ลดหนี้
    '25': { target_module: 'AP',   target_doc_code: '50', auto: true },  // เพิ่มหนี้เจ้าหนี้ (DNS) -> AP เพิ่มหนี้
    '30': { target_module: 'AR',   target_doc_code: '10', auto: false }, // ส่งสินค้า (DLN) -> AR ตั้งหนี้เองภายหลัง
    '31': { target_module: 'AR',   target_doc_code: '10', auto: true },  // ส่งสินค้า+ตั้งหนี้อัตโนมัติ -> AR ตั้งหนี้
    '32': { target_module: 'AR',   target_doc_code: '10', auto: true },  // ส่งสินค้ารอตั้งหนี้ -> AR ตั้งหนี้ตอนออกใบแจ้งหนี้
    '35': { target_module: 'AR',   target_doc_code: '50', auto: true },  // รับคืนสินค้า (RTC)   -> AR ลดหนี้
    '40': { target_module: 'AR',   target_doc_code: '50', auto: true },  // ลดหนี้ลูกหนี้ (CNC)  -> AR ลดหนี้
    '45': { target_module: 'AR',   target_doc_code: '30', auto: true },  // เพิ่มหนี้ลูกหนี้ (DNC) -> AR เพิ่มหนี้
    '60': { target_module: 'NONE', target_doc_code: null, auto: false }, // เบิกสินค้า (ISS)
    '70': { target_module: 'NONE', target_doc_code: null, auto: false }, // โอนสินค้า (TRF)
    '80': { target_module: 'NONE', target_doc_code: null, auto: false }, // ปรับยอดสินค้า (AJS)
};
const TARGET_SYS_MODULE = { AR: '11', AP: '21' };

const ensureImGlAccountSetupTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_gl_account_setup (
            id                    SERIAL PRIMARY KEY,
            doc_code              VARCHAR(10) NOT NULL UNIQUE,
            gl_doc_id             INTEGER REFERENCES sa_module_document(id),
            inventory_account_id  INTEGER REFERENCES gl_account(id),
            cogs_account_id       INTEGER REFERENCES gl_account(id),
            variance_account_id   INTEGER REFERENCES gl_account(id),
            wip_account_id        INTEGER REFERENCES gl_account(id),
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by            VARCHAR(100),
            updated_by            VARCHAR(100)
        )
    `);
    // บัญชีพักรอใบกำกับ (GR/IR clearing) — ใช้เฉพาะ sys_doc_type='10' (GRN ไม่มีเลขที่อ้างอิง)
    await client.query(`ALTER TABLE im_gl_account_setup ADD COLUMN IF NOT EXISTS grir_account_id INTEGER REFERENCES gl_account(id)`).catch(() => {});
    // บัญชี VAT ต่อ doc_code — override ก่อน fallback ไปที่บัญชี VAT ของ AP/AR เอง (vat_input_account_id ฝั่งซื้อ
    // '11'/'12'/'15'/'20'/'25', vat_output_account_id ฝั่งขาย '31'/'32'/'35'/'40'/'45') ดู imTransactionController.js
    await client.query(`ALTER TABLE im_gl_account_setup ADD COLUMN IF NOT EXISTS vat_output_account_id INTEGER REFERENCES gl_account(id)`).catch(() => {});
    await client.query(`ALTER TABLE im_gl_account_setup ADD COLUMN IF NOT EXISTS vat_input_account_id INTEGER REFERENCES gl_account(id)`).catch(() => {});
    // บัญชีเจ้าหนี้ฝากขาย (Consignment Payable) — ใช้เฉพาะ sys_doc_type='13' (รับฝากขาย) แทน grir_account_id
    // เพราะยังไม่เป็นหนี้ AP จริงจนกว่าจะขายออก (settle เป็นก้อนภายหลัง ดู resolveCounterAccount ใน imTransactionController.js)
    await client.query(`ALTER TABLE im_gl_account_setup ADD COLUMN IF NOT EXISTS consignment_payable_account_id INTEGER REFERENCES gl_account(id)`).catch(() => {});
    // ประเภทเอกสาร AR/AP ที่สร้างอัตโนมัติตอน Post (ดู DOC_TYPE_TARGET / resolveTargetDoc)
    await client.query(`ALTER TABLE im_gl_account_setup ADD COLUMN IF NOT EXISTS target_doc_id INTEGER REFERENCES sa_module_document(id)`).catch(() => {});
};

// Driven by sa_module_document (sys_module='31') so the left panel always reflects the
// admin-configured IM doc types, same convention as ap_gl_account_setup.
const SETUP_SELECT = `
    SELECT
        d.doc_code,
        d.doc_name_thai,
        d.doc_name_eng,
        d.sys_doc_type,
        d.is_active           AS doc_is_active,
        s.id,
        s.inventory_account_id, inv.account_code  AS inventory_account_code, inv.account_name_thai  AS inventory_account_name,
        s.cogs_account_id,      cogs.account_code AS cogs_account_code,      cogs.account_name_thai AS cogs_account_name,
        s.variance_account_id,  var.account_code  AS variance_account_code, var.account_name_thai  AS variance_account_name,
        s.wip_account_id,       wip.account_code  AS wip_account_code,      wip.account_name_thai  AS wip_account_name,
        s.grir_account_id,      grir.account_code AS grir_account_code,     grir.account_name_thai AS grir_account_name,
        s.vat_output_account_id, vato.account_code AS vat_output_account_code, vato.account_name_thai AS vat_output_account_name,
        s.vat_input_account_id,  vati.account_code AS vat_input_account_code,  vati.account_name_thai AS vat_input_account_name,
        s.consignment_payable_account_id, consp.account_code AS consignment_payable_account_code, consp.account_name_thai AS consignment_payable_account_name,
        s.gl_doc_id,             gl_d.doc_code AS gl_doc_code,               gl_d.doc_name_thai AS gl_doc_name,
        s.target_doc_id,         tg_d.doc_code AS target_doc_code_sel,       tg_d.doc_name_thai AS target_doc_name_th, tg_d.doc_name_eng AS target_doc_name_en,
        s.created_at, s.updated_at, s.created_by, s.updated_by
    FROM sa_module_document d
    LEFT JOIN im_gl_account_setup s ON s.doc_code = d.doc_code
    LEFT JOIN gl_account inv         ON inv.id  = s.inventory_account_id
    LEFT JOIN gl_account cogs        ON cogs.id = s.cogs_account_id
    LEFT JOIN gl_account var         ON var.id  = s.variance_account_id
    LEFT JOIN gl_account wip         ON wip.id  = s.wip_account_id
    LEFT JOIN gl_account grir        ON grir.id = s.grir_account_id
    LEFT JOIN gl_account vato        ON vato.id = s.vat_output_account_id
    LEFT JOIN gl_account vati        ON vati.id = s.vat_input_account_id
    LEFT JOIN gl_account consp       ON consp.id = s.consignment_payable_account_id
    LEFT JOIN sa_module_document gl_d ON gl_d.id = s.gl_doc_id
    LEFT JOIN sa_module_document tg_d ON tg_d.id = s.target_doc_id
    WHERE d.sys_module = '31'
      AND d.is_doc_type = true
`;

const withTarget = (row) => ({
    ...row,
    target_module: DOC_TYPE_TARGET[row.sys_doc_type]?.target_module ?? 'NONE',
    target_doc_code: DOC_TYPE_TARGET[row.sys_doc_type]?.target_doc_code ?? null,
    target_auto: DOC_TYPE_TARGET[row.sys_doc_type]?.auto ?? false,
});

// GET all IM doc_codes with setup data
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImGlAccountSetupTable(client);
        const result = await client.query(`${SETUP_SELECT} ORDER BY d.sort_order, d.doc_code`);
        res.status(200).json(result.rows.map(withTarget));
    } catch (error) {
        console.error('Error fetching im_gl_account_setup:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET one doc_code
const fetchRow = async (req, res) => {
    const { doc_code } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImGlAccountSetupTable(client);
        const result = await client.query(`${SETUP_SELECT} AND d.doc_code = $1`, [doc_code]);
        if (result.rows.length === 0) return res.status(404).json({ message: `doc_code '${doc_code}' ไม่พบในระบบ IM` });
        res.status(200).json(withTarget(result.rows[0]));
    } catch (error) {
        console.error('Error fetching im_gl_account_setup row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// POST upsert by doc_code — only the GL account fields + gl_doc_id are editable;
// target_module/target_doc_code are derived (see withTarget), never stored.
const upsertRow = async (req, res) => {
    const { doc_code } = req.params;
    const {
        inventory_account_id, cogs_account_id, variance_account_id, wip_account_id, grir_account_id,
        vat_output_account_id, vat_input_account_id, consignment_payable_account_id, gl_doc_id, target_doc_id,
    } = req.body;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await ensureImGlAccountSetupTable(client);
        const docCheck = await client.query(
            `SELECT doc_code, sys_doc_type FROM sa_module_document WHERE doc_code = $1 AND sys_module = '31' AND is_doc_type = true`,
            [doc_code]
        );
        if (docCheck.rows.length === 0) {
            return res.status(404).json({ message: `doc_code '${doc_code}' ไม่พบในระบบ IM` });
        }
        // ประเภทเอกสาร AR/AP ปลายทาง — เก็บเฉพาะประเภทที่สร้างเอกสารอัตโนมัติ และต้องตรงโมดูล/sys_doc_type ที่กำหนด
        const target = DOC_TYPE_TARGET[docCheck.rows[0].sys_doc_type];
        let targetDocId = null;
        if (target?.auto && target_doc_id) {
            const t = await client.query(
                `SELECT id FROM sa_module_document WHERE id = $1 AND sys_module = $2 AND sys_doc_type = $3 AND is_doc_type = true`,
                [target_doc_id, TARGET_SYS_MODULE[target.target_module], target.target_doc_code]);
            if (t.rows.length === 0) return res.status(400).json({ message: 'ประเภทเอกสาร AR/AP ที่เลือกไม่ตรงกับประเภทเอกสาร IM นี้' });
            targetDocId = t.rows[0].id;
        }

        await client.query(
            `INSERT INTO im_gl_account_setup
                (doc_code, inventory_account_id, cogs_account_id, variance_account_id, wip_account_id, grir_account_id,
                 vat_output_account_id, vat_input_account_id, consignment_payable_account_id, gl_doc_id, created_by, updated_by, target_doc_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)
             ON CONFLICT (doc_code) DO UPDATE SET
                inventory_account_id  = EXCLUDED.inventory_account_id,
                cogs_account_id       = EXCLUDED.cogs_account_id,
                variance_account_id   = EXCLUDED.variance_account_id,
                wip_account_id        = EXCLUDED.wip_account_id,
                grir_account_id       = EXCLUDED.grir_account_id,
                vat_output_account_id = EXCLUDED.vat_output_account_id,
                vat_input_account_id  = EXCLUDED.vat_input_account_id,
                consignment_payable_account_id = EXCLUDED.consignment_payable_account_id,
                gl_doc_id             = EXCLUDED.gl_doc_id,
                target_doc_id         = EXCLUDED.target_doc_id,
                updated_by            = EXCLUDED.updated_by,
                updated_at            = NOW()`,
            [doc_code, inventory_account_id || null, cogs_account_id || null, variance_account_id || null,
             wip_account_id || null, grir_account_id || null, vat_output_account_id || null, vat_input_account_id || null,
             consignment_payable_account_id || null, gl_doc_id || null, userName, targetDocId]
        );

        const updated = await client.query(`${SETUP_SELECT} AND d.doc_code = $1`, [doc_code]);
        res.status(200).json(withTarget(updated.rows[0]));
    } catch (error) {
        console.error('Error upserting im_gl_account_setup:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// สำหรับใช้ภายใน imTransactionController (เมื่อเริ่มพัฒนาโมดูลธุรกรรม)
const fetchSetupByDocCode = async (pool, docCode) => {
    const result = await pool.query(`SELECT * FROM im_gl_account_setup WHERE doc_code = $1`, [docCode]);
    return result.rows[0] || null;
};

// ประเภทเอกสาร AR/AP ที่เอกสาร IM (doc_code) สร้างอัตโนมัติ — ต้องตั้งในหน้าตั้งค่าบัญชี IM ก่อนใช้ ไม่ fallback
// (user-mandated 2026-10-30) คืน { id, doc_code } ของ sa_module_document ปลายทาง
const resolveTargetDoc = async (client, imDocCode) => {
    const r = await client.query(`
        SELECT d.sys_doc_type, t.id AS t_id, t.doc_code AS t_code, t.sys_module AS t_module,
               t.sys_doc_type AS t_type, t.is_active AS t_active
          FROM sa_module_document d
          LEFT JOIN im_gl_account_setup s ON s.doc_code = d.doc_code
          LEFT JOIN sa_module_document t ON t.id = s.target_doc_id
         WHERE d.doc_code = $1 AND d.sys_module = '31' LIMIT 1`, [imDocCode]);
    const row = r.rows[0];
    const target = row && DOC_TYPE_TARGET[row.sys_doc_type];
    if (!target?.auto) throw new Error(`ประเภทเอกสาร ${imDocCode} ไม่ได้สร้างเอกสาร AR/AP อัตโนมัติ`);
    const label = `ประเภทเอกสาร ${target.target_module}`;
    if (!row.t_id) throw new Error(`ยังไม่ได้ตั้งค่า${label} ที่สร้างอัตโนมัติ สำหรับ ${imDocCode} — ตั้งค่าที่หน้าตั้งค่าบัญชี IM`);
    if (row.t_module !== TARGET_SYS_MODULE[target.target_module] || row.t_type !== target.target_doc_code) {
        throw new Error(`${label} ${row.t_code} ที่ตั้งไว้สำหรับ ${imDocCode} ไม่ตรงประเภท — แก้ที่หน้าตั้งค่าบัญชี IM`);
    }
    if (!row.t_active) throw new Error(`${label} ${row.t_code} ที่ตั้งไว้สำหรับ ${imDocCode} ถูกปิดใช้งาน — แก้ที่หน้าตั้งค่าบัญชี IM`);
    return { id: row.t_id, doc_code: row.t_code };
};

module.exports = { ensureImGlAccountSetupTable, fetchRows, fetchRow, upsertRow, fetchSetupByDocCode, resolveTargetDoc, DOC_TYPE_TARGET };
