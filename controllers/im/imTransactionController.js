// controllers/im/imTransactionController.js — im_transaction (ปรับยอดสินค้า/นับสต็อค และในอนาคต ISS/TRF/GRN/DLN family)
// v1: doc_code='AJS' เท่านั้น — ตั้งยอดสินค้าด้วยการนับสต็อค เขียนลง im_stock_balance/im_stock_layer (sub-ledger
// ที่มีอยู่แล้วแบบ read-only) และโพสต์ GL ตรง (target_module='NONE' ตาม im_gl_account_setup)
'use strict';

const { ensureImItemTable } = require('./imItemController');
const { ensureImWarehouseTable } = require('./imWarehouseController');
const { ensureImLocationTable } = require('./imLocationController');
const { ensureImUomTable } = require('./imUomController');
const { ensureImStockBalanceTable } = require('./imStockBalanceController');
const { ensureImStockLayerTable } = require('./imStockLayerController');
const { fetchSetupByDocCode } = require('./imGlAccountSetupController');
const { fetchMode, fetchSettingRow } = require('./imAccountingSettingController');

// --- Schema ---
const ensureImTransactionTable = async (client) => {
    await ensureImItemTable(client);
    await ensureImWarehouseTable(client);
    await ensureImLocationTable(client);
    await ensureImUomTable(client);
    await ensureImStockBalanceTable(client);
    await ensureImStockLayerTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_transaction (
            id              SERIAL PRIMARY KEY,
            doc_id          INTEGER NOT NULL REFERENCES sa_module_document(id),
            doc_no          VARCHAR(50) NOT NULL,
            doc_code        VARCHAR(10) NOT NULL,
            doc_date        DATE NOT NULL,
            period_id       INTEGER REFERENCES gl_posting_period(id),
            warehouse_id    INTEGER NOT NULL REFERENCES im_warehouse(id),
            to_warehouse_id INTEGER REFERENCES im_warehouse(id),
            ref_no          VARCHAR(50),
            ref_doc_id      INTEGER,
            ref_doc_no      VARCHAR(50),
            description     TEXT,
            status          VARCHAR(20) NOT NULL DEFAULT 'Draft',
            gl_entry_id     INTEGER,
            total_qty       NUMERIC(18,4) NOT NULL DEFAULT 0,
            total_value_lc  NUMERIC(18,4) NOT NULL DEFAULT 0,
            dim1_id INTEGER, dim2_id INTEGER, dim3_id INTEGER, dim4_id INTEGER, dim5_id INTEGER,
            branch_id       INTEGER REFERENCES cd_branch(id),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by      VARCHAR(100),
            updated_by      VARCHAR(100)
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_transaction_date      ON im_transaction(doc_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_transaction_status    ON im_transaction(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_transaction_warehouse ON im_transaction(warehouse_id)`);

    await client.query(`
        CREATE TABLE IF NOT EXISTS im_transaction_detail (
            id                       SERIAL PRIMARY KEY,
            header_id                INTEGER NOT NULL REFERENCES im_transaction(id) ON DELETE CASCADE,
            line_no                  INTEGER NOT NULL,
            item_id                  INTEGER NOT NULL REFERENCES im_item(id),
            item_code                VARCHAR(30),
            item_name                VARCHAR(200),
            location_id              INTEGER REFERENCES im_location(id),
            lot_no                   VARCHAR(50),
            serial_no                VARCHAR(50),
            uom_id                   INTEGER REFERENCES im_uom(id),
            system_qty               NUMERIC(18,4),
            counted_qty              NUMERIC(18,4),
            qty                      NUMERIC(18,4),
            unit_cost                NUMERIC(18,4),
            balance_qty_before       NUMERIC(18,4),
            balance_avg_cost_before  NUMERIC(18,4),
            total_value_lc           NUMERIC(18,4),
            description              TEXT
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_transaction_detail_header ON im_transaction_detail(header_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_transaction_detail_item   ON im_transaction_detail(item_id)`);

    // สำหรับ TRF (โอนสินค้า) — ฝั่งปลายทาง (location_id/balance_*_before เดิม = ฝั่งต้นทางเสมอ)
    await client.query(`ALTER TABLE im_transaction_detail ADD COLUMN IF NOT EXISTS to_location_id             INTEGER REFERENCES im_location(id)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction_detail ADD COLUMN IF NOT EXISTS to_balance_qty_before      NUMERIC(18,4)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction_detail ADD COLUMN IF NOT EXISTS to_balance_avg_cost_before NUMERIC(18,4)`).catch(() => {});

    // สำหรับ GRN ('10' รับสินค้า / '11' รับสินค้า+ตั้งหนี้อัตโนมัติ) — ผู้ขาย + ลิงก์ไปยัง ap_transaction ที่สร้างให้
    await client.query(`ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS vendor_id               INTEGER REFERENCES ap_vendor(id)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS vendor_code             VARCHAR(20)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS vendor_name_th          VARCHAR(200)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS linked_ap_transaction_id INTEGER`).catch(() => {});

    // สำหรับ '12' (รับสินค้า รอตั้งหนี้) — ต้นทุนจริงตามใบกำกับ (อาจต่างจาก unit_cost ที่ใช้ตีมูลค่าสต็อกตอนรับของ)
    await client.query(`ALTER TABLE im_transaction_detail ADD COLUMN IF NOT EXISTS billed_unit_cost NUMERIC(18,4)`).catch(() => {});

    // สำหรับ DLN ('30' ส่งสินค้า / '31' ส่งสินค้า+ตั้งหนี้อัตโนมัติ / '32' ส่งสินค้ารอตั้งหนี้) — ลูกค้า + ลิงก์ไปยัง
    // ar_transaction ที่สร้างให้ (ฝั่งขาย มิเรอร์ vendor_id/linked_ap_transaction_id ของ GRN)
    await client.query(`ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS customer_id             INTEGER REFERENCES ar_customer(id)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS customer_code           VARCHAR(20)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS customer_name_th        VARCHAR(200)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS linked_ar_transaction_id INTEGER`).catch(() => {});

    // สำหรับ '31'/'32' — ราคาขายต่อหน่วย ใช้คำนวณรายได้ตอนสร้าง ar_transaction (ต่างจาก unit_cost ที่ตัดจาก stock
    // ledger เอง ไม่มีผลต่อการตีมูลค่าสต็อกใดๆ จึงไม่ต้องมีคอลัมน์คู่แบบ billed_unit_cost — แก้ไขได้ตรงๆ ก่อน Post)
    await client.query(`ALTER TABLE im_transaction_detail ADD COLUMN IF NOT EXISTS unit_price NUMERIC(18,4)`).catch(() => {});

    // สำหรับ '15'/'35' (คืนสินค้าผู้ขาย/รับคืนจากลูกค้า) — อ้างอิงเอกสารต้นฉบับ (GRN/DLN) เพื่อติดตามจำนวนคืนบางส่วน
    // (partial return) ระดับหัวเอกสารเก็บไว้เพื่อความสะดวกในการแสดงผล/กรอง ส่วนการตรวจคงเหลือที่คืนได้จริงคำนวณจาก
    // ระดับบรรทัดเสมอ (ref_im_transaction_detail_id) — เอกสารต้นฉบับหนึ่งใบอาจถูกคืนหลายครั้ง (คนละบรรทัด/คนละใบ)
    await client.query(`ALTER TABLE im_transaction ADD COLUMN IF NOT EXISTS ref_im_transaction_id INTEGER REFERENCES im_transaction(id)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction_detail ADD COLUMN IF NOT EXISTS ref_im_transaction_detail_id INTEGER REFERENCES im_transaction_detail(id)`).catch(() => {});

    // VAT ต่อบรรทัด — ใช้เฉพาะประเภทเอกสารที่สร้าง/อ้างอิงใบกำกับ AP/AR อัตโนมัติ ('11'/'12'/'15'/'20'/'25'/'31'/
    // '32'/'35'/'40'/'45') อ้างอิง cd_vat_rate เดียวกับที่ AR/AP ใช้ (vat_type=vat_code, vat_rate=snapshot ณ ตอนโพสต์
    // เหมือนที่ ar/apTransactionController.js เก็บ) — ไม่มี is_deferred_vat เหมือน AR เพราะ IM Post ครั้งเดียวจบ
    await client.query(`ALTER TABLE im_transaction_detail ADD COLUMN IF NOT EXISTS vat_type VARCHAR(10)`).catch(() => {});
    await client.query(`ALTER TABLE im_transaction_detail ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,2)`).catch(() => {});

    // audit ของการตัดต้นทุนจาก layer เดิม (FIFO/SPECIFIC เมื่อ variance ติดลบ) — ใช้ตอน Void เพื่อคืนค่า remaining_qty ให้ตรงเป๊ะ
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_stock_layer_consumption (
            id          SERIAL PRIMARY KEY,
            layer_id    INTEGER NOT NULL REFERENCES im_stock_layer(id),
            header_id   INTEGER NOT NULL REFERENCES im_transaction(id) ON DELETE CASCADE,
            detail_id   INTEGER REFERENCES im_transaction_detail(id) ON DELETE CASCADE,
            qty         NUMERIC(18,4) NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_stock_layer_consumption_header ON im_stock_layer_consumption(header_id)`);
};

// --- Helper: Generate Document Number (copied from apTransactionController.js — same per-module duplication convention as ap/ar/cm/gl) ---
const generateDocNo = async (client, docId, date, branchId = null) => {
    let config = null;
    let useBranchCounter = false;
    let branchRowId = null;

    if (branchId) {
        const branchRes = await client.query(
            `SELECT * FROM sa_doc_number_branch WHERE doc_id = $1 AND branch_id = $2 FOR UPDATE`,
            [docId, branchId]
        );
        if (branchRes.rows.length > 0) {
            const globalRes = await client.query(`SELECT * FROM sa_module_document WHERE id = $1`, [docId]);
            const global = globalRes.rows[0];
            if (!global || !global.is_auto_numbering) return null;
            const bc = branchRes.rows[0];
            config = {
                format_prefix:       bc.format_prefix      ?? global.format_prefix      ?? '',
                format_separator:    bc.format_separator   ?? global.format_separator   ?? '',
                format_suffix_date:  bc.format_suffix_date ?? global.format_suffix_date ?? '',
                running_length:      bc.running_length     ?? global.running_length     ?? 4,
                next_running_number: bc.next_running_number,
            };
            useBranchCounter = true;
            branchRowId = bc.id;
        }
    }
    if (!useBranchCounter) {
        const globalRes = await client.query(`SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]);
        const global = globalRes.rows[0];
        if (!global || !global.is_auto_numbering) return null;
        config = {
            format_prefix:       global.format_prefix      || '',
            format_separator:    global.format_separator   || '',
            format_suffix_date:  global.format_suffix_date || '',
            running_length:      global.running_length     || 4,
            next_running_number: global.next_running_number,
        };
    }

    let docNo = config.format_prefix;
    if (config.format_suffix_date) {
        const d = new Date(date);
        const year  = d.getFullYear().toString();
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const day   = d.getDate().toString().padStart(2, '0');
        if      (config.format_suffix_date === 'YY')       docNo += year.substring(2);
        else if (config.format_suffix_date === 'YYYY')     docNo += year;
        else if (config.format_suffix_date === 'YYMM')     docNo += year.substring(2) + month;
        else if (config.format_suffix_date === 'YYYYMM')   docNo += year + month;
        else if (config.format_suffix_date === 'YYYYMMDD') docNo += year + month + day;
    }
    if (config.format_separator) docNo += config.format_separator;
    docNo += config.next_running_number.toString().padStart(config.running_length, '0');

    if (useBranchCounter) {
        await client.query(
            `UPDATE sa_doc_number_branch SET next_running_number = next_running_number + 1 WHERE id = $1`,
            [branchRowId]
        );
    } else {
        await client.query(
            `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
            [docId]
        );
    }
    return docNo;
};

// --- Costing engine ---
// ตัดสิน actualUnitCost + เขียนผลลง im_stock_balance/im_stock_layer ตาม costing_method ของ item
const STOCK_BALANCE_KEY = `item_id = $1 AND warehouse_id = $2 AND COALESCE(location_id,0) = COALESCE($3::int,0) AND COALESCE(lot_no,'') = COALESCE($4,'')`;

const upsertStockBalance = async (client, { itemId, warehouseId, locationId, lotNo, qty, avgCost, updatedBy }) => {
    await client.query(`
        INSERT INTO im_stock_balance (item_id, warehouse_id, location_id, lot_no, qty_on_hand, avg_unit_cost, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (item_id, warehouse_id, COALESCE(location_id,0), COALESCE(lot_no,''))
        DO UPDATE SET qty_on_hand = EXCLUDED.qty_on_hand, avg_unit_cost = EXCLUDED.avg_unit_cost,
                      updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `, [itemId, warehouseId, locationId || null, lotNo || null, qty, avgCost, updatedBy || null]);
};

const recomputeBalanceFromLayers = async (client, { itemId, warehouseId, locationId, lotNo, updatedBy }) => {
    const aggRes = await client.query(`
        SELECT COALESCE(SUM(remaining_qty),0) AS qty,
               CASE WHEN COALESCE(SUM(remaining_qty),0) = 0 THEN 0
                    ELSE COALESCE(SUM(remaining_qty * unit_cost) / SUM(remaining_qty), 0) END AS avg_cost
        FROM im_stock_layer
        WHERE item_id = $1 AND warehouse_id = $2
          AND COALESCE(location_id,0) = COALESCE($3::int,0) AND COALESCE(lot_no,'') = COALESCE($4,'')
          AND remaining_qty > 0
    `, [itemId, warehouseId, locationId || null, lotNo || null]);
    const { qty, avg_cost } = aggRes.rows[0];
    await upsertStockBalance(client, { itemId, warehouseId, locationId, lotNo, qty, avgCost: avg_cost, updatedBy });
    return { qty: Number(qty), avgCost: Number(avg_cost) };
};

// บัญชีสต็อกที่จะใช้ Dr/Cr: ดูที่คลัง (im_warehouse.inventory_account_id) ก่อน ถ้าไม่ได้ตั้งค่อย fallback ไปที่สินค้า (im_item)
// แล้วค่อย fallback ไปที่ default ของ im_gl_account_setup — วันนี้ im_warehouse ยังไม่มีการตั้งค่าที่ไหนเลย จึง behavior
// เหมือนเดิมทุกประการสำหรับ AJS/ISS; เผื่อไว้สำหรับวันที่ผังบัญชีถูกแยกตามคลัง (ใช้จริงกับ TRF)
const resolveInventoryAccount = async (client, itemId, warehouseId, fallbackAccountId) => {
    const res = await client.query(`
        SELECT i.inventory_account_id AS item_account, w.inventory_account_id AS warehouse_account, i.item_code
        FROM im_item i
        LEFT JOIN im_warehouse w ON w.id = $2
        WHERE i.id = $1
    `, [itemId, warehouseId]);
    const row = res.rows[0];
    if (!row) throw new Error(`ไม่พบสินค้า item_id=${itemId}`);
    const accountId = Number(row.warehouse_account) || Number(row.item_account) || Number(fallbackAccountId) || 0;
    if (!accountId) throw new Error(`ไม่พบบัญชีสต็อกสำหรับ ${row.item_code} (ตั้งค่าที่ im_item, im_warehouse หรือ im_gl_account_setup)`);
    return accountId;
};

// บัญชีรายได้ที่ใช้ Cr ตอนสร้างใบแจ้งหนี้ลูกหนี้จาก DLN ('31'/'32'): ดูที่สินค้า (im_item.revenue_account_id) ก่อน
// แล้วค่อย fallback ไปที่ default ของ ar_gl_account_setup (บัญชีเดียวกับที่ AR เองใช้เป็น default เวลาเอกสารไม่มีรายบรรทัด)
const resolveRevenueAccount = async (client, itemId, fallbackAccountId) => {
    const res = await client.query(`SELECT revenue_account_id, item_code FROM im_item WHERE id = $1`, [itemId]);
    const row = res.rows[0];
    if (!row) throw new Error(`ไม่พบสินค้า item_id=${itemId}`);
    const accountId = Number(row.revenue_account_id) || Number(fallbackAccountId) || 0;
    if (!accountId) throw new Error(`ไม่พบบัญชีรายได้สำหรับ ${row.item_code} (ตั้งค่าที่ im_item หรือ ar_gl_account_setup)`);
    return accountId;
};

// countedQty คือยอดที่นับได้จริง (ไม่ใช่ variance) — varianceQty คำนวณสดจากยอดคงเหลือ ณ ตอน Post เสมอ
// เพื่อรับประกันว่า qty_on_hand หลัง Post จะเท่ากับ countedQty เป๊ะ ไม่ผูกกับ system_qty ที่ผู้ใช้เห็นตอนเพิ่มบรรทัด (อาจ stale)
const applyStockMovement = async (client, {
    item, warehouseId, locationId, lotNo, serialNo, countedQty, enteredUnitCost,
    docDate, docCode, headerId, docNo, detailId, updatedBy,
}) => {
    const costingMethod = item.costing_method;

    // SPECIFIC: นับตามการมี/ไม่มีของ serial จริง ณ ตอน Post ไม่ใช่ diff กับตัวเลข system_qty ที่อาจ stale
    if (costingMethod === 'SPECIFIC') {
        if (!serialNo) throw new Error(`กรุณาระบุ Serial No. สำหรับ ${item.item_code}`);
        const layerRes = await client.query(
            `SELECT * FROM im_stock_layer WHERE item_id=$1 AND serial_no=$2 AND remaining_qty > 0 FOR UPDATE`,
            [item.id, serialNo]
        );
        const existingLayer = layerRes.rows[0] || null;
        const isCounted = Number(countedQty) > 0;

        if (isCounted && !existingLayer) {
            if (enteredUnitCost == null) throw new Error(`กรุณาระบุต้นทุนต่อหน่วยสำหรับ serial ${serialNo}`);
            await client.query(`
                INSERT INTO im_stock_layer
                (item_id, warehouse_id, location_id, lot_no, serial_no, layer_date, received_qty, remaining_qty, unit_cost,
                 source_doc_type, source_doc_id, source_doc_no, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,$10,$11)
            `, [item.id, warehouseId, locationId || null, lotNo || null, serialNo, docDate, enteredUnitCost,
                docCode, headerId, docNo, updatedBy || null]);
            await recomputeBalanceFromLayers(client, { itemId: item.id, warehouseId, locationId, lotNo, updatedBy });
            return { actualUnitCost: Number(enteredUnitCost), varianceQty: 1, balanceQtyBefore: null, balanceAvgCostBefore: null };
        }
        if (!isCounted && existingLayer) {
            await client.query(`UPDATE im_stock_layer SET remaining_qty = 0 WHERE id = $1`, [existingLayer.id]);
            await client.query(`
                INSERT INTO im_stock_layer_consumption (layer_id, header_id, detail_id, qty) VALUES ($1,$2,$3,1)
            `, [existingLayer.id, headerId, detailId || null]);
            await recomputeBalanceFromLayers(client, { itemId: item.id, warehouseId, locationId: existingLayer.location_id, lotNo: existingLayer.lot_no, updatedBy });
            return { actualUnitCost: Number(existingLayer.unit_cost), varianceQty: -1, balanceQtyBefore: null, balanceAvgCostBefore: null };
        }
        // ตรงกับสถานะปัจจุบันอยู่แล้ว (มี+นับเจอ หรือ ไม่มี+นับไม่เจอ) — ไม่ต้องขยับสต็อก
        return { actualUnitCost: 0, varianceQty: 0, balanceQtyBefore: null, balanceAvgCostBefore: null };
    }

    const qtyBalRes = await client.query(
        `SELECT qty_on_hand, avg_unit_cost FROM im_stock_balance WHERE ${STOCK_BALANCE_KEY} FOR UPDATE`,
        [item.id, warehouseId, locationId || null, lotNo || null]
    );
    const balanceQtyBefore     = qtyBalRes.rows.length ? Number(qtyBalRes.rows[0].qty_on_hand)   : 0;
    const balanceAvgCostBefore = qtyBalRes.rows.length ? Number(qtyBalRes.rows[0].avg_unit_cost) : 0;
    const varianceQty = Number(countedQty) - balanceQtyBefore;

    if (costingMethod === 'STANDARD') {
        const actualUnitCost = Number(item.standard_cost) || 0;
        const newQty = balanceQtyBefore + varianceQty;
        if (newQty < 0) throw new Error(`ยอดคงเหลือของ ${item.item_code} ไม่พอสำหรับปรับลด (คงเหลือ ${balanceQtyBefore})`);
        await upsertStockBalance(client, { itemId: item.id, warehouseId, locationId, lotNo, qty: newQty, avgCost: actualUnitCost, updatedBy });
        return { actualUnitCost, balanceQtyBefore, balanceAvgCostBefore, varianceQty };
    }

    if (costingMethod === 'AVG') {
        let actualUnitCost, newAvg;
        const newQty = balanceQtyBefore + varianceQty;
        if (newQty < 0) throw new Error(`ยอดคงเหลือของ ${item.item_code} ไม่พอสำหรับปรับลด (คงเหลือ ${balanceQtyBefore})`);
        if (varianceQty > 0) {
            if (enteredUnitCost == null) throw new Error(`กรุณาระบุต้นทุนต่อหน่วยสำหรับ ${item.item_code} (นับได้มากกว่าระบบ)`);
            actualUnitCost = Number(enteredUnitCost);
            newAvg = newQty === 0 ? 0 : (balanceQtyBefore * balanceAvgCostBefore + varianceQty * actualUnitCost) / newQty;
        } else {
            actualUnitCost = balanceAvgCostBefore;
            newAvg = balanceAvgCostBefore;
        }
        await upsertStockBalance(client, { itemId: item.id, warehouseId, locationId, lotNo, qty: newQty, avgCost: newAvg, updatedBy });
        return { actualUnitCost, balanceQtyBefore, balanceAvgCostBefore, varianceQty };
    }

    if (costingMethod === 'FIFO') {
        if (varianceQty > 0) {
            if (enteredUnitCost == null) throw new Error(`กรุณาระบุต้นทุนต่อหน่วยสำหรับ ${item.item_code} (นับได้มากกว่าระบบ)`);
            await client.query(`
                INSERT INTO im_stock_layer
                (item_id, warehouse_id, location_id, lot_no, layer_date, received_qty, remaining_qty, unit_cost,
                 source_doc_type, source_doc_id, source_doc_no, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)
            `, [item.id, warehouseId, locationId || null, lotNo || null, docDate, varianceQty, enteredUnitCost,
                docCode, headerId, docNo, updatedBy || null]);
            await recomputeBalanceFromLayers(client, { itemId: item.id, warehouseId, locationId, lotNo, updatedBy });
            return { actualUnitCost: Number(enteredUnitCost), balanceQtyBefore, balanceAvgCostBefore, varianceQty };
        } else {
            let remainingToConsume = Math.abs(varianceQty);
            const layersRes = await client.query(`
                SELECT * FROM im_stock_layer
                WHERE item_id=$1 AND warehouse_id=$2 AND COALESCE(location_id,0)=COALESCE($3::int,0)
                  AND COALESCE(lot_no,'')=COALESCE($4,'') AND remaining_qty > 0
                ORDER BY layer_date ASC, id ASC FOR UPDATE
            `, [item.id, warehouseId, locationId || null, lotNo || null]);
            let consumedValue = 0;
            for (const layer of layersRes.rows) {
                if (remainingToConsume <= 0) break;
                const take = Math.min(Number(layer.remaining_qty), remainingToConsume);
                await client.query(`UPDATE im_stock_layer SET remaining_qty = remaining_qty - $1 WHERE id = $2`, [take, layer.id]);
                await client.query(`
                    INSERT INTO im_stock_layer_consumption (layer_id, header_id, detail_id, qty) VALUES ($1,$2,$3,$4)
                `, [layer.id, headerId, detailId || null, take]);
                consumedValue += take * Number(layer.unit_cost);
                remainingToConsume -= take;
            }
            if (remainingToConsume > 0) throw new Error(`สต็อก FIFO ของ ${item.item_code} ไม่พอสำหรับปรับลด (ขาด ${remainingToConsume})`);
            const actualUnitCost = Math.abs(varianceQty) === 0 ? 0 : consumedValue / Math.abs(varianceQty);
            await recomputeBalanceFromLayers(client, { itemId: item.id, warehouseId, locationId, lotNo, updatedBy });
            return { actualUnitCost, balanceQtyBefore, balanceAvgCostBefore, varianceQty };
        }
    }

    throw new Error(`ไม่รู้จัก costing_method '${costingMethod}' สำหรับ ${item.item_code}`);
};

// TRF (โอนสินค้า) — เคลื่อนไหว 2 ทิศทางต่อเนื่องกันในบรรทัดเดียว: ลดฝั่งต้นทาง (เหมือน ISS, countedQty คือ target ของ
// ต้นทางเช่นเดิม) แล้วเพิ่มฝั่งปลายทางด้วยต้นทุนที่ตัดออกจริงจากต้นทาง (ไม่ให้ผู้ใช้กรอกต้นทุนปลายทางเอง — ต้นทุนต้อง
// ติดไปกับสินค้าเป๊ะๆ ไม่ใช่ค่าเฉลี่ยใหม่/ราคาที่พิมพ์ผิด) ต้องรันฝั่งต้นทางก่อนเสมอ เพื่อให้ SPECIFIC เห็น serial ว่างที่ปลายทาง
const applyTransferMovement = async (client, {
    item, warehouseId, locationId, toWarehouseId, toLocationId, lotNo, serialNo, countedQty,
    docDate, docCode, headerId, docNo, detailId, updatedBy,
}) => {
    const srcResult = await applyStockMovement(client, {
        item, warehouseId, locationId, lotNo, serialNo, countedQty, enteredUnitCost: null,
        docDate, docCode, headerId, docNo, detailId, updatedBy,
    });
    const transferQty = -srcResult.varianceQty;

    let dstCountedQty;
    if (item.costing_method === 'SPECIFIC') {
        dstCountedQty = 1;
    } else {
        const balRes = await client.query(
            `SELECT qty_on_hand FROM im_stock_balance WHERE ${STOCK_BALANCE_KEY} FOR UPDATE`,
            [item.id, toWarehouseId, toLocationId || null, lotNo || null]
        );
        const destBalanceBefore = balRes.rows.length ? Number(balRes.rows[0].qty_on_hand) : 0;
        dstCountedQty = destBalanceBefore + transferQty;
    }

    const dstResult = await applyStockMovement(client, {
        item, warehouseId: toWarehouseId, locationId: toLocationId, lotNo, serialNo,
        countedQty: dstCountedQty, enteredUnitCost: srcResult.actualUnitCost,
        docDate, docCode, headerId, docNo, detailId, updatedBy,
    });

    return { srcResult, dstResult, transferQty };
};

// ย้อนกลับผลของ applyStockMovement ทั้งหมดของเอกสารนี้ (ใช้ตอน Void)
const reverseStockMovement = async (client, headerId) => {
    const detailsRes = await client.query(`
        SELECT dt.*, i.costing_method
        FROM im_transaction_detail dt
        JOIN im_item i ON i.id = dt.item_id
        WHERE dt.header_id = $1
    `, [headerId]);
    const headerRes = await client.query(`
        SELECT t.warehouse_id, t.to_warehouse_id, d.sys_doc_type
        FROM im_transaction t JOIN sa_module_document d ON d.id = t.doc_id
        WHERE t.id = $1
    `, [headerId]);
    const warehouseId = headerRes.rows[0]?.warehouse_id;
    const toWarehouseId = headerRes.rows[0]?.to_warehouse_id;
    const isTransfer = headerRes.rows[0]?.sys_doc_type === '70';

    for (const d of detailsRes.rows) {
        if (d.costing_method === 'AVG' || d.costing_method === 'STANDARD') {
            await upsertStockBalance(client, {
                itemId: d.item_id, warehouseId, locationId: d.location_id, lotNo: d.lot_no,
                qty: d.balance_qty_before || 0, avgCost: d.balance_avg_cost_before || 0,
            });
            if (isTransfer) {
                // TRF: ต้องคืนฝั่งปลายทางด้วย — เอกสารอื่นมีการเคลื่อนไหวแค่ฝั่งเดียว จึงไม่เข้าทางนี้
                await upsertStockBalance(client, {
                    itemId: d.item_id, warehouseId: toWarehouseId, locationId: d.to_location_id, lotNo: d.lot_no,
                    qty: d.to_balance_qty_before || 0, avgCost: d.to_balance_avg_cost_before || 0,
                });
            }
            continue;
        }
        // FIFO / SPECIFIC: ลบ layer ที่เอกสารนี้สร้าง (variance บวก, สำหรับ TRF คือ layer ที่สร้างที่ปลายทาง) +
        // คืน remaining_qty ให้ layer ที่ถูกตัด (variance ลบ, สำหรับ TRF คือ layer ที่ถูกตัดที่ต้นทาง) — ไม่ต้องกรองตามคลัง
        // เพราะ source_doc_id/header_id+detail_id ระบุเอกสารนี้ชัดเจนอยู่แล้ว ใช้ได้ทั้ง single-warehouse และ TRF
        const createdLayers = await client.query(`
            SELECT l.* FROM im_stock_layer l
            WHERE l.source_doc_id = $1 AND l.item_id = $2
        `, [headerId, d.item_id]);
        for (const layer of createdLayers.rows) {
            if (Number(layer.remaining_qty) !== Number(layer.received_qty)) {
                throw new Error(`ไม่สามารถยกเลิกได้ เนื่องจากมีการเบิกจ่ายจาก stock (item ${d.item_code}) ไปแล้วหลังจากเอกสารนี้`);
            }
            await client.query(`DELETE FROM im_stock_layer WHERE id = $1`, [layer.id]);
        }
        const consumptions = await client.query(`
            SELECT * FROM im_stock_layer_consumption WHERE header_id = $1 AND detail_id = $2
        `, [headerId, d.id]);
        for (const c of consumptions.rows) {
            await client.query(`UPDATE im_stock_layer SET remaining_qty = remaining_qty + $1 WHERE id = $2`, [c.qty, c.layer_id]);
        }
        await client.query(`DELETE FROM im_stock_layer_consumption WHERE header_id = $1 AND detail_id = $2`, [headerId, d.id]);

        await recomputeBalanceFromLayers(client, { itemId: d.item_id, warehouseId, locationId: d.location_id, lotNo: d.lot_no });
        if (isTransfer) {
            // ต้องรีเฟรชยอดรวมฝั่งปลายทางด้วย — layer/consumption ถูกจัดการถูกต้องแล้วข้างบน แต่ recompute ครั้งเดียว
            // ข้างบนรีเฟรชแค่ aggregate ของต้นทาง ไม่งั้น im_stock_balance ฝั่งปลายทางจะค้างเป็นค่าก่อน Void
            await recomputeBalanceFromLayers(client, { itemId: d.item_id, warehouseId: toWarehouseId, locationId: d.to_location_id, lotNo: d.lot_no });
        }
    }
};

// --- GL posting ---
// เลือกบัญชีคู่บัญชี (counterpart ของ inventory) ตาม sys_doc_type — มาตรฐานคงที่ตาม imSysDocType
// ใน sa_anan_module.dart ไม่ใช่ doc_code (ดู pattern_sys_doc_type_vs_doc_code) สูตร debit/credit ด้านล่าง
// เป็นสูตรเดียวกันสำหรับทุก sys_doc_type ที่รองรับ (totalValue บวก=Dr คลัง/Cr คู่บัญชี, ลบ=กลับด้าน) —
// ต่างกันแค่ "บัญชีคู่บัญชี" ที่ใช้เท่านั้น
const resolveCounterAccount = (sysDocType, setup) => {
    switch (sysDocType) {
        case '80': // AJS — ปรับยอดสินค้า: ส่วนต่างจากการนับสต็อก
            if (!setup.variance_account_id) {
                throw new Error(`ยังไม่ได้ตั้งค่าบัญชีผลต่างต้นทุน (variance_account_id) ใน im_gl_account_setup สำหรับประเภทเอกสารนี้`);
            }
            return { accountId: Number(setup.variance_account_id), label: 'ผลต่างจากการนับสต็อก' };
        case '60': // ISS — เบิกสินค้า: รับรู้เป็นต้นทุน
            if (!setup.cogs_account_id) {
                throw new Error(`ยังไม่ได้ตั้งค่าบัญชีต้นทุน (cogs_account_id) ใน im_gl_account_setup สำหรับประเภทเอกสารนี้`);
            }
            return { accountId: Number(setup.cogs_account_id), label: 'เบิกใช้สินค้า' };
        case '10': // GRN — รับสินค้า (ไม่มีเลขที่อ้างอิง): พักไว้รอ AP ตั้งหนี้เอง
            if (!setup.grir_account_id) {
                throw new Error(`ยังไม่ได้ตั้งค่าบัญชีพักรอใบกำกับ (grir_account_id) ใน im_gl_account_setup สำหรับประเภทเอกสารนี้`);
            }
            return { accountId: Number(setup.grir_account_id), label: 'รับสินค้า (รอใบกำกับ)' };
        case '30': // DLN — ส่งสินค้า (ธรรมดา/พร้อมตั้งหนี้/รอตั้งหนี้): รับรู้เป็นต้นทุนขาย ใช้บัญชีเดียวกับ ISS
        case '31':
        case '32':
        case '35': // รับคืนสินค้า (RTC) / ลดหนี้ลูกหนี้ (CNC) / เพิ่มหนี้ลูกหนี้ (DNC) — กลับรายการต้นทุนขายเดียวกัน
        case '40': // (บวก=คืนของ ลด COGS, ลบ=ส่งเพิ่ม เพิ่ม COGS — ทิศทางมาจากเครื่องหมายของ qty ใน postGlEntry เอง)
        case '45':
            if (!setup.cogs_account_id) {
                throw new Error(`ยังไม่ได้ตั้งค่าบัญชีต้นทุนขาย (cogs_account_id) ใน im_gl_account_setup สำหรับประเภทเอกสารนี้`);
            }
            return { accountId: Number(setup.cogs_account_id), label: 'ต้นทุนขาย (ส่งสินค้า)' };
        default:
            throw new Error(`ยังไม่รองรับการ Post บัญชีสำหรับประเภทเอกสารนี้ (sys_doc_type='${sysDocType}')`);
    }
};

const postGlEntry = async (client, headerId, header, details, docNo, sysDocType, mode) => {
    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date AND gl_status = 'OPEN' AND im_status != 'CLOSED' LIMIT 1`,
        [header.doc_date]
    );
    if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.doc_date}`);
    const periodId = periodRes.rows[0].id;

    const setup = await fetchSetupByDocCode(client, header.doc_code);
    if (!setup) throw new Error(`ยังไม่ได้ตั้งค่าบัญชีใน im_gl_account_setup สำหรับ ${header.doc_code}`);
    if (!setup.gl_doc_id) throw new Error('ยังไม่ได้ตั้งค่า GL Document Type ใน im_gl_account_setup สำหรับประเภทเอกสารนี้');

    const invDebitByAccount = {}; // account_id -> net value (บวก=debit สุทธิ, ลบ=credit สุทธิ)
    const glDetails = [];

    if (sysDocType === '70') {
        // TRF — โอนสินค้า: Dr บัญชีสต็อกปลายทาง / Cr บัญชีสต็อกต้นทาง ไม่มีบัญชีคู่บัญชีแยกต่างหาก (ทั้งสองฝั่งเป็นบัญชีสต็อก
        // เหมือนกัน) วันนี้ im_warehouse ยังไม่มีบัญชีแยกตามคลัง ทั้งสองฝั่งจึง resolve ไปที่บัญชีเดียวกันเสมอ หักล้างเป็น 0
        // และจะไม่มีการโพสต์ GL เลยจนกว่าจะตั้งค่าบัญชีแยกตามคลัง (ดู resolveInventoryAccount)
        for (const d of details) {
            const value = Number(d.qty) * Number(d.unit_cost); // ติดลบเสมอ — มูลค่าที่ออกจากต้นทาง (qty ของ TRF คือฝั่งต้นทาง)
            const srcAcc = await resolveInventoryAccount(client, d.item_id, header.warehouse_id, setup.inventory_account_id);
            const dstAcc = await resolveInventoryAccount(client, d.item_id, header.to_warehouse_id, setup.inventory_account_id);
            invDebitByAccount[srcAcc] = (invDebitByAccount[srcAcc] || 0) + value;
            invDebitByAccount[dstAcc] = (invDebitByAccount[dstAcc] || 0) - value;
        }
        for (const [accId, amt] of Object.entries(invDebitByAccount)) {
            if (amt === 0) continue;
            glDetails.push({
                account_id: Number(accId), description: `โอนสินค้า ${docNo}`,
                debit_lc: amt > 0 ? amt : 0, credit_lc: amt < 0 ? -amt : 0, debit_fc: 0, credit_fc: 0,
            });
        }
    } else if (sysDocType === '10') {
        // GRN — รับสินค้า (ไม่มีเลขที่อ้างอิง): Dr คลัง (Perpetual) หรือ Dr ซื้อสินค้า (Periodic) / Cr พักรอใบกำกับ (GR/IR)
        // ทั้งสองโหมด Post ที่นี่เสมอ (ต่างจาก AJS/ISS/TRF ที่ถูกระงับใน Periodic) เพราะ GR/IR ต้องขยับทันทีที่รับของจริง
        const { accountId: counterAccountId, label: counterLabel } = resolveCounterAccount(sysDocType, setup);
        let purchasesAccountId = null;
        if (mode === 'PERIODIC') {
            const setting = await fetchSettingRow(client);
            if (!setting?.purchases_account_id) {
                throw new Error('ยังไม่ได้ตั้งค่าบัญชีซื้อสินค้า (purchases_account_id) ใน ตั้งค่าบัญชีสินค้าคงคลัง IM สำหรับโหมด Periodic');
            }
            purchasesAccountId = Number(setting.purchases_account_id);
        }
        let totalValue = 0;
        for (const d of details) {
            const invAcc = purchasesAccountId || await resolveInventoryAccount(client, d.item_id, header.warehouse_id, setup.inventory_account_id);
            const value = Number(d.qty) * Number(d.unit_cost);
            invDebitByAccount[invAcc] = (invDebitByAccount[invAcc] || 0) + value;
            totalValue += value;
        }
        for (const [accId, amt] of Object.entries(invDebitByAccount)) {
            if (amt === 0) continue;
            glDetails.push({
                account_id: Number(accId), description: `${counterLabel} ${docNo}`,
                debit_lc: amt > 0 ? amt : 0, credit_lc: amt < 0 ? -amt : 0, debit_fc: 0, credit_fc: 0,
            });
        }
        if (totalValue !== 0) {
            glDetails.push({
                account_id: counterAccountId, description: `${counterLabel} ${docNo}`,
                debit_lc: totalValue < 0 ? -totalValue : 0, credit_lc: totalValue > 0 ? totalValue : 0, debit_fc: 0, credit_fc: 0,
            });
        }
    } else {
        const { accountId: counterAccountId, label: counterLabel } = resolveCounterAccount(sysDocType, setup);
        let totalValue = 0;
        for (const d of details) {
            const invAcc = await resolveInventoryAccount(client, d.item_id, header.warehouse_id, setup.inventory_account_id);
            const value = Number(d.qty) * Number(d.unit_cost);
            invDebitByAccount[invAcc] = (invDebitByAccount[invAcc] || 0) + value;
            totalValue += value;
        }
        for (const [accId, amt] of Object.entries(invDebitByAccount)) {
            if (amt === 0) continue;
            glDetails.push({
                account_id: Number(accId), description: `${counterLabel} ${docNo}`,
                debit_lc: amt > 0 ? amt : 0, credit_lc: amt < 0 ? -amt : 0, debit_fc: 0, credit_fc: 0,
            });
        }
        if (totalValue !== 0) {
            glDetails.push({
                account_id: counterAccountId, description: `${counterLabel} ${docNo}`,
                debit_lc: totalValue < 0 ? -totalValue : 0, credit_lc: totalValue > 0 ? totalValue : 0, debit_fc: 0, credit_fc: 0,
            });
        }
    }
    if (glDetails.length === 0) return null; // ไม่มีผลต่างมูลค่าใดๆ — ไม่ต้องโพสต์ GL

    let glDocNo = await generateDocNo(client, setup.gl_doc_id, header.doc_date, header.branch_id);
    if (!glDocNo) glDocNo = `GL-${docNo}`;

    let createdByUserId = null;
    if (header.created_by) {
        const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [header.created_by]);
        if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
    }

    const totalDebit = glDetails.reduce((s, l) => s + l.debit_lc, 0);
    const totalCredit = glDetails.reduce((s, l) => s + l.credit_lc, 0);

    const glHeaderRes = await client.query(`
        INSERT INTO gl_entry_header
        (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
         currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
         created_by, ref_doc_id, ref_doc_no, external_source_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'Posted',$9,$10,0,0,$11,$12,$13,$14)
        RETURNING id
    `, [
        setup.gl_doc_id, glDocNo, header.doc_date, header.doc_date, periodId,
        header.ref_no || null, header.description || null,
        1, totalDebit, totalCredit, createdByUserId, header.doc_id, docNo, headerId,
    ]);
    const glEntryId = glHeaderRes.rows[0].id;

    let lineNo = 1;
    for (const l of glDetails) {
        await client.query(`
            INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc,
                                          dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [glEntryId, lineNo++, l.account_id, l.description, l.debit_lc, l.credit_lc, l.debit_fc, l.credit_fc,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null]);
    }
    return glEntryId;
};

// บันทึกรายการ VAT ลง vt_transaction (ตารางกลางสำหรับรายงานภาษีมูลค่าเพิ่ม ใช้ร่วมกันทุกโมดูล) — มิเรอร์
// insertVtRecords ของ ap/arTransactionController.js เอง แต่รวมเป็นฟังก์ชันเดียวใช้ร่วมกันทั้งฝั่ง AP
// (INPUT_VAT) และ AR (OUTPUT_VAT) เพราะฟังก์ชัน postXxxFromIm ทั้งหมด insert ตรงเข้า ap_transaction/
// ar_transaction เอง (ไม่ได้เรียกผ่าน createTransaction ของ AP/AR) จึงต้องบันทึก vt_transaction เองที่นี่
// ด้วยเช่นกัน — เรียกทีละบรรทัดหลังจาก insert ap_transaction_detail/ar_transaction_detail แล้ว เพื่อให้มี
// detailId จริงสำหรับ source_detail_id (มิเรอร์ระดับความละเอียดเดียวกับต้นฉบับ)
const insertImVtLine = async (client, {
    moduleCode, vatType, vatRate, docId, headerId, detailId, docNo, docDate,
    baseLc, vatLc, entityIdField, entityId, entityName, entityTaxId, createdByUserId, vatSign,
}) => {
    if (!vatType || vatType === 'NOVAT' || Number(vatLc) === 0) return;
    await client.query(`
        INSERT INTO vt_transaction
        (module_code, vat_type, doc_id, source_header_id, source_detail_id,
         doc_no, doc_date, vat_rate,
         base_amount_lc, vat_amount_lc, base_amount_fc, vat_amount_fc,
         currency_id, exchange_rate, ${entityIdField}, entity_name, entity_tax_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$10,1,1,$11,$12,$13,$14)
    `, [
        moduleCode, vatType, docId, headerId, detailId,
        docNo, docDate, vatRate,
        baseLc * vatSign, vatLc * vatSign,
        entityId, entityName || '', entityTaxId || null, createdByUserId,
    ]);
};

// GRN Billing (sys_doc_type='11') — สร้าง+โพสต์ ap_transaction (ใบกำกับสินค้า) อัตโนมัติแทนการ Post GL ของ IM เอง
// ตามธรรมเนียมเดียวกับ postCmPaymentHelper/postCmReceiptsHelper ใน ap/arTransactionController.js: INSERT ตรงเข้า
// ตารางของอีกโมดูลด้วย client เดียวกัน ไม่เรียกผ่าน createTransaction ของ AP (จัดการ BEGIN/COMMIT เอง เรียกข้าม
// transaction ที่เปิดอยู่ไม่ได้) — v1: ไม่มี VAT/WHT, ผู้ใช้ AP แก้ไขเพิ่มเติมได้เองภายหลังถ้าจำเป็น
const postApBillFromGrn = async (client, { header, details, docNo, vendorInvoiceNo, mode }) => {
    if (!header.vendor_id) throw new Error('ต้องระบุผู้ขายสำหรับเอกสารประเภทนี้');
    if (!vendorInvoiceNo) throw new Error('ต้องระบุเลขที่ใบกำกับสินค้าผู้ขายสำหรับเอกสารประเภทนี้');

    const apDocRes = await client.query(`
        SELECT id, doc_code FROM sa_module_document
        WHERE sys_module='21' AND sys_doc_type='10' AND is_doc_type=true AND is_active=true
        ORDER BY sort_order LIMIT 1
    `);
    if (apDocRes.rows.length === 0) throw new Error('ไม่พบประเภทเอกสารใบกำกับสินค้า (Purchase Invoice) ในโมดูล AP');
    const apDocId = apDocRes.rows[0].id;
    const apDocCode = apDocRes.rows[0].doc_code;

    const apSetupRes = await client.query(`SELECT * FROM ap_gl_account_setup WHERE doc_code = $1`, [apDocCode]);
    const apSetup = apSetupRes.rows[0] || null;
    if (!apSetup?.gl_doc_id) throw new Error('ยังไม่ได้ตั้งค่า GL Document Type ใน ap_gl_account_setup สำหรับใบกำกับสินค้า');

    let apAccountId = apSetup.ap_account_id ? Number(apSetup.ap_account_id) : null;
    if (!apAccountId) {
        const vendorAcctRes = await client.query(`SELECT ap_account_id FROM ap_vendor WHERE id = $1`, [header.vendor_id]);
        apAccountId = vendorAcctRes.rows[0]?.ap_account_id ? Number(vendorAcctRes.rows[0].ap_account_id) : null;
    }
    if (!apAccountId) throw new Error('ไม่พบบัญชีเจ้าหนี้สำหรับการลงบัญชี กรุณาตั้งค่าใน ap_gl_account_setup หรือผู้ขาย');

    // บัญชี VAT ซื้อ — ดูที่ im_gl_account_setup ของ doc_code เอกสาร IM นี้ก่อน (ให้ override ได้ต่อ doc_code
    // เหมือน resolveInventoryAccount) แล้วค่อย fallback ไปที่บัญชี VAT ของใบกำกับสินค้า AP เอง
    const imSetupVatRes = await client.query(`SELECT vat_input_account_id FROM im_gl_account_setup WHERE doc_code = $1`, [header.doc_code]);
    const vatAccountId = Number(imSetupVatRes.rows[0]?.vat_input_account_id) || Number(apSetup.vat_input_account_id) || null;

    let purchasesAccountId = null;
    if (mode === 'PERIODIC') {
        const setting = await fetchSettingRow(client);
        if (!setting?.purchases_account_id) {
            throw new Error('ยังไม่ได้ตั้งค่าบัญชีซื้อสินค้า (purchases_account_id) ใน ตั้งค่าบัญชีสินค้าคงคลัง IM สำหรับโหมด Periodic');
        }
        purchasesAccountId = Number(setting.purchases_account_id);
    }

    const vendorRow = await client.query(`SELECT vendor_code, vendor_name_th, tax_id FROM ap_vendor WHERE id = $1`, [header.vendor_id]);
    const vendorCode = vendorRow.rows[0]?.vendor_code || null;
    const vendorNameTh = vendorRow.rows[0]?.vendor_name_th || null;
    const vendorTaxId = vendorRow.rows[0]?.tax_id || null;

    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date AND gl_status='OPEN' AND ap_status != 'CLOSED' LIMIT 1`,
        [header.doc_date]
    );
    if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.doc_date}`);
    const periodId = periodRes.rows[0].id;

    let apDocNo = await generateDocNo(client, apDocId, header.doc_date, header.branch_id);
    if (!apDocNo) apDocNo = `PI-${docNo}`;

    let createdByUserId = null;
    if (header.created_by) {
        const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [header.created_by]);
        if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
    }

    const lineRows = [];
    let totalAmount = 0, totalVat = 0;
    for (const d of details) {
        const expenseAccountId = purchasesAccountId
            || await resolveInventoryAccount(client, d.item_id, header.warehouse_id, apSetup.expense_account_id);
        const qty = Number(d.qty);
        const unitCost = Number(d.unit_cost);
        const amount = qty * unitCost;
        const vatType = d.vat_type || 'NOVAT';
        const vatRate = vatType === 'NOVAT' ? 0 : (Number(d.vat_rate) || 0);
        const vatAmount = amount * vatRate / 100;
        lineRows.push({ itemCode: d.item_code, itemName: d.item_name, quantity: qty, unitPriceFc: unitCost, amount, expenseAccountId, vatType, vatRate, vatAmount });
        totalAmount += amount;
        totalVat += vatAmount;
    }
    const grandTotal = totalAmount + totalVat;

    const apHeaderRes = await client.query(`
        INSERT INTO ap_transaction
        (doc_id, doc_no, doc_date, period_id, vendor_id, vendor_code, vendor_name_th, ap_account_id, gl_doc_id,
         currency_code, exchange_rate, subtotal_fc, before_vat_fc, vat_amount_fc, total_amount_fc,
         subtotal_lc, before_vat_lc, vat_amount_lc, total_amount_lc,
         balance_amount_lc, ref_no, ref_doc_id, ref_doc_no, description, status, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'THB',1,$10,$10,$11,$12,$10,$10,$11,$12,$12,$13,$14,$15,$16,'Posted',$17,$17)
        RETURNING id
    `, [
        apDocId, apDocNo, header.doc_date, periodId, header.vendor_id, vendorCode, vendorNameTh, apAccountId, apSetup.gl_doc_id,
        totalAmount, totalVat, grandTotal,
        vendorInvoiceNo, header.doc_id, docNo, `ใบกำกับสินค้าจากการรับสินค้า ${docNo}`, createdByUserId,
    ]);
    const apTransactionId = apHeaderRes.rows[0].id;

    let lineNo = 1;
    for (const l of lineRows) {
        const detailRes = await client.query(`
            INSERT INTO ap_transaction_detail
            (header_id, line_no, description, quantity, unit_price_fc, subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
             expense_account_id, subtotal_lc, vat_amount_lc, total_amount_lc)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$6,$9,$10)
            RETURNING id
        `, [apTransactionId, lineNo++, l.itemName || l.itemCode, l.quantity, l.unitPriceFc, l.amount, l.vatType, l.vatRate, l.vatAmount, l.amount + l.vatAmount, l.expenseAccountId]);
        await insertImVtLine(client, {
            moduleCode: 'AP', vatType: l.vatType, vatRate: l.vatRate, docId: apDocId, headerId: apTransactionId,
            detailId: detailRes.rows[0].id, docNo: apDocNo, docDate: header.doc_date,
            baseLc: l.amount, vatLc: l.vatAmount, entityIdField: 'vendor_id', entityId: header.vendor_id,
            entityName: vendorNameTh, entityTaxId: vendorTaxId, createdByUserId, vatSign: 1,
        });
    }

    const expDebitByAccount = {};
    for (const l of lineRows) {
        expDebitByAccount[l.expenseAccountId] = (expDebitByAccount[l.expenseAccountId] || 0) + l.amount;
    }
    const apGlDetails = [];
    for (const [accId, amt] of Object.entries(expDebitByAccount)) {
        if (amt === 0) continue;
        apGlDetails.push({ account_id: Number(accId), description: `ใบกำกับสินค้า ${apDocNo}`, debit_lc: amt, credit_lc: 0 });
    }
    if (totalVat !== 0) {
        if (!vatAccountId) throw new Error('ยังไม่ได้ตั้งค่าบัญชี VAT ซื้อ (vat_input_account_id) ใน im_gl_account_setup หรือ ap_gl_account_setup');
        apGlDetails.push({ account_id: vatAccountId, description: `VAT ซื้อ ${apDocNo}`, debit_lc: totalVat, credit_lc: 0 });
    }
    if (grandTotal !== 0) {
        apGlDetails.push({ account_id: apAccountId, description: `ใบกำกับสินค้า ${apDocNo}`, debit_lc: 0, credit_lc: grandTotal });
    }

    if (apGlDetails.length > 0) {
        const totalDebit = apGlDetails.reduce((s, l) => s + l.debit_lc, 0);
        const totalCredit = apGlDetails.reduce((s, l) => s + l.credit_lc, 0);
        const apGlHeaderRes = await client.query(`
            INSERT INTO gl_entry_header
            (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
             currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
             created_by, ref_doc_id, ref_doc_no, external_source_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'Posted',$9,$10,0,0,$11,$12,$13,$14)
            RETURNING id
        `, [
            apSetup.gl_doc_id, `GL-${apDocNo}`, header.doc_date, header.doc_date, periodId,
            vendorInvoiceNo, `ใบกำกับสินค้าจากการรับสินค้า ${docNo}`,
            1, totalDebit, totalCredit, createdByUserId, apDocId, apDocNo, apTransactionId,
        ]);
        const apGlEntryId = apGlHeaderRes.rows[0].id;
        let glLineNo = 1;
        for (const l of apGlDetails) {
            await client.query(`
                INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                VALUES ($1,$2,$3,$4,$5,$6,0,0)
            `, [apGlEntryId, glLineNo++, l.account_id, l.description, l.debit_lc, l.credit_lc]);
        }
        await client.query(`UPDATE ap_transaction SET gl_entry_id = $1 WHERE id = $2`, [apGlEntryId, apTransactionId]);
    }

    return apTransactionId;
};

// DLN Billing (sys_doc_type='31'/'32' ตอน Post AR/GL) — สร้าง+โพสต์ ar_transaction (ใบแจ้งหนี้ลูกหนี้) อัตโนมัติ
// แยกต่างหากจากการ Post GL ของ IM เอง (Dr ต้นทุนขาย/Cr คลัง ผ่าน postGlEntry) เพราะการขายมี 2 journal entry แยกกัน
// ตามหลักบัญชีคู่มาตรฐาน (ต่างจาก GRN ที่ Dr คลัง/Cr เจ้าหนี้ เป็น entry เดียวกัน จึงข้าม postGlEntry ไปเลยสำหรับ '11')
// vat_type/vat_rate มาจากที่ผู้ใช้เลือกต่อบรรทัดในหน้าจอ IM เอง (อ้างอิง cd_vat_rate เดียวกับ AR/AP) ไม่ใช่ 7%
// ตายตัวอีกต่อไป — ดู insertImVtLine สำหรับการบันทึกลง vt_transaction (รายงานภาษี) ควบคู่กันไปด้วย
const postArBillFromDln = async (client, { header, details, docNo }) => {
    if (!header.customer_id) throw new Error('ต้องระบุลูกค้าสำหรับเอกสารประเภทนี้');

    const arDocRes = await client.query(`
        SELECT id, doc_code FROM sa_module_document
        WHERE sys_module='11' AND sys_doc_type='10' AND is_doc_type=true AND is_active=true
        ORDER BY sort_order LIMIT 1
    `);
    if (arDocRes.rows.length === 0) throw new Error('ไม่พบประเภทเอกสารใบแจ้งหนี้ (Billing) ในโมดูล AR');
    const arDocId = arDocRes.rows[0].id;
    const arDocCode = arDocRes.rows[0].doc_code;

    const arSetupRes = await client.query(`SELECT * FROM ar_gl_account_setup WHERE doc_code = $1`, [arDocCode]);
    const arSetup = arSetupRes.rows[0] || null;
    if (!arSetup?.gl_doc_id) throw new Error('ยังไม่ได้ตั้งค่า GL Document Type ใน ar_gl_account_setup สำหรับใบแจ้งหนี้');

    // บัญชี VAT ขาย — ดูที่ im_gl_account_setup ของ doc_code เอกสาร IM นี้ก่อน (ให้ override ได้ต่อ doc_code
    // เหมือน resolveInventoryAccount) แล้วค่อย fallback ไปที่บัญชี VAT ของใบแจ้งหนี้ AR เอง
    const imSetupVatRes = await client.query(`SELECT vat_output_account_id FROM im_gl_account_setup WHERE doc_code = $1`, [header.doc_code]);
    const vatAccountId = Number(imSetupVatRes.rows[0]?.vat_output_account_id) || Number(arSetup.vat_output_account_id) || null;

    const customerRes = await client.query(`
        SELECT c.customer_code, c.customer_name_th, c.tax_id, c.ar_account_id, g.gl_account_id AS group_ar_account_id
        FROM ar_customer c LEFT JOIN ar_customer_group g ON g.id = c.customer_group_id
        WHERE c.id = $1
    `, [header.customer_id]);
    const customerRow = customerRes.rows[0];
    if (!customerRow) throw new Error('ไม่พบลูกค้าที่ระบุ');

    // บัญชีลูกหนี้ — มิเรอร์ 3 ระดับเดียวกับ postGlEntry ของ arTransactionController.js เอง: ar_gl_account_setup >
    // กลุ่มลูกค้า > ลูกค้า (ต่างจาก AP ที่มีแค่ 2 ระดับ เพราะ ap_vendor ไม่มีแนวคิดกลุ่มผู้ขาย)
    let arAccountId = arSetup.ar_account_id ? Number(arSetup.ar_account_id) : null;
    if (!arAccountId) arAccountId = customerRow.group_ar_account_id ? Number(customerRow.group_ar_account_id) : null;
    if (!arAccountId) arAccountId = customerRow.ar_account_id ? Number(customerRow.ar_account_id) : null;
    if (!arAccountId) throw new Error('ไม่พบบัญชีลูกหนี้สำหรับการลงบัญชี กรุณาตั้งค่าใน ar_gl_account_setup, กลุ่มลูกค้า หรือลูกค้า');

    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date AND gl_status='OPEN' LIMIT 1`,
        [header.doc_date]
    );
    if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.doc_date}`);
    const periodId = periodRes.rows[0].id;

    let arDocNo = await generateDocNo(client, arDocId, header.doc_date, header.branch_id);
    if (!arDocNo) arDocNo = `INV-${docNo}`;

    let createdByUserId = null;
    if (header.created_by) {
        const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [header.created_by]);
        if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
    }

    const lineRows = [];
    let totalSubtotal = 0, totalVat = 0;
    for (const d of details) {
        const revenueAccountId = await resolveRevenueAccount(client, d.item_id, arSetup.revenue_account_id);
        const qty = Math.abs(Number(d.qty) || 0); // qty ของ DLN ติดลบเสมอ (สต็อกลด) — ใบแจ้งหนี้ต้องเป็นจำนวนบวก
        const unitPrice = Number(d.unit_price) || 0;
        const subtotal = qty * unitPrice;
        const vatType = d.vat_type || 'NOVAT';
        const vatRate = vatType === 'NOVAT' ? 0 : (Number(d.vat_rate) || 0);
        const vatAmount = subtotal * vatRate / 100;
        lineRows.push({
            itemCode: d.item_code, itemName: d.item_name, quantity: qty, unitPriceFc: unitPrice,
            subtotal, vatType, vatRate, vatAmount, total: subtotal + vatAmount, revenueAccountId,
        });
        totalSubtotal += subtotal;
        totalVat += vatAmount;
    }
    const totalAmount = totalSubtotal + totalVat;

    const arHeaderRes = await client.query(`
        INSERT INTO ar_transaction
        (doc_id, doc_no, doc_date, period_id, customer_id, customer_code, customer_name_th, ar_account_id,
         currency_code, exchange_rate, subtotal_fc, before_vat_fc, vat_amount_fc, total_amount_fc,
         subtotal_lc, before_vat_lc, vat_amount_lc, total_amount_lc, balance_amount_lc,
         ref_no, ref_doc_id, ref_doc_no, description, status, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'THB',1,$9,$9,$10,$11,$9,$9,$10,$11,$11,$12,$13,$14,$15,'Posted',$16,$16)
        RETURNING id
    `, [
        arDocId, arDocNo, header.doc_date, periodId, header.customer_id, customerRow.customer_code, customerRow.customer_name_th,
        arAccountId,
        totalSubtotal, totalVat, totalAmount,
        header.ref_no || null, header.doc_id, docNo, `ใบแจ้งหนี้จากการส่งสินค้า ${docNo}`, createdByUserId,
    ]);
    const arTransactionId = arHeaderRes.rows[0].id;

    let lineNo = 1;
    for (const l of lineRows) {
        const detailRes = await client.query(`
            INSERT INTO ar_transaction_detail
            (header_id, line_no, description, quantity, unit_price_fc, subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
             revenue_account_id, subtotal_lc, vat_amount_lc, total_amount_lc)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$6,$9,$10)
            RETURNING id
        `, [arTransactionId, lineNo++, l.itemName || l.itemCode, l.quantity, l.unitPriceFc, l.subtotal, l.vatType, l.vatRate, l.vatAmount, l.total, l.revenueAccountId]);
        await insertImVtLine(client, {
            moduleCode: 'AR', vatType: l.vatType, vatRate: l.vatRate, docId: arDocId, headerId: arTransactionId,
            detailId: detailRes.rows[0].id, docNo: arDocNo, docDate: header.doc_date,
            baseLc: l.subtotal, vatLc: l.vatAmount, entityIdField: 'customer_id', entityId: header.customer_id,
            entityName: customerRow.customer_name_th, entityTaxId: customerRow.tax_id, createdByUserId, vatSign: 1,
        });
    }

    const revCreditByAccount = {};
    for (const l of lineRows) {
        revCreditByAccount[l.revenueAccountId] = (revCreditByAccount[l.revenueAccountId] || 0) + l.subtotal;
    }
    const arGlDetails = [];
    for (const [accId, amt] of Object.entries(revCreditByAccount)) {
        if (amt === 0) continue;
        arGlDetails.push({ account_id: Number(accId), description: `ใบแจ้งหนี้ ${arDocNo}`, debit_lc: 0, credit_lc: amt });
    }
    if (totalVat !== 0) {
        if (!vatAccountId) throw new Error('ยังไม่ได้ตั้งค่าบัญชีภาษีขาย (vat_output_account_id) ใน im_gl_account_setup หรือ ar_gl_account_setup');
        arGlDetails.push({ account_id: vatAccountId, description: `ภาษีขาย ${arDocNo}`, debit_lc: 0, credit_lc: totalVat });
    }
    if (totalAmount !== 0) {
        arGlDetails.push({ account_id: arAccountId, description: `ใบแจ้งหนี้ ${arDocNo}`, debit_lc: totalAmount, credit_lc: 0 });
    }

    if (arGlDetails.length > 0) {
        const totalDebit = arGlDetails.reduce((s, l) => s + l.debit_lc, 0);
        const totalCredit = arGlDetails.reduce((s, l) => s + l.credit_lc, 0);
        const arGlHeaderRes = await client.query(`
            INSERT INTO gl_entry_header
            (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
             currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
             created_by, ref_doc_id, ref_doc_no, external_source_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'Posted',$9,$10,0,0,$11,$12,$13,$14)
            RETURNING id
        `, [
            arSetup.gl_doc_id, `GL-${arDocNo}`, header.doc_date, header.doc_date, periodId,
            header.ref_no || null, `ใบแจ้งหนี้จากการส่งสินค้า ${docNo}`,
            1, totalDebit, totalCredit, createdByUserId, arDocId, arDocNo, arTransactionId,
        ]);
        const arGlEntryId = arGlHeaderRes.rows[0].id;
        let glLineNo = 1;
        for (const l of arGlDetails) {
            await client.query(`
                INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                VALUES ($1,$2,$3,$4,$5,$6,0,0)
            `, [arGlEntryId, glLineNo++, l.account_id, l.description, l.debit_lc, l.credit_lc]);
        }
        await client.query(`UPDATE ar_transaction SET gl_entry_id = $1 WHERE id = $2`, [arGlEntryId, arTransactionId]);
    }

    return arTransactionId;
};

// AP CN/DN from IM (sys_doc_type '15'/'20'=คืนสินค้า/ลดหนี้เจ้าหนี้ → AP CN, '25'=เพิ่มหนี้เจ้าหนี้ → AP DN) —
// รวมเป็นฟังก์ชันเดียวด้วย flag isCredit แทนที่จะแยก 2 ฟังก์ชันแบบ postApBillFromGrn/postArBillFromDln เพราะการ
// แยกฟังก์ชันของทั้งคู่นั้นมีเหตุผลจากการข้าม module boundary (AP กับ AR) — แต่ CN/DN ที่นี่อยู่ใน module เดียวกัน
// (AP) ต่างกันแค่ทิศทาง Dr/Cr เหมือนที่ apTransactionController.js เองก็ใช้ flag เดียว (isCreditNote) จัดการทั้งคู่
// สำคัญ: sys_doc_type จริงของ AP CN/DN คือ 30=ใบลดหนี้(CN), 50=ใบเพิ่มหนี้(DN) ตาม ap_transaction.dart/
// apTransactionController.js ('isCreditNote = sysDocType === '30'') — สลับกับ label ที่ผิดใน apSysDocType
// (sa_anan_module.dart) จึง hardcode ตามโค้ดจริงตรงนี้ ไม่ผ่าน map นั้น
// v1: ไม่มี VAT/WHT เหมือน postApBillFromGrn (เอกสารฝั่งซื้อ ผู้ใช้ AP แก้ไขเพิ่มเติมได้เองภายหลังถ้าจำเป็น)
const postApCreditDebitNoteFromIm = async (client, { header, details, docNo, mode, isCredit }) => {
    if (!header.vendor_id) throw new Error('ต้องระบุผู้ขายสำหรับเอกสารประเภทนี้');

    const apSysDocType = isCredit ? '30' : '50';
    const apDocRes = await client.query(`
        SELECT id, doc_code FROM sa_module_document
        WHERE sys_module='21' AND sys_doc_type=$1 AND is_doc_type=true AND is_active=true
        ORDER BY sort_order LIMIT 1
    `, [apSysDocType]);
    if (apDocRes.rows.length === 0) {
        throw new Error(`ไม่พบประเภทเอกสาร${isCredit ? 'ใบลดหนี้จากผู้ขาย' : 'ใบเพิ่มหนี้จากผู้ขาย'} ในโมดูล AP`);
    }
    const apDocId = apDocRes.rows[0].id;
    const apDocCode = apDocRes.rows[0].doc_code;

    const apSetupRes = await client.query(`SELECT * FROM ap_gl_account_setup WHERE doc_code = $1`, [apDocCode]);
    const apSetup = apSetupRes.rows[0] || null;
    if (!apSetup?.gl_doc_id) throw new Error(`ยังไม่ได้ตั้งค่า GL Document Type ใน ap_gl_account_setup สำหรับ${isCredit ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้'}จากผู้ขาย`);

    let apAccountId = apSetup.ap_account_id ? Number(apSetup.ap_account_id) : null;
    if (!apAccountId) {
        const vendorAcctRes = await client.query(`SELECT ap_account_id FROM ap_vendor WHERE id = $1`, [header.vendor_id]);
        apAccountId = vendorAcctRes.rows[0]?.ap_account_id ? Number(vendorAcctRes.rows[0].ap_account_id) : null;
    }
    if (!apAccountId) throw new Error('ไม่พบบัญชีเจ้าหนี้สำหรับการลงบัญชี กรุณาตั้งค่าใน ap_gl_account_setup หรือผู้ขาย');

    // บัญชี VAT ซื้อ — ดูที่ im_gl_account_setup ของ doc_code เอกสาร IM นี้ก่อน แล้วค่อย fallback ไปที่
    // บัญชี VAT ของ AP เอง (มิเรอร์ postApBillFromGrn ทุกประการ)
    const imSetupVatRes = await client.query(`SELECT vat_input_account_id FROM im_gl_account_setup WHERE doc_code = $1`, [header.doc_code]);
    const vatAccountId = Number(imSetupVatRes.rows[0]?.vat_input_account_id) || Number(apSetup.vat_input_account_id) || null;

    let purchasesAccountId = null;
    if (mode === 'PERIODIC') {
        const setting = await fetchSettingRow(client);
        if (!setting?.purchases_account_id) {
            throw new Error('ยังไม่ได้ตั้งค่าบัญชีซื้อสินค้า (purchases_account_id) ใน ตั้งค่าบัญชีสินค้าคงคลัง IM สำหรับโหมด Periodic');
        }
        purchasesAccountId = Number(setting.purchases_account_id);
    }

    const vendorRow = await client.query(`SELECT vendor_code, vendor_name_th, tax_id FROM ap_vendor WHERE id = $1`, [header.vendor_id]);
    const vendorCode = vendorRow.rows[0]?.vendor_code || null;
    const vendorNameTh = vendorRow.rows[0]?.vendor_name_th || null;
    const vendorTaxId = vendorRow.rows[0]?.tax_id || null;

    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date AND gl_status='OPEN' AND ap_status != 'CLOSED' LIMIT 1`,
        [header.doc_date]
    );
    if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.doc_date}`);
    const periodId = periodRes.rows[0].id;

    let apDocNo = await generateDocNo(client, apDocId, header.doc_date, header.branch_id);
    if (!apDocNo) apDocNo = `${isCredit ? 'CN' : 'DN'}-${docNo}`;

    let createdByUserId = null;
    if (header.created_by) {
        const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [header.created_by]);
        if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
    }

    const lineRows = [];
    let totalAmount = 0, totalVat = 0;
    for (const d of details) {
        const expenseAccountId = purchasesAccountId
            || await resolveInventoryAccount(client, d.item_id, header.warehouse_id, apSetup.expense_account_id);
        const qty = Math.abs(Number(d.qty) || 0); // qty ติดลบสำหรับ CN (สต็อกลด) บวกสำหรับ DN — เอกสาร AP ต้องเป็นจำนวนบวกเสมอ
        const unitCost = Number(d.unit_cost);
        const amount = qty * unitCost;
        const vatType = d.vat_type || 'NOVAT';
        const vatRate = vatType === 'NOVAT' ? 0 : (Number(d.vat_rate) || 0);
        const vatAmount = amount * vatRate / 100;
        lineRows.push({ itemCode: d.item_code, itemName: d.item_name, quantity: qty, unitPriceFc: unitCost, amount, expenseAccountId, vatType, vatRate, vatAmount });
        totalAmount += amount;
        totalVat += vatAmount;
    }
    const grandTotal = totalAmount + totalVat;

    const label = isCredit ? 'ใบลดหนี้จากผู้ขาย' : 'ใบเพิ่มหนี้จากผู้ขาย';
    const apHeaderRes = await client.query(`
        INSERT INTO ap_transaction
        (doc_id, doc_no, doc_date, period_id, vendor_id, vendor_code, vendor_name_th, ap_account_id, gl_doc_id,
         currency_code, exchange_rate, subtotal_fc, before_vat_fc, vat_amount_fc, total_amount_fc,
         subtotal_lc, before_vat_lc, vat_amount_lc, total_amount_lc,
         balance_amount_lc, ref_no, ref_doc_id, ref_doc_no, description, status, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'THB',1,$10,$10,$11,$12,$10,$10,$11,$12,$12,$13,$14,$15,$16,'Posted',$17,$17)
        RETURNING id
    `, [
        apDocId, apDocNo, header.doc_date, periodId, header.vendor_id, vendorCode, vendorNameTh, apAccountId, apSetup.gl_doc_id,
        totalAmount, totalVat, grandTotal,
        header.ref_no || null, header.doc_id, docNo, `${label} (${docNo})`, createdByUserId,
    ]);
    const apTransactionId = apHeaderRes.rows[0].id;

    let lineNo = 1;
    for (const l of lineRows) {
        const detailRes = await client.query(`
            INSERT INTO ap_transaction_detail
            (header_id, line_no, description, quantity, unit_price_fc, subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
             expense_account_id, subtotal_lc, vat_amount_lc, total_amount_lc)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$6,$9,$10)
            RETURNING id
        `, [apTransactionId, lineNo++, l.itemName || l.itemCode, l.quantity, l.unitPriceFc, l.amount, l.vatType, l.vatRate, l.vatAmount, l.amount + l.vatAmount, l.expenseAccountId]);
        await insertImVtLine(client, {
            moduleCode: 'AP', vatType: l.vatType, vatRate: l.vatRate, docId: apDocId, headerId: apTransactionId,
            detailId: detailRes.rows[0].id, docNo: apDocNo, docDate: header.doc_date,
            baseLc: l.amount, vatLc: l.vatAmount, entityIdField: 'vendor_id', entityId: header.vendor_id,
            entityName: vendorNameTh, entityTaxId: vendorTaxId, createdByUserId,
            vatSign: isCredit ? -1 : 1, // CN ลดยอดภาษีซื้อ (ตรงข้ามใบกำกับปกติ) มิเรอร์ AP's own insertVtRecords
        });
    }

    const invByAccount = {};
    for (const l of lineRows) {
        invByAccount[l.expenseAccountId] = (invByAccount[l.expenseAccountId] || 0) + l.amount;
    }
    const apGlDetails = [];
    for (const [accId, amt] of Object.entries(invByAccount)) {
        if (amt === 0) continue;
        // CN: Dr AP / Cr คลัง — DN: Dr คลัง / Cr AP (มิเรอร์ postApBillFromGrn โดยกลับทิศทางเมื่อ isCredit)
        apGlDetails.push({
            account_id: Number(accId), description: `${label} ${apDocNo}`,
            debit_lc: isCredit ? 0 : amt, credit_lc: isCredit ? amt : 0,
        });
    }
    if (totalVat !== 0) {
        if (!vatAccountId) throw new Error('ยังไม่ได้ตั้งค่าบัญชี VAT ซื้อ (vat_input_account_id) ใน im_gl_account_setup หรือ ap_gl_account_setup');
        // VAT ตามทิศทางเดียวกับรายการต้นทุน (CN กลับรายการ VAT ที่เคยขอคืนไปด้วย, DN เพิ่ม VAT ใหม่)
        apGlDetails.push({
            account_id: vatAccountId, description: `VAT ซื้อ ${apDocNo}`,
            debit_lc: isCredit ? 0 : totalVat, credit_lc: isCredit ? totalVat : 0,
        });
    }
    if (grandTotal !== 0) {
        apGlDetails.push({
            account_id: apAccountId, description: `${label} ${apDocNo}`,
            debit_lc: isCredit ? grandTotal : 0, credit_lc: isCredit ? 0 : grandTotal,
        });
    }

    if (apGlDetails.length > 0) {
        const totalDebit = apGlDetails.reduce((s, l) => s + l.debit_lc, 0);
        const totalCredit = apGlDetails.reduce((s, l) => s + l.credit_lc, 0);
        const apGlHeaderRes = await client.query(`
            INSERT INTO gl_entry_header
            (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
             currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
             created_by, ref_doc_id, ref_doc_no, external_source_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'Posted',$9,$10,0,0,$11,$12,$13,$14)
            RETURNING id
        `, [
            apSetup.gl_doc_id, `GL-${apDocNo}`, header.doc_date, header.doc_date, periodId,
            header.ref_no || null, `${label} (${docNo})`,
            1, totalDebit, totalCredit, createdByUserId, apDocId, apDocNo, apTransactionId,
        ]);
        const apGlEntryId = apGlHeaderRes.rows[0].id;
        let glLineNo = 1;
        for (const l of apGlDetails) {
            await client.query(`
                INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                VALUES ($1,$2,$3,$4,$5,$6,0,0)
            `, [apGlEntryId, glLineNo++, l.account_id, l.description, l.debit_lc, l.credit_lc]);
        }
        await client.query(`UPDATE ap_transaction SET gl_entry_id = $1 WHERE id = $2`, [apGlEntryId, apTransactionId]);
    }

    return apTransactionId;
};

// AR CN/DN from IM (sys_doc_type '35'/'40'=รับคืนสินค้า/ลดหนี้ลูกหนี้ → AR CN, '45'=เพิ่มหนี้ลูกหนี้ → AR DN) —
// มิเรอร์ postApCreditDebitNoteFromIm ข้างบน (ฟังก์ชันเดียว + flag isCredit) ใช้ vat_type/vat_rate ต่อบรรทัด
// เดียวกับ postArBillFromDln (ดู insertImVtLine) ไม่ใช่ 7% ตายตัวอีกต่อไป
// sys_doc_type จริงตรงกับ arSysDocType (sa_anan_module.dart) พอดี ไม่มีปัญหา label สลับแบบฝั่ง AP: 50=CN, 30=DN
const postArCreditDebitNoteFromIm = async (client, { header, details, docNo, isCredit }) => {
    if (!header.customer_id) throw new Error('ต้องระบุลูกค้าสำหรับเอกสารประเภทนี้');

    const arSysDocType = isCredit ? '50' : '30';
    const arDocRes = await client.query(`
        SELECT id, doc_code FROM sa_module_document
        WHERE sys_module='11' AND sys_doc_type=$1 AND is_doc_type=true AND is_active=true
        ORDER BY sort_order LIMIT 1
    `, [arSysDocType]);
    if (arDocRes.rows.length === 0) {
        throw new Error(`ไม่พบประเภทเอกสาร${isCredit ? 'ใบลดหนี้ลูกค้า' : 'ใบเพิ่มหนี้ลูกค้า'} ในโมดูล AR`);
    }
    const arDocId = arDocRes.rows[0].id;
    const arDocCode = arDocRes.rows[0].doc_code;

    const arSetupRes = await client.query(`SELECT * FROM ar_gl_account_setup WHERE doc_code = $1`, [arDocCode]);
    const arSetup = arSetupRes.rows[0] || null;
    if (!arSetup?.gl_doc_id) throw new Error(`ยังไม่ได้ตั้งค่า GL Document Type ใน ar_gl_account_setup สำหรับ${isCredit ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้'}ลูกค้า`);

    // บัญชี VAT ขาย — ดูที่ im_gl_account_setup ของ doc_code เอกสาร IM นี้ก่อน แล้วค่อย fallback ไปที่
    // บัญชี VAT ของ AR เอง (มิเรอร์ postArBillFromDln ทุกประการ)
    const imSetupVatRes = await client.query(`SELECT vat_output_account_id FROM im_gl_account_setup WHERE doc_code = $1`, [header.doc_code]);
    const vatAccountId = Number(imSetupVatRes.rows[0]?.vat_output_account_id) || Number(arSetup.vat_output_account_id) || null;

    const customerRes = await client.query(`
        SELECT c.customer_code, c.customer_name_th, c.tax_id, c.ar_account_id, g.gl_account_id AS group_ar_account_id
        FROM ar_customer c LEFT JOIN ar_customer_group g ON g.id = c.customer_group_id
        WHERE c.id = $1
    `, [header.customer_id]);
    const customerRow = customerRes.rows[0];
    if (!customerRow) throw new Error('ไม่พบลูกค้าที่ระบุ');

    let arAccountId = arSetup.ar_account_id ? Number(arSetup.ar_account_id) : null;
    if (!arAccountId) arAccountId = customerRow.group_ar_account_id ? Number(customerRow.group_ar_account_id) : null;
    if (!arAccountId) arAccountId = customerRow.ar_account_id ? Number(customerRow.ar_account_id) : null;
    if (!arAccountId) throw new Error('ไม่พบบัญชีลูกหนี้สำหรับการลงบัญชี กรุณาตั้งค่าใน ar_gl_account_setup, กลุ่มลูกค้า หรือลูกค้า');

    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date AND gl_status='OPEN' LIMIT 1`,
        [header.doc_date]
    );
    if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.doc_date}`);
    const periodId = periodRes.rows[0].id;

    let arDocNo = await generateDocNo(client, arDocId, header.doc_date, header.branch_id);
    if (!arDocNo) arDocNo = `${isCredit ? 'CN' : 'DN'}-${docNo}`;

    let createdByUserId = null;
    if (header.created_by) {
        const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [header.created_by]);
        if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
    }

    const lineRows = [];
    let totalSubtotal = 0, totalVat = 0;
    for (const d of details) {
        const revenueAccountId = await resolveRevenueAccount(client, d.item_id, arSetup.revenue_account_id);
        const qty = Math.abs(Number(d.qty) || 0); // qty ติดลบสำหรับ DN (สต็อกลด) บวกสำหรับ CN — ใบแจ้งหนี้ต้องเป็นจำนวนบวก
        const unitPrice = Number(d.unit_price) || 0;
        const subtotal = qty * unitPrice;
        const vatType = d.vat_type || 'NOVAT';
        const vatRate = vatType === 'NOVAT' ? 0 : (Number(d.vat_rate) || 0);
        const vatAmount = subtotal * vatRate / 100;
        lineRows.push({
            itemCode: d.item_code, itemName: d.item_name, quantity: qty, unitPriceFc: unitPrice,
            subtotal, vatType, vatRate, vatAmount, total: subtotal + vatAmount, revenueAccountId,
        });
        totalSubtotal += subtotal;
        totalVat += vatAmount;
    }
    const totalAmount = totalSubtotal + totalVat;

    const label = isCredit ? 'ใบลดหนี้ลูกค้า' : 'ใบเพิ่มหนี้ลูกค้า';
    const arHeaderRes = await client.query(`
        INSERT INTO ar_transaction
        (doc_id, doc_no, doc_date, period_id, customer_id, customer_code, customer_name_th, ar_account_id,
         currency_code, exchange_rate, subtotal_fc, before_vat_fc, vat_amount_fc, total_amount_fc,
         subtotal_lc, before_vat_lc, vat_amount_lc, total_amount_lc, balance_amount_lc,
         ref_no, ref_doc_id, ref_doc_no, description, status, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'THB',1,$9,$9,$10,$11,$9,$9,$10,$11,$11,$12,$13,$14,$15,'Posted',$16,$16)
        RETURNING id
    `, [
        arDocId, arDocNo, header.doc_date, periodId, header.customer_id, customerRow.customer_code, customerRow.customer_name_th,
        arAccountId,
        totalSubtotal, totalVat, totalAmount,
        header.ref_no || null, header.doc_id, docNo, `${label} (${docNo})`, createdByUserId,
    ]);
    const arTransactionId = arHeaderRes.rows[0].id;

    let lineNo = 1;
    for (const l of lineRows) {
        const detailRes = await client.query(`
            INSERT INTO ar_transaction_detail
            (header_id, line_no, description, quantity, unit_price_fc, subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
             revenue_account_id, subtotal_lc, vat_amount_lc, total_amount_lc)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$6,$9,$10)
            RETURNING id
        `, [arTransactionId, lineNo++, l.itemName || l.itemCode, l.quantity, l.unitPriceFc, l.subtotal, l.vatType, l.vatRate, l.vatAmount, l.total, l.revenueAccountId]);
        await insertImVtLine(client, {
            moduleCode: 'AR', vatType: l.vatType, vatRate: l.vatRate, docId: arDocId, headerId: arTransactionId,
            detailId: detailRes.rows[0].id, docNo: arDocNo, docDate: header.doc_date,
            baseLc: l.subtotal, vatLc: l.vatAmount, entityIdField: 'customer_id', entityId: header.customer_id,
            entityName: customerRow.customer_name_th, entityTaxId: customerRow.tax_id, createdByUserId,
            vatSign: isCredit ? -1 : 1, // CN ลดยอดภาษีขาย (ตรงข้ามใบแจ้งหนี้ปกติ) มิเรอร์ AR's own insertVtRecords
        });
    }

    const revByAccount = {};
    for (const l of lineRows) {
        revByAccount[l.revenueAccountId] = (revByAccount[l.revenueAccountId] || 0) + l.subtotal;
    }
    const arGlDetails = [];
    for (const [accId, amt] of Object.entries(revByAccount)) {
        if (amt === 0) continue;
        // DN: Cr รายได้ (เหมือน postArBillFromDln) — CN: Dr รายได้ (กลับรายการ)
        arGlDetails.push({
            account_id: Number(accId), description: `${label} ${arDocNo}`,
            debit_lc: isCredit ? amt : 0, credit_lc: isCredit ? 0 : amt,
        });
    }
    if (totalVat !== 0) {
        if (!vatAccountId) throw new Error('ยังไม่ได้ตั้งค่าบัญชีภาษีขาย (vat_output_account_id) ใน im_gl_account_setup หรือ ar_gl_account_setup');
        arGlDetails.push({
            account_id: vatAccountId, description: `ภาษีขาย ${arDocNo}`,
            debit_lc: isCredit ? totalVat : 0, credit_lc: isCredit ? 0 : totalVat,
        });
    }
    if (totalAmount !== 0) {
        arGlDetails.push({
            account_id: arAccountId, description: `${label} ${arDocNo}`,
            debit_lc: isCredit ? 0 : totalAmount, credit_lc: isCredit ? totalAmount : 0,
        });
    }

    if (arGlDetails.length > 0) {
        const totalDebit = arGlDetails.reduce((s, l) => s + l.debit_lc, 0);
        const totalCredit = arGlDetails.reduce((s, l) => s + l.credit_lc, 0);
        const arGlHeaderRes = await client.query(`
            INSERT INTO gl_entry_header
            (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
             currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
             created_by, ref_doc_id, ref_doc_no, external_source_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'Posted',$9,$10,0,0,$11,$12,$13,$14)
            RETURNING id
        `, [
            arSetup.gl_doc_id, `GL-${arDocNo}`, header.doc_date, header.doc_date, periodId,
            header.ref_no || null, `${label} (${docNo})`,
            1, totalDebit, totalCredit, createdByUserId, arDocId, arDocNo, arTransactionId,
        ]);
        const arGlEntryId = arGlHeaderRes.rows[0].id;
        let glLineNo = 1;
        for (const l of arGlDetails) {
            await client.query(`
                INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                VALUES ($1,$2,$3,$4,$5,$6,0,0)
            `, [arGlEntryId, glLineNo++, l.account_id, l.description, l.debit_lc, l.credit_lc]);
        }
        await client.query(`UPDATE ar_transaction SET gl_entry_id = $1 WHERE id = $2`, [arGlEntryId, arTransactionId]);
    }

    return arTransactionId;
};

// ตรวจสอบว่าจำนวนที่จะคืน (ต่อบรรทัด, '15'/'35') ไม่เกินจำนวนคงเหลือที่คืนได้ของบรรทัดต้นฉบับ (GRN/DLN) — เอกสาร
// ต้นฉบับหนึ่งบรรทัดอาจถูกคืนหลายครั้ง (คนละใบ) คงเหลือคำนวณจากผลรวมการคืนที่ Posted แล้วเท่านั้น (Draft ไม่นับ
// เหมือนกับที่ Draft ไม่มีผลต่อ stock ที่ไหนในโมดูลนี้เลย) — เรียกจาก postDetailLines ก่อน applyStockMovement เสมอ
const validateReturnableQty = async (client, { refImTransactionDetailId, requestedQty }) => {
    const origRes = await client.query(
        `SELECT qty, item_code FROM im_transaction_detail WHERE id = $1`, [refImTransactionDetailId]
    );
    if (origRes.rows.length === 0) throw new Error('ไม่พบรายการต้นฉบับที่อ้างอิงสำหรับการคืนสินค้า');
    const originalQty = Math.abs(Number(origRes.rows[0].qty));
    const returnedRes = await client.query(`
        SELECT COALESCE(SUM(ABS(dt2.qty)), 0) AS returned
        FROM im_transaction_detail dt2 JOIN im_transaction t2 ON t2.id = dt2.header_id
        WHERE dt2.ref_im_transaction_detail_id = $1 AND t2.status = 'Posted'
    `, [refImTransactionDetailId]);
    const remaining = originalQty - Number(returnedRes.rows[0].returned);
    if (requestedQty > remaining + 0.0001) {
        throw new Error(`จำนวนที่คืนเกินกว่าคงเหลือที่คืนได้ของ ${origRes.rows[0].item_code} (คงเหลือคืนได้ ${remaining})`);
    }
};

// นับสต็อก + โพสต์ GL สำหรับทุกบรรทัดของเอกสาร — ใช้ทั้งใน createTransaction(action=Post) และ postTransaction
const postDetailLines = async (client, headerId, header, docNo) => {
    const docTypeRes = await client.query(
        `SELECT sys_doc_type FROM sa_module_document WHERE doc_code=$1 AND sys_module='31' LIMIT 1`,
        [header.doc_code]
    );
    const sysDocType = docTypeRes.rows[0]?.sys_doc_type || '';

    const detailsRes = await client.query(`SELECT * FROM im_transaction_detail WHERE header_id = $1 ORDER BY line_no`, [headerId]);
    const updatedDetails = [];
    let totalQty = 0, totalValue = 0;
    for (const d of detailsRes.rows) {
        const itemRes = await client.query(`SELECT * FROM im_item WHERE id = $1`, [d.item_id]);
        if (itemRes.rows.length === 0) throw new Error(`ไม่พบสินค้า item_id=${d.item_id}`);
        const item = itemRes.rows[0];
        const updatedBy = header.updated_by || header.created_by;

        if (sysDocType === '70') {
            // TRF — เก็บฝั่งต้นทางลงคอลัมน์เดิม (qty ติดลบ=ออกจากต้นทาง) + ฝั่งปลายทางลงคอลัมน์ to_balance_* ใหม่
            const { srcResult, dstResult } = await applyTransferMovement(client, {
                item, warehouseId: header.warehouse_id, locationId: d.location_id,
                toWarehouseId: header.to_warehouse_id, toLocationId: d.to_location_id,
                lotNo: d.lot_no, serialNo: d.serial_no, countedQty: d.counted_qty,
                docDate: header.doc_date, docCode: header.doc_code, headerId, docNo, detailId: d.id, updatedBy,
            });
            const valueLc = srcResult.varianceQty * srcResult.actualUnitCost;
            await client.query(`
                UPDATE im_transaction_detail
                SET qty=$1, unit_cost=$2, balance_qty_before=$3, balance_avg_cost_before=$4,
                    to_balance_qty_before=$5, to_balance_avg_cost_before=$6, total_value_lc=$7
                WHERE id=$8
            `, [srcResult.varianceQty, srcResult.actualUnitCost, srcResult.balanceQtyBefore, srcResult.balanceAvgCostBefore,
                dstResult.balanceQtyBefore, dstResult.balanceAvgCostBefore, valueLc, d.id]);
            totalQty += srcResult.varianceQty;
            totalValue += valueLc;
            updatedDetails.push({ ...d, qty: srcResult.varianceQty, unit_cost: srcResult.actualUnitCost, total_value_lc: valueLc });
            continue;
        }

        const { actualUnitCost, balanceQtyBefore, balanceAvgCostBefore, varianceQty } = await applyStockMovement(client, {
            item, warehouseId: header.warehouse_id, locationId: d.location_id, lotNo: d.lot_no, serialNo: d.serial_no,
            countedQty: d.counted_qty, enteredUnitCost: d.unit_cost, docDate: header.doc_date, docCode: header.doc_code,
            headerId, docNo, detailId: d.id, updatedBy,
        });
        // '15'/'35' (คืนสินค้าผู้ขาย/รับคืนจากลูกค้า) ที่อ้างอิงบรรทัดต้นฉบับ — ตรวจคงเหลือที่คืนได้ *หลัง* ทราบ
        // จำนวนจริงที่เคลื่อนไหว (varianceQty) เพื่อเลี่ยงคำนวณ balance-before ซ้ำ ยัง throw ก่อน COMMIT ได้ทันเวลา
        // เพราะทั้งหมดอยู่ใน client transaction เดียวกัน (rollback ทั้งหมดถ้า error)
        if (['15', '35'].includes(sysDocType) && d.ref_im_transaction_detail_id) {
            await validateReturnableQty(client, {
                refImTransactionDetailId: d.ref_im_transaction_detail_id, requestedQty: Math.abs(varianceQty),
            });
        }
        const valueLc = varianceQty * actualUnitCost;
        await client.query(`
            UPDATE im_transaction_detail
            SET qty=$1, unit_cost=$2, balance_qty_before=$3, balance_avg_cost_before=$4, total_value_lc=$5
            WHERE id=$6
        `, [varianceQty, actualUnitCost, balanceQtyBefore, balanceAvgCostBefore, valueLc, d.id]);
        totalQty += varianceQty;
        totalValue += valueLc;
        updatedDetails.push({ ...d, qty: varianceQty, unit_cost: actualUnitCost, total_value_lc: valueLc });
    }
    // '12' (รับสินค้า รอตั้งหนี้): Post IM อย่างเดียว — อัปเดต subledger ตามปกติ แต่ไม่แตะ GL/AP เลย จนกว่าจะ Post
    // AP/GL แยกต่างหากทีหลัง (postApBillingForGrn) เมื่อได้ใบกำกับจริงจากผู้ขาย — สถานะจึงเป็น 'Received' ไม่ใช่ 'Posted'
    if (sysDocType === '12') {
        await client.query(`
            UPDATE im_transaction SET status='Received', total_qty=$1, total_value_lc=$2, updated_at=NOW() WHERE id=$3
        `, [totalQty, totalValue, headerId]);
        return null;
    }

    // Periodic mode: ไม่ Post GL ต่อธุรกรรมเลย (ยังอัปเดต subledger เหมือนเดิมทุกประการ) — COGS ทั้งหมดคำนวณครั้งเดียว
    // ตอนปิดงวดใน imPeriodClosingController.js แทน — ดู pattern_im_periodic_accounting_mode — ยกเว้น '10' (GRN ไม่มี
    // เลขที่อ้างอิง) ที่ต้อง Post เสมอทั้งสองโหมด เพราะ GR/IR ต้องขยับทันทีที่รับของจริง (ดู postGlEntry) และ '11'
    // (GRN Billing) ที่ไม่ Post ผ่านทางนี้เลยไม่ว่าโหมดใด เพราะ ap_transaction ที่สร้างอัตโนมัติมี entry ของตัวเองแล้ว
    const mode = await fetchMode(client);
    let glEntryId = null;
    let linkedApTransactionId = null;
    let linkedArTransactionId = null;
    if (sysDocType === '11') {
        linkedApTransactionId = await postApBillFromGrn(client, {
            header, details: updatedDetails, docNo, vendorInvoiceNo: header.ref_no, mode,
        });
    } else if (['15', '20'].includes(sysDocType)) {
        // คืนสินค้าผู้ขาย ('15') / ลดหนี้เจ้าหนี้ ('20') — ทั้งคู่โพสต์ AP CN เดียวกัน ('15' มีการอ้างอิงเอกสารต้นฉบับ
        // เพิ่มเติมเท่านั้น ไม่ต่างกันที่การโพสต์บัญชี — Dr AP/Cr คลัง เป็น entry เดียวจบ ไม่ผ่าน postGlEntry ของ IM
        // เอง เลย (มิเรอร์ '11') ไม่ระงับใน Periodic เพราะเป็นภาระผูกพันจริงกับเจ้าหนี้ ไม่ใช่การตีมูลค่าสต็อก
        linkedApTransactionId = await postApCreditDebitNoteFromIm(client, {
            header, details: updatedDetails, docNo, mode, isCredit: true,
        });
    } else if (sysDocType === '25') {
        // เพิ่มหนี้เจ้าหนี้ (DNS) — โพสต์ AP DN, Dr คลัง/Cr AP (เหมือน '11' ทุกประการในรูปร่าง ต่างกันแค่เหตุผลทางธุรกิจ)
        linkedApTransactionId = await postApCreditDebitNoteFromIm(client, {
            header, details: updatedDetails, docNo, mode, isCredit: false,
        });
    } else if (['35', '40'].includes(sysDocType)) {
        // รับคืนสินค้าจากลูกค้า ('35') / ลดหนี้ลูกหนี้ ('40') — มิเรอร์ '31': กลับรายการต้นทุนขาย (Dr คลัง/Cr COGS ผ่าน
        // postGlEntry ของ IM เอง ระงับใน Periodic เหมือน '30'/'31'/ISS) + โพสต์ AR CN แยกต่างหาก (Dr รายได้+ภาษี/Cr AR
        // ต้อง Post เสมอไม่ว่าโหมดใด เพราะเป็นภาระผูกพันจริงกับลูกค้า) — 2 entry แยกกันเหมือน '31' ('15'/'20' ฝั่ง AP
        // ไม่ต้องแยกเพราะ Dr/Cr คลัง-เจ้าหนี้เป็น entry เดียวจบได้ในตัว ไม่มีการรับรู้ต้นทุนขายแยกแบบฝั่งขาย)
        if (mode !== 'PERIODIC') {
            glEntryId = await postGlEntry(client, headerId, header, updatedDetails, docNo, sysDocType, mode);
        }
        linkedArTransactionId = await postArCreditDebitNoteFromIm(client, {
            header, details: updatedDetails, docNo, isCredit: true,
        });
    } else if (sysDocType === '45') {
        // เพิ่มหนี้ลูกหนี้ (DNC) — มิเรอร์ '31' ทุกประการในรูปร่าง (Dr COGS/Cr คลัง + Dr AR/Cr รายได้+ภาษี)
        if (mode !== 'PERIODIC') {
            glEntryId = await postGlEntry(client, headerId, header, updatedDetails, docNo, sysDocType, mode);
        }
        linkedArTransactionId = await postArCreditDebitNoteFromIm(client, {
            header, details: updatedDetails, docNo, isCredit: false,
        });
    } else if (sysDocType === '31') {
        // DLN Billing — ต้นทุนขาย (Dr COGS/Cr คลัง) ถูกระงับใน Periodic เหมือน '30'/ISS ทุกประการ (คำนวณรวมตอนปิดงวด
        // แทน) แต่ใบแจ้งหนี้ลูกหนี้ (Dr AR/Cr รายได้+ภาษี) ต้อง Post เสมอไม่ว่าโหมดใด เพราะเป็นภาระผูกพันจริงกับลูกค้า
        // ไม่ใช่การตีมูลค่าสต็อก — มิเรอร์ '11' ที่ ap_transaction ก็ Post เสมอไม่สนโหมดเช่นกัน
        if (mode !== 'PERIODIC') {
            glEntryId = await postGlEntry(client, headerId, header, updatedDetails, docNo, sysDocType, mode);
        }
        linkedArTransactionId = await postArBillFromDln(client, { header, details: updatedDetails, docNo });
    } else if (sysDocType === '32') {
        // DLN รอตั้งหนี้ — Stage 1 (Post IM): ต้นทุนขาย Post ทันที (มิเรอร์ '30', ระงับเฉพาะใน Periodic) เพราะต้นทุน
        // คำนวณจาก stock ledger เอง ไม่ขึ้นกับราคาขาย/ใบแจ้งหนี้ที่ยังไม่ออกเลย — ต่างจาก GRN '12' ที่ราคาซื้อจากผู้ขาย
        // ยังไม่ทราบแน่ชัดจนกว่าใบกำกับจะมาถึง จึงต้องพักทั้งหมด ส่วนใบแจ้งหนี้ลูกหนี้รอ Stage 2 (postBillingForDln)
        if (mode !== 'PERIODIC') {
            glEntryId = await postGlEntry(client, headerId, header, updatedDetails, docNo, sysDocType, mode);
        }
        await client.query(`
            UPDATE im_transaction SET status='Delivered', gl_entry_id=$1, total_qty=$2, total_value_lc=$3, updated_at=NOW() WHERE id=$4
        `, [glEntryId, totalQty, totalValue, headerId]);
        return glEntryId;
    } else if (sysDocType === '10' || mode !== 'PERIODIC') {
        glEntryId = await postGlEntry(client, headerId, header, updatedDetails, docNo, sysDocType, mode);
    }
    await client.query(`
        UPDATE im_transaction SET status='Posted', gl_entry_id=$1, linked_ap_transaction_id=$2, linked_ar_transaction_id=$3,
            total_qty=$4, total_value_lc=$5, updated_at=NOW() WHERE id=$6
    `, [glEntryId, linkedApTransactionId, linkedArTransactionId, totalQty, totalValue, headerId]);
    return glEntryId;
};

// --- Fetch helpers ---
const fetchRowById = async (pool, id) => {
    const hRes = await pool.query(`
        SELECT t.*,
               d.doc_code AS d_doc_code, d.doc_name_thai, d.doc_name_eng, d.sys_doc_type, d.is_auto_numbering,
               w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
               tw.warehouse_code AS to_warehouse_code, tw.warehouse_name_th AS to_warehouse_name_th,
               b.branch_code, b.branch_name_thai,
               reft.doc_no AS ref_im_transaction_doc_no,
               dim1.value_name_thai AS dim1_name, dim2.value_name_thai AS dim2_name, dim3.value_name_thai AS dim3_name,
               dim4.value_name_thai AS dim4_name, dim5.value_name_thai AS dim5_name
        FROM im_transaction t
        JOIN sa_module_document d ON d.id = t.doc_id
        LEFT JOIN im_warehouse w  ON w.id = t.warehouse_id
        LEFT JOIN im_warehouse tw ON tw.id = t.to_warehouse_id
        LEFT JOIN cd_branch b     ON b.id = t.branch_id
        LEFT JOIN im_transaction reft ON reft.id = t.ref_im_transaction_id
        LEFT JOIN gl_dimension_value dim1 ON dim1.id = t.dim1_id
        LEFT JOIN gl_dimension_value dim2 ON dim2.id = t.dim2_id
        LEFT JOIN gl_dimension_value dim3 ON dim3.id = t.dim3_id
        LEFT JOIN gl_dimension_value dim4 ON dim4.id = t.dim4_id
        LEFT JOIN gl_dimension_value dim5 ON dim5.id = t.dim5_id
        WHERE t.id = $1`, [id]);
    if (hRes.rows.length === 0) return null;
    const dRes = await pool.query(`
        SELECT dt.*, u.uom_code, l.location_code, tl.location_code AS to_location_code
        FROM im_transaction_detail dt
        LEFT JOIN im_uom u      ON u.id = dt.uom_id
        LEFT JOIN im_location l  ON l.id = dt.location_id
        LEFT JOIN im_location tl ON tl.id = dt.to_location_id
        WHERE dt.header_id = $1 ORDER BY dt.line_no`, [id]);
    return { ...hRes.rows[0], details: dRes.rows };
};

// --- GET list ---
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImTransactionTable(client);
        const { doc_code, status, warehouse_id, date_from, date_to, search } = req.query;
        let query = `
            SELECT t.id, t.doc_no, t.doc_date, t.status, t.warehouse_id,
                   w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                   t.total_qty, t.total_value_lc, t.ref_no, t.description,
                   d.doc_code, d.doc_name_thai, d.doc_name_eng, d.sys_doc_type
            FROM im_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            LEFT JOIN im_warehouse w  ON w.id = t.warehouse_id
            WHERE 1=1`;
        const params = [];
        let pi = 1;
        if (doc_code)     { params.push(doc_code);     query += ` AND d.doc_code = $${pi++}`; }
        if (status)       { params.push(status);       query += ` AND t.status = $${pi++}`; }
        if (warehouse_id) { params.push(warehouse_id); query += ` AND t.warehouse_id = $${pi++}`; }
        if (date_from)    { params.push(date_from);    query += ` AND t.doc_date >= $${pi++}`; }
        if (date_to)      { params.push(date_to);      query += ` AND t.doc_date <= $${pi++}`; }
        if (search) {
            params.push(`%${search.toUpperCase()}%`);
            query += ` AND (UPPER(t.doc_no) LIKE $${pi} OR UPPER(COALESCE(t.ref_no,'')) LIKE $${pi})`;
            pi++;
        }
        query += ` ORDER BY t.doc_date DESC, t.id DESC`;
        const result = await client.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_transaction list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- GET one ---
const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImTransactionTable(client);
        const data = await fetchRowById(client, req.params.id);
        if (!data) return res.status(404).json({ message: 'Not found.' });
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching im_transaction row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET /im_transaction/system_qty?item_id=&warehouse_id=&location_id=&lot_no=&serial_no=
const fetchSystemQty = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImTransactionTable(client);
        const { item_id, warehouse_id, location_id, lot_no, serial_no } = req.query;
        if (!item_id || !warehouse_id) return res.status(400).json({ message: 'item_id และ warehouse_id จำเป็น' });

        if (serial_no) {
            const r = await client.query(
                `SELECT id FROM im_stock_layer WHERE item_id=$1 AND serial_no=$2 AND remaining_qty > 0`,
                [item_id, serial_no]
            );
            return res.status(200).json({ system_qty: r.rows.length > 0 ? 1 : 0 });
        }
        const r = await client.query(
            `SELECT qty_on_hand FROM im_stock_balance WHERE ${STOCK_BALANCE_KEY}`,
            [item_id, warehouse_id, location_id || null, lot_no || null]
        );
        res.status(200).json({ system_qty: r.rows.length > 0 ? Number(r.rows[0].qty_on_hand) : 0 });
    } catch (error) {
        console.error('Error fetching im_transaction system_qty:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET /im_transaction/returnable_docs?family=GRN|DLN&vendor_id=&customer_id=&search= — เอกสาร GRN/DLN ที่ Post
// แล้ว ให้เลือกเป็นเอกสารต้นฉบับสำหรับ '15' (คืนสินค้าผู้ขาย) / '35' (รับคืนจากลูกค้า) — ใช้โดย document picker หน้าบ้าน
const fetchReturnableDocs = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImTransactionTable(client);
        const { family, vendor_id, customer_id, search } = req.query;
        const isDln = family === 'DLN';
        const sysTypes = isDln ? ['30', '31', '32'] : ['10', '11', '12'];
        const statuses = isDln ? ['Posted', 'Delivered'] : ['Posted', 'Received'];
        let query = `
            SELECT t.id, t.doc_no, t.doc_date, t.status, t.vendor_id, t.vendor_code, t.vendor_name_th,
                   t.customer_id, t.customer_code, t.customer_name_th, d.doc_code, d.sys_doc_type
            FROM im_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE d.sys_doc_type = ANY($1::text[]) AND t.status = ANY($2::text[])`;
        const params = [sysTypes, statuses];
        let pi = 3;
        if (vendor_id)   { params.push(vendor_id);   query += ` AND t.vendor_id = $${pi++}`; }
        if (customer_id) { params.push(customer_id); query += ` AND t.customer_id = $${pi++}`; }
        if (search) { params.push(`%${search.toUpperCase()}%`); query += ` AND UPPER(t.doc_no) LIKE $${pi++}`; }
        query += ` ORDER BY t.doc_date DESC, t.id DESC LIMIT 50`;
        const result = await client.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_transaction returnable_docs:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET /im_transaction/:id/returnable_lines — บรรทัดของเอกสารต้นฉบับ (GRN/DLN) พร้อมจำนวนคงเหลือที่คืนได้ต่อบรรทัด
// (จำนวนเดิม - ผลรวมจำนวนที่ถูกคืนไปแล้วผ่านเอกสาร '15'/'35' ที่ Posted แล้วเท่านั้น) — คำนวณสูตรเดียวกับ
// validateReturnableQty ที่ใช้ตรวจจริงตอน Post เพื่อให้ตัวเลขที่ผู้ใช้เห็นตอนเลือกตรงกับที่ระบบจะยอมให้ Post จริง
const fetchReturnableLines = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImTransactionTable(client);
        const { id } = req.params;
        const detailsRes = await client.query(`
            SELECT dt.id, dt.line_no, dt.item_id, dt.item_code, dt.item_name, dt.location_id, dt.lot_no, dt.serial_no,
                   dt.uom_id, dt.qty, dt.unit_cost, l.location_code, u.uom_code
            FROM im_transaction_detail dt
            LEFT JOIN im_location l ON l.id = dt.location_id
            LEFT JOIN im_uom u      ON u.id  = dt.uom_id
            WHERE dt.header_id = $1 ORDER BY dt.line_no
        `, [id]);
        const lines = [];
        for (const d of detailsRes.rows) {
            const originalQty = Math.abs(Number(d.qty) || 0);
            const returnedRes = await client.query(`
                SELECT COALESCE(SUM(ABS(dt2.qty)), 0) AS returned
                FROM im_transaction_detail dt2 JOIN im_transaction t2 ON t2.id = dt2.header_id
                WHERE dt2.ref_im_transaction_detail_id = $1 AND t2.status = 'Posted'
            `, [d.id]);
            const remainingQty = originalQty - Number(returnedRes.rows[0].returned);
            lines.push({ ...d, original_qty: originalQty, remaining_qty: remainingQty });
        }
        res.status(200).json(lines);
    } catch (error) {
        console.error('Error fetching im_transaction returnable_lines:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- 1. Create Transaction (Draft/Post) ---
// สร้าง + (ถ้า action='Post') โพสต์ im_transaction ทันที ในทรานแซกชันของ client ที่ส่งเข้ามา
// ใช้ได้ 2 ทาง: (1) createTransaction (HTTP handler ด้านล่าง) ส่ง docId ที่ผู้ใช้เลือกมาจาก dropdown
// (2) imStockCountController.closeCount เรียกตรงๆ ด้วย sysDocType='80' (มาตรฐาน AJS) โดยไม่เจาะจง doc_code —
//     ให้ resolve เอาเองว่าจะใช้ doc_code ไหนใต้มาตรฐานนี้ (เผื่อมีหลาย doc_code ต่อ sys_doc_type)
const insertAndPostAdjustment = async (client, {
    docId, docCode, sysDocType, docNo, docDate, warehouseId, toWarehouseId, vendorId, customerId,
    refNo, refDocId, refDocNo, refImTransactionId, description,
    dim1Id, dim2Id, dim3Id, dim4Id, dim5Id, branchId, createdBy,
    lines, action,
}) => {
    let resolvedDocId = docId;
    let resolvedDocCode = docCode;
    if (!resolvedDocId) {
        let docTypeRes;
        if (docCode) {
            docTypeRes = await client.query(
                `SELECT id, doc_code FROM sa_module_document WHERE doc_code=$1 AND sys_module='31' AND is_doc_type=true LIMIT 1`,
                [docCode]
            );
        } else {
            // ไม่ระบุ doc_code เจาะจง — เลือก doc_code ตัวแรก (sort_order ต่ำสุด, active) ภายใต้มาตรฐาน sys_doc_type นี้
            // (แต่ละ sys_doc_type อาจมีได้หลาย doc_code เช่น AJS1/AJS2 — ผู้เรียกที่ไม่เจาะจง doc_code จะได้ค่า default)
            docTypeRes = await client.query(
                `SELECT id, doc_code FROM sa_module_document
                 WHERE sys_module='31' AND sys_doc_type=$1 AND is_doc_type=true AND is_active=true
                 ORDER BY sort_order LIMIT 1`,
                [sysDocType || '80']
            );
        }
        if (docTypeRes.rows.length === 0) {
            throw new Error(`ไม่พบประเภทเอกสารสำหรับ ${docCode ? `doc_code=${docCode}` : `sys_doc_type=${sysDocType || '80'}`} ในระบบ`);
        }
        resolvedDocId = docTypeRes.rows[0].id;
        resolvedDocCode = docTypeRes.rows[0].doc_code;
    } else if (!resolvedDocCode) {
        const r = await client.query(`SELECT doc_code FROM sa_module_document WHERE id=$1`, [resolvedDocId]);
        if (r.rows.length === 0) throw new Error('ไม่พบประเภทเอกสาร');
        resolvedDocCode = r.rows[0].doc_code;
    }

    const resolvedTypeRes = await client.query(`SELECT sys_doc_type FROM sa_module_document WHERE id = $1`, [resolvedDocId]);
    const resolvedSysDocType = resolvedTypeRes.rows[0]?.sys_doc_type || '';
    if (resolvedSysDocType === '70' && !toWarehouseId) {
        throw new Error('กรุณาระบุคลังปลายทาง (to_warehouse_id) สำหรับเอกสารประเภทโอนสินค้า');
    }
    if (['10', '11', '12', '15', '20', '25'].includes(resolvedSysDocType) && !vendorId) {
        throw new Error('กรุณาระบุผู้ขาย สำหรับเอกสารประเภทนี้');
    }
    if (resolvedSysDocType === '11' && !refNo) {
        throw new Error('กรุณาระบุเลขที่ใบกำกับสินค้าผู้ขาย สำหรับเอกสารประเภทรับสินค้า+ตั้งหนี้อัตโนมัติ');
    }
    if (['30', '31', '32', '35', '40', '45'].includes(resolvedSysDocType) && !customerId) {
        throw new Error('กรุณาระบุลูกค้า สำหรับเอกสารประเภทนี้');
    }
    // '15'/'35' (คืนสินค้าผู้ขาย/รับคืนจากลูกค้า) — บังคับอ้างอิงเอกสารต้นฉบับ (GRN/DLN) เสมอ เพื่อติดตามจำนวนคืน
    // บางส่วน (partial return) แตกต่างจาก '20'/'25'/'40'/'45' ที่เป็นเอกสารอิสระ (stand-alone เหมือน '11'/'31')
    if (['15', '35'].includes(resolvedSysDocType)) {
        if (!refImTransactionId) {
            throw new Error('กรุณาระบุเอกสารต้นฉบับที่จะคืน สำหรับเอกสารประเภทนี้');
        }
        const refFamily = resolvedSysDocType === '15' ? ['10', '11', '12'] : ['30', '31', '32'];
        const refStatuses = resolvedSysDocType === '15' ? ['Posted', 'Received'] : ['Posted', 'Delivered'];
        const refRes = await client.query(`
            SELECT t.vendor_id, t.customer_id, t.status, d.sys_doc_type FROM im_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id WHERE t.id = $1
        `, [refImTransactionId]);
        if (refRes.rows.length === 0) throw new Error('ไม่พบเอกสารต้นฉบับที่อ้างอิง');
        const refRow = refRes.rows[0];
        if (!refFamily.includes(refRow.sys_doc_type) || !refStatuses.includes(refRow.status)) {
            throw new Error('เอกสารต้นฉบับที่อ้างอิงต้องเป็นเอกสารรับ/ส่งสินค้าที่ Post แล้วในกลุ่มเดียวกันเท่านั้น');
        }
        if (resolvedSysDocType === '15' && Number(refRow.vendor_id) !== Number(vendorId)) {
            throw new Error('ผู้ขายของเอกสารคืนสินค้าต้องตรงกับผู้ขายของเอกสารต้นฉบับ');
        }
        if (resolvedSysDocType === '35' && Number(refRow.customer_id) !== Number(customerId)) {
            throw new Error('ลูกค้าของเอกสารรับคืนสินค้าต้องตรงกับลูกค้าของเอกสารต้นฉบับ');
        }
    }

    let vendorCode = null, vendorNameTh = null;
    if (vendorId) {
        const vendorRes = await client.query(`SELECT vendor_code, vendor_name_th FROM ap_vendor WHERE id = $1`, [vendorId]);
        if (vendorRes.rows.length === 0) throw new Error('ไม่พบผู้ขายที่ระบุ');
        vendorCode = vendorRes.rows[0].vendor_code;
        vendorNameTh = vendorRes.rows[0].vendor_name_th;
    }

    let customerCode = null, customerNameTh = null;
    if (customerId) {
        const customerRes = await client.query(`SELECT customer_code, customer_name_th FROM ar_customer WHERE id = $1`, [customerId]);
        if (customerRes.rows.length === 0) throw new Error('ไม่พบลูกค้าที่ระบุ');
        customerCode = customerRes.rows[0].customer_code;
        customerNameTh = customerRes.rows[0].customer_name_th;
    }

    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date AND gl_status = 'OPEN' AND im_status != 'CLOSED' LIMIT 1`,
        [docDate]
    );
    if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${docDate}`);
    const periodId = periodRes.rows[0].id;

    let finalDocNo = docNo;
    if (!finalDocNo || finalDocNo === 'AUTO') {
        finalDocNo = await generateDocNo(client, resolvedDocId, docDate, branchId);
        if (!finalDocNo) throw new Error('Auto numbering failed or manual doc_no required');
    }

    if (!lines || lines.length === 0) throw new Error('ต้องมีรายการนับสต็อกอย่างน้อย 1 รายการ');

    const hRes = await client.query(`
        INSERT INTO im_transaction
        (doc_id, doc_no, doc_code, doc_date, period_id, warehouse_id, to_warehouse_id,
         vendor_id, vendor_code, vendor_name_th, customer_id, customer_code, customer_name_th,
         ref_no, ref_doc_id, ref_doc_no, ref_im_transaction_id, description, status,
         dim1_id, dim2_id, dim3_id, dim4_id, dim5_id, branch_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        RETURNING id
    `, [
        resolvedDocId, finalDocNo, resolvedDocCode, docDate, periodId, warehouseId, toWarehouseId || null,
        vendorId || null, vendorCode, vendorNameTh, customerId || null, customerCode, customerNameTh,
        refNo || null, refDocId || null, refDocNo || null, refImTransactionId || null, description || null, 'Draft',
        dim1Id || null, dim2Id || null, dim3Id || null, dim4Id || null, dim5Id || null,
        branchId || null, createdBy || null,
    ]);
    const newHeaderId = hRes.rows[0].id;

    let lineNo = 1;
    for (const d of lines) {
        await client.query(`
            INSERT INTO im_transaction_detail
            (header_id, line_no, item_id, item_code, item_name, location_id, to_location_id, lot_no, serial_no, uom_id,
             system_qty, counted_qty, unit_cost, unit_price, vat_type, vat_rate, ref_im_transaction_detail_id, description)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        `, [
            newHeaderId, lineNo++, d.item_id, d.item_code || null, d.item_name || null,
            d.location_id || null, d.to_location_id || null, d.lot_no || null, d.serial_no || null, d.uom_id || null,
            d.system_qty ?? 0, d.counted_qty ?? 0, d.unit_cost ?? null, d.unit_price ?? null,
            d.vat_type || null, d.vat_rate ?? null,
            d.ref_im_transaction_detail_id || null, d.description || null,
        ]);
    }

    if ((action || 'Post') === 'Post') {
        const headerForPost = {
            doc_id: resolvedDocId, doc_code: resolvedDocCode, doc_date: docDate, warehouse_id: warehouseId, to_warehouse_id: toWarehouseId || null,
            vendor_id: vendorId || null, customer_id: customerId || null,
            ref_no: refNo, description,
            dim1_id: dim1Id, dim2_id: dim2Id, dim3_id: dim3Id, dim4_id: dim4Id, dim5_id: dim5Id,
            branch_id: branchId, created_by: createdBy, updated_by: createdBy,
        };
        await postDetailLines(client, newHeaderId, headerForPost, finalDocNo);
    }

    return newHeaderId;
};

const createTransaction = async (req, res) => {
    const { header, details, action } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureImTransactionTable(client);

        const newHeaderId = await insertAndPostAdjustment(client, {
            docId: header.doc_id, docNo: header.doc_no, docDate: header.doc_date,
            warehouseId: header.warehouse_id, toWarehouseId: header.to_warehouse_id, vendorId: header.vendor_id,
            customerId: header.customer_id,
            refNo: header.ref_no, refDocId: header.ref_doc_id, refDocNo: header.ref_doc_no,
            refImTransactionId: header.ref_im_transaction_id,
            description: header.description,
            dim1Id: header.dim1_id, dim2Id: header.dim2_id, dim3Id: header.dim3_id,
            dim4Id: header.dim4_id, dim5Id: header.dim5_id,
            branchId: header.branch_id, createdBy: header.created_by,
            lines: details, action,
        });

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, newHeaderId);
        res.status(201).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating im_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 2. Update Transaction (Draft only) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, details } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`
            SELECT t.status, d.sys_doc_type FROM im_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id WHERE t.id=$1
        `, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');

        // '12' (รับสินค้า รอตั้งหนี้) ที่อยู่สถานะ Received: แก้ได้แค่เลขที่ใบกำกับ + billed cost รายบรรทัด — ไม่แตะ
        // จำนวน/สินค้า/คลัง เพราะรับของจริงไปแล้ว ไม่ใช่ flow เดียวกับการแก้ไข Draft ทั่วไป จึงแยก branch ต่างหาก
        if (existing.rows[0].status === 'Received' && existing.rows[0].sys_doc_type === '12') {
            await client.query(`UPDATE im_transaction SET ref_no=$1, updated_by=$2, updated_at=NOW() WHERE id=$3`,
                [header.ref_no || null, header.updated_by || null, id]);
            for (const d of details || []) {
                if (!d.id) continue;
                await client.query(
                    `UPDATE im_transaction_detail SET billed_unit_cost=$1 WHERE id=$2 AND header_id=$3`,
                    [d.billed_unit_cost ?? null, d.id, id]
                );
            }
            await client.query('COMMIT');
            const full = await fetchRowById(req.dbPool, id);
            return res.status(200).json(full);
        }

        // '32' (ส่งสินค้า รอตั้งหนี้) ที่อยู่สถานะ Delivered: แก้ได้แค่เลขที่อ้างอิง + ราคาขายรายบรรทัด — ไม่แตะ
        // จำนวน/สินค้า/คลัง เพราะส่งของจริงไปแล้ว ต้นทุนขายก็ Post ไปแล้วตอน Post IM — มิเรอร์ branch ของ '12'/Received
        if (existing.rows[0].status === 'Delivered' && existing.rows[0].sys_doc_type === '32') {
            await client.query(`UPDATE im_transaction SET ref_no=$1, updated_by=$2, updated_at=NOW() WHERE id=$3`,
                [header.ref_no || null, header.updated_by || null, id]);
            for (const d of details || []) {
                if (!d.id) continue;
                await client.query(
                    `UPDATE im_transaction_detail SET unit_price=$1 WHERE id=$2 AND header_id=$3`,
                    [d.unit_price ?? null, d.id, id]
                );
            }
            await client.query('COMMIT');
            const full = await fetchRowById(req.dbPool, id);
            return res.status(200).json(full);
        }

        if (existing.rows[0].status !== 'Draft') throw new Error('แก้ไขได้เฉพาะเอกสาร Draft เท่านั้น');
        if (existing.rows[0].sys_doc_type === '70' && !header.to_warehouse_id) {
            throw new Error('กรุณาระบุคลังปลายทาง (to_warehouse_id) สำหรับเอกสารประเภทโอนสินค้า');
        }
        if (['10', '11', '12', '15', '20', '25'].includes(existing.rows[0].sys_doc_type) && !header.vendor_id) {
            throw new Error('กรุณาระบุผู้ขาย สำหรับเอกสารประเภทนี้');
        }
        if (existing.rows[0].sys_doc_type === '11' && !header.ref_no) {
            throw new Error('กรุณาระบุเลขที่ใบกำกับสินค้าผู้ขาย สำหรับเอกสารประเภทรับสินค้า+ตั้งหนี้อัตโนมัติ');
        }
        if (['30', '31', '32', '35', '40', '45'].includes(existing.rows[0].sys_doc_type) && !header.customer_id) {
            throw new Error('กรุณาระบุลูกค้า สำหรับเอกสารประเภทนี้');
        }
        if (['15', '35'].includes(existing.rows[0].sys_doc_type)) {
            const sysType = existing.rows[0].sys_doc_type;
            if (!header.ref_im_transaction_id) {
                throw new Error('กรุณาระบุเอกสารต้นฉบับที่จะคืน สำหรับเอกสารประเภทนี้');
            }
            const refFamily = sysType === '15' ? ['10', '11', '12'] : ['30', '31', '32'];
            const refStatuses = sysType === '15' ? ['Posted', 'Received'] : ['Posted', 'Delivered'];
            const refRes = await client.query(`
                SELECT t.vendor_id, t.customer_id, t.status, d.sys_doc_type FROM im_transaction t
                JOIN sa_module_document d ON d.id = t.doc_id WHERE t.id = $1
            `, [header.ref_im_transaction_id]);
            if (refRes.rows.length === 0) throw new Error('ไม่พบเอกสารต้นฉบับที่อ้างอิง');
            const refRow = refRes.rows[0];
            if (!refFamily.includes(refRow.sys_doc_type) || !refStatuses.includes(refRow.status)) {
                throw new Error('เอกสารต้นฉบับที่อ้างอิงต้องเป็นเอกสารรับ/ส่งสินค้าที่ Post แล้วในกลุ่มเดียวกันเท่านั้น');
            }
            if (sysType === '15' && Number(refRow.vendor_id) !== Number(header.vendor_id)) {
                throw new Error('ผู้ขายของเอกสารคืนสินค้าต้องตรงกับผู้ขายของเอกสารต้นฉบับ');
            }
            if (sysType === '35' && Number(refRow.customer_id) !== Number(header.customer_id)) {
                throw new Error('ลูกค้าของเอกสารรับคืนสินค้าต้องตรงกับลูกค้าของเอกสารต้นฉบับ');
            }
        }

        let vendorCode = null, vendorNameTh = null;
        if (header.vendor_id) {
            const vendorRes = await client.query(`SELECT vendor_code, vendor_name_th FROM ap_vendor WHERE id = $1`, [header.vendor_id]);
            if (vendorRes.rows.length === 0) throw new Error('ไม่พบผู้ขายที่ระบุ');
            vendorCode = vendorRes.rows[0].vendor_code;
            vendorNameTh = vendorRes.rows[0].vendor_name_th;
        }

        let customerCode = null, customerNameTh = null;
        if (header.customer_id) {
            const customerRes = await client.query(`SELECT customer_code, customer_name_th FROM ar_customer WHERE id = $1`, [header.customer_id]);
            if (customerRes.rows.length === 0) throw new Error('ไม่พบลูกค้าที่ระบุ');
            customerCode = customerRes.rows[0].customer_code;
            customerNameTh = customerRes.rows[0].customer_name_th;
        }

        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period WHERE $1::date BETWEEN period_start_date AND period_end_date AND gl_status = 'OPEN' AND im_status != 'CLOSED' LIMIT 1`,
            [header.doc_date]
        );
        if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        const periodId = periodRes.rows[0].id;

        if (!details || details.length === 0) throw new Error('ต้องมีรายการนับสต็อกอย่างน้อย 1 รายการ');

        await client.query(`
            UPDATE im_transaction SET
                doc_date=$1, period_id=$2, warehouse_id=$3, to_warehouse_id=$4,
                vendor_id=$5, vendor_code=$6, vendor_name_th=$7,
                customer_id=$8, customer_code=$9, customer_name_th=$10,
                ref_no=$11, ref_doc_id=$12, ref_doc_no=$13, ref_im_transaction_id=$14, description=$15,
                dim1_id=$16, dim2_id=$17, dim3_id=$18, dim4_id=$19, dim5_id=$20,
                branch_id=$21, updated_by=$22, updated_at=NOW()
            WHERE id=$23
        `, [
            header.doc_date, periodId, header.warehouse_id, header.to_warehouse_id || null,
            header.vendor_id || null, vendorCode, vendorNameTh,
            header.customer_id || null, customerCode, customerNameTh,
            header.ref_no || null, header.ref_doc_id || null, header.ref_doc_no || null,
            header.ref_im_transaction_id || null, header.description || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, header.updated_by || null, id,
        ]);

        await client.query(`DELETE FROM im_transaction_detail WHERE header_id=$1`, [id]);
        let lineNo = 1;
        for (const d of details) {
            await client.query(`
                INSERT INTO im_transaction_detail
                (header_id, line_no, item_id, item_code, item_name, location_id, to_location_id, lot_no, serial_no, uom_id,
                 system_qty, counted_qty, unit_cost, unit_price, vat_type, vat_rate, ref_im_transaction_detail_id, description)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
            `, [
                id, lineNo++, d.item_id, d.item_code || null, d.item_name || null,
                d.location_id || null, d.to_location_id || null, d.lot_no || null, d.serial_no || null, d.uom_id || null,
                d.system_qty ?? 0, d.counted_qty ?? 0, d.unit_cost ?? null, d.unit_price ?? null,
                d.vat_type || null, d.vat_rate ?? null,
                d.ref_im_transaction_detail_id || null, d.description || null,
            ]);
        }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating im_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 2b. Post an existing Draft ---
const postTransaction = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`
            SELECT t.*, d.doc_code AS d_doc_code FROM im_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id WHERE t.id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        const tx = existing.rows[0];
        if (tx.status !== 'Draft') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Post ได้เฉพาะเอกสาร Draft เท่านั้น' });
        }
        const headerForPost = { ...tx, doc_code: tx.doc_code || tx.d_doc_code, updated_by: userName };
        await postDetailLines(client, id, headerForPost, tx.doc_no);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error posting im_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 2c. Post AP/GL for a 'Received' '12' (รับสินค้า รอตั้งหนี้) — ครั้งที่สองเมื่อได้ใบกำกับจริงจากผู้ขายแล้ว
// รับ ref_no (เลขที่ใบกำกับผู้ขาย) + billed costs รายบรรทัดมาอัปเดตในคำขอเดียวกันได้เลย (ไม่บังคับต้อง Save แยกก่อน)
// แล้วเรียก postApBillFromGrn ตัวเดียวกับที่ '11' ใช้ ด้วยต้นทุนตามใบกำกับ (ไม่ใช่ unit_cost ที่ตีมูลค่าสต็อกไปแล้ว)
const postBillingForGrn = async (req, res) => {
    const { id } = req.params;
    const { ref_no: refNoBody, lines } = req.body || {};
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`
            SELECT t.*, d.doc_code AS d_doc_code, d.sys_doc_type FROM im_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id WHERE t.id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        const tx = existing.rows[0];
        if (tx.sys_doc_type !== '12') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ใช้ได้เฉพาะเอกสารประเภทรับสินค้า (รอตั้งหนี้) เท่านั้น' });
        }
        if (tx.status !== 'Received') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Post AP/GL ได้เฉพาะเอกสารที่ Post IM แล้ว (สถานะ Received) เท่านั้น' });
        }

        const refNo = refNoBody || tx.ref_no;
        if (!refNo) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'กรุณาระบุเลขที่ใบกำกับสินค้าผู้ขาย' });
        }

        // บันทึกเลขที่ใบกำกับ + billed cost รายบรรทัด (ถ้าส่งมาในคำขอนี้) ก่อน Post
        if (refNoBody) {
            await client.query(`UPDATE im_transaction SET ref_no=$1, updated_by=$2, updated_at=NOW() WHERE id=$3`, [refNoBody, userName, id]);
        }
        if (Array.isArray(lines)) {
            for (const l of lines) {
                if (!l.id) continue;
                await client.query(
                    `UPDATE im_transaction_detail SET billed_unit_cost=$1, vat_type=$2, vat_rate=$3 WHERE id=$4 AND header_id=$5`,
                    [l.billed_unit_cost ?? null, l.vat_type ?? null, l.vat_rate ?? null, l.id, id]
                );
            }
        }

        const detailsRes = await client.query(`SELECT * FROM im_transaction_detail WHERE header_id=$1 ORDER BY line_no`, [id]);
        const billedDetails = detailsRes.rows.map((d) => ({
            ...d, unit_cost: d.billed_unit_cost ?? d.unit_cost,
        }));

        const mode = await fetchMode(client);
        const headerForBilling = { ...tx, doc_code: tx.doc_code || tx.d_doc_code, updated_by: userName };
        const apTransactionId = await postApBillFromGrn(client, {
            header: headerForBilling, details: billedDetails, docNo: tx.doc_no, vendorInvoiceNo: refNo, mode,
        });

        await client.query(`
            UPDATE im_transaction SET status='Posted', linked_ap_transaction_id=$1, updated_by=$2, updated_at=NOW() WHERE id=$3
        `, [apTransactionId, userName, id]);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error posting AP/GL billing for im_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 2d. Post AR/GL for a 'Delivered' '32' (ส่งสินค้า รอตั้งหนี้) — ครั้งที่สองเมื่อจะออกใบแจ้งหนี้จริงให้ลูกค้า
// รับ ref_no (เลขที่อ้างอิงลูกค้า, ไม่บังคับ) + unit_price รายบรรทัดมาอัปเดตในคำขอเดียวกันได้เลย แล้วเรียก
// postArBillFromDln ตัวเดียวกับที่ '31' ใช้ — ต้นทุนขาย (COGS) Post ไปแล้วตอน Post IM ไม่แตะซ้ำที่นี่
const postBillingForDln = async (req, res) => {
    const { id } = req.params;
    const { ref_no: refNoBody, lines } = req.body || {};
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`
            SELECT t.*, d.doc_code AS d_doc_code, d.sys_doc_type FROM im_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id WHERE t.id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        const tx = existing.rows[0];
        if (tx.sys_doc_type !== '32') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ใช้ได้เฉพาะเอกสารประเภทส่งสินค้า (รอตั้งหนี้) เท่านั้น' });
        }
        if (tx.status !== 'Delivered') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Post AR/GL ได้เฉพาะเอกสารที่ Post IM แล้ว (สถานะ Delivered) เท่านั้น' });
        }

        // บันทึกเลขที่อ้างอิง + ราคาขายรายบรรทัด (ถ้าส่งมาในคำขอนี้) ก่อน Post
        if (refNoBody) {
            await client.query(`UPDATE im_transaction SET ref_no=$1, updated_by=$2, updated_at=NOW() WHERE id=$3`, [refNoBody, userName, id]);
        }
        if (Array.isArray(lines)) {
            for (const l of lines) {
                if (!l.id) continue;
                await client.query(
                    `UPDATE im_transaction_detail SET unit_price=$1, vat_type=$2, vat_rate=$3 WHERE id=$4 AND header_id=$5`,
                    [l.unit_price ?? null, l.vat_type ?? null, l.vat_rate ?? null, l.id, id]
                );
            }
        }

        const detailsRes = await client.query(`SELECT * FROM im_transaction_detail WHERE header_id=$1 ORDER BY line_no`, [id]);
        const headerForBilling = { ...tx, doc_code: tx.doc_code || tx.d_doc_code, updated_by: userName, ref_no: refNoBody || tx.ref_no };
        const arTransactionId = await postArBillFromDln(client, {
            header: headerForBilling, details: detailsRes.rows, docNo: tx.doc_no,
        });

        await client.query(`
            UPDATE im_transaction SET status='Posted', linked_ar_transaction_id=$1, updated_by=$2, updated_at=NOW() WHERE id=$3
        `, [arTransactionId, userName, id]);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error posting AR/GL billing for im_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 3. Void ---
const voidTransaction = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT * FROM im_transaction WHERE id=$1 FOR UPDATE`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        const tx = existing.rows[0];
        // 'Received' = '12' ที่ Post IM แล้วแต่ยังไม่ Post AP/GL, 'Delivered' = '32' ที่ Post IM แล้วแต่ยังไม่ Post
        // AR/GL — Void ได้เหมือนกัน แค่บาง entry ยังไม่มีให้ย้อนกลับ (คู่ '32': COGS Post ไปแล้วตอน Delivered, ต่างจาก
        // '12' ที่ยังไม่มี GL ใดๆ เลยตอน Received)
        if (tx.status !== 'Posted' && tx.status !== 'Received' && tx.status !== 'Delivered') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Void ได้เฉพาะเอกสารที่ Posted, Received หรือ Delivered แล้วเท่านั้น' });
        }

        // GRN Billing ('11') สร้าง ap_transaction ไว้ — ต้อง Void ตามด้วยเสมอ เว้นแต่มีการจ่ายชำระ/จับคู่ไปแล้ว
        if (tx.linked_ap_transaction_id) {
            const apRes = await client.query(`SELECT * FROM ap_transaction WHERE id = $1 FOR UPDATE`, [tx.linked_ap_transaction_id]);
            const apTx = apRes.rows[0];
            if (apTx && apTx.status !== 'Void') {
                const appliedRes = await client.query(
                    `SELECT COUNT(*) FROM ap_transaction_apply WHERE applied_to_id = $1`,
                    [tx.linked_ap_transaction_id]
                );
                if (Number(appliedRes.rows[0].count) > 0 || Number(apTx.paid_amount_lc) > 0) {
                    throw new Error('ไม่สามารถ Void ได้ เนื่องจากใบตั้งหนี้ที่สร้างจากเอกสารนี้มีการจ่ายชำระ/จับคู่ไปแล้วในโมดูล AP');
                }
                if (apTx.gl_entry_id) {
                    await client.query(`UPDATE gl_entry_header SET status='Void', updated_at=NOW() WHERE id=$1`, [apTx.gl_entry_id]);
                }
                await client.query(`UPDATE ap_transaction SET status='Void', updated_at=NOW() WHERE id=$1`, [tx.linked_ap_transaction_id]);
            }
        }

        // DLN Billing ('31'/'32' หลัง Post AR/GL) สร้าง ar_transaction ไว้ — ต้อง Void ตามด้วยเสมอ เว้นแต่มีการรับชำระ/จับคู่ไปแล้ว
        if (tx.linked_ar_transaction_id) {
            const arRes = await client.query(`SELECT * FROM ar_transaction WHERE id = $1 FOR UPDATE`, [tx.linked_ar_transaction_id]);
            const arTx = arRes.rows[0];
            if (arTx && arTx.status !== 'Void') {
                const appliedRes = await client.query(
                    `SELECT COUNT(*) FROM ar_transaction_apply WHERE applied_to_id = $1`,
                    [tx.linked_ar_transaction_id]
                );
                if (Number(appliedRes.rows[0].count) > 0 || Number(arTx.paid_amount_lc) > 0) {
                    throw new Error('ไม่สามารถ Void ได้ เนื่องจากใบแจ้งหนี้ที่สร้างจากเอกสารนี้มีการรับชำระ/จับคู่ไปแล้วในโมดูล AR');
                }
                if (arTx.gl_entry_id) {
                    await client.query(`UPDATE gl_entry_header SET status='Void', updated_at=NOW() WHERE id=$1`, [arTx.gl_entry_id]);
                }
                await client.query(`UPDATE ar_transaction SET status='Void', updated_at=NOW() WHERE id=$1`, [tx.linked_ar_transaction_id]);
            }
        }

        await reverseStockMovement(client, id);

        if (tx.gl_entry_id) {
            await client.query(`UPDATE gl_entry_header SET status='Void', updated_at=NOW() WHERE id=$1`, [tx.gl_entry_id]);
        }
        await client.query(`UPDATE im_transaction SET status='Void', updated_at=NOW() WHERE id=$1`, [id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error voiding im_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- 4. Delete (Draft only) ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM im_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (existing.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ลบได้เฉพาะเอกสาร Draft เท่านั้น' }); }
        await client.query(`DELETE FROM im_transaction WHERE id=$1`, [id]);
        await client.query('COMMIT');
        res.status(204).send();
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting im_transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = {
    ensureImTransactionTable,
    fetchRows, fetchRow, fetchSystemQty, fetchReturnableDocs, fetchReturnableLines,
    createTransaction, updateTransaction, postTransaction, postBillingForGrn, postBillingForDln, voidTransaction, deleteTransaction,
    insertAndPostAdjustment, STOCK_BALANCE_KEY,
    upsertStockBalance, recomputeBalanceFromLayers,
    generateDocNo,
};
