// controllers/im/imAccountingSettingController.js — company/database-level inventory
// accounting mode (PERPETUAL vs PERIODIC). Hybrid design: the stock subledger
// (im_stock_balance/im_stock_layer) always tracks qty/cost in real time regardless of
// mode — only whether postDetailLines posts a GL entry per-transaction is switchable.
// Item/category/warehouse can override it (utils/imAccountingMode.js). See imPeriodClosingController.js for the closing entry.
'use strict';

const { logModeChange } = require('../../utils/imAccountingMode');

const ensureImAccountingSettingTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_accounting_setting (
            id                        SERIAL PRIMARY KEY,
            inventory_accounting_mode VARCHAR(10) NOT NULL DEFAULT 'PERPETUAL',
            mode_effective_period_id  INTEGER REFERENCES gl_posting_period(id),
            inventory_account_id      INTEGER REFERENCES gl_account(id),
            cogs_account_id           INTEGER REFERENCES gl_account(id),
            purchases_account_id      INTEGER REFERENCES gl_account(id),
            closing_gl_doc_id         INTEGER REFERENCES sa_module_document(id), -- ประเภทเอกสาร GL สำหรับ entry ปิดงวด IM
            created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by                VARCHAR(100),
            updated_by                VARCHAR(100)
        )
    `);
};

// ใช้จาก imTransactionController.js เพื่อตัดสินว่าจะ Post GL ต่อธุรกรรมหรือไม่ — ไม่มีแถวเลย = PERPETUAL (ของเดิม)
const fetchMode = async (client) => {
    await ensureImAccountingSettingTable(client);
    const res = await client.query(
        `SELECT inventory_accounting_mode FROM im_accounting_setting ORDER BY id LIMIT 1`
    );
    return res.rows[0]?.inventory_accounting_mode || 'PERPETUAL';
};

const SETTING_SELECT = `
    SELECT s.*,
           ia.account_code AS inventory_account_code, ia.account_name_thai AS inventory_account_name,
           ca.account_code AS cogs_account_code,       ca.account_name_thai AS cogs_account_name,
           pa.account_code AS purchases_account_code,  pa.account_name_thai AS purchases_account_name,
           p.period_name AS mode_effective_period_name,
           d.doc_code AS closing_doc_code, d.doc_name_thai AS closing_doc_name_thai, d.doc_name_eng AS closing_doc_name_eng
    FROM im_accounting_setting s
    LEFT JOIN gl_account ia ON ia.id = s.inventory_account_id
    LEFT JOIN gl_account ca ON ca.id = s.cogs_account_id
    LEFT JOIN gl_account pa ON pa.id = s.purchases_account_id
    LEFT JOIN gl_posting_period p ON p.id = s.mode_effective_period_id
    LEFT JOIN sa_module_document d ON d.id = s.closing_gl_doc_id
`;

// ใช้จาก imPeriodClosingController.js — ต่างจาก getSetting (HTTP handler) ตรงที่คืน raw row ไม่ join ชื่อบัญชี
const fetchSettingRow = async (client) => {
    await ensureImAccountingSettingTable(client);
    const res = await client.query(`SELECT * FROM im_accounting_setting ORDER BY id LIMIT 1`);
    return res.rows[0] || null;
};

const getSetting = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImAccountingSettingTable(client);
        const result = await client.query(`${SETTING_SELECT} ORDER BY s.id LIMIT 1`);
        res.status(200).json(result.rows[0] || null);
    } catch (error) {
        console.error('Error fetching im_accounting_setting:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const upsertSetting = async (req, res) => {
    const {
        inventory_accounting_mode, mode_effective_period_id,
        inventory_account_id, cogs_account_id, purchases_account_id, closing_gl_doc_id,
    } = req.body;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await ensureImAccountingSettingTable(client);

        if (!['PERPETUAL', 'PERIODIC'].includes(inventory_accounting_mode)) {
            return res.status(400).json({ message: `ค่าโหมดบัญชีสินค้าไม่ถูกต้อง: '${inventory_accounting_mode}'` });
        }

        const existing = await client.query(`SELECT id, inventory_accounting_mode FROM im_accounting_setting ORDER BY id LIMIT 1`);
        const current = existing.rows[0] || null;
        const isSwitchingMode = !current || current.inventory_accounting_mode !== inventory_accounting_mode;

        // ไม่ต้องจำกัดงวดหรือตั้งยอดต้นงวดตอนเปลี่ยนโหมดแล้ว — โหมดที่ใช้จริงบันทึกต่อบรรทัดตอน Post และการปิดงวด
        // ปรับยอด GL ให้ตรงกับมูลค่าสต็อกเสมอ (ดู imPeriodClosingController.js) — mode_effective_period_id เก็บไว้เป็นข้อมูลเดิม

        let result;
        if (current) {
            result = await client.query(`
                UPDATE im_accounting_setting SET
                    inventory_accounting_mode = $1, mode_effective_period_id = $2,
                    inventory_account_id = $3, cogs_account_id = $4, purchases_account_id = $5, closing_gl_doc_id = $6,
                    updated_by = $7, updated_at = NOW()
                WHERE id = $8 RETURNING id
            `, [inventory_accounting_mode, mode_effective_period_id || null,
                inventory_account_id || null, cogs_account_id || null, purchases_account_id || null, closing_gl_doc_id || null,
                userName, current.id]);
        } else {
            result = await client.query(`
                INSERT INTO im_accounting_setting
                (inventory_accounting_mode, mode_effective_period_id, inventory_account_id, cogs_account_id, purchases_account_id, closing_gl_doc_id, created_by, updated_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id
            `, [inventory_accounting_mode, mode_effective_period_id || null,
                inventory_account_id || null, cogs_account_id || null, purchases_account_id || null, closing_gl_doc_id || null, userName]);
        }

        if (isSwitchingMode) {
            await logModeChange(client, {
                level: 'DEFAULT', oldMode: current?.inventory_accounting_mode || 'PERPETUAL',
                newMode: inventory_accounting_mode, changedBy: userName,
            });
        }

        const full = await client.query(`${SETTING_SELECT} WHERE s.id = $1`, [result.rows[0].id]);
        res.status(200).json(full.rows[0]);
    } catch (error) {
        console.error('Error upserting im_accounting_setting:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImAccountingSettingTable, fetchMode, fetchSettingRow, getSetting, upsertSetting };
