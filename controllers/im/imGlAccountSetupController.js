// controllers/im/imGlAccountSetupController.js
'use strict';

// Fixed structural mapping from IM sys_doc_type (the standard enum in imSysDocType,
// lib/sa/models/sa_anan_module.dart) -> which module/doc_code it pushes to when posted.
// Keyed by sys_doc_type, NOT doc_code — each sys_doc_type may have multiple doc_code
// instances configured under it (e.g. 'GRN1', 'GRN2' both sys_doc_type='10'), each with
// its own GL account setup row, but all sharing the same structural routing behavior:
//   10=GRN 15=RTS 20=CNS 25=DNS 30=DLN 35=RTC 40=CNC 45=DNC 60=ISS 70=TRF 80=AJS
// This is architecture, not admin-editable config — computed on read, never stored.
const DOC_TYPE_TARGET = {
    '10': { target_module: 'AP',   target_doc_code: '10' }, // รับสินค้า (GRN, ไม่มีเลขที่อ้างอิง) -> AP ตั้งหนี้เองภายหลัง
    '11': { target_module: 'AP',   target_doc_code: '10' }, // รับสินค้า+ตั้งหนี้อัตโนมัติ (GRN Billing) -> AP Billing
    '15': { target_module: 'AP',   target_doc_code: '50' }, // คืนสินค้า (RTS)      -> AP CN
    '20': { target_module: 'AP',   target_doc_code: '50' }, // ลดหนี้เจ้าหนี้ (CNS)  -> AP CN
    '25': { target_module: 'AP',   target_doc_code: '30' }, // เพิ่มหนี้เจ้าหนี้ (DNS) -> AP DN
    '30': { target_module: 'AR',   target_doc_code: '10' }, // ส่งสินค้า (DLN)      -> AR Billing
    '35': { target_module: 'AR',   target_doc_code: '50' }, // รับคืนสินค้า (RTC)   -> AR CN
    '40': { target_module: 'AR',   target_doc_code: '50' }, // ลดหนี้ลูกหนี้ (CNC)  -> AR CN
    '45': { target_module: 'AR',   target_doc_code: '30' }, // เพิ่มหนี้ลูกหนี้ (DNC) -> AR DN
    '60': { target_module: 'NONE', target_doc_code: null }, // เบิกสินค้า (ISS)
    '70': { target_module: 'NONE', target_doc_code: null }, // โอนสินค้า (TRF)
    '80': { target_module: 'NONE', target_doc_code: null }, // ปรับยอดสินค้า (AJS)
};

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
        s.gl_doc_id,             gl_d.doc_code AS gl_doc_code,               gl_d.doc_name_thai AS gl_doc_name,
        s.created_at, s.updated_at, s.created_by, s.updated_by
    FROM sa_module_document d
    LEFT JOIN im_gl_account_setup s ON s.doc_code = d.doc_code
    LEFT JOIN gl_account inv         ON inv.id  = s.inventory_account_id
    LEFT JOIN gl_account cogs        ON cogs.id = s.cogs_account_id
    LEFT JOIN gl_account var         ON var.id  = s.variance_account_id
    LEFT JOIN gl_account wip         ON wip.id  = s.wip_account_id
    LEFT JOIN gl_account grir        ON grir.id = s.grir_account_id
    LEFT JOIN sa_module_document gl_d ON gl_d.id = s.gl_doc_id
    WHERE d.sys_module = '31'
      AND d.is_doc_type = true
`;

const withTarget = (row) => ({
    ...row,
    target_module: DOC_TYPE_TARGET[row.sys_doc_type]?.target_module ?? 'NONE',
    target_doc_code: DOC_TYPE_TARGET[row.sys_doc_type]?.target_doc_code ?? null,
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
    const { inventory_account_id, cogs_account_id, variance_account_id, wip_account_id, grir_account_id, gl_doc_id } = req.body;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await ensureImGlAccountSetupTable(client);
        const docCheck = await client.query(
            `SELECT doc_code FROM sa_module_document WHERE doc_code = $1 AND sys_module = '31' AND is_doc_type = true`,
            [doc_code]
        );
        if (docCheck.rows.length === 0) {
            return res.status(404).json({ message: `doc_code '${doc_code}' ไม่พบในระบบ IM` });
        }

        await client.query(
            `INSERT INTO im_gl_account_setup
                (doc_code, inventory_account_id, cogs_account_id, variance_account_id, wip_account_id, grir_account_id, gl_doc_id, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
             ON CONFLICT (doc_code) DO UPDATE SET
                inventory_account_id = EXCLUDED.inventory_account_id,
                cogs_account_id      = EXCLUDED.cogs_account_id,
                variance_account_id  = EXCLUDED.variance_account_id,
                wip_account_id       = EXCLUDED.wip_account_id,
                grir_account_id      = EXCLUDED.grir_account_id,
                gl_doc_id            = EXCLUDED.gl_doc_id,
                updated_by           = EXCLUDED.updated_by,
                updated_at           = NOW()`,
            [doc_code, inventory_account_id || null, cogs_account_id || null, variance_account_id || null,
             wip_account_id || null, grir_account_id || null, gl_doc_id || null, userName]
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

module.exports = { ensureImGlAccountSetupTable, fetchRows, fetchRow, upsertRow, fetchSetupByDocCode, DOC_TYPE_TARGET };
