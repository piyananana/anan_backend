// โหมดบัญชีสินค้า (PERPETUAL/PERIODIC) ระดับสต็อก — ลำดับ: สินค้า → หมวดสินค้า → คลัง → ค่าเริ่มต้นของบริษัท
// (im_accounting_setting.inventory_accounting_mode) — ไม่มีระดับประเภทเอกสาร เพราะโหมดเป็นคุณสมบัติของสต็อก
// (สินค้า × คลัง) ไม่ใช่ของเอกสาร ถ้าใบรับกับใบเบิกของสต็อกก้อนเดียวกันใช้คนละโหมด บัญชีสต็อกจะไม่มีวันตรงกับยอดสต็อก
// ดู project_im_mixed_accounting_mode
'use strict';

const MODES = ['PERPETUAL', 'PERIODIC'];

// ค่าที่รับจากหน้าจอ master — ว่าง/ไม่รู้จัก = ตามระดับถัดไป (NULL)
const normalizeMode = (v) => (MODES.includes(v) ? v : null);

const ensureModeLogTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_accounting_mode_log (
            id          SERIAL PRIMARY KEY,
            level       VARCHAR(20) NOT NULL, -- DEFAULT / ITEM / CATEGORY / WAREHOUSE
            ref_id      INTEGER,
            old_mode    VARCHAR(10),          -- NULL = ตามระดับถัดไป
            new_mode    VARCHAR(10),
            changed_by  VARCHAR(100),
            changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
};

// บันทึกประวัติเมื่อโหมดเปลี่ยนจริงเท่านั้น
const logModeChange = async (client, { level, refId = null, oldMode, newMode, changedBy }) => {
    if ((oldMode || null) === (newMode || null)) return;
    await ensureModeLogTable(client);
    await client.query(`
        INSERT INTO im_accounting_mode_log (level, ref_id, old_mode, new_mode, changed_by) VALUES ($1,$2,$3,$4,$5)
    `, [level, refId, oldMode || null, newMode || null, changedBy || null]);
};

const fetchDefaultMode = async (client) => {
    const r = await client.query(`SELECT to_regclass('im_accounting_setting') AS t`);
    if (!r.rows[0].t) return 'PERPETUAL';
    const s = await client.query(`SELECT inventory_accounting_mode FROM im_accounting_setting ORDER BY id LIMIT 1`);
    return s.rows[0]?.inventory_accounting_mode || 'PERPETUAL';
};

// โหมดที่มีผลของสินค้าในคลัง — itemIds หลายตัวในครั้งเดียว คืน { [itemId]: mode }
const resolveItemModes = async (client, itemIds, warehouseId) => {
    const ids = [...new Set((itemIds || []).map(Number).filter(Boolean))];
    const defaultMode = await fetchDefaultMode(client);
    const out = {};
    if (ids.length === 0) return out;
    const r = await client.query(`
        SELECT i.id, COALESCE(i.accounting_mode, c.accounting_mode, w.accounting_mode) AS mode
          FROM im_item i
          LEFT JOIN im_item_category c ON c.id = i.category_id
          LEFT JOIN im_warehouse w ON w.id = $2
         WHERE i.id = ANY($1::int[])
    `, [ids, warehouseId || null]);
    for (const row of r.rows) out[row.id] = row.mode || defaultMode;
    for (const id of ids) if (!out[id]) out[id] = defaultMode;
    return out;
};

const resolveItemMode = async (client, itemId, warehouseId) =>
    (await resolveItemModes(client, [itemId], warehouseId))[Number(itemId)] || fetchDefaultMode(client);

module.exports = { MODES, normalizeMode, ensureModeLogTable, logModeChange, fetchDefaultMode, resolveItemModes, resolveItemMode };
