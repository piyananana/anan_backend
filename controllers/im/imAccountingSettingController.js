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
           ia.account_code AS inventory_account_code, ia.account_name_thai AS inventory_account_name, ia.account_name_eng AS inventory_account_name_eng,
           ca.account_code AS cogs_account_code,       ca.account_name_thai AS cogs_account_name, ca.account_name_eng AS cogs_account_name_eng,
           pa.account_code AS purchases_account_code,  pa.account_name_thai AS purchases_account_name, pa.account_name_eng AS purchases_account_name_eng,
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

// GET /im_accounting_setting/summary — ตัวเลขสรุปและรายการที่ตั้งโหมดแยก ของหน้าตั้งค่าโหมดบัญชี (redesign 2026-11-26)
//   overrides: คลัง/หมวด/สินค้าที่ตั้ง accounting_mode เอง (สินค้าแสดงสูงสุด 200 แถว, counts นับครบ)
//   open_period: งวดที่สิ้นสุดแล้วแต่ยังไม่ปิดงวดสต็อก และมีธุรกรรม IM — เฉพาะเมื่อมีสต็อก Periodic อยู่ (ค่าเริ่มต้นหรือมี override)
//   last_closing: การปิดงวดสต็อกที่ Post ล่าสุด
const OVERRIDE_ITEM_LIMIT = 200;
const getSummary = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImAccountingSettingTable(client);
        const exists = async (t) => !!(await client.query(`SELECT to_regclass($1) AS t`, [t])).rows[0].t;
        const hasCol = async (t, c) => (await client.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [t, c])).rows.length > 0;

        const overrides = [];
        const counts = { WAREHOUSE: { PERPETUAL: 0, PERIODIC: 0 }, CATEGORY: { PERPETUAL: 0, PERIODIC: 0 }, ITEM: { PERPETUAL: 0, PERIODIC: 0 } };
        const levels = [
            { level: 'WAREHOUSE', table: 'im_warehouse', code: 'warehouse_code', th: 'warehouse_name_th', en: 'warehouse_name_en' },
            { level: 'CATEGORY', table: 'im_item_category', code: 'category_code', th: 'category_name_th', en: 'category_name_en' },
            { level: 'ITEM', table: 'im_item', code: 'item_code', th: 'item_name_th', en: 'item_name_en' },
        ];
        for (const l of levels) {
            if (!(await exists(l.table)) || !(await hasCol(l.table, 'accounting_mode'))) continue;
            const hasPur = await hasCol(l.table, 'purchases_account_id');
            const c = await client.query(`SELECT accounting_mode AS m, COUNT(*)::int AS n FROM ${l.table} WHERE accounting_mode IS NOT NULL GROUP BY 1`);
            for (const r of c.rows) if (counts[l.level][r.m] !== undefined) counts[l.level][r.m] = r.n;
            const r = await client.query(`
                SELECT x.id, x.${l.code} AS code, x.${l.th} AS name_th, x.${l.en} AS name_en, x.accounting_mode AS mode,
                       pa.account_code AS purchases_account_code, pa.account_name_thai AS purchases_account_name,
                       pa.account_name_eng AS purchases_account_name_eng
                  FROM ${l.table} x LEFT JOIN gl_account pa ON ${hasPur ? 'pa.id = x.purchases_account_id' : 'false'}
                 WHERE x.accounting_mode IS NOT NULL
                 ORDER BY x.${l.code} ${l.level === 'ITEM' ? `LIMIT ${OVERRIDE_ITEM_LIMIT}` : ''}`);
            for (const row of r.rows) overrides.push({ level: l.level, ...row });
        }

        const setting = (await client.query(`SELECT inventory_accounting_mode FROM im_accounting_setting ORDER BY id LIMIT 1`)).rows[0];
        const anyPeriodic = (setting?.inventory_accounting_mode === 'PERIODIC')
            || Object.values(counts).some(c => c.PERIODIC > 0);

        let openPeriod = null, lastClosing = null;
        const hasClosing = await exists('im_period_closing');
        if (anyPeriodic && await exists('im_transaction')) {
            const r = await client.query(`
                SELECT p.id, p.period_name, p.period_end_date::text AS period_end_date
                  FROM gl_posting_period p
                 WHERE p.period_end_date < CURRENT_DATE AND COALESCE(p.im_status, '') <> 'CLOSED'
                   ${hasClosing ? `AND NOT EXISTS (SELECT 1 FROM im_period_closing c WHERE c.period_id = p.id AND c.status = 'Posted')` : ''}
                   AND EXISTS (SELECT 1 FROM im_transaction t WHERE t.period_id = p.id AND t.status IN ('Posted','Received','Delivered'))
                 ORDER BY p.period_start_date LIMIT 1`);
            openPeriod = r.rows[0] || null;
        }
        if (hasClosing) {
            const r = await client.query(`
                SELECT p.period_name, c.posted_at, h.doc_no
                  FROM im_period_closing c
                  JOIN gl_posting_period p ON p.id = c.period_id
                  LEFT JOIN gl_entry_header h ON h.id = c.gl_entry_id
                 WHERE c.status = 'Posted'
                 ORDER BY p.period_start_date DESC LIMIT 1`);
            lastClosing = r.rows[0] || null;
        }

        res.status(200).json({ counts, overrides, override_item_limit: OVERRIDE_ITEM_LIMIT, any_periodic: anyPeriodic,
            open_period: openPeriod, last_closing: lastClosing });
    } catch (error) {
        console.error('Error fetching im_accounting_setting summary:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImAccountingSettingTable, fetchMode, fetchSettingRow, getSetting, upsertSetting, getSummary };
