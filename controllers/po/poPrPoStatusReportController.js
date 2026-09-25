// controllers/po/poPrPoStatusReportController.js — ติดตามสถานะใบขอซื้อ(PR)/ใบสั่งซื้อ(PO) คู่กัน — อ่านอย่างเดียว
//
// สองฝั่งกรองอิสระจากกัน: เงื่อนไข PR (สถานะ/วันที่) ใช้เลือกว่า PR ใบไหนจะแสดง — เมื่อ PR ใบหนึ่งตรงเงื่อนไขแล้ว
// จะพา PO ที่แปลงมาจากมันมาแสดงด้วยเสมอไม่ว่า PO จะสถานะ/วันที่อะไรก็ตาม (ไม่ถูกกรองซ้ำด้วยเงื่อนไข PO) — ส่วน
// เงื่อนไข PO ใช้เลือกเฉพาะ PO ที่ไม่มีใบขอซื้ออ้างอิงเลย (สร้างตรงโดยไม่ผ่าน PR) เท่านั้น
//
// จับคู่ที่ระดับหัวเอกสาร (distinct PR header + PO header ที่มีอย่างน้อย 1 บรรทัดโยงกันผ่าน ref_pr_detail_id) —
// ถ้า PR ใบเดียวถูกแยกไปหลาย PO จะเห็นหลายแถว (ข้อมูล PR ซ้ำ, PO ต่างกัน) แต่ละแถวแสดงบรรทัดสินค้า "ทั้งหมด" ของ
// ทั้งสองฝั่ง ไม่ใช่เฉพาะบรรทัดที่โยงกันจริง — เป็นข้อจำกัดที่ยอมรับได้เพราะส่วนใหญ่ 1 PR แปลงเป็น 1 PO เท่านั้น
'use strict';

const fetchReport = async (req, res) => {
    const { pr_date_from, pr_date_to, po_date_from, po_date_to, pr_statuses, po_statuses } = req.query;
    const prStatusList = (pr_statuses || '').split(',').map(s => s.trim()).filter(Boolean);
    const poStatusList = (po_statuses || '').split(',').map(s => s.trim()).filter(Boolean);

    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`
            WITH pr_po_links AS (
                SELECT DISTINCT prd.header_id AS pr_id, pod.header_id AS po_id
                FROM po_transaction_detail pod
                JOIN pr_transaction_detail prd ON prd.id = pod.ref_pr_detail_id
            ),
            combined AS (
                SELECT pr.id AS pr_id, pr.doc_no AS pr_doc_no, pr.doc_date AS pr_doc_date,
                       ru.user_name AS pr_requested_by_name,
                       (SELECT string_agg(a.approver_user_name, ', ' ORDER BY a.sequence_no)
                        FROM pr_transaction_approval a
                        WHERE a.header_id = pr.id AND a.status IN ('Approved','Rejected')) AS pr_approver_name,
                       pr.status AS pr_status,
                       po.id AS po_id, po.doc_no AS po_doc_no, po.doc_date AS po_doc_date, po.approved_at AS po_approved_at,
                       po.created_by AS po_created_by, po.approved_by AS po_approver_name, po.status AS po_status
                FROM pr_transaction pr
                LEFT JOIN sa_user ru ON ru.id = pr.requested_by
                LEFT JOIN pr_po_links l ON l.pr_id = pr.id
                LEFT JOIN po_transaction po ON po.id = l.po_id
                WHERE ($1::text[] IS NULL OR pr.status = ANY($1::text[]))
                  AND ($2::date IS NULL OR pr.doc_date >= $2::date)
                  AND ($3::date IS NULL OR pr.doc_date <= $3::date)

                UNION ALL

                SELECT NULL, NULL, NULL, NULL, NULL, NULL,
                       po.id, po.doc_no, po.doc_date, po.approved_at, po.created_by, po.approved_by, po.status
                FROM po_transaction po
                WHERE NOT EXISTS (
                        SELECT 1 FROM po_transaction_detail pod
                        WHERE pod.header_id = po.id AND pod.ref_pr_detail_id IS NOT NULL)
                  AND ($4::text[] IS NULL OR po.status = ANY($4::text[]))
                  AND ($5::date IS NULL OR po.doc_date >= $5::date)
                  AND ($6::date IS NULL OR po.doc_date <= $6::date)
            )
            SELECT * FROM combined
            ORDER BY COALESCE(pr_doc_date, po_doc_date) DESC NULLS LAST, pr_id, po_id
        `, [
            prStatusList.length > 0 ? prStatusList : null, pr_date_from || null, pr_date_to || null,
            poStatusList.length > 0 ? poStatusList : null, po_date_from || null, po_date_to || null,
        ]);

        const rows = result.rows;
        const prIds = [...new Set(rows.map(r => r.pr_id).filter(Boolean))];
        const poIds = [...new Set(rows.map(r => r.po_id).filter(Boolean))];

        const prItemsByHeader = {};
        if (prIds.length > 0) {
            const prItemsRes = await client.query(`
                SELECT header_id, item_code, item_name, qty_requested, estimated_unit_cost
                FROM pr_transaction_detail WHERE header_id = ANY($1::int[]) ORDER BY line_no
            `, [prIds]);
            for (const d of prItemsRes.rows) {
                (prItemsByHeader[d.header_id] ??= []).push({
                    item_code: d.item_code, item_name: d.item_name,
                    qty: d.qty_requested, price: d.estimated_unit_cost,
                });
            }
        }

        const poItemsByHeader = {};
        if (poIds.length > 0) {
            const poItemsRes = await client.query(`
                SELECT header_id, item_code, item_name, qty_ordered, unit_price_fc
                FROM po_transaction_detail WHERE header_id = ANY($1::int[]) ORDER BY line_no
            `, [poIds]);
            for (const d of poItemsRes.rows) {
                (poItemsByHeader[d.header_id] ??= []).push({
                    item_code: d.item_code, item_name: d.item_name,
                    qty: d.qty_ordered, price: d.unit_price_fc,
                });
            }
        }

        const report = rows.map(r => ({
            ...r,
            pr_items: r.pr_id ? (prItemsByHeader[r.pr_id] || []) : [],
            po_items: r.po_id ? (poItemsByHeader[r.po_id] || []) : [],
        }));

        res.status(200).json(report);
    } catch (error) {
        console.error('Error fetching PR/PO status report:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { fetchReport };
