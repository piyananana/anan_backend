// controllers/im/imUomConversionController.js
// im_uom_conversion is entirely owned by im_item (alternate purchase/sales units per
// item, e.g. 1 BOX = 12 PCS) — no standalone list screen, saved as a nested array
// inside im_item's own addRow/updateRow, same convention as ap_vendor's
// addresses/contacts/bank_accounts.
'use strict';

const { ensureImUomTable } = require('./imUomController');

const ensureImUomConversionTable = async (client) => {
    await ensureImUomTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_uom_conversion (
            id                    SERIAL PRIMARY KEY,
            item_id               INTEGER NOT NULL,
            uom_id                INTEGER NOT NULL REFERENCES im_uom(id),
            conversion_factor     NUMERIC(18,6) NOT NULL DEFAULT 1,
            barcode               VARCHAR(50),
            is_purchase_default   BOOLEAN NOT NULL DEFAULT false,
            is_sales_default      BOOLEAN NOT NULL DEFAULT false
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_uom_conversion_item ON im_uom_conversion(item_id)`);
};

const CONVERSION_SELECT = `
    SELECT c.*, u.uom_code, u.uom_name_th, u.uom_name_en
    FROM im_uom_conversion c
    LEFT JOIN im_uom u ON u.id = c.uom_id
    WHERE c.item_id = $1
    ORDER BY c.id
`;

const fetchByItem = async (client, itemId) => {
    const result = await client.query(CONVERSION_SELECT, [itemId]);
    return result.rows;
};

// Adds a FK item_id -> im_item(id) once im_item is guaranteed to exist
// (called from imItemController.ensureImItemTable, after im_item itself is created)
const attachItemFk = async (client) => {
    await client.query(`
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'im_uom_conversion_item_id_fkey'
            ) THEN
                ALTER TABLE im_uom_conversion ADD CONSTRAINT im_uom_conversion_item_id_fkey
                    FOREIGN KEY (item_id) REFERENCES im_item(id) ON DELETE CASCADE;
            END IF;
        END $$;
    `).catch(() => {});
};

const replaceForItem = async (client, itemId, conversions) => {
    await client.query(`DELETE FROM im_uom_conversion WHERE item_id = $1`, [itemId]);
    for (const c of (conversions || [])) {
        if (!c.uom_id) continue;
        await client.query(
            `INSERT INTO im_uom_conversion (item_id, uom_id, conversion_factor, barcode, is_purchase_default, is_sales_default)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [itemId, c.uom_id, c.conversion_factor ?? 1, c.barcode || null, c.is_purchase_default ?? false, c.is_sales_default ?? false]
        );
    }
};

module.exports = { ensureImUomConversionTable, attachItemFk, fetchByItem, replaceForItem };
