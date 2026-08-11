// controllers/im/imLocationController.js
// im_location (bin/zone/rack) is owned by im_warehouse — no standalone list screen,
// saved as a nested array inside im_warehouse's own addRow/updateRow, same convention
// as im_uom_conversion under im_item.
'use strict';

const ensureImLocationTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_location (
            id              SERIAL PRIMARY KEY,
            warehouse_id    INTEGER NOT NULL,
            location_code   VARCHAR(20)  NOT NULL,
            location_name   VARCHAR(200),
            is_active       BOOLEAN NOT NULL DEFAULT true
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_location_warehouse ON im_location(warehouse_id)`);
};

// Adds a FK warehouse_id -> im_warehouse(id) once im_warehouse is guaranteed to exist
const attachWarehouseFk = async (client) => {
    await client.query(`
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'im_location_warehouse_id_fkey'
            ) THEN
                ALTER TABLE im_location ADD CONSTRAINT im_location_warehouse_id_fkey
                    FOREIGN KEY (warehouse_id) REFERENCES im_warehouse(id) ON DELETE CASCADE;
            END IF;
        END $$;
    `).catch(() => {});
};

const fetchByWarehouse = async (client, warehouseId) => {
    const result = await client.query(
        `SELECT * FROM im_location WHERE warehouse_id = $1 ORDER BY location_code`, [warehouseId]
    );
    return result.rows;
};

const replaceForWarehouse = async (client, warehouseId, locations) => {
    await client.query(`DELETE FROM im_location WHERE warehouse_id = $1`, [warehouseId]);
    for (const l of (locations || [])) {
        if (!l.location_code) continue;
        await client.query(
            `INSERT INTO im_location (warehouse_id, location_code, location_name, is_active)
             VALUES ($1,$2,$3,$4)`,
            [warehouseId, l.location_code.trim().toUpperCase(), l.location_name || null, l.is_active ?? true]
        );
    }
};

module.exports = { ensureImLocationTable, attachWarehouseFk, fetchByWarehouse, replaceForWarehouse };
