// controllers/im/imItemCategoryController.js
'use strict';

const ensureImItemCategoryTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_item_category (
            id                    SERIAL PRIMARY KEY,
            category_code         VARCHAR(20)  NOT NULL UNIQUE,
            category_name_th      VARCHAR(200) NOT NULL,
            category_name_en      VARCHAR(200),
            parent_id             INTEGER REFERENCES im_item_category(id),
            level                 SMALLINT     NOT NULL DEFAULT 1,
            inventory_account_id  INTEGER REFERENCES gl_account(id),
            cogs_account_id       INTEGER REFERENCES gl_account(id),
            revenue_account_id    INTEGER REFERENCES gl_account(id),
            expense_account_id    INTEGER REFERENCES gl_account(id),
            variance_account_id   INTEGER REFERENCES gl_account(id),
            wip_account_id        INTEGER REFERENCES gl_account(id),
            is_active             BOOLEAN      NOT NULL DEFAULT true,
            created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by            VARCHAR(100),
            updated_by            VARCHAR(100)
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_item_category_parent ON im_item_category(parent_id)`);
};

const CATEGORY_SELECT = `
    SELECT c.*,
           inv.account_code AS inventory_account_code, inv.account_name_thai AS inventory_account_name,
           cogs.account_code AS cogs_account_code,      cogs.account_name_thai AS cogs_account_name,
           rev.account_code AS revenue_account_code,    rev.account_name_thai AS revenue_account_name,
           exp.account_code AS expense_account_code,    exp.account_name_thai AS expense_account_name,
           var.account_code AS variance_account_code,   var.account_name_thai AS variance_account_name,
           wip.account_code AS wip_account_code,         wip.account_name_thai AS wip_account_name
    FROM im_item_category c
    LEFT JOIN gl_account inv  ON inv.id  = c.inventory_account_id
    LEFT JOIN gl_account cogs ON cogs.id = c.cogs_account_id
    LEFT JOIN gl_account rev  ON rev.id  = c.revenue_account_id
    LEFT JOIN gl_account exp  ON exp.id  = c.expense_account_id
    LEFT JOIN gl_account var  ON var.id  = c.variance_account_id
    LEFT JOIN gl_account wip  ON wip.id  = c.wip_account_id
`;

// GET all (tree order: parent before children, then code)
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImItemCategoryTable(client);
        const result = await client.query(`${CATEGORY_SELECT} ORDER BY c.level, c.category_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_item_category:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchActiveRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImItemCategoryTable(client);
        const result = await client.query(`${CATEGORY_SELECT} WHERE c.is_active = true ORDER BY c.level, c.category_code`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching active im_item_category:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImItemCategoryTable(client);
        const result = await client.query(`${CATEGORY_SELECT} WHERE c.id = $1`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบหมวดหมู่สินค้า' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching im_item_category row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const {
        category_code, category_name_th, category_name_en, parent_id,
        inventory_account_id, cogs_account_id, revenue_account_id,
        expense_account_id, variance_account_id, wip_account_id,
        is_active,
    } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImItemCategoryTable(client);
        let level = 1;
        if (parent_id) {
            const parent = await client.query(`SELECT level FROM im_item_category WHERE id = $1`, [parent_id]);
            if (parent.rows.length === 0) return res.status(400).json({ message: 'ไม่พบหมวดหมู่แม่' });
            level = parent.rows[0].level + 1;
        }
        const result = await client.query(
            `INSERT INTO im_item_category
                (category_code, category_name_th, category_name_en, parent_id, level,
                 inventory_account_id, cogs_account_id, revenue_account_id,
                 expense_account_id, variance_account_id, wip_account_id,
                 is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
             RETURNING id`,
            [
                (category_code || '').trim().toUpperCase(),
                category_name_th || '', category_name_en || null, parent_id || null, level,
                inventory_account_id || null, cogs_account_id || null, revenue_account_id || null,
                expense_account_id || null, variance_account_id || null, wip_account_id || null,
                is_active ?? true, userName,
            ]
        );
        const newRow = await client.query(`${CATEGORY_SELECT} WHERE c.id = $1`, [result.rows[0].id]);
        res.status(201).json(newRow.rows[0]);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: `รหัสหมวดหมู่ '${category_code}' มีอยู่แล้ว` });
        console.error('Error adding im_item_category:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const {
        category_name_th, category_name_en, parent_id,
        inventory_account_id, cogs_account_id, revenue_account_id,
        expense_account_id, variance_account_id, wip_account_id,
        is_active,
    } = req.body;
    const userName = req.headers.username || null;
    try {
        await ensureImItemCategoryTable(client);
        if (parent_id && Number(parent_id) === Number(id)) {
            return res.status(400).json({ message: 'หมวดหมู่แม่ต้องไม่ใช่ตัวเอง' });
        }
        let level = 1;
        if (parent_id) {
            const parent = await client.query(`SELECT level FROM im_item_category WHERE id = $1`, [parent_id]);
            if (parent.rows.length === 0) return res.status(400).json({ message: 'ไม่พบหมวดหมู่แม่' });
            level = parent.rows[0].level + 1;
        }
        const result = await client.query(
            `UPDATE im_item_category SET
                category_name_th     = $1,
                category_name_en     = $2,
                parent_id             = $3,
                level                 = $4,
                inventory_account_id  = $5,
                cogs_account_id       = $6,
                revenue_account_id    = $7,
                expense_account_id    = $8,
                variance_account_id   = $9,
                wip_account_id        = $10,
                is_active             = $11,
                updated_by            = $12,
                updated_at            = NOW()
             WHERE id = $13
             RETURNING id`,
            [
                category_name_th || '', category_name_en || null, parent_id || null, level,
                inventory_account_id || null, cogs_account_id || null, revenue_account_id || null,
                expense_account_id || null, variance_account_id || null, wip_account_id || null,
                is_active ?? true, userName, id,
            ]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบหมวดหมู่สินค้า' });
        const updated = await client.query(`${CATEGORY_SELECT} WHERE c.id = $1`, [id]);
        res.status(200).json(updated.rows[0]);
    } catch (error) {
        console.error('Error updating im_item_category:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImItemCategoryTable(client);
        const hasChildren = await client.query(`SELECT 1 FROM im_item_category WHERE parent_id = $1 LIMIT 1`, [id]);
        if (hasChildren.rows.length > 0) {
            return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีหมวดหมู่ย่อยอ้างอิงอยู่' });
        }
        const tableCheck = await client.query(`SELECT to_regclass('public.im_item') AS reg`);
        if (tableCheck.rows[0].reg) {
            const inUse = await client.query(`SELECT 1 FROM im_item WHERE category_id = $1 LIMIT 1`, [id]);
            if (inUse.rows.length > 0) {
                return res.status(409).json({ message: 'ไม่สามารถลบได้ เนื่องจากมีสินค้าอ้างอิงหมวดหมู่นี้' });
            }
        }
        const result = await client.query(`DELETE FROM im_item_category WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบหมวดหมู่สินค้า' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting im_item_category:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = {
    ensureImItemCategoryTable,
    fetchRows, fetchActiveRows, fetchRow, addRow, updateRow, deleteRow,
};
