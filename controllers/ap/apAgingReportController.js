// controllers/ap/apAgingReportController.js
// รายงานเจ้าหนี้คงค้างตามอายุหนี้ (AP Aging Report)

const getAgingReport = async (req, res) => {
    const {
        as_of_date,
        branch_id,
        vendor_group_id,
        vendor_code_from,
        vendor_code_to,
    } = req.query;

    const asOf   = as_of_date || new Date().toISOString().slice(0, 10);
    const client = await req.dbPool.connect();
    try {
        // idempotent migration
        await client.query(
            `ALTER TABLE ap_vendor ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(18,4) NOT NULL DEFAULT 0`
        ).catch(() => {});

        const params  = [asOf];
        const filters = [];

        // สาขา
        if (branch_id) {
            params.push(parseInt(branch_id));
            filters.push(`t.branch_id = $${params.length}`);
        }

        // กลุ่มผู้ขาย
        if (vendor_group_id) {
            params.push(parseInt(vendor_group_id));
            filters.push(`v.vendor_group_id = $${params.length}`);
        }

        // รหัสผู้ขาย ตั้งแต่
        if (vendor_code_from) {
            params.push(vendor_code_from);
            filters.push(`t.vendor_code >= $${params.length}`);
        }

        // รหัสผู้ขาย ถึง
        if (vendor_code_to) {
            params.push(vendor_code_to);
            filters.push(`t.vendor_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

        // ดึงธุรกรรม AP ที่ยังค้างชำระ: PI(10) + DN(50) เท่านั้น
        const result = await client.query(`
            SELECT
                -- ข้อมูลผู้ขาย
                t.vendor_id,
                t.vendor_code,
                t.vendor_name_th,
                v.vendor_name_en,
                v.vendor_group_id,
                vg.group_code      AS vendor_group_code,
                vg.group_name_thai AS vendor_group_name,
                COALESCE(v.credit_limit, 0) AS credit_limit,
                -- ข้อมูลเอกสาร
                t.doc_no,
                d.doc_code,
                d.doc_name_thai,
                d.sys_doc_type,
                t.doc_date,
                t.due_date,
                t.currency_code,
                t.balance_amount_lc,
                -- ข้อมูลสาขา
                t.branch_id,
                b.branch_code,
                b.branch_name_thai,
                -- จำนวนวันค้างชำระ (ลบถ้ายังไม่ถึงกำหนด)
                ($1::date - COALESCE(t.due_date, t.doc_date)::date) AS days_overdue
            FROM ap_transaction t
            JOIN sa_module_document d  ON t.doc_id   = d.id
            LEFT JOIN cd_branch b      ON b.id        = t.branch_id
            LEFT JOIN ap_vendor v      ON v.id        = t.vendor_id
            LEFT JOIN ap_vendor_group vg ON vg.id     = v.vendor_group_id
            WHERE t.status = 'Posted'
              AND t.balance_amount_lc > 0.005
              AND d.sys_module = '21'
              AND d.sys_doc_type IN ('10', '50')
              AND t.doc_date <= $1::date
              ${extraFilters}
            ORDER BY t.vendor_code ASC, COALESCE(t.due_date, t.doc_date) ASC
        `, params);

        // จัดกลุ่มตามผู้ขาย
        const vendorMap = new Map();
        for (const row of result.rows) {
            const vid = row.vendor_id;
            if (!vendorMap.has(vid)) {
                vendorMap.set(vid, {
                    vendor_id:          vid,
                    vendor_code:        row.vendor_code,
                    vendor_name_th:     row.vendor_name_th,
                    vendor_name_en:     row.vendor_name_en,
                    vendor_group_id:    row.vendor_group_id,
                    vendor_group_code:  row.vendor_group_code,
                    vendor_group_name:  row.vendor_group_name,
                    credit_limit:       Number(row.credit_limit || 0),
                    invoices: [],
                });
            }
            vendorMap.get(vid).invoices.push({
                doc_no:            row.doc_no,
                doc_code:          row.doc_code,
                doc_name_thai:     row.doc_name_thai,
                sys_doc_type:      row.sys_doc_type,
                doc_date:          row.doc_date,
                due_date:          row.due_date,
                currency_code:     row.currency_code,
                balance_amount_lc: Number(row.balance_amount_lc),
                days_overdue:      Number(row.days_overdue),
                branch_code:       row.branch_code,
                branch_name_thai:  row.branch_name_thai,
            });
        }

        res.json(Array.from(vendorMap.values()));
    } catch (err) {
        console.error('AP Aging Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getAgingReport };
