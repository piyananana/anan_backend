// controllers/ap/apMovementReportController.js
// รายงานการเคลื่อนไหวเจ้าหนี้ (AP Movement Report)

// DR_TYPES: PI(10), DN(50) → เพิ่มยอดเจ้าหนี้
const DR_TYPES  = ['10', '50'];
// CR_TYPES: CN(30), จ่ายมัดจำ(60), คืนมัดจำ(65), ชำระ(80) → ลดยอดเจ้าหนี้
const CR_TYPES  = ['30', '60', '65', '80'];
// ADV_TYPES: advance payment/return ที่อาจถูกตัดแยก
const ADV_TYPES = ['60', '65'];

const getMovementReport = async (req, res) => {
    const {
        date_from,
        date_to,
        vendor_group_id,
        vendor_code_from,
        vendor_code_to,
    } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        // Fixed params $1–$6
        const params = [
            dateFrom,
            dateTo,
            DR_TYPES,                    // $3
            CR_TYPES,                    // $4
            [...DR_TYPES, ...CR_TYPES],  // $5
            ADV_TYPES,                   // $6
        ];
        const filters = [];

        if (vendor_group_id) {
            const groupIds = String(vendor_group_id)
                .split(',')
                .map(s => parseInt(s.trim()))
                .filter(n => !isNaN(n));
            if (groupIds.length > 0) {
                params.push(groupIds);
                filters.push(`v.vendor_group_id = ANY($${params.length})`);
            }
        }
        if (vendor_code_from) {
            params.push(vendor_code_from);
            filters.push(`t.vendor_code >= $${params.length}`);
        }
        if (vendor_code_to) {
            params.push(vendor_code_to);
            filters.push(`t.vendor_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

        const result = await client.query(`
            WITH all_txn AS (
                SELECT
                    t.vendor_id,
                    t.vendor_code,
                    t.vendor_name_th,
                    v.vendor_name_en,
                    v.vendor_group_id,
                    t.id         AS txn_id,
                    t.doc_no,
                    t.doc_date,
                    t.ref_doc_no,
                    apply_info.apply_refs,
                    adv_info.advance_subs,
                    applied_by_info.applied_by_subs,
                    d.doc_name_thai,
                    d.sys_doc_type,
                    CASE WHEN d.sys_doc_type = ANY($3::text[]) THEN t.total_amount_lc ELSE 0 END AS debit_amount,
                    -- ใช้ยอดล้าง AP ที่อัตรา invoice เพื่อให้ running balance ตรงกับ balance_amount_lc
                    CASE WHEN d.sys_doc_type = ANY($4::text[]) THEN
                        COALESCE(
                            NULLIF((
                                SELECT SUM(ata.applied_amount_fc * ref_t.exchange_rate)
                                FROM ap_transaction_apply ata
                                JOIN ap_transaction ref_t ON ref_t.id = ata.applied_to_id
                                WHERE ata.transaction_id = t.id
                                  AND ata.apply_type = 'invoice'
                            ), 0),
                            t.total_amount_lc
                        )
                    ELSE 0 END AS credit_amount,
                    CASE
                        WHEN t.doc_date < $1::date THEN 'before'
                        ELSE 'in'
                    END AS period
                FROM ap_transaction t
                JOIN sa_module_document d  ON d.id = t.doc_id
                LEFT JOIN ap_vendor v      ON v.id = t.vendor_id
                -- อ้างอิงใบสั่งซื้อ/DN ที่เอกสารนี้ชำระ
                LEFT JOIN LATERAL (
                    SELECT ARRAY_AGG(
                        ref_t.doc_no
                        ORDER BY ref_t.doc_date, ref_t.doc_no
                    ) AS apply_refs
                    FROM ap_transaction_apply ta
                    JOIN ap_transaction ref_t ON ref_t.id = ta.applied_to_id
                    WHERE ta.transaction_id = t.id
                      AND ta.apply_type = 'invoice'
                ) apply_info ON true
                -- มัดจำที่ถูกหักในเอกสารนี้ (payment หักเงินมัดจำ)
                LEFT JOIN LATERAL (
                    SELECT JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'doc_no',  adv_t.doc_no,
                            'amount',  ta.applied_amount_lc
                        ) ORDER BY adv_t.doc_date, adv_t.doc_no
                    ) AS advance_subs
                    FROM ap_transaction_apply ta
                    JOIN ap_transaction adv_t ON adv_t.id = ta.applied_to_id
                    WHERE ta.transaction_id = t.id
                      AND ta.apply_type = 'advance'
                ) adv_info ON true
                -- เอกสารชำระที่ได้ตัดยอดมัดจำนี้
                LEFT JOIN LATERAL (
                    SELECT JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'doc_no',  pay_t.doc_no,
                            'amount',  ta.applied_amount_lc
                        ) ORDER BY pay_t.doc_date, pay_t.doc_no
                    ) AS applied_by_subs
                    FROM ap_transaction_apply ta
                    JOIN ap_transaction pay_t ON pay_t.id = ta.transaction_id
                    WHERE ta.applied_to_id = t.id
                      AND ta.apply_type = 'advance'
                ) applied_by_info ON true
                WHERE (
                          t.status = 'Posted'
                          OR (d.sys_doc_type = ANY($6::text[]) AND t.status <> 'Void')
                      )
                  AND d.sys_doc_type = ANY($5::text[])
                  AND t.doc_date <= $2::date
                  ${extraFilters}
            ),
            vendor_list AS (
                SELECT DISTINCT vendor_id, vendor_code, vendor_name_th, vendor_name_en, vendor_group_id
                FROM all_txn
                WHERE period = 'in' OR period = 'before'
            ),
            opening AS (
                SELECT vendor_id,
                       SUM(debit_amount) - SUM(credit_amount) AS opening_balance
                FROM all_txn
                WHERE period = 'before'
                GROUP BY vendor_id
            )
            SELECT
                vl.vendor_id,
                vl.vendor_code,
                vl.vendor_name_th,
                vl.vendor_name_en,
                vl.vendor_group_id,
                COALESCE(o.opening_balance, 0) AS opening_balance,
                t.txn_id,
                t.doc_no,
                t.doc_date,
                t.ref_doc_no,
                t.apply_refs,
                t.advance_subs,
                t.applied_by_subs,
                t.doc_name_thai,
                t.sys_doc_type,
                t.debit_amount,
                t.credit_amount
            FROM vendor_list vl
            LEFT JOIN opening o ON o.vendor_id = vl.vendor_id
            LEFT JOIN all_txn t ON t.vendor_id = vl.vendor_id AND t.period = 'in'
            ORDER BY vl.vendor_code ASC,
                     t.doc_date ASC,
                     t.doc_no ASC
        `, params);

        const vendorMap = new Map();
        for (const row of result.rows) {
            const vid = row.vendor_id;
            if (!vendorMap.has(vid)) {
                vendorMap.set(vid, {
                    vendor_id:       vid,
                    vendor_code:     row.vendor_code,
                    vendor_name_th:  row.vendor_name_th,
                    vendor_name_en:  row.vendor_name_en,
                    vendor_group_id: row.vendor_group_id,
                    opening_balance: Number(row.opening_balance || 0),
                    transactions:    [],
                });
            }
            const vendor = vendorMap.get(vid);

            if (row.doc_no != null) {
                const prevBalance = vendor.transactions.length > 0
                    ? vendor.transactions[vendor.transactions.length - 1].running_balance
                    : vendor.opening_balance;
                const dr = Number(row.debit_amount  || 0);
                const cr = Number(row.credit_amount || 0);
                const txn = {
                    doc_no:          row.doc_no,
                    doc_date:        row.doc_date,
                    doc_name_thai:   row.doc_name_thai,
                    sys_doc_type:    row.sys_doc_type,
                    ref_doc_no:      row.ref_doc_no || '',
                    apply_refs:      row.apply_refs  || [],
                    debit_amount:    dr,
                    credit_amount:   cr,
                    running_balance: prevBalance + dr - cr,
                };
                vendor.transactions.push(txn);

                // Inject advance deduction sub-entries
                const advSubs = row.advance_subs || [];
                for (const adv of advSubs) {
                    vendor.transactions.push({
                        doc_no:          'หักเงินมัดจำ',
                        advance_ref:     adv.doc_no,
                        doc_date:        row.doc_date,
                        doc_name_thai:   'หักเงินมัดจำ',
                        sys_doc_type:    '_adv_sub',
                        ref_doc_no:      row.doc_no,
                        apply_refs:      [],
                        debit_amount:    0,
                        credit_amount:   0,
                        running_balance: txn.running_balance,
                        is_advance_sub:  true,
                        advance_amount:  Number(adv.amount || 0),
                    });
                }

                // Inject applied-by sub-entries สำหรับ advance payment
                const ADV_TYPES_SET = new Set(['60', '65']);
                if (ADV_TYPES_SET.has(row.sys_doc_type)) {
                    const appliedBySubs = row.applied_by_subs || [];
                    for (const pay of appliedBySubs) {
                        vendor.transactions.push({
                            doc_no:             'ตัดยอดชำระ',
                            applied_by_ref:     pay.doc_no,
                            doc_date:           row.doc_date,
                            doc_name_thai:      'ตัดยอดชำระ',
                            sys_doc_type:       '_applied_by_sub',
                            ref_doc_no:         row.doc_no,
                            apply_refs:         [],
                            debit_amount:       0,
                            credit_amount:      0,
                            running_balance:    txn.running_balance,
                            is_applied_by_sub:  true,
                            applied_amount:     Number(pay.amount || 0),
                        });
                    }
                }
            }
        }

        const vendors = Array.from(vendorMap.values())
            .filter(v => v.opening_balance !== 0 || v.transactions.length > 0)
            .map(v => ({
                ...v,
                closing_balance: v.transactions.length > 0
                    ? v.transactions[v.transactions.length - 1].running_balance
                    : v.opening_balance,
            }));

        res.json(vendors);
    } catch (err) {
        console.error('AP Movement Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getMovementReport };
