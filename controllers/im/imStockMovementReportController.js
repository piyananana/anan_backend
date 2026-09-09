// controllers/im/imStockMovementReportController.js
// รายงานสินค้าคงเหลือและการเคลื่อนไหว — จัดกลุ่ม คลัง > หมวดหมู่ > สินค้า (1 "การ์ด" ต่อ สินค้า+คลัง) พร้อมยอดสะสม
// (running balance) ต่อบรรทัด
//
// จุดสำคัญที่ verify กับข้อมูลจริงก่อนเขียน query นี้ (ดู project memory pattern_im_stock_movement_report):
// 1. TRF สร้าง im_transaction แถวเดียว scope ที่ warehouse_id (ต้นทาง) ด้วย qty ติดลบเสมอ — ฝั่งปลายทาง
//    (to_warehouse_id) ไม่มีแถว im_transaction_detail แยกต่างหาก ต้อง UNION สร้างขึ้นเองโดย flip sign
// 2. การจับกลุ่ม รับ/จ่าย/เบิก/โอน/ปรับ ยึดจาก sys_doc_type + ทิศทางจริงของ qty ที่ post แล้ว (ไม่ใช่แค่ AP/AR
//    side) — รับ=สต็อกเพิ่ม(GRN/GRB/GRP/DNS/RTC/CNC), จ่าย=สต็อกลด(DLN/DLB/DLP/CNS/DNC/RTS), เบิก=ISS,
//    โอน=TRF, ปรับ=AJS
// 3. ยอดยกมา (opening) คำนวณฝั่ง server จาก SUM ก่อน date_from เสมอ ไม่ใช่ 0 — และสินค้าที่มียอดยกมาแต่ไม่มี
//    การเคลื่อนไหวในช่วงที่เลือกก็ต้องแสดง (การ์ดว่างไม่มีแถวรายการ แต่มียอดยกมา=ยอดคงเหลือ)
'use strict';

const RECEIVE_TYPES  = ['10', '11', '12', '25', '35', '40']; // GRN, GRB, GRP, DNS, RTC, CNC
const ISSUE_TYPES     = ['30', '31', '32', '20', '45', '15']; // DLN, DLB, DLP, CNS, DNC, RTS
const WITHDRAW_TYPE   = '60'; // ISS
const TRANSFER_TYPE   = '70'; // TRF
const ADJUST_TYPE     = '80'; // AJS

const bucketOf = (sysDocType) => {
    if (RECEIVE_TYPES.includes(sysDocType)) return 'receive';
    if (ISSUE_TYPES.includes(sysDocType)) return 'issue';
    if (sysDocType === WITHDRAW_TYPE) return 'withdraw';
    if (sysDocType === TRANSFER_TYPE) return 'transfer';
    if (sysDocType === ADJUST_TYPE) return 'adjust';
    return 'other';
};

const getStockMovementReport = async (req, res) => {
    const { warehouse_ids, category_ids, item_code_from, item_code_to, date_from, date_to } = req.query;
    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        const params = [dateFrom, dateTo];
        let itemFilter = '';
        if (category_ids) {
            const ids = String(category_ids).split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
            if (ids.length > 0) {
                params.push(ids);
                itemFilter += ` AND it.category_id = ANY($${params.length}::int[])`;
            }
        } else {
            if (item_code_from) {
                params.push(item_code_from);
                itemFilter += ` AND it.item_code >= $${params.length}`;
            }
            if (item_code_to) {
                params.push(item_code_to);
                itemFilter += ` AND it.item_code <= $${params.length}`;
            }
        }

        let warehouseFilter = '';
        if (warehouse_ids) {
            const ids = String(warehouse_ids).split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
            if (ids.length > 0) {
                params.push(ids);
                warehouseFilter = ` AND s.effective_warehouse_id = ANY($${params.length}::int[])`;
            }
        }

        const sql = `
            WITH movement AS (
                -- ทุก sys_doc_type ยกเว้นฝั่งปลายทางของ TRF — ใช้ warehouse_id (ต้นทาง/คลังเดียว) ตรงๆ
                SELECT
                    t.id AS txn_id, t.doc_no, t.doc_date, d.doc_code, d.doc_name_thai, d.doc_name_eng,
                    d.sys_doc_type, t.warehouse_id AS effective_warehouse_id,
                    dt.item_id, dt.qty, dt.total_value_lc
                FROM im_transaction t
                JOIN sa_module_document d ON d.id = t.doc_id
                JOIN im_transaction_detail dt ON dt.header_id = t.id
                WHERE t.status IN ('Posted', 'Received', 'Delivered')
                  AND t.doc_date <= $2::date

                UNION ALL

                -- ฝั่งปลายทางของ TRF (โอนเข้า) — ไม่มีแถวจริงใน im_transaction_detail จึงสร้างขึ้นเองโดย flip
                -- sign ของ qty/total_value_lc แล้วใช้ to_warehouse_id เป็นคลังที่มีผล
                SELECT
                    t.id, t.doc_no, t.doc_date, d.doc_code, d.doc_name_thai, d.doc_name_eng,
                    d.sys_doc_type, t.to_warehouse_id AS effective_warehouse_id,
                    dt.item_id, -dt.qty AS qty, -dt.total_value_lc AS total_value_lc
                FROM im_transaction t
                JOIN sa_module_document d ON d.id = t.doc_id
                JOIN im_transaction_detail dt ON dt.header_id = t.id
                WHERE t.status IN ('Posted', 'Received', 'Delivered')
                  AND t.doc_date <= $2::date
                  AND d.sys_doc_type = '${TRANSFER_TYPE}'
                  AND t.to_warehouse_id IS NOT NULL
            ),
            scope AS (
                SELECT DISTINCT effective_warehouse_id, item_id
                FROM movement
                WHERE effective_warehouse_id IS NOT NULL
            ),
            opening AS (
                SELECT effective_warehouse_id, item_id,
                       SUM(qty) AS opening_qty, SUM(total_value_lc) AS opening_value
                FROM movement
                WHERE doc_date < $1::date
                GROUP BY effective_warehouse_id, item_id
            ),
            in_range AS (
                SELECT m.*,
                    SUM(m.qty) OVER (
                        PARTITION BY m.effective_warehouse_id, m.item_id
                        ORDER BY m.doc_date, m.txn_id
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS cum_qty,
                    SUM(m.total_value_lc) OVER (
                        PARTITION BY m.effective_warehouse_id, m.item_id
                        ORDER BY m.doc_date, m.txn_id
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS cum_value
                FROM movement m
                WHERE m.doc_date >= $1::date
            )
            SELECT
                ir.txn_id, ir.doc_no, ir.doc_date, ir.doc_code, ir.doc_name_thai, ir.doc_name_eng, ir.sys_doc_type,
                ir.qty, ir.total_value_lc,
                COALESCE(o.opening_qty, 0) + COALESCE(ir.cum_qty, 0)     AS running_qty,
                COALESCE(o.opening_value, 0) + COALESCE(ir.cum_value, 0) AS running_value,
                COALESCE(o.opening_qty, 0)   AS opening_qty,
                COALESCE(o.opening_value, 0) AS opening_value,
                w.id AS warehouse_id, w.warehouse_code, w.warehouse_name_th, w.warehouse_name_en,
                it.id AS item_id, it.item_code, it.item_name_th, it.item_name_en, it.costing_method,
                cat.id AS category_id, cat.category_code, cat.category_name_th, cat.category_name_en,
                u.uom_code, u.uom_name_th, u.uom_name_en
            FROM scope s
            LEFT JOIN opening  o  ON o.effective_warehouse_id  = s.effective_warehouse_id AND o.item_id  = s.item_id
            LEFT JOIN in_range ir ON ir.effective_warehouse_id = s.effective_warehouse_id AND ir.item_id = s.item_id
            JOIN im_item it             ON it.id = s.item_id
            LEFT JOIN im_item_category cat ON cat.id = it.category_id
            LEFT JOIN im_warehouse w    ON w.id = s.effective_warehouse_id
            LEFT JOIN im_uom u          ON u.id = it.base_uom_id
            WHERE 1=1
              ${warehouseFilter}
              ${itemFilter}
            ORDER BY w.warehouse_code, cat.category_code, it.item_code, ir.doc_date NULLS FIRST, ir.txn_id
        `;

        const result = await client.query(sql, params);
        const rows = result.rows.map(row => ({ ...row, bucket: row.sys_doc_type ? bucketOf(row.sys_doc_type) : null }));
        res.json(rows);
    } catch (err) {
        console.error('IM Stock Movement Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getStockMovementReport };
