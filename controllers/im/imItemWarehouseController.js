// controllers/im/imItemWarehouseController.js
// im_item_warehouse (per-item, per-warehouse min/max/reorder policy) is owned by
// im_item — no standalone list screen, saved as a nested array inside im_item's own
// addRow/updateRow, same convention as im_uom_conversion.
'use strict';

const { ensureImWarehouseTable } = require('./imWarehouseController');
const { ensureImLocationTable } = require('./imLocationController');

const ensureImItemWarehouseTable = async (client) => {
    await ensureImWarehouseTable(client);
    await ensureImLocationTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_item_warehouse (
            id                  SERIAL PRIMARY KEY,
            item_id             INTEGER NOT NULL,
            warehouse_id        INTEGER NOT NULL REFERENCES im_warehouse(id),
            min_stock_qty       NUMERIC(18,4) NOT NULL DEFAULT 0,
            max_stock_qty       NUMERIC(18,4) NOT NULL DEFAULT 0,
            reorder_point       NUMERIC(18,4) NOT NULL DEFAULT 0,
            default_location_id INTEGER,
            UNIQUE (item_id, warehouse_id)
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_item_warehouse_item ON im_item_warehouse(item_id)`);
    // idempotent migrations: attach FKs once the referenced tables are guaranteed to exist
    await client.query(`
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'im_item_warehouse_default_location_id_fkey'
            ) THEN
                ALTER TABLE im_item_warehouse ADD CONSTRAINT im_item_warehouse_default_location_id_fkey
                    FOREIGN KEY (default_location_id) REFERENCES im_location(id);
            END IF;
        END $$;
    `).catch(() => {});
};

// Adds a FK item_id -> im_item(id) once im_item is guaranteed to exist
const attachItemFk = async (client) => {
    await client.query(`
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'im_item_warehouse_item_id_fkey'
            ) THEN
                ALTER TABLE im_item_warehouse ADD CONSTRAINT im_item_warehouse_item_id_fkey
                    FOREIGN KEY (item_id) REFERENCES im_item(id) ON DELETE CASCADE;
            END IF;
        END $$;
    `).catch(() => {});
};

const ITEM_WAREHOUSE_SELECT = `
    SELECT iw.*,
           w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
           l.location_code AS default_location_code
    FROM im_item_warehouse iw
    LEFT JOIN im_warehouse w ON w.id = iw.warehouse_id
    LEFT JOIN im_location l  ON l.id = iw.default_location_id
    WHERE iw.item_id = $1
    ORDER BY w.warehouse_code
`;

const fetchByItem = async (client, itemId) => {
    const result = await client.query(ITEM_WAREHOUSE_SELECT, [itemId]);
    return result.rows;
};

const replaceForItem = async (client, itemId, rows) => {
    await client.query(`DELETE FROM im_item_warehouse WHERE item_id = $1`, [itemId]);
    for (const r of (rows || [])) {
        if (!r.warehouse_id) continue;
        await client.query(
            `INSERT INTO im_item_warehouse (item_id, warehouse_id, min_stock_qty, max_stock_qty, reorder_point, default_location_id)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [itemId, r.warehouse_id, r.min_stock_qty ?? 0, r.max_stock_qty ?? 0, r.reorder_point ?? 0, r.default_location_id || null]
        );
    }
};

module.exports = { ensureImItemWarehouseTable, attachItemFk, fetchByItem, replaceForItem };
