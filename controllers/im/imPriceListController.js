// controllers/im/imPriceListController.js
'use strict';

const { ensureImItemTable } = require('./imItemController');
const { ensureImUomTable } = require('./imUomController');
const { ensureImPriceGroupTable } = require('./imPriceGroupController');

const LIST_TYPES = ['SALES', 'PURCHASE'];

const ensureImPriceListTable = async (client) => {
    // im_price_list_detail references im_item/im_uom, so they must exist first
    await ensureImItemTable(client);
    await ensureImUomTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_price_list (
            id                SERIAL PRIMARY KEY,
            price_list_code   VARCHAR(20)  NOT NULL UNIQUE,
            price_list_name   VARCHAR(200) NOT NULL,
            list_type         VARCHAR(10)  NOT NULL DEFAULT 'SALES',
            currency_id       INTEGER REFERENCES cd_currency(id),
            is_active         BOOLEAN      NOT NULL DEFAULT true,
            created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by        VARCHAR(100),
            updated_by        VARCHAR(100)
        )
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_price_list_detail (
            id                SERIAL PRIMARY KEY,
            price_list_id     INTEGER NOT NULL REFERENCES im_price_list(id) ON DELETE CASCADE,
            item_id           INTEGER NOT NULL REFERENCES im_item(id),
            uom_id            INTEGER REFERENCES im_uom(id),
            min_qty           NUMERIC(18,4) NOT NULL DEFAULT 0,
            unit_price_fc     NUMERIC(18,4) NOT NULL DEFAULT 0,
            effective_from    DATE,
            effective_to      DATE
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_price_list_detail_list ON im_price_list_detail(price_list_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_price_list_detail_item ON im_price_list_detail(item_id)`);

    // audit trail ระดับบรรทัด — updateRow เดิม delete-all-then-reinsert ทุกครั้งที่บันทึกทำให้ไม่รู้ว่าใครแก้ราคา
    // บรรทัดไหนเมื่อไหร่จากเท่าไหร่เป็นเท่าไหร่ ตอนนี้เปลี่ยนเป็น diff-based update (จับคู่ด้วย id) แล้ว จึงต้องมี
    // คอลัมน์เหล่านี้ไว้บอกว่าบรรทัดที่ "คงอยู่" ถูกแก้ล่าสุดโดยใครเมื่อไหร่ (บรรทัดที่ถูกลบ/แทนที่ยังไม่มีประวัติ
    // เก็บแยกเป็นตาราง — ดู comment ใน updateRow)
    await client.query(`ALTER TABLE im_price_list_detail ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`).catch(() => {});
    await client.query(`ALTER TABLE im_price_list_detail ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`).catch(() => {});
    await client.query(`ALTER TABLE im_price_list_detail ADD COLUMN IF NOT EXISTS created_by VARCHAR(100)`).catch(() => {});
    await client.query(`ALTER TABLE im_price_list_detail ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100)`).catch(() => {});

    // กลุ่มราคา (im_price_group) — **แค่ป้ายกำกับ/หมวดหมู่ของตารางราคา ไม่มีผลต่อ resolveItemPrice เลย** ลูกค้า/
    // ผู้ขายหลายรายเป็น "ลูกค้าค้าส่ง" เหมือนกันได้ แต่ราคาค้าส่งที่แต่ละคนได้รับอาจต่างกัน (คนละตารางราคา) —
    // ตารางราคาหลายใบจึงแปะป้าย "ค้าส่ง" ซ้อนกันได้ ไม่ใช่ป้ายละ 1 ใบ จึงไม่มี unique constraint ที่นี่ และไม่
    // แยกช่องตาม list_type (แค่หมวดหมู่ ไม่ใช่ target) ดู ensureArCustomerTable/ensureApVendorTable สำหรับฝั่งที่
    // ลูกค้า/ผู้ขายผูกกับ "ตารางราคา" ที่จะใช้จริงโดยตรง (price_list_id ไม่ใช่ price_group_id)
    await ensureImPriceGroupTable(client);
    await client.query(`ALTER TABLE im_price_list ADD COLUMN IF NOT EXISTS price_group_id INTEGER REFERENCES im_price_group(id)`).catch(() => {});
    // migrate ข้อมูลเดิมจากรอบออกแบบก่อนหน้า (customer_price_group_id/vendor_price_group_id เคยถูกใช้เป็น targeting
    // ผิดจุด) เข้าคอลัมน์ป้ายกำกับใหม่ก่อนตัดทิ้ง — เช็คว่าคอลัมน์เก่ายังอยู่จริงก่อนแตะมันทุกครั้ง (ต้องเช็ค ไม่ใช่
    // แค่ .catch(()=>{}) เฉยๆ) เพราะข้อผิดพลาด SQL ภายใน transaction (BEGIN ของ addRow/updateRow ที่เรียกมาจากตรง
    // นี้) จะทำให้ transaction ทั้งก้อน "aborted" ไปเลย แม้ promise ฝั่ง JS จะถูก catch กลืนไว้ก็ตาม — รันครั้งเดียว
    // พอตอนคอลัมน์เก่ายังอยู่ หลังจากนั้นจะข้าม block นี้ไปทั้งหมดเพราะคอลัมน์ไม่อยู่แล้ว
    const oldGroupCols = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'im_price_list' AND column_name IN ('customer_price_group_id', 'vendor_price_group_id')
    `);
    if (oldGroupCols.rows.length > 0) {
        await client.query(`
            UPDATE im_price_list SET price_group_id = COALESCE(customer_price_group_id, vendor_price_group_id)
            WHERE price_group_id IS NULL AND (customer_price_group_id IS NOT NULL OR vendor_price_group_id IS NOT NULL)
        `);
        await client.query(`DROP INDEX IF EXISTS idx_price_list_customer_group_uq`);
        await client.query(`DROP INDEX IF EXISTS idx_price_list_vendor_group_uq`);
        await client.query(`ALTER TABLE im_price_list DROP COLUMN IF EXISTS customer_price_group_id`);
        await client.query(`ALTER TABLE im_price_list DROP COLUMN IF EXISTS vendor_price_group_id`);
    }

    // ตัดวิธี targeting แบบเดิม (im_price_list.vendor_id/customer_id ผูกลิสต์กับผู้ขาย/ลูกค้อรายตัว) ตามแนวคิดที่
    // ผู้ใช้ยืนยันแล้วว่า ar_customer/ap_vendor ควรผูกกับ im_price_list โดยตรง (price_list_id) ไม่ใช่กลับทาง —
    // ก่อนตัดคอลัมน์เก่าทิ้งต้อง "ย้ายข้อมูลจริง" ที่มีอยู่ก่อน (เช่น PUR-2382 เคยผูกกับ vendor_id=2382) ไปเป็น
    // ap_vendor.price_list_id/ar_customer.price_list_id ก่อน ไม่งั้นความสัมพันธ์ที่ผู้ใช้สร้างไว้จะหายไปเงียบๆ —
    // เช็คว่าคอลัมน์เก่ายังอยู่จริงก่อนแตะมันทุกครั้ง (เหตุผลเดียวกับ migration ด้านบน: SQL error ภายใน transaction
    // ของ addRow/updateRow ที่เรียก ensureImPriceListTable นี้จะทำให้ transaction ทั้งก้อน aborted แม้ promise ฝั่ง
    // JS จะถูก catch กลืนไว้ก็ตาม) — รันครั้งเดียวพอตอนคอลัมน์เก่ายังอยู่ หลังจากนั้นข้าม block นี้ไปทั้งหมด
    const oldTargetingCols = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'im_price_list' AND column_name IN ('customer_id', 'vendor_id')
    `);
    if (oldTargetingCols.rows.length > 0) {
        // รับประกันว่าคอลัมน์ปลายทางมีอยู่แล้ว (เผื่อ ensureImPriceListTable ถูกเรียกก่อน ensureArCustomerTable/
        // ensureApVendorTable ของตัวเอง — ลำดับการเรียกข้ามไฟล์ไม่การันตี)
        await client.query(`ALTER TABLE ar_customer ADD COLUMN IF NOT EXISTS price_list_id INTEGER REFERENCES im_price_list(id)`).catch(() => {});
        await client.query(`ALTER TABLE ap_vendor   ADD COLUMN IF NOT EXISTS price_list_id INTEGER REFERENCES im_price_list(id)`).catch(() => {});
        await client.query(`
            UPDATE ar_customer c SET price_list_id = pl.id
            FROM im_price_list pl
            WHERE pl.customer_id = c.id AND c.price_list_id IS NULL
        `);
        await client.query(`
            UPDATE ap_vendor v SET price_list_id = pl.id
            FROM im_price_list pl
            WHERE pl.vendor_id = v.id AND v.price_list_id IS NULL
        `);
        await client.query(`DROP INDEX IF EXISTS idx_price_list_customer_uq`);
        await client.query(`DROP INDEX IF EXISTS idx_price_list_vendor_uq`);
        await client.query(`ALTER TABLE im_price_list DROP COLUMN IF EXISTS customer_id`);
        await client.query(`ALTER TABLE im_price_list DROP COLUMN IF EXISTS vendor_id`);
    }

    // ป้ายกำกับราคาปกติ/โปรโมชั่น — ไม่กระทบการ resolve (ยังเลือกด้วย effective_from/to ตามเดิม) แค่ให้ UI/รายงาน
    // แยกแยะได้ว่าบรรทัดราคาไหนเป็นราคาปกติ บรรทัดไหนเป็นราคาโปรโมชั่นชั่วคราว
    await client.query(`ALTER TABLE im_price_list_detail ADD COLUMN IF NOT EXISTS price_type VARCHAR(10) NOT NULL DEFAULT 'STANDARD'`).catch(() => {});

    // is_default — ลิสต์ที่ใช้เป็น fallback ของ list_type นั้น ถ้าผู้ขาย/ลูกค้าไม่ได้ถูกตั้งค่าให้ใช้ลิสต์ไหนโดยตรง
    // (ar_customer.price_list_id/ap_vendor.price_list_id เป็น NULL) — **ต้องเป็น flag ชัดเจน ไม่ใช่เดาจาก
    // "ไม่มีผู้ขาย/ลูกค้าผูกอยู่"** เพราะลิสต์ที่ยังไม่มีใครผูก (รอ ar_customer/ap_vendor ชี้มาเอง เช่น WSLG รอ
    // ลูกค้าค้าส่งมาผูก) ก็ไม่ได้แปลว่าเป็นลิสต์กลาง/ค่าเริ่มต้นเสมอไป — เจอบั๊กจริงตอนทดสอบรอบก่อน (RTLG/WSLG
    // ทั้งคู่ไม่มีใครผูกพร้อมกัน แต่ไม่ใช่ทั้งคู่ที่ควรเป็น default)
    await client.query(`ALTER TABLE im_price_list ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false`).catch(() => {});
    await client.query(`DROP INDEX IF EXISTS idx_price_list_central_uq`).catch(() => {});

    // unique index กันความกำกวมตอน resolveItemPrice — ลิสต์ default ได้ใบเดียวต่อ list_type (price_group_id ไม่
    // เกี่ยวเลย — เป็นแค่ป้ายกำกับ ไม่ใช่ targeting; การจับคู่ผู้ขาย/ลูกค้ากับลิสต์เฉพาะทำผ่าน ap_vendor.price_list_id/
    // ar_customer.price_list_id ซึ่งเป็น FK ธรรมดา ไม่ต้องมี unique index ฝั่งนี้)
    await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_price_list_default_uq ON im_price_list(list_type)
        WHERE is_default = true
    `).catch(() => {});
};

const HEADER_SELECT = `
    SELECT h.*,
           c.currency_code AS currency_code, c.currency_name_th AS currency_name_th, c.currency_name_en AS currency_name_en,
           pg.price_group_code AS price_group_code,
           pg.price_group_name_th AS price_group_name_th, pg.price_group_name_en AS price_group_name_en,
           (SELECT COUNT(*) FROM im_price_list_detail d WHERE d.price_list_id = h.id) AS line_count
    FROM im_price_list h
    LEFT JOIN cd_currency   c    ON c.id    = h.currency_id
    LEFT JOIN im_price_group pg  ON pg.id   = h.price_group_id
`;

const DETAIL_SELECT = `
    SELECT d.*,
           i.item_code AS item_code, i.item_name_th AS item_name_th, i.item_name_en AS item_name_en,
           u.uom_code AS uom_code, u.uom_name_th AS uom_name_th, u.uom_name_en AS uom_name_en
    FROM im_price_list_detail d
    LEFT JOIN im_item i ON i.id = d.item_id
    LEFT JOIN im_uom u  ON u.id = d.uom_id
    WHERE d.price_list_id = $1
    ORDER BY d.id
`;

// GET all (headers only, list view)
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceListTable(client);
        const { list_type } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (list_type) { where += ` AND h.list_type = $1`; params.push(list_type); }
        const result = await client.query(`${HEADER_SELECT} ${where} ORDER BY h.price_list_code`, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_price_list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET one (header + detail lines)
const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceListTable(client);
        const header = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        if (header.rows.length === 0) return res.status(404).json({ message: 'ไม่พบตารางราคา' });
        const details = await client.query(DETAIL_SELECT, [id]);
        res.status(200).json({ ...header.rows[0], details: details.rows });
    } catch (error) {
        console.error('Error fetching im_price_list row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET price lines for a given item, across all price lists — used by the Item detail screen
const fetchByItem = async (req, res) => {
    const { itemId } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceListTable(client);
        const result = await client.query(
            `SELECT d.*,
                    h.price_list_code, h.price_list_name, h.list_type,
                    c.currency_code,
                    u.uom_code, u.uom_name_th, u.uom_name_en
             FROM im_price_list_detail d
             JOIN im_price_list h ON h.id = d.price_list_id
             LEFT JOIN cd_currency c ON c.id = h.currency_id
             LEFT JOIN im_uom u ON u.id = d.uom_id
             WHERE d.item_id = $1 AND h.is_active = true
             ORDER BY h.list_type, h.price_list_code, d.min_qty`,
            [itemId]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching price lines by item:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// หาราคาที่ควรใช้สำหรับ item หนึ่งตัว — ลำดับความเจาะจง: (1) ลิสต์ที่ผู้ขาย/ลูกค้ารายนี้ถูกกำหนดให้ใช้โดยตรง
// (ap_vendor.price_list_id/ar_customer.price_list_id — ผู้ขาย/ลูกค้าแต่ละรายใช้ได้รหัสเดียวเท่านั้น) (2) ลิสต์
// default ของ list_type นั้น (is_default=true) — เลือกได้อย่างมากหนึ่งลิสต์ต่อชั้นเสมอ (ชั้น 1 เพราะ FK ชี้ตรง,
// ชั้น 2 การันตีด้วย partial unique index ใน ensureImPriceListTable) จากนั้นในลิสต์ที่เลือกได้ หา min_qty ที่
// สูงสุดที่ไม่เกิน qty ที่ขอ, uom_id ตรงกับที่ระบุ (บรรทัดที่ uom_id เป็น NULL ถือว่าใช้ได้ทุกหน่วยนับ แต่บรรทัดที่
// uom_id ตรงเป๊ะมาก่อนเสมอถ้ามีให้เลือก), และ effective_from/to ครอบคลุม docDate — คืน null ถ้าไม่พบเลย (ผู้เรียก
// ต้องรองรับการกรอกราคาเองได้เสมอ ไม่ใช่ error) เรียกจากทั้งหน้าจอ PO (list_type='PURCHASE', vendorId) และ SO/Quote
// (list_type='SALES', customerId)
const resolveItemPrice = async (client, { itemId, listType, vendorId, customerId, uomId, qty, docDate }) => {
    const partyTable = listType === 'PURCHASE' ? 'ap_vendor' : 'ar_customer';
    const partyId = listType === 'PURCHASE' ? vendorId : customerId;
    const date = docDate || new Date().toISOString().slice(0, 10);
    const q = Number(qty) || 0;

    let priceListId = null;
    if (partyId) {
        const assignedRes = await client.query(`
            SELECT pl.id
            FROM ${partyTable} p
            JOIN im_price_list pl ON pl.id = p.price_list_id
            WHERE p.id = $1 AND pl.is_active = true AND pl.list_type = $2
        `, [partyId, listType]);
        priceListId = assignedRes.rows[0]?.id || null;
    }
    if (!priceListId) {
        const defaultRes = await client.query(`
            SELECT id FROM im_price_list WHERE list_type = $1 AND is_active = true AND is_default = true LIMIT 1
        `, [listType]);
        priceListId = defaultRes.rows[0]?.id || null;
    }
    if (!priceListId) return null;

    const detailRes = await client.query(`
        SELECT unit_price_fc, uom_id, min_qty
        FROM im_price_list_detail
        WHERE price_list_id = $1 AND item_id = $2 AND min_qty <= $3
          AND (uom_id = $4 OR uom_id IS NULL OR $4::int IS NULL)
          AND (effective_from IS NULL OR effective_from <= $5::date)
          AND (effective_to   IS NULL OR effective_to   >= $5::date)
        ORDER BY (uom_id IS NULL) ASC, min_qty DESC
        LIMIT 1
    `, [priceListId, itemId, q, uomId || null, date]);
    if (detailRes.rows.length === 0) return null;
    return { price_list_id: priceListId, unit_price_fc: Number(detailRes.rows[0].unit_price_fc), uom_id: detailRes.rows[0].uom_id };
};

// GET /im_price_list/resolve_price?item_id=&list_type=PURCHASE|SALES&vendor_id=&customer_id=&uom_id=&qty=&doc_date=
const resolvePriceHandler = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceListTable(client);
        const { item_id, list_type, vendor_id, customer_id, uom_id, qty, doc_date } = req.query;
        if (!item_id || !list_type) return res.status(400).json({ message: 'กรุณาระบุ item_id และ list_type' });
        const result = await resolveItemPrice(client, {
            itemId: item_id, listType: list_type, vendorId: vendor_id || null, customerId: customer_id || null,
            uomId: uom_id || null, qty: qty || 0, docDate: doc_date || null,
        });
        res.status(200).json(result || {});
    } catch (error) {
        console.error('Error resolving item price:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const validateDetails = (details) => {
    if (!Array.isArray(details) || details.length === 0) return 'กรุณาระบุรายการราคาอย่างน้อย 1 รายการ';
    for (const line of details) {
        if (!line.item_id) return 'กรุณาระบุสินค้าในทุกรายการ';
    }
    return null;
};

// resolveItemPrice เลือกบรรทัดด้วย (price_list_id, item_id, min_qty) — ไม่สนใจ uom_id เลย ดังนั้นสองบรรทัดที่
// item_id/min_qty เดียวกันแล้วช่วง effective_from/to คาบเกี่ยวกัน จะทำให้ผลลัพธ์ไม่แน่นอน (ORDER BY min_qty DESC
// LIMIT 1 ไม่การันตีว่าจะได้บรรทัดที่ตั้งใจ) ตรวจก่อนบันทึกเสมอ — เทียบเฉพาะภายใน details ที่ส่งมาในคำขอเดียวกัน
// เพราะ details ที่ส่งมาคือ "สถานะที่ต้องการทั้งหมด" ของตารางราคานี้อยู่แล้ว (ทั้ง addRow และ updateRow แบบ diff)
const rangesOverlap = (aFrom, aTo, bFrom, bTo) => {
    const aStart = aFrom || '0001-01-01';
    const aEnd = aTo || '9999-12-31';
    const bStart = bFrom || '0001-01-01';
    const bEnd = bTo || '9999-12-31';
    return aStart <= bEnd && bStart <= aEnd;
};

const findOverlappingPair = (details) => {
    for (let i = 0; i < details.length; i++) {
        for (let j = i + 1; j < details.length; j++) {
            const a = details[i], b = details[j];
            if (a.item_id === b.item_id && Number(a.min_qty ?? 0) === Number(b.min_qty ?? 0)) {
                if (rangesOverlap(a.effective_from, a.effective_to, b.effective_from, b.effective_to)) {
                    return [a, b];
                }
            }
        }
    }
    return null;
};

// error.code 23505 (unique violation) เกิดได้จากหลาย constraint ในตารางนี้ (price_list_code เดิม + ลิสต์ default
// ได้ใบเดียวต่อ list_type) — ต้องแยกตาม error.constraint ไม่งั้นข้อความจะโกหกผู้ใช้ (เช่น ชน unique index
// "ลิสต์กลางได้ใบเดียว" แต่ขึ้นข้อความว่า "รหัสตารางราคาซ้ำ" ซึ่งไม่จริงเลย)
const UNIQUE_VIOLATION_MESSAGES = {
    im_price_list_price_list_code_key: (b) => `รหัสตารางราคา '${b.price_list_code}' มีอยู่แล้ว`,
    idx_price_list_default_uq: () => 'มีตารางราคาที่ตั้งเป็นค่าเริ่มต้นสำหรับประเภทนี้อยู่แล้ว (ตั้งเป็นค่าเริ่มต้นได้ใบเดียวต่อประเภท SALES/PURCHASE — ยกเลิกค่าเริ่มต้นของใบเดิมก่อน)',
};

const uniqueViolationMessage = (error, b) => {
    const mapper = UNIQUE_VIOLATION_MESSAGES[error.constraint];
    return mapper ? mapper(b) : 'ข้อมูลซ้ำกับที่มีอยู่แล้ว';
};

const checkOverlap = async (client, details) => {
    const pair = findOverlappingPair(details);
    if (!pair) return null;
    const itemRes = await client.query(`SELECT item_code FROM im_item WHERE id = $1`, [pair[0].item_id]);
    const itemCode = itemRes.rows[0]?.item_code || pair[0].item_id;
    return `ช่วงวันที่มีผลของสินค้า '${itemCode}' (จำนวนขั้นต่ำ ${Number(pair[0].min_qty ?? 0)}) มีสองรายการที่ช่วงวันคาบเกี่ยวกัน กรุณาแก้ช่วงวันที่ไม่ให้ทับซ้อนก่อนบันทึก`;
};

const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const b = req.body;
    const userName = req.headers.username || null;
    try {
        await client.query('BEGIN');
        await ensureImPriceListTable(client);

        if (!b.price_list_code || !b.price_list_name) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'กรุณาระบุรหัสและชื่อตารางราคา' });
        }
        if (b.list_type && !LIST_TYPES.includes(b.list_type)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `list_type ต้องเป็นหนึ่งใน ${LIST_TYPES.join(', ')}` });
        }
        const detailErr = validateDetails(b.details || []);
        if (detailErr) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: detailErr });
        }
        const overlapErr = await checkOverlap(client, b.details || []);
        if (overlapErr) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: overlapErr });
        }

        const header = await client.query(
            `INSERT INTO im_price_list
                (price_list_code, price_list_name, list_type, currency_id,
                 price_group_id, is_default, is_active, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
             RETURNING id`,
            [
                b.price_list_code.trim().toUpperCase(), b.price_list_name.trim(),
                b.list_type || 'SALES', b.currency_id || null,
                b.price_group_id || null, b.is_default ?? false,
                b.is_active ?? true, userName,
            ]
        );
        const headerId = header.rows[0].id;

        for (const line of (b.details || [])) {
            await client.query(
                `INSERT INTO im_price_list_detail
                    (price_list_id, item_id, uom_id, min_qty, unit_price_fc, price_type, effective_from, effective_to, created_by, updated_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
                [headerId, line.item_id, line.uom_id || null, line.min_qty ?? 0, line.unit_price_fc ?? 0,
                 line.price_type || 'STANDARD', line.effective_from || null, line.effective_to || null, userName]
            );
        }

        await client.query('COMMIT');
        const newHeader = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [headerId]);
        const newDetails = await client.query(DETAIL_SELECT, [headerId]);
        res.status(201).json({ ...newHeader.rows[0], details: newDetails.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') return res.status(409).json({ message: uniqueViolationMessage(error, b) });
        console.error('Error adding im_price_list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const b = req.body;
    const userName = req.headers.username || null;
    try {
        await client.query('BEGIN');
        await ensureImPriceListTable(client);

        if (b.list_type && !LIST_TYPES.includes(b.list_type)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `list_type ต้องเป็นหนึ่งใน ${LIST_TYPES.join(', ')}` });
        }
        const detailErr = validateDetails(b.details || []);
        if (detailErr) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: detailErr });
        }
        const overlapErr = await checkOverlap(client, b.details || []);
        if (overlapErr) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: overlapErr });
        }

        const result = await client.query(
            `UPDATE im_price_list SET
                price_list_name = $1,
                list_type       = $2,
                currency_id     = $3,
                price_group_id  = $4,
                is_default      = $5,
                is_active       = $6,
                updated_by      = $7,
                updated_at      = NOW()
             WHERE id = $8
             RETURNING id`,
            [b.price_list_name || '', b.list_type || 'SALES', b.currency_id || null,
             b.price_group_id || null, b.is_default ?? false,
             b.is_active ?? true, userName, id]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'ไม่พบตารางราคา' });
        }

        // แก้ไขบรรทัดแบบ diff (UPDATE ของเดิม / INSERT ใหม่ / DELETE ที่ถูกลบ) แทน delete-all-then-reinsert เดิม —
        // เพื่อรักษา updated_by/updated_at ต่อบรรทัดไว้เป็น audit trail จริง (บรรทัดที่ id ไม่เปลี่ยนแต่ค่าเปลี่ยน
        // จะเห็นว่าใครแก้ล่าสุดเมื่อไหร่ ไม่ใช่ทุกบรรทัดโดนเขียนทับเป็น "ตอนนี้" หมดทุกครั้งที่กดบันทึก)
        const existingIdsRes = await client.query(`SELECT id FROM im_price_list_detail WHERE price_list_id = $1`, [id]);
        const existingIds = new Set(existingIdsRes.rows.map(r => r.id));
        const incomingIds = new Set((b.details || []).filter(d => d.id).map(d => d.id));
        const removedIds = [...existingIds].filter(x => !incomingIds.has(x));

        if (removedIds.length > 0) {
            await client.query(`DELETE FROM im_price_list_detail WHERE id = ANY($1::int[])`, [removedIds]);
        }
        for (const line of (b.details || [])) {
            if (line.id && existingIds.has(line.id)) {
                await client.query(
                    `UPDATE im_price_list_detail SET
                        item_id = $1, uom_id = $2, min_qty = $3, unit_price_fc = $4, price_type = $5,
                        effective_from = $6, effective_to = $7, updated_by = $8, updated_at = NOW()
                     WHERE id = $9`,
                    [line.item_id, line.uom_id || null, line.min_qty ?? 0, line.unit_price_fc ?? 0, line.price_type || 'STANDARD',
                     line.effective_from || null, line.effective_to || null, userName, line.id]
                );
            } else {
                await client.query(
                    `INSERT INTO im_price_list_detail
                        (price_list_id, item_id, uom_id, min_qty, unit_price_fc, price_type, effective_from, effective_to, created_by, updated_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
                    [id, line.item_id, line.uom_id || null, line.min_qty ?? 0, line.unit_price_fc ?? 0,
                     line.price_type || 'STANDARD', line.effective_from || null, line.effective_to || null, userName]
                );
            }
        }

        await client.query('COMMIT');
        const updatedHeader = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        const updatedDetails = await client.query(DETAIL_SELECT, [id]);
        res.status(200).json({ ...updatedHeader.rows[0], details: updatedDetails.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') return res.status(409).json({ message: uniqueViolationMessage(error, b) });
        console.error('Error updating im_price_list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceListTable(client);
        const result = await client.query(`DELETE FROM im_price_list WHERE id = $1 RETURNING id`, [id]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'ไม่พบตารางราคา' });
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting im_price_list:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = {
    ensureImPriceListTable, fetchRows, fetchRow, fetchByItem, addRow, updateRow, deleteRow, LIST_TYPES,
    resolveItemPrice, resolvePriceHandler,
};
