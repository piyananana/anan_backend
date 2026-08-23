// controllers/im/imStockCountController.js — im_stock_count (ใบตรวจนับสต็อก, ต่อคลังสินค้าเดียว)
// Workflow แยกจาก im_transaction (AJS): Draft (ตรวจสอบผังก่อนบันทึก) -> Posted (บันทึกใบตรวจนับ —
// ล็อครายการ + freeze system_qty) -> Approved (ตรวจผล+อนุมัติ) -> Closed (บันทึกปรับยอด — สร้าง+
// โพสต์ im_transaction AJS) กิ่ง Void แยกจาก Draft/Posted ได้
// ไม่มี approver queue แบบ AP — ใช้ menu permission canApprove ธรรมดา (ดู routes/im.js)
'use strict';

const ExcelJS = require('exceljs');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const { ensureImWarehouseTable } = require('./imWarehouseController');
const { ensureImLocationTable } = require('./imLocationController');
const { ensureImItemTable } = require('./imItemController');
const { ensureImUomTable } = require('./imUomController');
const { ensureImStockBalanceTable } = require('./imStockBalanceController');
const {
    ensureImTransactionTable,
    insertAndPostAdjustment,
    STOCK_BALANCE_KEY,
} = require('./imTransactionController');
const {
    ensureImStockCountRunningTable,
    generateNextCode,
} = require('./imStockCountRunningController');

const ensureImStockCountTable = async (client) => {
    await ensureImWarehouseTable(client);
    await ensureImLocationTable(client);
    await ensureImItemTable(client);
    await ensureImUomTable(client);
    await ensureImStockBalanceTable(client);
    await ensureImTransactionTable(client); // im_stock_count.im_transaction_id references it
    await ensureImStockCountRunningTable(client);

    await client.query(`
        CREATE TABLE IF NOT EXISTS im_stock_count (
            id                SERIAL PRIMARY KEY,
            warehouse_id      INTEGER NOT NULL REFERENCES im_warehouse(id),
            count_date        DATE NOT NULL,
            description       TEXT,
            status            VARCHAR(20) NOT NULL DEFAULT 'Draft',
            im_transaction_id INTEGER REFERENCES im_transaction(id),
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by        VARCHAR(100),
            updated_by        VARCHAR(100),
            approved_at       TIMESTAMPTZ,
            approved_by       VARCHAR(100)
        )
    `);
    // idempotent migrations: count_no now generated+stored at creation (was computed-on-read),
    // print_count for screen 3, closed_at/by for the new distinct Close step
    await client.query(`ALTER TABLE im_stock_count ADD COLUMN IF NOT EXISTS count_no    VARCHAR(30)`).catch(() => {});
    await client.query(`ALTER TABLE im_stock_count ADD COLUMN IF NOT EXISTS print_count INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    await client.query(`ALTER TABLE im_stock_count ADD COLUMN IF NOT EXISTS closed_at   TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE im_stock_count ADD COLUMN IF NOT EXISTS closed_by   VARCHAR(100)`).catch(() => {});
    // backfill any legacy rows created before count_no existed, and legacy status names
    await client.query(`UPDATE im_stock_count SET count_no = 'CNT-' || LPAD(id::text, 6, '0') WHERE count_no IS NULL`).catch(() => {});
    await client.query(`UPDATE im_stock_count SET status = 'Posted' WHERE status = 'Counting'`).catch(() => {});
    await client.query(`UPDATE im_stock_count SET status = 'Void' WHERE status = 'Cancelled'`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_stock_count_warehouse ON im_stock_count(warehouse_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_stock_count_status    ON im_stock_count(status)`);

    await client.query(`
        CREATE TABLE IF NOT EXISTS im_stock_count_detail (
            id           SERIAL PRIMARY KEY,
            header_id    INTEGER NOT NULL REFERENCES im_stock_count(id) ON DELETE CASCADE,
            line_no      INTEGER NOT NULL,
            item_id      INTEGER NOT NULL REFERENCES im_item(id),
            item_code    VARCHAR(30),
            item_name    VARCHAR(200),
            location_id  INTEGER REFERENCES im_location(id),
            lot_no       VARCHAR(50),
            serial_no    VARCHAR(50),
            uom_id       INTEGER REFERENCES im_uom(id),
            system_qty   NUMERIC(18,4),
            counted_qty  NUMERIC(18,4),
            unit_cost    NUMERIC(18,4),
            counted_by   VARCHAR(100),
            counted_at   TIMESTAMPTZ,
            remark       TEXT
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_stock_count_detail_header   ON im_stock_count_detail(header_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_stock_count_detail_location ON im_stock_count_detail(location_id)`);
};

// ยอดคงเหลือระบบ ณ ตอนนี้ — สำหรับ item ปกติใช้ im_stock_balance, สำหรับ SPECIFIC (serial) ใช้การมี/ไม่มี layer เปิดอยู่
// (สูตรเดียวกับ imTransactionController.fetchSystemQty — reuse STOCK_BALANCE_KEY เพื่อไม่ให้ formula เพี้ยนกัน)
const getSystemQty = async (client, { itemId, warehouseId, locationId, lotNo, serialNo }) => {
    if (serialNo) {
        const r = await client.query(
            `SELECT id FROM im_stock_layer WHERE item_id=$1 AND serial_no=$2 AND remaining_qty > 0`,
            [itemId, serialNo]
        );
        return r.rows.length > 0 ? 1 : 0;
    }
    const r = await client.query(
        `SELECT qty_on_hand FROM im_stock_balance WHERE ${STOCK_BALANCE_KEY}`,
        [itemId, warehouseId, locationId || null, lotNo || null]
    );
    return r.rows.length > 0 ? Number(r.rows[0].qty_on_hand) : 0;
};

// รายการทั้งหมดที่มียอดคงเหลือในคลังนี้ ณ ตอนนี้ — ใช้ตอนสร้างใบตรวจนับใหม่และตอน "โหลดผังใหม่"
const seedLinesForWarehouse = async (client, warehouseId) => {
    const result = await client.query(`
        SELECT b.item_id, i.item_code, i.item_name_th AS item_name, b.location_id, b.lot_no, i.base_uom_id AS uom_id
        FROM im_stock_balance b
        JOIN im_item i ON i.id = b.item_id
        WHERE b.warehouse_id = $1 AND b.qty_on_hand != 0
        ORDER BY i.item_code, b.location_id
    `, [warehouseId]);
    return result.rows;
};

const insertLines = async (client, headerId, lines) => {
    let lineNo = 1;
    for (const l of lines) {
        await client.query(`
            INSERT INTO im_stock_count_detail
            (header_id, line_no, item_id, item_code, item_name, location_id, lot_no, serial_no, uom_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [headerId, lineNo++, l.item_id, l.item_code || null, l.item_name || null,
            l.location_id || null, l.lot_no || null, l.serial_no || null, l.uom_id || null]);
    }
};

// อนุประโยค subtree ของผัง location (รวม location_id ที่เลือกเองด้วย) — ใช้ร่วมกันในหน้าบันทึกยอด/รายงานผลต่าง/import-export
const LOCATION_SUBTREE_CTE = `
    WITH RECURSIVE loc_tree AS (
        SELECT id FROM im_location WHERE id = $LOC_PARAM
        UNION ALL
        SELECT l.id FROM im_location l JOIN loc_tree t ON l.parent_id = t.id
    )
`;

// --- Fetch helpers ---
const fetchRowById = async (pool, id) => {
    const hRes = await pool.query(`
        SELECT c.*,
               w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
               t.doc_no AS im_transaction_doc_no
        FROM im_stock_count c
        LEFT JOIN im_warehouse w    ON w.id = c.warehouse_id
        LEFT JOIN im_transaction t ON t.id = c.im_transaction_id
        WHERE c.id = $1
    `, [id]);
    if (hRes.rows.length === 0) return null;
    const dRes = await pool.query(`
        SELECT d.*, u.uom_code, l.location_code, l.sort_order AS location_sort_order
        FROM im_stock_count_detail d
        LEFT JOIN im_uom u      ON u.id = d.uom_id
        LEFT JOIN im_location l ON l.id = d.location_id
        WHERE d.header_id = $1 ORDER BY d.line_no
    `, [id]);
    return { ...hRes.rows[0], details: dRes.rows };
};

const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImStockCountTable(client);
        const { warehouse_id, status, date_from, date_to, exclude_closed_void } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (warehouse_id) { params.push(warehouse_id); where += ` AND c.warehouse_id = $${pi++}`; }
        if (status)       { params.push(status);       where += ` AND c.status = $${pi++}`; }
        if (date_from)    { params.push(date_from);    where += ` AND c.count_date >= $${pi++}`; }
        if (date_to)      { params.push(date_to);      where += ` AND c.count_date <= $${pi++}`; }
        if (exclude_closed_void === 'true') where += ` AND c.status NOT IN ('Closed','Void')`;
        const result = await client.query(`
            SELECT c.*,
                   w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                   (SELECT COUNT(*) FROM im_stock_count_detail d WHERE d.header_id = c.id) AS line_count
            FROM im_stock_count c
            LEFT JOIN im_warehouse w ON w.id = c.warehouse_id
            ${where}
            ORDER BY c.count_date DESC, c.id DESC
        `, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_stock_count list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImStockCountTable(client);
        const data = await fetchRowById(client, req.params.id);
        if (!data) return res.status(404).json({ message: 'Not found.' });
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching im_stock_count row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- Create (Draft) — always auto-seeds every item+location with nonzero balance in the chosen warehouse ---
const addRow = async (req, res) => {
    const { warehouse_id, count_date, description } = req.body;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureImStockCountTable(client);
        if (!warehouse_id) throw new Error('กรุณาระบุคลังสินค้า');
        if (!count_date) throw new Error('กรุณาระบุวันที่ตรวจนับ');

        let countNo = await generateNextCode(client);

        const hRes = await client.query(`
            INSERT INTO im_stock_count (warehouse_id, count_date, description, status, count_no, created_by, updated_by)
            VALUES ($1,$2,$3,'Draft',$4,$5,$5) RETURNING id
        `, [warehouse_id, count_date, description || null, countNo, userName]);
        const headerId = hRes.rows[0].id;
        if (!countNo) {
            countNo = `CNT-${headerId.toString().padStart(6, '0')}`;
            await client.query(`UPDATE im_stock_count SET count_no=$1 WHERE id=$2`, [countNo, headerId]);
        }

        const seeded = await seedLinesForWarehouse(client, warehouse_id);
        await insertLines(client, headerId, seeded);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, headerId);
        res.status(201).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding im_stock_count:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- Update header fields (Draft only) ---
const updateHeader = async (req, res) => {
    const { id } = req.params;
    const { warehouse_id, count_date, description } = req.body;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hRes = await client.query(`SELECT status, warehouse_id FROM im_stock_count WHERE id=$1`, [id]);
        if (hRes.rows.length === 0) throw new Error('Not found');
        if (hRes.rows[0].status !== 'Draft') throw new Error('แก้ไขข้อมูลเอกสารได้เฉพาะสถานะ Draft เท่านั้น');
        const warehouseChanged = Number(warehouse_id) !== Number(hRes.rows[0].warehouse_id);

        await client.query(`
            UPDATE im_stock_count SET warehouse_id=$1, count_date=$2, description=$3, updated_by=$4, updated_at=NOW()
            WHERE id=$5
        `, [warehouse_id, count_date, description || null, userName, id]);

        // เปลี่ยนคลัง = ต้องรื้อผังใหม่ทั้งหมดจากคลังใหม่ (ข้อมูลเดิมอ้างอิงคลังเก่า ใช้ต่อไม่ได้)
        if (warehouseChanged) {
            await client.query(`DELETE FROM im_stock_count_detail WHERE header_id=$1`, [id]);
            const seeded = await seedLinesForWarehouse(client, warehouse_id);
            await insertLines(client, id, seeded);
        }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating im_stock_count header:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- "โหลดผังใหม่" — Draft only, re-syncs the full item/bin list from current im_stock_balance ---
const resyncLines = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hRes = await client.query(`SELECT status, warehouse_id FROM im_stock_count WHERE id=$1 FOR UPDATE`, [id]);
        if (hRes.rows.length === 0) throw new Error('Not found');
        if (hRes.rows[0].status !== 'Draft') throw new Error('โหลดผังใหม่ได้เฉพาะสถานะ Draft เท่านั้น');

        await client.query(`DELETE FROM im_stock_count_detail WHERE header_id=$1`, [id]);
        const seeded = await seedLinesForWarehouse(client, hRes.rows[0].warehouse_id);
        await insertLines(client, id, seeded);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error resyncing im_stock_count lines:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- "บันทึกใบตรวจนับ": Draft -> Posted, freezes system_qty for every line (idempotent) ---
const postCount = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hRes = await client.query(`SELECT * FROM im_stock_count WHERE id=$1 FOR UPDATE`, [id]);
        if (hRes.rows.length === 0) throw new Error('Not found');
        const header = hRes.rows[0];
        if (header.status === 'Posted') {
            await client.query('COMMIT');
            const full = await fetchRowById(req.dbPool, id);
            return res.status(200).json(full);
        }
        if (header.status !== 'Draft') throw new Error('สถานะเอกสารไม่ถูกต้อง');

        const dRes = await client.query(`SELECT * FROM im_stock_count_detail WHERE header_id=$1`, [id]);
        if (dRes.rows.length === 0) throw new Error('ยังไม่มีรายการให้ตรวจนับ');
        for (const d of dRes.rows) {
            const systemQty = await getSystemQty(client, {
                itemId: d.item_id, warehouseId: header.warehouse_id, locationId: d.location_id, lotNo: d.lot_no, serialNo: d.serial_no,
            });
            await client.query(`UPDATE im_stock_count_detail SET system_qty=$1 WHERE id=$2`, [systemQty, d.id]);
        }
        await client.query(`UPDATE im_stock_count SET status='Posted', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error posting im_stock_count:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- Void (Draft or Posted) ---
const voidCount = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hRes = await client.query(`SELECT status FROM im_stock_count WHERE id=$1`, [id]);
        if (hRes.rows.length === 0) throw new Error('Not found');
        if (!['Draft', 'Posted'].includes(hRes.rows[0].status)) throw new Error('ยกเลิกได้เฉพาะสถานะ Draft หรือ Posted เท่านั้น');
        await client.query(`UPDATE im_stock_count SET status='Void', updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error voiding im_stock_count:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- Print counter (screen 3 calls this right before generating the PDF) ---
const incrementPrintCount = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `UPDATE im_stock_count SET print_count = print_count + 1 WHERE id=$1 RETURNING print_count`,
            [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Not found' });
        res.status(200).json({ print_count: result.rows[0].print_count });
    } catch (error) {
        console.error('Error incrementing print_count:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- GET /:id/lines?location_id= — screen 4's core query: every line under a location subtree ---
const fetchLinesForRecording = async (req, res) => {
    const { id } = req.params;
    const { location_id } = req.query;
    if (!location_id) return res.status(400).json({ message: 'กรุณาระบุตำแหน่งจัดเก็บ' });
    const client = await req.dbPool.connect();
    try {
        const hRes = await client.query(`SELECT status, warehouse_id FROM im_stock_count WHERE id=$1`, [id]);
        if (hRes.rows.length === 0) return res.status(404).json({ message: 'Not found' });
        if (['Closed', 'Void'].includes(hRes.rows[0].status)) {
            return res.status(400).json({ message: 'เอกสารนี้ปิดหรือยกเลิกแล้ว ไม่สามารถบันทึกยอดตรวจนับได้' });
        }
        const result = await client.query(`
            ${LOCATION_SUBTREE_CTE.replace('$LOC_PARAM', '$2')}
            SELECT d.*, u.uom_code, l.location_code,
                   w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en
            FROM im_stock_count_detail d
            LEFT JOIN im_uom u      ON u.id = d.uom_id
            LEFT JOIN im_location l ON l.id = d.location_id
            LEFT JOIN im_warehouse w ON w.id = $3
            WHERE d.header_id = $1 AND d.location_id IN (SELECT id FROM loc_tree)
            ORDER BY l.location_code, d.item_code
        `, [id, location_id, hRes.rows[0].warehouse_id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_stock_count lines for recording:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- Bulk-save counted qty / unit cost / remark (Posted only — screen 4's Save button) ---
const updateCounts = async (req, res) => {
    const { id } = req.params;
    const { lines } = req.body;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hRes = await client.query(`SELECT status FROM im_stock_count WHERE id=$1`, [id]);
        if (hRes.rows.length === 0) throw new Error('Not found');
        if (hRes.rows[0].status !== 'Posted') throw new Error('บันทึกยอดตรวจนับได้เฉพาะสถานะ Posted เท่านั้น');
        for (const l of (lines || [])) {
            await client.query(`
                UPDATE im_stock_count_detail
                SET counted_qty=$1, unit_cost=$2, remark=$3, counted_by=$4, counted_at=NOW()
                WHERE id=$5 AND header_id=$6
            `, [l.counted_qty ?? null, l.unit_cost ?? null, l.remark || null, userName, l.id, id]);
        }
        await client.query(`UPDATE im_stock_count SET updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating im_stock_count counts:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- Check results (screen 6, read-only) ---
const checkResults = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const hRes = await client.query(`SELECT * FROM im_stock_count WHERE id=$1`, [id]);
        if (hRes.rows.length === 0) return res.status(404).json({ message: 'Not found' });
        const header = hRes.rows[0];

        const binsRes = await client.query(`
            SELECT COUNT(*) AS total_bins,
                   COUNT(*) FILTER (WHERE EXISTS (
                       SELECT 1 FROM im_stock_count_detail d WHERE d.header_id=$1 AND d.location_id = l.id
                   )) AS non_empty_bins
            FROM im_location l
            WHERE l.warehouse_id = $2 AND l.location_type = 'BIN'
        `, [id, header.warehouse_id]);

        const itemsRes = await client.query(`
            SELECT COUNT(*) AS total_items,
                   COUNT(*) FILTER (WHERE COALESCE(system_qty,0) > 0) AS items_with_stock,
                   COUNT(*) FILTER (WHERE COALESCE(system_qty,0) = 0) AS items_without_stock,
                   COUNT(*) FILTER (WHERE COALESCE(counted_qty,0) != COALESCE(system_qty,0)) AS items_with_variance,
                   COALESCE(SUM((COALESCE(counted_qty,0) - COALESCE(system_qty,0)) * COALESCE(unit_cost,0))
                       FILTER (WHERE COALESCE(counted_qty,0) != COALESCE(system_qty,0)), 0) AS variance_value
            FROM im_stock_count_detail WHERE header_id=$1
        `, [id]);

        const bins = binsRes.rows[0];
        const items = itemsRes.rows[0];
        res.status(200).json({
            total_bins: Number(bins.total_bins),
            non_empty_bins: Number(bins.non_empty_bins),
            empty_bins: Number(bins.total_bins) - Number(bins.non_empty_bins),
            total_items: Number(items.total_items),
            items_with_stock: Number(items.items_with_stock),
            items_without_stock: Number(items.items_without_stock),
            items_with_variance: Number(items.items_with_variance),
            variance_value: Number(items.variance_value),
        });
    } catch (error) {
        console.error('Error checking im_stock_count results:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- Approve: Posted -> Approved only (no AJS yet) ---
const approveCount = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hRes = await client.query(`SELECT * FROM im_stock_count WHERE id=$1 FOR UPDATE`, [id]);
        if (hRes.rows.length === 0) throw new Error('Not found');
        const header = hRes.rows[0];
        if (header.status !== 'Posted') throw new Error('อนุมัติได้เฉพาะเอกสารสถานะ Posted เท่านั้น');

        const dRes = await client.query(`SELECT id FROM im_stock_count_detail WHERE header_id=$1 AND counted_qty IS NULL`, [id]);
        if (dRes.rows.length > 0) throw new Error(`มี ${dRes.rows.length} รายการยังไม่ได้บันทึกยอดตรวจนับ`);

        await client.query(`
            UPDATE im_stock_count SET status='Approved', approved_at=NOW(), approved_by=$1, updated_by=$1, updated_at=NOW()
            WHERE id=$2
        `, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error approving im_stock_count:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- Save Adjustment: Approved -> Closed — creates+posts the AJS im_transaction ---
const closeCount = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hRes = await client.query(`SELECT * FROM im_stock_count WHERE id=$1 FOR UPDATE`, [id]);
        if (hRes.rows.length === 0) throw new Error('Not found');
        const header = hRes.rows[0];
        if (header.status !== 'Approved') throw new Error('บันทึกปรับยอดได้เฉพาะเอกสารที่อนุมัติแล้วเท่านั้น');

        const dRes = await client.query(`SELECT * FROM im_stock_count_detail WHERE header_id=$1 ORDER BY line_no`, [id]);
        const changedLines = dRes.rows
            .filter(d => Number(d.counted_qty) !== Number(d.system_qty ?? 0))
            .map(d => ({
                item_id: d.item_id, item_code: d.item_code, item_name: d.item_name,
                location_id: d.location_id, lot_no: d.lot_no, serial_no: d.serial_no, uom_id: d.uom_id,
                system_qty: d.system_qty, counted_qty: d.counted_qty, unit_cost: d.unit_cost,
            }));

        let imTransactionId = null;
        if (changedLines.length > 0) {
            // ไม่ระบุ doc_code ตายตัว — สั่งด้วย sys_doc_type='80' (มาตรฐาน AJS) ให้ insertAndPostAdjustment
            // เลือก doc_code เริ่มต้นเอง เพราะอาจมีหลาย doc_code (เช่น AJS1/AJS2) ใต้มาตรฐานเดียวกันนี้
            imTransactionId = await insertAndPostAdjustment(client, {
                sysDocType: '80', docDate: header.count_date, warehouseId: header.warehouse_id,
                description: header.description, lines: changedLines, createdBy: userName, action: 'Post',
            });
        }
        await client.query(`
            UPDATE im_stock_count
            SET status='Closed', im_transaction_id=$1, closed_at=NOW(), closed_by=$2, updated_by=$2, updated_at=NOW()
            WHERE id=$3
        `, [imTransactionId, userName, id]);

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error closing im_stock_count:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

// --- Variance report ---
const fetchVarianceReport = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImStockCountTable(client);
        const { count_id, warehouse_id, location_id, date_from, date_to, variance_only } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        let pi = 1;
        if (count_id)     { params.push(count_id);     where += ` AND c.id = $${pi++}`; }
        if (warehouse_id) { params.push(warehouse_id); where += ` AND c.warehouse_id = $${pi++}`; }
        if (date_from)    { params.push(date_from);    where += ` AND c.count_date >= $${pi++}`; }
        if (date_to)      { params.push(date_to);      where += ` AND c.count_date <= $${pi++}`; }
        if (variance_only === 'true') where += ` AND COALESCE(d.counted_qty,0) != COALESCE(d.system_qty,0)`;

        let cte = '';
        if (location_id) {
            params.push(location_id);
            cte = LOCATION_SUBTREE_CTE.replace('$LOC_PARAM', `$${pi++}`);
            where += ` AND d.location_id IN (SELECT id FROM loc_tree)`;
        }

        const result = await client.query(`
            ${cte}
            SELECT c.id AS count_id, c.count_no, c.count_date, c.status,
                   w.warehouse_code, w.warehouse_name_th,
                   d.item_id, d.item_code, d.item_name, d.location_id, l.location_code,
                   d.lot_no, d.serial_no, d.system_qty, d.counted_qty,
                   (COALESCE(d.counted_qty,0) - COALESCE(d.system_qty,0)) AS variance_qty,
                   d.unit_cost,
                   ((COALESCE(d.counted_qty,0) - COALESCE(d.system_qty,0)) * COALESCE(d.unit_cost,0)) AS variance_value
            FROM im_stock_count_detail d
            JOIN im_stock_count c    ON c.id = d.header_id
            LEFT JOIN im_warehouse w ON w.id = c.warehouse_id
            LEFT JOIN im_location l  ON l.id = d.location_id
            ${where}
            ORDER BY c.count_date DESC, d.item_code
        `, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_stock_count variance report:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- Excel export (GET /:id/export?location_id=) — blind (no system_qty), locks every column except
// Counted Qty / Unit Cost / Remark. Hidden 'id' column is how import re-matches rows.
// Scoped to the same location subtree currently displayed on screen 4. ---
const exportExcel = async (req, res) => {
    const { id } = req.params;
    const { location_id } = req.query;
    if (!location_id) return res.status(400).json({ message: 'กรุณาระบุตำแหน่งจัดเก็บ' });
    const client = await req.dbPool.connect();
    try {
        const hRes = await client.query(`SELECT status FROM im_stock_count WHERE id=$1`, [id]);
        if (hRes.rows.length === 0) return res.status(404).json({ message: 'Not found' });

        const dRes = await client.query(`
            ${LOCATION_SUBTREE_CTE.replace('$LOC_PARAM', '$2')}
            SELECT d.*, u.uom_code, l.location_code
            FROM im_stock_count_detail d
            LEFT JOIN im_uom u      ON u.id = d.uom_id
            LEFT JOIN im_location l ON l.id = d.location_id
            WHERE d.header_id = $1 AND d.location_id IN (SELECT id FROM loc_tree)
            ORDER BY l.location_code, d.item_code
        `, [id, location_id]);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('ใบตรวจนับ');
        sheet.columns = [
            { header: 'ลำดับ', key: 'line_no', width: 8 },
            { header: 'รหัสสินค้า', key: 'item_code', width: 16 },
            { header: 'ชื่อสินค้า', key: 'item_name', width: 32 },
            { header: 'ตำแหน่งจัดเก็บ', key: 'location', width: 14 },
            { header: 'ล็อต', key: 'lot_no', width: 12 },
            { header: 'Serial No.', key: 'serial_no', width: 14 },
            { header: 'หน่วยนับ', key: 'uom', width: 10 },
            { header: 'ยอดตรวจนับ', key: 'counted_qty', width: 14 },
            { header: 'ต้นทุน/หน่วย', key: 'unit_cost', width: 14 },
            { header: 'หมายเหตุ', key: 'remark', width: 24 },
            { header: 'id', key: 'detail_id', width: 8 },
        ];
        sheet.getRow(1).font = { bold: true };

        for (const d of dRes.rows) {
            sheet.addRow({
                line_no: d.line_no, item_code: d.item_code, item_name: d.item_name,
                location: d.location_code || '', lot_no: d.lot_no || '', serial_no: d.serial_no || '',
                uom: d.uom_code || '', counted_qty: d.counted_qty ?? null, unit_cost: d.unit_cost ?? null,
                remark: d.remark || '', detail_id: d.id,
            });
        }

        const editableKeys = ['counted_qty', 'unit_cost', 'remark'];
        const editableColNums = editableKeys.map((k) => sheet.getColumn(k).number);
        sheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            editableColNums.forEach((colNum) => { row.getCell(colNum).protection = { locked: false }; });
        });
        sheet.getColumn('detail_id').hidden = true;
        await sheet.protect('', { selectLockedCells: true, selectUnlockedCells: true });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="stock_count_${id}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Error exporting im_stock_count:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// --- Excel import step 1: parse + validate, no writes (POST /:id/import/validate, multipart) ---
const importValidate = [
    upload.single('file'),
    async (req, res) => {
        const { id } = req.params;
        if (!req.file) return res.status(400).json({ message: 'ไม่พบไฟล์' });
        const client = await req.dbPool.connect();
        try {
            const hRes = await client.query(`SELECT status FROM im_stock_count WHERE id=$1`, [id]);
            if (hRes.rows.length === 0) return res.status(404).json({ message: 'Not found' });
            if (hRes.rows[0].status !== 'Posted') {
                return res.status(400).json({ message: 'Import ได้เฉพาะเอกสารสถานะ Posted เท่านั้น' });
            }

            const dRes = await client.query(`SELECT * FROM im_stock_count_detail WHERE header_id=$1`, [id]);
            const detailMap = new Map(dRes.rows.map((d) => [String(d.id), d]));

            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(req.file.buffer);
            const sheet = workbook.worksheets[0];
            if (!sheet) return res.status(400).json({ message: 'ไม่พบข้อมูลในไฟล์' });

            const headerRow = sheet.getRow(1).values;
            const colIndex = {};
            headerRow.forEach((v, i) => { if (v) colIndex[String(v).trim()] = i; });
            const idCol = colIndex['id'];
            const countedCol = colIndex['ยอดตรวจนับ'];
            const costCol = colIndex['ต้นทุน/หน่วย'];
            const remarkCol = colIndex['หมายเหตุ'];
            const itemCodeCol = colIndex['รหัสสินค้า'];
            if (!idCol || !countedCol) {
                return res.status(400).json({
                    message: 'รูปแบบไฟล์ไม่ถูกต้อง (ไม่พบคอลัมน์ id หรือ ยอดตรวจนับ) — กรุณาใช้ไฟล์ที่ export จากระบบเท่านั้น',
                });
            }

            const errors = [];
            const validRows = [];
            let rowCount = 0;
            sheet.eachRow((row, rowNumber) => {
                if (rowNumber === 1) return;
                const detailId = row.getCell(idCol).value;
                if (detailId === null || detailId === undefined || detailId === '') return;
                rowCount++;
                const detail = detailMap.get(String(detailId));
                if (!detail) {
                    errors.push({ row: rowNumber, message: `ไม่พบรายการ id=${detailId} ในเอกสารนี้ (id ถูกแก้ไข หรือไฟล์มาจากเอกสารอื่น)` });
                    return;
                }
                if (itemCodeCol) {
                    const itemCodeVal = String(row.getCell(itemCodeCol).value ?? '').trim();
                    if (itemCodeVal && itemCodeVal !== (detail.item_code || '')) {
                        errors.push({ row: rowNumber, message: `แถว id=${detailId}: คอลัมน์ที่ล็อค (รหัสสินค้า) ถูกแก้ไข — ไม่รับข้อมูลแถวนี้` });
                        return;
                    }
                }
                const countedRaw = row.getCell(countedCol).value;
                const counted = (countedRaw === null || countedRaw === undefined || countedRaw === '') ? null : Number(countedRaw);
                if (counted !== null && Number.isNaN(counted)) {
                    errors.push({ row: rowNumber, message: `แถว id=${detailId}: ยอดตรวจนับต้องเป็นตัวเลข` });
                    return;
                }
                const costRaw = costCol ? row.getCell(costCol).value : null;
                const cost = (costRaw === null || costRaw === undefined || costRaw === '') ? null : Number(costRaw);
                if (cost !== null && Number.isNaN(cost)) {
                    errors.push({ row: rowNumber, message: `แถว id=${detailId}: ต้นทุนต่อหน่วยต้องเป็นตัวเลข` });
                    return;
                }
                const remark = remarkCol ? String(row.getCell(remarkCol).value ?? '').trim() : '';
                validRows.push({ id: detail.id, counted_qty: counted, unit_cost: cost, remark: remark || null });
            });

            res.status(200).json({ totalRows: rowCount, validRows: validRows.length, errorRows: errors.length, errors, rows: validRows });
        } catch (error) {
            console.error('Error validating im_stock_count import:', error);
            res.status(500).json({ message: 'ไม่สามารถอ่านไฟล์ได้: ' + error.message });
        } finally { client.release(); }
    },
];

// --- Excel import step 2: apply already-validated rows (POST /:id/import/confirm, JSON body {rows}) ---
const importConfirm = async (req, res) => {
    const { id } = req.params;
    const { rows } = req.body;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const hRes = await client.query(`SELECT status FROM im_stock_count WHERE id=$1`, [id]);
        if (hRes.rows.length === 0) throw new Error('Not found');
        if (hRes.rows[0].status !== 'Posted') throw new Error('Import ได้เฉพาะเอกสารสถานะ Posted เท่านั้น');
        for (const r of (rows || [])) {
            await client.query(`
                UPDATE im_stock_count_detail
                SET counted_qty=$1, unit_cost=$2, remark=$3, counted_by=$4, counted_at=NOW()
                WHERE id=$5 AND header_id=$6
            `, [r.counted_qty ?? null, r.unit_cost ?? null, r.remark || null, userName, r.id, id]);
        }
        await client.query(`UPDATE im_stock_count SET updated_by=$1, updated_at=NOW() WHERE id=$2`, [userName, id]);
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error confirming im_stock_count import:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = {
    ensureImStockCountTable,
    fetchRows, fetchRow, addRow, updateHeader, resyncLines,
    postCount, voidCount, incrementPrintCount,
    fetchLinesForRecording, updateCounts,
    checkResults, approveCount, closeCount,
    fetchVarianceReport,
    exportExcel, importValidate, importConfirm,
    fetchRowById,
};
