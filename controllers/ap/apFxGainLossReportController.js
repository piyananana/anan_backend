// controllers/ap/apFxGainLossReportController.js
// รายงานกำไร/ขาดทุนจากอัตราแลกเปลี่ยน (AP FX Gain/Loss Report)
// คำนวณจาก: applied_amount_fc × (payment.exchange_rate − invoice.exchange_rate)
// หมายเหตุ: AP → จ่ายอัตราสูงกว่าตั้งหนี้ = ขาดทุน, จ่ายต่ำกว่า = กำไร

const getFxGainLossReport = async (req, res) => {
    const {
        date_from, date_to,
        currency_code,
        vendor_group_id,
        vendor_code_from,
        vendor_code_to,
        fx_only,   // 'true' → แสดงเฉพาะที่มีผลต่าง
        sort_by,   // 'vendor' | 'net_desc' | 'net_asc'
    } = req.query;

    const dateFrom = date_from || new Date().toISOString().slice(0, 10);
    const dateTo   = date_to   || new Date().toISOString().slice(0, 10);

    const client = await req.dbPool.connect();
    try {
        // ─── ดึง base currency ───────────────────────────────────────────────
        const baseCurRes = await client.query(
            `SELECT currency_code FROM cd_currency WHERE base_currency_flag = TRUE LIMIT 1`
        );
        const baseCurrencyCode = baseCurRes.rows[0]?.currency_code || 'THB';

        // ─── Build filter params ─────────────────────────────────────────────
        const params  = [dateFrom, dateTo, baseCurrencyCode];
        const filters = [];

        if (currency_code) {
            params.push(currency_code);
            filters.push(`pay.currency_code = $${params.length}`);
        }
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
            filters.push(`pay.vendor_code >= $${params.length}`);
        }
        if (vendor_code_to) {
            params.push(vendor_code_to);
            filters.push(`pay.vendor_code <= $${params.length}`);
        }

        const extraFilters = filters.length > 0
            ? 'AND ' + filters.join('\n              AND ')
            : '';

        // ─── Main query ──────────────────────────────────────────────────────
        // apply_type = 'invoice' → payment ตัดยอดใบสั่งซื้อ/DN
        const result = await client.query(`
            SELECT
                pay.id               AS payment_id,
                pay.doc_no           AS payment_no,
                pay.doc_date         AS payment_date,
                pay.vendor_id,
                pay.vendor_code,
                pay.vendor_name_th,
                v.vendor_name_en,
                pay.currency_code,
                COALESCE(pay.exchange_rate, 1) AS payment_rate,
                inv.id               AS invoice_id,
                inv.doc_no           AS invoice_no,
                inv.doc_date         AS invoice_date,
                COALESCE(inv.exchange_rate, 1) AS invoice_rate,
                COALESCE(a.applied_amount_fc, 0) AS applied_fc
            FROM ap_transaction_apply a
            JOIN ap_transaction pay     ON pay.id = a.transaction_id
            JOIN sa_module_document pd  ON pd.id  = pay.doc_id
            JOIN ap_transaction inv     ON inv.id  = a.applied_to_id
            JOIN sa_module_document id  ON id.id   = inv.doc_id
            LEFT JOIN ap_vendor v       ON v.id    = pay.vendor_id
            WHERE pay.status          = 'Posted'
              AND pd.sys_doc_type     = '80'
              AND id.sys_doc_type     IN ('10', '50')
              AND a.apply_type        = 'invoice'
              AND pay.currency_code  != $3
              AND pay.doc_date       >= $1::date
              AND pay.doc_date       <= $2::date
              ${extraFilters}
            ORDER BY pay.vendor_code ASC, pay.currency_code ASC,
                     pay.doc_date ASC, pay.doc_no ASC, inv.doc_no ASC
        `, params);

        // ─── จัดกลุ่มตาม vendor + currency ──────────────────────────────────
        const groupMap = new Map(); // key = `${vendor_id}:${currency_code}`

        for (const row of result.rows) {
            const key = `${row.vendor_id}:${row.currency_code}`;
            if (!groupMap.has(key)) {
                groupMap.set(key, {
                    vendor_id:        row.vendor_id,
                    vendor_code:      row.vendor_code,
                    vendor_name_th:   row.vendor_name_th,
                    vendor_name_en:   row.vendor_name_en,
                    currency_code:    row.currency_code,
                    total_fc:         0,
                    weighted_inv_sum: 0,
                    weighted_pay_sum: 0,
                    fx_gain:          0,
                    fx_loss:          0,
                    fx_net:           0,
                    details:          [],
                });
            }
            const grp = groupMap.get(key);
            const fc       = Number(row.applied_fc    || 0);
            const invRate  = Number(row.invoice_rate  || 1);
            const payRate  = Number(row.payment_rate  || 1);
            // AP: จ่ายอัตราต่ำกว่าตั้งหนี้ = กำไร (ลบน้อยกว่าที่บันทึกไว้)
            const fxAmount = fc * (invRate - payRate);

            grp.total_fc         += fc;
            grp.weighted_inv_sum += fc * invRate;
            grp.weighted_pay_sum += fc * payRate;
            if (fxAmount >= 0) { grp.fx_gain += fxAmount; }
            else               { grp.fx_loss += Math.abs(fxAmount); }
            grp.fx_net           += fxAmount;

            grp.details.push({
                payment_id:   row.payment_id,
                payment_no:   row.payment_no,
                payment_date: row.payment_date,
                invoice_id:   row.invoice_id,
                invoice_no:   row.invoice_no,
                invoice_date: row.invoice_date,
                applied_fc:   fc,
                invoice_rate: invRate,
                payment_rate: payRate,
                fx_amount:    fxAmount,
            });
        }

        // คำนวณ weighted average rates
        let groups = Array.from(groupMap.values()).map(g => ({
            ...g,
            weighted_inv_rate: g.total_fc > 0 ? g.weighted_inv_sum / g.total_fc : 0,
            weighted_pay_rate: g.total_fc > 0 ? g.weighted_pay_sum / g.total_fc : 0,
            weighted_inv_sum:  undefined,
            weighted_pay_sum:  undefined,
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

        res.json({ base_currency_code: baseCurrencyCode, rows: groups });
    } catch (err) {
        console.error('AP FX Gain/Loss Report error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getFxGainLossReport };
