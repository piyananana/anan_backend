// controllers/im/imAccountingSettingController.js — company/database-level inventory
// accounting mode (PERPETUAL vs PERIODIC). Hybrid design: the stock subledger
// (im_stock_balance/im_stock_layer) always tracks qty/cost in real time regardless of
// mode — only whether postDetailLines posts a GL entry per-transaction is switchable.
// See imPeriodClosingController.js for the periodic period-end closing entry.
'use strict';

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

// ตั้งใจไม่ require imPeriodClosingController.js ที่นี่ (จะเกิด circular require กับที่นั่นซึ่ง require
// fetchSettingRow กลับมา — ฟังก์ชันที่ destructure ตอน module load จะได้ reference ที่ยังไม่สมบูรณ์) จึง
// inline DDL+seed แบบย่อไว้ตรงนี้แทน — โครงสร้างตารางต้องตรงกับ ensureImPeriodClosingTable ในไฟล์นั้นเสมอ
const seedBeginningValueForModeSwitch = async (client, effectivePeriodId, userName) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_period_closing (
            id              SERIAL PRIMARY KEY,
            period_id       INTEGER NOT NULL UNIQUE REFERENCES gl_posting_period(id),
            status          VARCHAR(20) NOT NULL DEFAULT 'Draft',
            beginning_value NUMERIC(18,4), purchases_value NUMERIC(18,4), ending_value NUMERIC(18,4), cogs_value NUMERIC(18,4),
            gl_entry_id     INTEGER REFERENCES gl_entry_header(id),
            calculated_at   TIMESTAMPTZ, posted_at TIMESTAMPTZ, created_by VARCHAR(100), posted_by VARCHAR(100)
        )
    `);
    const effRes = await client.query(`SELECT period_start_date FROM gl_posting_period WHERE id = $1`, [effectivePeriodId]);
    if (effRes.rows.length === 0) return;
    const prevPeriodRes = await client.query(
        `SELECT id FROM gl_posting_period WHERE period_start_date < $1 ORDER BY period_start_date DESC LIMIT 1`,
        [effRes.rows[0].period_start_date]
    );
    if (prevPeriodRes.rows.length === 0) return; // งวดแรกสุดของระบบ ไม่มีงวดก่อนหน้าให้ seed
    const prevPeriodId = prevPeriodRes.rows[0].id;

    const snapshotRes = await client.query(`SELECT COALESCE(SUM(qty_on_hand * avg_unit_cost), 0) AS total FROM im_stock_balance`);
    const snapshotValue = Number(snapshotRes.rows[0].total) || 0;

    const existing = await client.query(`SELECT id, status FROM im_period_closing WHERE period_id = $1`, [prevPeriodId]);
    if (existing.rows.length > 0 && existing.rows[0].status === 'Posted') return; // ปิดจริงไปแล้ว ไม่ทับ
    if (existing.rows.length > 0) {
        await client.query(`
            UPDATE im_period_closing SET status='Posted', ending_value=$1, calculated_at=NOW(), posted_at=NOW(), posted_by=$2 WHERE id=$3
        `, [snapshotValue, userName, existing.rows[0].id]);
    } else {
        await client.query(`
            INSERT INTO im_period_closing (period_id, status, ending_value, calculated_at, posted_at, created_by, posted_by)
            VALUES ($1,'Posted',$2,NOW(),NOW(),$3,$3)
        `, [prevPeriodId, snapshotValue, userName]);
    }
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

        // สลับโหมดได้เฉพาะไปยังงวดที่ยังไม่มีธุรกรรม IM ที่ Posted แล้ว — กันไม่ให้ตัวเลขงวดที่ผ่านมาแล้วถูกตีความใหม่ย้อนหลัง
        if (isSwitchingMode && mode_effective_period_id) {
            const postedCheck = await client.query(
                `SELECT COUNT(*) FROM im_transaction WHERE period_id = $1 AND status = 'Posted'`,
                [mode_effective_period_id]
            );
            if (Number(postedCheck.rows[0].count) > 0) {
                return res.status(400).json({
                    message: 'งวดที่เลือกมีธุรกรรม IM ที่ Post ไปแล้ว ไม่สามารถกำหนดให้เป็นงวดที่เริ่มใช้โหมดใหม่ได้ — กรุณาเลือกงวดที่ยังไม่มีการ Post',
                });
            }
        }

        // สลับเข้าสู่ PERIODIC — seed มูลค่าสต็อกปัจจุบันเป็น "ปลายงวด" ของงวดก่อนหน้า effective period ทันที
        // เพื่อให้การปิดงวดจริงครั้งแรกหา "ต้นงวด" เจอ (ไม่งั้นจะเป็น 0 ทั้งที่จริงมีสต็อกสะสมจากตอน perpetual)
        if (isSwitchingMode && inventory_accounting_mode === 'PERIODIC' && mode_effective_period_id) {
            await seedBeginningValueForModeSwitch(client, mode_effective_period_id, userName);
        }

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

        const full = await client.query(`${SETTING_SELECT} WHERE s.id = $1`, [result.rows[0].id]);
        res.status(200).json(full.rows[0]);
    } catch (error) {
        console.error('Error upserting im_accounting_setting:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImAccountingSettingTable, fetchMode, fetchSettingRow, getSetting, upsertSetting };
