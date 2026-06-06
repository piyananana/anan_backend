// controllers/ar/arFxGainLossReportController.js
// รายงานกำไร/ขาดทุนจากอัตราแลกเปลี่ยน (AR FX Gain/Loss Report)
// คำนวณจาก: applied_amount_fc × (receipt.exchange_rate − invoice.exchange_rate)

const getFxGainLossReport = async (req, res) => {
    const {
        date_from, date_to,
        currency_code,          // filter เฉพาะสกุลเงินนั้น (optional)
        customer_group_id,
        salesperson_id,
        customer_code_from,
        customer_code_to,
        fx_only,                // 'true' → แสดงเฉพาะที่มีผลต่าง
        sort_by,                // 'customer' | 'net_desc' | 'net_asc'
    } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        // ─── ดึง base currency จากระบบ ───────────────────────────────────────
        const baseCurRes = await client.query(
            `SELECT currency_code FROM cd_currency WHERE base_currency_flag = TRUE LIMIT 1`
        );
        const baseCurrencyCode = baseCurRes.rows[0]?.currency_code || 'THB';

        // ─── Build filter params ──────────────────────────────────────────────
        const params  = [dateFrom, dateTo, baseCurrencyCode];
        const filters = [];

        if (currency_code) {
            params.push(currency_code);
            filters.push(`rec.currency_code = $${params.length}`);
        }
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
            filters.push(`rec.customer_code >= $${params.length}`);
        }
        if (customer_code_to) {
            params.push(customer_code_to);
            filters.push(`rec.customer_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

        // ─── Main query ───────────────────────────────────────────────────────
        // apply_type = 'invoice' เท่านั้น (ไม่รวม advance, cn, bc_*)
        const result = await client.query(`
            SELECT
                rec.id               AS receipt_id,
                rec.doc_no           AS receipt_no,
                rec.doc_date         AS receipt_date,
                rec.customer_id,
                rec.customer_code,
                rec.customer_name_th,
                rec.currency_code,
                COALESCE(rec.exchange_rate, 1) AS receipt_rate,
                inv.id               AS invoice_id,
                inv.doc_no           AS invoice_no,
                inv.doc_date         AS invoice_date,
                COALESCE(inv.exchange_rate, 1) AS invoice_rate,
                COALESCE(a.applied_amount_fc, 0) AS applied_fc
            FROM ar_transaction_apply a
            JOIN ar_transaction rec    ON rec.id = a.transaction_id
            JOIN sa_module_document rd ON rd.id  = rec.doc_id
            JOIN ar_transaction inv    ON inv.id  = a.applied_to_id
            JOIN sa_module_document id ON id.id   = inv.doc_id
            LEFT JOIN ar_customer c    ON c.id    = rec.customer_id
            WHERE rec.status          = 'Posted'
              AND rd.sys_doc_type     = '80'
              AND id.sys_doc_type     IN ('10','30','35')
              AND a.apply_type        = 'invoice'
              AND rec.currency_code  != $3
              AND rec.doc_date       >= $1::date
              AND rec.doc_date       <= $2::date
              ${extraFilters}
            ORDER BY rec.customer_code ASC, rec.currency_code ASC,
                     rec.doc_date ASC, rec.doc_no ASC, inv.doc_no ASC
        `, params);

        // ─── จัดกลุ่มตาม customer + currency ─────────────────────────────────
        const groupMap = new Map(); // key = `${customer_id}:${currency_code}`

        for (const row of result.rows) {
            const key = `${row.customer_id}:${row.currency_code}`;
            if (!groupMap.has(key)) {
                groupMap.set(key, {
                    customer_id:      row.customer_id,
                    customer_code:    row.customer_code,
                    customer_name_th: row.customer_name_th,
                    currency_code:    row.currency_code,
                    total_fc:         0,
                    weighted_inv_sum: 0, // SUM(fc × inv_rate) — ใช้หาร total_fc
                    weighted_rec_sum: 0, // SUM(fc × rec_rate)
                    fx_gain:          0,
                    fx_loss:          0,
                    fx_net:           0,
                    details:          [],
                });
            }
            const grp = groupMap.get(key);
            const fc        = Number(row.applied_fc   || 0);
            const invRate   = Number(row.invoice_rate || 1);
            const recRate   = Number(row.receipt_rate || 1);
            const fxAmount  = fc * (recRate - invRate); // บวก=กำไร, ลบ=ขาดทุน

            grp.total_fc         += fc;
            grp.weighted_inv_sum += fc * invRate;
            grp.weighted_rec_sum += fc * recRate;
            if (fxAmount >= 0) { grp.fx_gain += fxAmount; }
            else               { grp.fx_loss += Math.abs(fxAmount); }
            grp.fx_net           += fxAmount;

            grp.details.push({
                receipt_id:   row.receipt_id,
                receipt_no:   row.receipt_no,
                receipt_date: row.receipt_date,
                invoice_id:   row.invoice_id,
                invoice_no:   row.invoice_no,
                invoice_date: row.invoice_date,
                applied_fc:   fc,
                invoice_rate: invRate,
                receipt_rate: recRate,
                fx_amount:    fxAmount,
            });
        }

        // คำนวณ weighted average rates
        let groups = Array.from(groupMap.values()).map(g => ({
            ...g,
            weighted_inv_rate: g.total_fc > 0 ? g.weighted_inv_sum / g.total_fc : 0,
            weighted_rec_rate: g.total_fc > 0 ? g.weighted_rec_sum / g.total_fc : 0,
            weighted_inv_sum: undefined,
            weighted_rec_sum: undefined,
        }));

        // filter fx_only
        if (fx_only === 'true') {
            groups = groups.filter(g => Math.abs(g.fx_net) >= 0.005);
        }

        // sort
        if (sort_by === 'net_desc') {
            groups.sort((a, b) => b.fx_net - a.fx_net);
        } else if (sort_by === 'net_asc') {
            groups.sort((a, b) => a.fx_net - b.fx_net);
        }
        // default 'customer': already sorted by customer_code/currency from SQL

        res.json({ base_currency_code: baseCurrencyCode, rows: groups });
    } catch (err) {
        console.error('AR FX Gain/Loss Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getFxGainLossReport };
