// controllers/im/imPriceChangeController.js
// ธุรกรรมเปลี่ยนแปลงราคา (im_price_change_header/detail) — พักรายการปรับราคาจำนวนมากไว้ตรวจสอบก่อนมีผลจริง
// สถานะ: Draft (แก้ไขได้) -> Pending (ส่งขออนุมัติ, ล็อกแก้ไข) -> Approved (เขียนผลจริงลง im_price_list_detail)
//                                                              -> Draft (ไม่อนุมัติ, กลับไปแก้ไขใหม่)
// Draft/Pending -> Void (ยกเลิกทั้งใบ, ทำได้ก่อน Approved เท่านั้น — หลัง Approved ต้องสร้างธุรกรรมใหม่มาหักกลับ)
'use strict';

const { ensureImPriceListTable, findOverlapAgainstExisting } = require('./imPriceListController');
const { ensureImItemCategoryTable } = require('./imItemCategoryController');
// เลขที่เอกสารมาจากระบบประเภทเอกสาร (sa_module_document) เดียวกับธุรกรรม IM ปกติ (GRN/DLN/AJS ฯลฯ) — ไม่ใช่ตาราง
// running number แยกของตัวเอง ผู้ใช้เลือก "ประเภทเอกสาร" (doc_id, sys_doc_type='85') ตอนสร้างธุรกรรม แล้วเลขที่/การ
// ตั้งค่าเลขที่อัตโนมัติมาจาก config ของ doc_id นั้นโดยตรง (จัดการผ่านหน้าจอ sa_module_document ของ SA เหมือน GRN/DLN)
const { generateDocNo } = require('./imTransactionController');

const CHANGE_TYPES = ['REVISE', 'PROMOTION'];
const ADJUSTMENT_MODES = ['PERCENT', 'AMOUNT', 'SET_PRICE'];

const ensureImPriceChangeTable = async (client) => {
    // อ้าง im_price_list(id) และ im_item/im_uom (ผ่าน detail) ต้องมีก่อน
    await ensureImPriceListTable(client);
    await ensureImItemCategoryTable(client);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_price_change_header (
            id                    SERIAL PRIMARY KEY,
            doc_id                INTEGER REFERENCES sa_module_document(id),
            doc_code              VARCHAR(20),
            change_no             VARCHAR(30) UNIQUE,
            price_list_id         INTEGER NOT NULL REFERENCES im_price_list(id),
            change_type           VARCHAR(10) NOT NULL DEFAULT 'REVISE',
            adjustment_mode       VARCHAR(10) NOT NULL DEFAULT 'PERCENT',
            adjustment_direction  VARCHAR(10) NOT NULL DEFAULT 'INCREASE',
            adjustment_value      NUMERIC(18,4) NOT NULL DEFAULT 0,
            rounding_step         NUMERIC(18,4) NOT NULL DEFAULT 0,
            effective_from        DATE,
            effective_to          DATE,
            category_filter       JSONB,
            item_code_from        VARCHAR(50),
            item_code_to          VARCHAR(50),
            status                VARCHAR(20) NOT NULL DEFAULT 'Draft',
            remark                TEXT,
            approved_at           TIMESTAMPTZ,
            approved_by           VARCHAR(100),
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by            VARCHAR(100),
            updated_by            VARCHAR(100)
        )
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_price_change_detail (
            id                    SERIAL PRIMARY KEY,
            header_id             INTEGER NOT NULL REFERENCES im_price_change_header(id) ON DELETE CASCADE,
            item_id               INTEGER NOT NULL REFERENCES im_item(id),
            uom_id                INTEGER REFERENCES im_uom(id),
            min_qty               NUMERIC(18,4) NOT NULL DEFAULT 0,
            source_detail_id      INTEGER REFERENCES im_price_list_detail(id),
            old_unit_price_fc     NUMERIC(18,4),
            new_unit_price_fc     NUMERIC(18,4) NOT NULL DEFAULT 0,
            is_selected           BOOLEAN NOT NULL DEFAULT true
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_im_price_change_detail_header ON im_price_change_detail(header_id)`);
    // ปัดเศษราคาใหม่ที่คำนวณจาก % ให้สอดคล้องกับเงินจริง (0 = ไม่ปัดเศษ) — รองรับ DB เดิมที่สร้างตารางนี้ไปแล้วก่อนเพิ่มคอลัมน์นี้
    await client.query(`ALTER TABLE im_price_change_header ADD COLUMN IF NOT EXISTS rounding_step NUMERIC(18,4) NOT NULL DEFAULT 0`).catch(() => {});
    // ประเภทเอกสาร (doc_id/doc_code) — รองรับ DB เดิมที่สร้างตารางนี้ไปแล้วก่อนเพิ่มคอลัมน์นี้ (ตอนแรกใช้ตาราง
    // running number แยกของตัวเอง ภายหลังเปลี่ยนมาใช้ระบบประเภทเอกสารเดียวกับธุรกรรม IM ปกติ)
    await client.query(`ALTER TABLE im_price_change_header ADD COLUMN IF NOT EXISTS doc_id INTEGER REFERENCES sa_module_document(id)`).catch(() => {});
    await client.query(`ALTER TABLE im_price_change_header ADD COLUMN IF NOT EXISTS doc_code VARCHAR(20)`).catch(() => {});
    // trace ย้อนได้ว่าแถวราคานี้ใน im_price_list_detail เกิดจากธุรกรรมเปลี่ยนแปลงราคาใบไหน — เพิ่มที่นี่ (ไม่ใช่ใน
    // ensureImPriceListTable) เพราะ im_price_change_header ต้องถูกสร้างก่อนจึงอ้าง FK ได้ ไม่งั้นเกิด circular
    // ensure-table dependency ระหว่างสองไฟล์
    await client.query(`ALTER TABLE im_price_list_detail ADD COLUMN IF NOT EXISTS source_price_change_id INTEGER REFERENCES im_price_change_header(id)`).catch(() => {});
};

const HEADER_SELECT = `
    SELECT h.*,
           pl.price_list_code, pl.price_list_name, pl.list_type,
           md.doc_name_thai, md.doc_name_eng,
           (SELECT COUNT(*) FROM im_price_change_detail d WHERE d.header_id = h.id) AS line_count,
           (SELECT COUNT(*) FROM im_price_change_detail d WHERE d.header_id = h.id AND d.is_selected = true) AS selected_count
    FROM im_price_change_header h
    LEFT JOIN im_price_list pl ON pl.id = h.price_list_id
    LEFT JOIN sa_module_document md ON md.id = h.doc_id
`;

const DETAIL_SELECT = `
    SELECT d.*,
           i.item_code, i.item_name_th, i.item_name_en, i.category_id,
           c.category_code, c.category_name_th, c.category_name_en,
           u.uom_code, u.uom_name_th, u.uom_name_en
    FROM im_price_change_detail d
    LEFT JOIN im_item i ON i.id = d.item_id
    LEFT JOIN im_item_category c ON c.id = i.category_id
    LEFT JOIN im_uom u ON u.id = d.uom_id
    WHERE d.header_id = $1
    ORDER BY i.item_code, d.min_qty
`;

// GET /im_price_change?status=&price_list_id=
const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceChangeTable(client);
        const { status, price_list_id } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (status) { params.push(status); where += ` AND h.status = $${params.length}`; }
        if (price_list_id) { params.push(price_list_id); where += ` AND h.price_list_id = $${params.length}`; }
        const result = await client.query(`${HEADER_SELECT} ${where} ORDER BY h.id DESC`, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching im_price_change:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET /im_price_change/:id
const fetchRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceChangeTable(client);
        const header = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        if (header.rows.length === 0) return res.status(404).json({ message: 'ไม่พบธุรกรรมเปลี่ยนแปลงราคา' });
        const details = await client.query(DETAIL_SELECT, [id]);
        res.status(200).json({ ...header.rows[0], details: details.rows });
    } catch (error) {
        console.error('Error fetching im_price_change row:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET /im_price_change/preview_lines?price_list_id=&category_ids=&item_code_from=&item_code_to=
// อ่านอย่างเดียว — ดึงรายชื่อสินค้าตามเงื่อนไขกรอง พร้อมราคาปัจจุบัน (STANDARD, มีผล ณ วันนี้) ในตารางราคาเป้าหมาย
// ถ้าสินค้ายังไม่มีราคาในลิสต์นี้เลย source_detail_id จะเป็น null (ฝั่ง frontend ต้องบังคับกรอกราคาเอง ใช้ % ไม่ได้)
const previewLines = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImPriceChangeTable(client);
        const { price_list_id, category_ids, item_code_from, item_code_to } = req.query;
        if (!price_list_id) return res.status(400).json({ message: 'กรุณาระบุตารางราคาเป้าหมาย' });

        let itemFilter = 'WHERE i.is_active = true';
        const params = [price_list_id];
        if (category_ids) {
            const ids = String(category_ids).split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
            if (ids.length > 0) { params.push(ids); itemFilter += ` AND i.category_id = ANY($${params.length}::int[])`; }
        }
        if (item_code_from) { params.push(item_code_from); itemFilter += ` AND i.item_code >= $${params.length}`; }
        if (item_code_to)   { params.push(item_code_to);   itemFilter += ` AND i.item_code <= $${params.length}`; }

        const result = await client.query(`
            SELECT i.id AS item_id, i.item_code, i.item_name_th, i.item_name_en, i.category_id,
                   c.category_code, c.category_name_th, c.category_name_en,
                   d.id AS source_detail_id, COALESCE(d.uom_id, i.base_uom_id) AS uom_id,
                   COALESCE(d.min_qty, 0) AS min_qty, d.unit_price_fc AS old_unit_price_fc,
                   u.uom_code, u.uom_name_th, u.uom_name_en
            FROM im_item i
            LEFT JOIN im_item_category c ON c.id = i.category_id
            LEFT JOIN im_price_list_detail d ON d.item_id = i.id AND d.price_list_id = $1 AND d.price_type = 'STANDARD'
                AND (d.effective_from IS NULL OR d.effective_from <= CURRENT_DATE)
                AND (d.effective_to   IS NULL OR d.effective_to   >= CURRENT_DATE)
            LEFT JOIN im_uom u ON u.id = COALESCE(d.uom_id, i.base_uom_id)
            ${itemFilter}
            ORDER BY i.item_code, d.min_qty
        `, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error generating im_price_change preview lines:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const validateHeader = (b) => {
    if (!b.doc_id) return 'กรุณาเลือกประเภทเอกสาร';
    if (!b.price_list_id) return 'กรุณาเลือกตารางราคาเป้าหมาย';
    if (b.change_type && !CHANGE_TYPES.includes(b.change_type)) return `change_type ต้องเป็นหนึ่งใน ${CHANGE_TYPES.join(', ')}`;
    if (b.adjustment_mode && !ADJUSTMENT_MODES.includes(b.adjustment_mode)) return `adjustment_mode ต้องเป็นหนึ่งใน ${ADJUSTMENT_MODES.join(', ')}`;
    if (!b.effective_from) return 'กรุณาระบุวันที่มีผล';
    if ((b.change_type || 'REVISE') === 'PROMOTION' && !b.effective_to) return 'ธุรกรรมแบบโปรโมชั่นต้องระบุวันที่สิ้นสุดด้วย';
    return null;
};

const validateDetails = (details) => {
    if (!Array.isArray(details) || details.length === 0) return 'กรุณาดึงข้อมูลสินค้าอย่างน้อย 1 รายการ';
    for (const line of details) {
        if (!line.item_id) return 'พบรายการที่ไม่มีรหัสสินค้า';
    }
    return null;
};

// POST /im_price_change — บันทึก Draft
const addRow = async (req, res) => {
    const client = await req.dbPool.connect();
    const b = req.body;
    const userName = req.headers.username || null;
    try {
        await client.query('BEGIN');
        await ensureImPriceChangeTable(client);

        const headerErr = validateHeader(b);
        if (headerErr) { await client.query('ROLLBACK'); return res.status(400).json({ message: headerErr }); }
        const detailErr = validateDetails(b.details || []);
        if (detailErr) { await client.query('ROLLBACK'); return res.status(400).json({ message: detailErr }); }

        const docRes = await client.query(`SELECT doc_code FROM sa_module_document WHERE id = $1 AND is_active = true`, [b.doc_id]);
        if (docRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ไม่พบประเภทเอกสารที่เลือก' });
        }
        const docCode = docRes.rows[0].doc_code;

        // รองรับเลขที่ด้วยมือเหมือนธุรกรรม IM ปกติ ('AUTO'/ว่าง = ให้ระบบออกเลขที่จาก config ของ doc_id นี้)
        let changeNo = (b.doc_no && b.doc_no !== 'AUTO') ? b.doc_no : null;
        if (!changeNo) {
            changeNo = await generateDocNo(client, b.doc_id, b.effective_from, null);
            if (!changeNo) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'ไม่สามารถออกเลขที่เอกสารอัตโนมัติได้ กรุณาตรวจสอบการตั้งค่าเลขที่อัตโนมัติของประเภทเอกสารนี้ (เมนูประเภทเอกสาร)' });
            }
        }
        const header = await client.query(
            `INSERT INTO im_price_change_header
                (doc_id, doc_code, change_no, price_list_id, change_type, adjustment_mode, adjustment_direction,
                 adjustment_value, rounding_step, effective_from, effective_to, category_filter, item_code_from,
                 item_code_to, status, remark, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Draft',$15,$16,$16)
             RETURNING id`,
            [b.doc_id, docCode, changeNo, b.price_list_id, b.change_type || 'REVISE', b.adjustment_mode || 'PERCENT',
             b.adjustment_direction || 'INCREASE', b.adjustment_value ?? 0, b.rounding_step ?? 0,
             b.effective_from, b.effective_to || null,
             b.category_filter ? JSON.stringify(b.category_filter) : null,
             b.item_code_from || null, b.item_code_to || null, b.remark || null, userName]
        );
        const headerId = header.rows[0].id;

        for (const line of (b.details || [])) {
            await client.query(
                `INSERT INTO im_price_change_detail
                    (header_id, item_id, uom_id, min_qty, source_detail_id, old_unit_price_fc, new_unit_price_fc, is_selected)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [headerId, line.item_id, line.uom_id || null, line.min_qty ?? 0, line.source_detail_id || null,
                 line.old_unit_price_fc ?? null, line.new_unit_price_fc ?? 0, line.is_selected ?? true]
            );
        }

        await client.query('COMMIT');
        const newHeader = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [headerId]);
        const newDetails = await client.query(DETAIL_SELECT, [headerId]);
        res.status(201).json({ ...newHeader.rows[0], details: newDetails.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') return res.status(409).json({ message: 'เลขที่ธุรกรรมซ้ำกับที่มีอยู่แล้ว' });
        console.error('Error adding im_price_change:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// PUT /im_price_change/:id — แก้ไขได้เฉพาะสถานะ Draft
const updateHeader = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    const b = req.body;
    const userName = req.headers.username || null;
    try {
        await client.query('BEGIN');
        await ensureImPriceChangeTable(client);

        const cur = await client.query(`SELECT status FROM im_price_change_header WHERE id = $1 FOR UPDATE`, [id]);
        if (cur.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบธุรกรรมเปลี่ยนแปลงราคา' }); }
        if (cur.rows[0].status !== 'Draft') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'แก้ไขได้เฉพาะธุรกรรมที่ยังเป็นสถานะ Draft เท่านั้น' });
        }

        const headerErr = validateHeader(b);
        if (headerErr) { await client.query('ROLLBACK'); return res.status(400).json({ message: headerErr }); }
        const detailErr = validateDetails(b.details || []);
        if (detailErr) { await client.query('ROLLBACK'); return res.status(400).json({ message: detailErr }); }

        await client.query(
            `UPDATE im_price_change_header SET
                price_list_id = $1, change_type = $2, adjustment_mode = $3, adjustment_direction = $4,
                adjustment_value = $5, rounding_step = $6, effective_from = $7, effective_to = $8, category_filter = $9,
                item_code_from = $10, item_code_to = $11, remark = $12, updated_by = $13, updated_at = NOW()
             WHERE id = $14`,
            [b.price_list_id, b.change_type || 'REVISE', b.adjustment_mode || 'PERCENT', b.adjustment_direction || 'INCREASE',
             b.adjustment_value ?? 0, b.rounding_step ?? 0, b.effective_from, b.effective_to || null,
             b.category_filter ? JSON.stringify(b.category_filter) : null,
             b.item_code_from || null, b.item_code_to || null, b.remark || null, userName, id]
        );

        // diff-based update ของ detail (เหมือน im_price_list_detail) — จับคู่ด้วย id, ลบที่หายไป, แก้ที่เหลือ, เพิ่มใหม่
        const existingIdsRes = await client.query(`SELECT id FROM im_price_change_detail WHERE header_id = $1`, [id]);
        const existingIds = new Set(existingIdsRes.rows.map((r) => r.id));
        const incomingIds = new Set((b.details || []).filter((d) => d.id).map((d) => d.id));
        const removedIds = [...existingIds].filter((x) => !incomingIds.has(x));
        if (removedIds.length > 0) {
            await client.query(`DELETE FROM im_price_change_detail WHERE id = ANY($1::int[])`, [removedIds]);
        }
        for (const line of (b.details || [])) {
            if (line.id && existingIds.has(line.id)) {
                await client.query(
                    `UPDATE im_price_change_detail SET
                        item_id = $1, uom_id = $2, min_qty = $3, source_detail_id = $4,
                        old_unit_price_fc = $5, new_unit_price_fc = $6, is_selected = $7
                     WHERE id = $8`,
                    [line.item_id, line.uom_id || null, line.min_qty ?? 0, line.source_detail_id || null,
                     line.old_unit_price_fc ?? null, line.new_unit_price_fc ?? 0, line.is_selected ?? true, line.id]
                );
            } else {
                await client.query(
                    `INSERT INTO im_price_change_detail
                        (header_id, item_id, uom_id, min_qty, source_detail_id, old_unit_price_fc, new_unit_price_fc, is_selected)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [id, line.item_id, line.uom_id || null, line.min_qty ?? 0, line.source_detail_id || null,
                     line.old_unit_price_fc ?? null, line.new_unit_price_fc ?? 0, line.is_selected ?? true]
                );
            }
        }

        await client.query('COMMIT');
        const updatedHeader = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        const updatedDetails = await client.query(DETAIL_SELECT, [id]);
        res.status(200).json({ ...updatedHeader.rows[0], details: updatedDetails.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating im_price_change:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// PUT /im_price_change/:id/submit — Draft -> Pending
const submitChange = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureImPriceChangeTable(client);
        const cur = await client.query(`SELECT status FROM im_price_change_header WHERE id = $1 FOR UPDATE`, [id]);
        if (cur.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบธุรกรรมเปลี่ยนแปลงราคา' }); }
        if (cur.rows[0].status !== 'Draft') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ส่งขออนุมัติได้เฉพาะธุรกรรมที่เป็นสถานะ Draft เท่านั้น' });
        }
        const selectedRes = await client.query(`SELECT COUNT(*) AS c FROM im_price_change_detail WHERE header_id = $1 AND is_selected = true`, [id]);
        if (Number(selectedRes.rows[0].c) === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'กรุณาเลือกรายการที่จะปรับราคาอย่างน้อย 1 รายการ' });
        }
        await client.query(`UPDATE im_price_change_header SET status = 'Pending', updated_by = $1, updated_at = NOW() WHERE id = $2`, [userName, id]);
        await client.query('COMMIT');
        const full = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        res.status(200).json(full.rows[0]);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error submitting im_price_change:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// PUT /im_price_change/:id/reject — Pending -> Draft (ไม่อนุมัติ, กลับไปแก้ไขใหม่)
const rejectChange = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureImPriceChangeTable(client);
        const cur = await client.query(`SELECT status FROM im_price_change_header WHERE id = $1 FOR UPDATE`, [id]);
        if (cur.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบธุรกรรมเปลี่ยนแปลงราคา' }); }
        if (cur.rows[0].status !== 'Pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ไม่อนุมัติได้เฉพาะธุรกรรมที่เป็นสถานะ Pending เท่านั้น' });
        }
        await client.query(`UPDATE im_price_change_header SET status = 'Draft', updated_by = $1, updated_at = NOW() WHERE id = $2`, [userName, id]);
        await client.query('COMMIT');
        const full = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        res.status(200).json(full.rows[0]);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error rejecting im_price_change:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// PUT /im_price_change/:id/void — Draft/Pending -> Void
const voidChange = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureImPriceChangeTable(client);
        const cur = await client.query(`SELECT status FROM im_price_change_header WHERE id = $1 FOR UPDATE`, [id]);
        if (cur.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบธุรกรรมเปลี่ยนแปลงราคา' }); }
        if (!['Draft', 'Pending'].includes(cur.rows[0].status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'ยกเลิกได้เฉพาะธุรกรรมที่ยังไม่อนุมัติเท่านั้น' });
        }
        await client.query(`UPDATE im_price_change_header SET status = 'Void', updated_by = $1, updated_at = NOW() WHERE id = $2`, [userName, id]);
        await client.query('COMMIT');
        const full = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        res.status(200).json(full.rows[0]);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error voiding im_price_change:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// PUT /im_price_change/:id/approve — Pending -> Approved, เขียนผลจริงลง im_price_list_detail
// REVISE: ปิด effective_to ของ source_detail_id (ถ้ามี) ที่วันก่อนวันมีผลใหม่ 1 วัน แล้ว insert แถว STANDARD ใหม่
// PROMOTION: insert แถว PROMOTION ใหม่คู่ขนาน ไม่แก้ไขแถว STANDARD เดิมเลย
const approveChange = async (req, res) => {
    const { id } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureImPriceChangeTable(client);
        const headerRes = await client.query(`SELECT * FROM im_price_change_header WHERE id = $1 FOR UPDATE`, [id]);
        if (headerRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'ไม่พบธุรกรรมเปลี่ยนแปลงราคา' }); }
        const header = headerRes.rows[0];
        if (header.status !== 'Pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'อนุมัติได้เฉพาะธุรกรรมที่เป็นสถานะ Pending เท่านั้น' });
        }

        const detailsRes = await client.query(
            `SELECT * FROM im_price_change_detail WHERE header_id = $1 AND is_selected = true`,
            [id]
        );
        const targetPriceType = header.change_type === 'PROMOTION' ? 'PROMOTION' : 'STANDARD';

        for (const line of detailsRes.rows) {
            if (header.change_type === 'REVISE' && line.source_detail_id) {
                const srcRes = await client.query(`SELECT effective_from FROM im_price_list_detail WHERE id = $1`, [line.source_detail_id]);
                const srcFrom = srcRes.rows[0]?.effective_from || null;
                if (srcFrom && new Date(header.effective_from) <= new Date(srcFrom)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: `สินค้ารหัส item_id=${line.item_id}: วันที่มีผลใหม่ต้องมากกว่าวันที่เริ่มราคาเดิม` });
                }
                const closeTo = new Date(header.effective_from);
                closeTo.setDate(closeTo.getDate() - 1);
                await client.query(
                    `UPDATE im_price_list_detail SET effective_to = $1, updated_by = $2, updated_at = NOW() WHERE id = $3`,
                    [closeTo.toISOString().slice(0, 10), userName, line.source_detail_id]
                );
            }

            const hasOverlap = await findOverlapAgainstExisting(client, {
                priceListId: header.price_list_id, itemId: line.item_id, uomId: line.uom_id, minQty: line.min_qty,
                priceType: targetPriceType, effectiveFrom: header.effective_from, effectiveTo: header.effective_to,
                excludeDetailId: null,
            });
            if (hasOverlap) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: `สินค้ารหัส item_id=${line.item_id}: ช่วงวันที่มีผลคาบเกี่ยวกับราคา ${targetPriceType === 'PROMOTION' ? 'โปรโมชั่น' : 'ปกติ'} ที่มีอยู่แล้ว` });
            }

            await client.query(
                `INSERT INTO im_price_list_detail
                    (price_list_id, item_id, uom_id, min_qty, unit_price_fc, price_type, effective_from, effective_to,
                     source_price_change_id, created_by, updated_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
                [header.price_list_id, line.item_id, line.uom_id, line.min_qty, line.new_unit_price_fc,
                 targetPriceType, header.effective_from, header.change_type === 'PROMOTION' ? header.effective_to : null,
                 header.id, userName]
            );
        }

        await client.query(
            `UPDATE im_price_change_header SET status = 'Approved', approved_at = NOW(), approved_by = $1, updated_by = $1, updated_at = NOW() WHERE id = $2`,
            [userName, id]
        );
        await client.query('COMMIT');
        const full = await client.query(`${HEADER_SELECT} WHERE h.id = $1`, [id]);
        const fullDetails = await client.query(DETAIL_SELECT, [id]);
        res.status(200).json({ ...full.rows[0], details: fullDetails.rows });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error approving im_price_change:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = {
    ensureImPriceChangeTable, fetchRows, fetchRow, previewLines, addRow, updateHeader,
    submitChange, rejectChange, voidChange, approveChange, CHANGE_TYPES, ADJUSTMENT_MODES,
};
