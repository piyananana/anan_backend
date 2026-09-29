// controllers/so/soQuoteSoStatusReportController.js — ติดตามสถานะใบเสนอราคา(Quote)/ใบสั่งขาย(SO) คู่กัน — อ่านอย่างเดียว
// มิเรอร์ poPrPoStatusReportController.js ทุกประการ (PR->Quote, PO->SO, vendor->customer)
//
// สองฝั่งกรองอิสระจากกัน: เงื่อนไข Quote (สถานะ/วันที่) ใช้เลือกว่า Quote ใบไหนจะแสดง — เมื่อ Quote ใบหนึ่งตรง
// เงื่อนไขแล้ว จะพา SO ที่แปลงมาจากมันมาแสดงด้วยเสมอไม่ว่า SO จะสถานะ/วันที่อะไรก็ตาม (ไม่ถูกกรองซ้ำด้วยเงื่อนไข
// SO) — ส่วนเงื่อนไข SO ใช้เลือกเฉพาะ SO ที่ไม่มีใบเสนอราคาอ้างอิงเลย (สร้างตรงโดยไม่ผ่าน Quote) เท่านั้น
//
// show_quote/show_so (จาก switch "แสดงใบเสนอราคา"/"แสดงใบสั่งขาย" ที่ filter panel) ปิดทั้งฝั่งนั้นได้ทั้งหมด —
// ดู poPrPoStatusReportController.js สำหรับคำอธิบายพฤติกรรมเต็มของแต่ละ combination
//
// จับคู่ที่ระดับหัวเอกสาร (distinct Quote header + SO header ที่มีอย่างน้อย 1 บรรทัดโยงกันผ่าน ref_quote_detail_id)
'use strict';

const fetchReport = async (req, res) => {
    const { quote_date_from, quote_date_to, so_date_from, so_date_to, quote_statuses, so_statuses, show_quote, show_so } = req.query;
    const quoteStatusList = (quote_statuses || '').split(',').map(s => s.trim()).filter(Boolean);
    const soStatusList = (so_statuses || '').split(',').map(s => s.trim()).filter(Boolean);
    const showQuote = show_quote !== 'false';
    const showSo = show_so !== 'false';

    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`
            WITH quote_so_links AS (
                SELECT DISTINCT qtd.header_id AS quote_id, sod.header_id AS so_id
                FROM so_transaction_detail sod
                JOIN quote_transaction_detail qtd ON qtd.id = sod.ref_quote_detail_id
            ),
            combined AS (
                SELECT q.id AS quote_id, q.doc_no AS quote_doc_no, q.doc_date AS quote_doc_date,
                       pu.user_name AS quote_prepared_by_name,
                       (SELECT string_agg(a.approver_user_name, ', ' ORDER BY a.sequence_no)
                        FROM quote_transaction_approval a
                        WHERE a.header_id = q.id AND a.status IN ('Approved','Rejected')) AS quote_approver_name,
                       (SELECT MAX(a.approved_at)
                        FROM quote_transaction_approval a
                        WHERE a.header_id = q.id AND a.status IN ('Approved','Rejected')) AS quote_decided_at,
                       q.status AS quote_status, q.updated_at AS quote_updated_at,
                       so.id AS so_id, so.doc_no AS so_doc_no, so.doc_date AS so_doc_date, so.approved_at AS so_approved_at,
                       so.created_by AS so_created_by, so.approved_by AS so_approver_name, so.status AS so_status, so.updated_at AS so_updated_at
                FROM quote_transaction q
                LEFT JOIN sa_user pu ON pu.id = q.prepared_by
                LEFT JOIN quote_so_links l ON l.quote_id = q.id AND $7::boolean = true
                LEFT JOIN so_transaction so ON so.id = l.so_id
                WHERE $8::boolean = true
                  AND ($1::text[] IS NULL OR q.status = ANY($1::text[]))
                  AND ($2::date IS NULL OR q.doc_date >= $2::date)
                  AND ($3::date IS NULL OR q.doc_date <= $3::date)

                UNION ALL

                SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                       so.id, so.doc_no, so.doc_date, so.approved_at, so.created_by, so.approved_by, so.status, so.updated_at
                FROM so_transaction so
                WHERE $7::boolean = true
                  AND ($8::boolean = false OR NOT EXISTS (
                        SELECT 1 FROM so_transaction_detail sod
                        WHERE sod.header_id = so.id AND sod.ref_quote_detail_id IS NOT NULL))
                  AND ($4::text[] IS NULL OR so.status = ANY($4::text[]))
                  AND ($5::date IS NULL OR so.doc_date >= $5::date)
                  AND ($6::date IS NULL OR so.doc_date <= $6::date)
            )
            SELECT * FROM combined
            ORDER BY COALESCE(quote_doc_date, so_doc_date) DESC NULLS LAST, quote_id, so_id
        `, [
            quoteStatusList.length > 0 ? quoteStatusList : null, quote_date_from || null, quote_date_to || null,
            soStatusList.length > 0 ? soStatusList : null, so_date_from || null, so_date_to || null,
            showSo, showQuote,
        ]);

        const rows = result.rows;
        const quoteIds = [...new Set(rows.map(r => r.quote_id).filter(Boolean))];
        const soIds = [...new Set(rows.map(r => r.so_id).filter(Boolean))];

        const quoteItemsByHeader = {};
        if (quoteIds.length > 0) {
            const quoteItemsRes = await client.query(`
                SELECT header_id, item_code, item_name, qty_quoted, unit_price_fc
                FROM quote_transaction_detail WHERE header_id = ANY($1::int[]) ORDER BY line_no
            `, [quoteIds]);
            for (const d of quoteItemsRes.rows) {
                (quoteItemsByHeader[d.header_id] ??= []).push({
                    item_code: d.item_code, item_name: d.item_name,
                    qty: d.qty_quoted, price: d.unit_price_fc,
                });
            }
        }

        const soItemsByHeader = {};
        if (soIds.length > 0) {
            const soItemsRes = await client.query(`
                SELECT header_id, item_code, item_name, qty_ordered, unit_price_fc
                FROM so_transaction_detail WHERE header_id = ANY($1::int[]) ORDER BY line_no
            `, [soIds]);
            for (const d of soItemsRes.rows) {
                (soItemsByHeader[d.header_id] ??= []).push({
                    item_code: d.item_code, item_name: d.item_name,
                    qty: d.qty_ordered, price: d.unit_price_fc,
                });
            }
        }

        const report = rows.map(r => ({
            ...r,
            quote_items: r.quote_id ? (quoteItemsByHeader[r.quote_id] || []) : [],
            so_items: r.so_id ? (soItemsByHeader[r.so_id] || []) : [],
        }));

        res.status(200).json(report);
    } catch (error) {
        console.error('Error fetching Quote/SO status report:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchReport };
