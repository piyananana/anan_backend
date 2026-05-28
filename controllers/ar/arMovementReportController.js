// controllers/ar/arMovementReportController.js
// รายงานการเคลื่อนไหวลูกหนี้ (AR Movement Report)

const DR_TYPES  = ['10', '30', '35'];
// Advance receipts (60, 65) ยังคงอยู่ใน CR_TYPES: ลดหนี้เมื่อรับเงินมัดจำ
const CR_TYPES  = ['50', '55', '60', '65', '80'];
// ใช้สำหรับ WHERE status exception (advance receipts อาจเปลี่ยน status เมื่อถูกตัดชำระหมด)
const ADV_TYPES = ['60', '65'];

const getMovementReport = async (req, res) => {
    const {
        date_from,
        date_to,
        customer_group_id,
        salesperson_id,
        customer_code_from,
        customer_code_to,
    } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        // Fixed params: $1–$6. Dynamic filter params start at $7+
        const params = [
            dateFrom,
            dateTo,
            DR_TYPES,                    // $3
            CR_TYPES,                    // $4
            [...DR_TYPES, ...CR_TYPES],  // $5
            ADV_TYPES,                   // $6
        ];
        const filters = [];

        if (customer_group_id) {
            params.push(parseInt(customer_group_id));
            filters.push(`c.customer_group_id = $${params.length}`);
        }
        if (salesperson_id) {
            params.push(parseInt(salesperson_id));
            filters.push(`c.salesperson_id = $${params.length}`);
        }
        if (customer_code_from) {
            params.push(customer_code_from);
            filters.push(`t.customer_code >= $${params.length}`);
        }
        if (customer_code_to) {
            params.push(customer_code_to);
            filters.push(`t.customer_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

        const result = await client.query(`
            WITH all_txn AS (
                SELECT
                    t.customer_id,
                    t.customer_code,
                    t.customer_name_th,
                    c.customer_group_id,
                    c.salesperson_id,
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
                    CASE WHEN d.sys_doc_type = ANY($4::text[]) THEN t.total_amount_lc ELSE 0 END AS credit_amount,
                    CASE
                        WHEN t.doc_date < $1::date THEN 'before'
                        ELSE 'in'
                    END AS period
                FROM ar_transaction t
                JOIN sa_module_document d  ON d.id = t.doc_id
                LEFT JOIN ar_customer c    ON c.id = t.customer_id
                -- Invoice refs ที่เอกสารนี้ชำระ/ปรับ
                LEFT JOIN LATERAL (
                    SELECT ARRAY_AGG(
                        ref_t.doc_no
                        ORDER BY ref_t.doc_date, ref_t.doc_no
                    ) AS apply_refs
                    FROM ar_transaction_apply ta
                    JOIN ar_transaction ref_t ON ref_t.id = ta.applied_to_id
                    WHERE ta.transaction_id = t.id
                      AND ta.apply_type IN ('invoice', 'cn', 'dn_ref', 'bc_invoice')
                ) apply_info ON true
                -- เงินมัดจำที่ถูกหักในเอกสารนี้ (sub-entries ใต้ Receipt)
                LEFT JOIN LATERAL (
                    SELECT JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'doc_no',  adv_t.doc_no,
                            'amount',  ta.applied_amount_lc
                        ) ORDER BY adv_t.doc_date, adv_t.doc_no
                    ) AS advance_subs
                    FROM ar_transaction_apply ta
                    JOIN ar_transaction adv_t ON adv_t.id = ta.applied_to_id
                    WHERE ta.transaction_id = t.id
                      AND ta.apply_type = 'advance'
                ) adv_info ON true
                -- เอกสารรับชำระที่ได้ตัดยอดเงินมัดจำนี้ (sub-entries ใต้ Advance Receipt)
                LEFT JOIN LATERAL (
                    SELECT JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'doc_no',  rec_t.doc_no,
                            'amount',  ta.applied_amount_lc
                        ) ORDER BY rec_t.doc_date, rec_t.doc_no
                    ) AS applied_by_subs
                    FROM ar_transaction_apply ta
                    JOIN ar_transaction rec_t ON rec_t.id = ta.transaction_id
                    WHERE ta.applied_to_id = t.id
                      AND ta.apply_type = 'advance'
                ) applied_by_info ON true
                WHERE (
                          t.status = 'Posted'
                          -- Advance receipts ที่ถูกตัดชำระหมดแล้วอาจมี status อื่น ให้แสดงด้วยตราบที่ไม่ใช่ Void
                          OR (d.sys_doc_type = ANY($6::text[]) AND t.status <> 'Void')
                      )
                  AND d.sys_doc_type = ANY($5::text[])
                  AND t.doc_date <= $2::date
                  ${extraFilters}
            ),
            customer_list AS (
                SELECT DISTINCT customer_id, customer_code, customer_name_th,
                       customer_group_id, salesperson_id
                FROM all_txn
                WHERE period = 'in' OR period = 'before'
            ),
            opening AS (
                SELECT customer_id,
                       SUM(debit_amount) - SUM(credit_amount) AS opening_balance
                FROM all_txn
                WHERE period = 'before'
                GROUP BY customer_id
            )
            SELECT
                cl.customer_id,
                cl.customer_code,
                cl.customer_name_th,
                cl.customer_group_id,
                cl.salesperson_id,
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
            FROM customer_list cl
            LEFT JOIN opening o ON o.customer_id = cl.customer_id
            LEFT JOIN all_txn t ON t.customer_id = cl.customer_id AND t.period = 'in'
            ORDER BY cl.customer_code ASC,
                     t.doc_date ASC,
                     t.doc_no ASC
        `, params);

        const customerMap = new Map();
        for (const row of result.rows) {
            const cid = row.customer_id;
            if (!customerMap.has(cid)) {
                customerMap.set(cid, {
                    customer_id:       cid,
                    customer_code:     row.customer_code,
                    customer_name_th:  row.customer_name_th,
                    customer_group_id: row.customer_group_id,
                    salesperson_id:    row.salesperson_id,
                    opening_balance:   Number(row.opening_balance || 0),
                    transactions:      [],
                });
            }
            const customer = customerMap.get(cid);

            if (row.doc_no != null) {
                const prevBalance = customer.transactions.length > 0
                    ? customer.transactions[customer.transactions.length - 1].running_balance
                    : customer.opening_balance;
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
                customer.transactions.push(txn);

                // Inject advance deduction sub-entries (แสดงข้อมูล, ไม่กระทบ running_balance)
                const advSubs = row.advance_subs || [];
                for (const adv of advSubs) {
                    customer.transactions.push({
                        doc_no:          'หักเงินมัดจำ',  // แสดงในคอลัมน์เลขที่เอกสาร
                        advance_ref:     adv.doc_no,      // เลขที่มัดจำ → แสดงในคอลัมน์อ้างอิง
                        doc_date:        row.doc_date,
                        doc_name_thai:   'หักเงินมัดจำ',
                        sys_doc_type:    '_adv_sub',
                        ref_doc_no:      row.doc_no,      // parent receipt (ใช้ pairing)
                        apply_refs:      [],
                        debit_amount:    0,
                        credit_amount:   0,
                        running_balance: txn.running_balance,
                        is_advance_sub:  true,
                        advance_amount:  Number(adv.amount || 0),
                    });
                }

                // Inject applied-by sub-entries สำหรับ Advance Receipt (แสดงว่าถูกตัดโดยใคร)
                const ADV_TYPES_SET = new Set(['60', '65']);
                if (ADV_TYPES_SET.has(row.sys_doc_type)) {
                    const appliedBySubs = row.applied_by_subs || [];
                    for (const rec of appliedBySubs) {
                        customer.transactions.push({
                            doc_no:             'ตัดยอดชำระ',   // แสดงในคอลัมน์เลขที่เอกสาร
                            applied_by_ref:     rec.doc_no,     // เลขที่รับชำระ → คอลัมน์อ้างอิง
                            doc_date:           row.doc_date,
                            doc_name_thai:      'ตัดยอดชำระ',
                            sys_doc_type:       '_applied_by_sub',
                            ref_doc_no:         row.doc_no,     // parent advance receipt (ใช้ pairing)
                            apply_refs:         [],
                            debit_amount:       0,
                            credit_amount:      0,
                            running_balance:    txn.running_balance,
                            is_applied_by_sub:  true,
                            applied_amount:     Number(rec.amount || 0),
                        });
                    }
                }
            }
        }

        const customers = Array.from(customerMap.values())
            .filter(c => c.opening_balance !== 0 || c.transactions.length > 0)
            .map(c => ({
                ...c,
                closing_balance: c.transactions.length > 0
                    ? c.transactions[c.transactions.length - 1].running_balance
                    : c.opening_balance,
            }));

        res.json(customers);
    } catch (err) {
        console.error('AR Movement Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getMovementReport };
