// controllers/im/imGlAccountSetupController.js
'use strict';

// Fixed structural mapping from IM doc_code (sa_module_document.doc_code, e.g. 'GRN') ->
// which module/doc_code it pushes to when posted. Keyed by the same doc_code values
// configured in sa_module_document for sys_module='31' (see sys_doc_type alongside each
// for cross-reference against imSysDocType in lib/sa/models/sa_anan_module.dart):
//   GRN(10) RTS(15) CNS(20) DNS(25) DLN(30) RTC(35) CNC(40) DNC(45) ISS(60) TRF(70) AJS(80)
// This is architecture, not admin-editable config — computed on read, never stored.
const DOC_TYPE_TARGET = {
    'GRN': { target_module: 'AP',   target_doc_code: '10' }, // รับสินค้า          -> AP Billing
    'RTS': { target_module: 'AP',   target_doc_code: '50' }, // คืนสินค้า          -> AP CN
    'CNS': { target_module: 'AP',   target_doc_code: '50' }, // ลดหนี้เจ้าหนี้      -> AP CN
    'DNS': { target_module: 'AP',   target_doc_code: '30' }, // เพิ่มหนี้เจ้าหนี้    -> AP DN
    'DLN': { target_module: 'AR',   target_doc_code: '10' }, // ส่งสินค้า (ขาย)     -> AR Billing
    'RTC': { target_module: 'AR',   target_doc_code: '50' }, // รับคืนสินค้า        -> AR CN
    'CNC': { target_module: 'AR',   target_doc_code: '50' }, // ลดหนี้ลูกหนี้       -> AR CN
    'DNC': { target_module: 'AR',   target_doc_code: '30' }, // เพิ่มหนี้ลูกหนี้     -> AR DN
    'ISS': { target_module: 'NONE', target_doc_code: null }, // เบิกสินค้า
    'TRF': { target_module: 'NONE', target_doc_code: null }, // โอนสินค้า
    'AJS': { target_module: 'NONE', target_doc_code: null }, // ปรับยอดสินค้า
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
        s.gl_doc_id,             gl_d.doc_code AS gl_doc_code,               gl_d.doc_name_thai AS gl_doc_name,
        s.created_at, s.updated_at, s.created_by, s.updated_by
    FROM sa_module_document d
    LEFT JOIN im_gl_account_setup s ON s.doc_code = d.doc_code
    LEFT JOIN gl_account inv         ON inv.id  = s.inventory_account_id
    LEFT JOIN gl_account cogs        ON cogs.id = s.cogs_account_id
    LEFT JOIN gl_account var         ON var.id  = s.variance_account_id
    LEFT JOIN gl_account wip         ON wip.id  = s.wip_account_id
    LEFT JOIN sa_module_document gl_d ON gl_d.id = s.gl_doc_id
    WHERE d.sys_module = '31'
      AND d.is_doc_type = true
`;

const withTarget = (row) => ({
    ...row,
    target_module: DOC_TYPE_TARGET[row.doc_code]?.target_module ?? 'NONE',
    target_doc_code: DOC_TYPE_TARGET[row.doc_code]?.target_doc_code ?? null,
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
    const { inventory_account_id, cogs_account_id, variance_account_id, wip_account_id, gl_doc_id } = req.body;
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
                (doc_code, inventory_account_id, cogs_account_id, variance_account_id, wip_account_id, gl_doc_id, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
             ON CONFLICT (doc_code) DO UPDATE SET
                inventory_account_id = EXCLUDED.inventory_account_id,
                cogs_account_id      = EXCLUDED.cogs_account_id,
                variance_account_id  = EXCLUDED.variance_account_id,
                wip_account_id       = EXCLUDED.wip_account_id,
                gl_doc_id            = EXCLUDED.gl_doc_id,
                updated_by           = EXCLUDED.updated_by,
                updated_at           = NOW()`,
            [doc_code, inventory_account_id || null, cogs_account_id || null, variance_account_id || null,
             wip_account_id || null, gl_doc_id || null, userName]
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
