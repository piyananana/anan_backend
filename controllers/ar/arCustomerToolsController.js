// controllers/ar/arCustomerToolsController.js
// เครื่องมือของหน้าจอลูกค้าแบบใหม่ (user 2026-11-28, IM design B):
//   - GET /ar_customer/balances        ยอดค้าง/เกินกำหนดต่อลูกค้า — การ์ดรายการ + ตัวกรอง "เกินกำหนด" / "เกินวงเงิน"
//   - GET /ar_customer/:id/summary     ตัวเลขสรุป (ยอดค้าง, เกินกำหนด, วงเงินที่ใช้ไป, ขาย/รับชำระล่าสุด),
//                                      ยอดค้างตามอายุหนี้, เอกสารค้าง 10 ใบเก่าสุด, ที่มาของบัญชีลูกหนี้ (ลูกค้า > กลุ่ม > ประเภทเอกสาร)
// ยอดค้างคิดแบบเดียวกับการตรวจวงเงิน (utils/creditCheck.customerExposure):
//   ใบแจ้งหนี้/เพิ่มหนี้ (10,30,35) ที่ยังค้าง − ใบลดหนี้/มัดจำ (50,55,60) ที่ยังไม่ได้ตัด, สกุลหลัก, เฉพาะ Posted
// วงเงินที่ใช้ไปในหน้ารายละเอียด = ยอดค้าง + ใบส่งสินค้ารอตั้งหนี้ (IM 32) เหมือนตอนตรวจวงเงินจริง
'use strict';

const { today } = require('../../utils/dateUtil');
const { customerExposure, ensureCreditSchema } = require('../../utils/creditCheck');

const DEBIT = `('10','30','35')`;
const OPEN_TYPES = `('10','30','35','50','55','60')`;

// GET /ar_customer/balances
const fetchBalances = async (req, res) => {
    try {
        const r = await req.dbPool.query(`
            SELECT t.customer_id,
                   SUM(CASE WHEN d.sys_doc_type IN ${DEBIT} THEN t.balance_amount_lc ELSE -t.balance_amount_lc END)::float AS outstanding,
                   COALESCE(SUM(t.balance_amount_lc) FILTER (WHERE d.sys_doc_type IN ${DEBIT}
                       AND COALESCE(t.due_date, t.doc_date) < $1::date), 0)::float AS overdue,
                   COUNT(*) FILTER (WHERE d.sys_doc_type IN ${DEBIT} AND COALESCE(t.due_date, t.doc_date) < $1::date)::int AS overdue_count,
                   COUNT(*) FILTER (WHERE d.sys_doc_type IN ${DEBIT})::int AS open_count
              FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
             WHERE t.status = 'Posted' AND t.balance_amount_lc > 0.005 AND d.sys_doc_type IN ${OPEN_TYPES}
             GROUP BY t.customer_id`, [today()]);
        res.json(r.rows);
    } catch (err) {
        console.error('ar_customer balances error:', err);
        res.status(500).json({ message: err.message });
    }
};

// GET /ar_customer/:id/summary
const fetchSummary = async (req, res) => {
    const id = Number(req.params.id) || 0;
    const asOf = today();
    const client = await req.dbPool.connect();
    try {
        const cust = (await client.query(`
            SELECT c.id, c.customer_group_id, c.ar_account_id,
                   a.account_code AS ar_account_code, a.account_name_thai AS ar_account_name_thai, a.account_name_eng AS ar_account_name_eng,
                   g.group_code, g.gl_account_id AS group_account_id,
                   ga.account_code AS group_account_code, ga.account_name_thai AS group_account_name_thai, ga.account_name_eng AS group_account_name_eng
              FROM ar_customer c
              LEFT JOIN gl_account a ON a.id = c.ar_account_id
              LEFT JOIN ar_customer_group g ON g.id = c.customer_group_id
              LEFT JOIN gl_account ga ON ga.id = g.gl_account_id
             WHERE c.id = $1`, [id])).rows[0];
        if (!cust) return res.status(404).json({ message: 'Customer not found' });

        await ensureCreditSchema(client);
        const exposure = await customerExposure(client, id);

        // เอกสารค้างฝั่งหนี้ (ใบแจ้งหนี้/เพิ่มหนี้) + อายุหนี้
        const open = (await client.query(`
            SELECT t.id, t.doc_no, d.doc_code, t.doc_date::text AS doc_date, COALESCE(t.due_date, t.doc_date)::text AS due_date,
                   t.balance_amount_lc::float AS balance,
                   ($1::date - COALESCE(t.due_date, t.doc_date)::date) AS days_overdue
              FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
             WHERE t.customer_id = $2 AND t.status = 'Posted' AND t.balance_amount_lc > 0.005 AND d.sys_doc_type IN ${DEBIT}
             ORDER BY COALESCE(t.due_date, t.doc_date), t.doc_date, t.id`, [asOf, id])).rows;

        const aging = { not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, over_90: 0, total: 0 };
        let overdue = 0, overdueCount = 0, maxDays = 0;
        for (const o of open) {
            const days = Number(o.days_overdue) || 0;
            const b = Number(o.balance) || 0;
            aging.total += b;
            if (days <= 0) aging.not_due += b;
            else if (days <= 30) aging.d1_30 += b;
            else if (days <= 60) aging.d31_60 += b;
            else if (days <= 90) aging.d61_90 += b;
            else aging.over_90 += b;
            if (days > 0) { overdue += b; overdueCount++; if (days > maxDays) maxDays = days; }
        }
        for (const k of Object.keys(aging)) aging[k] = Math.round(aging[k] * 100) / 100;

        // ใบลดหนี้/มัดจำที่ยังไม่ได้ตัด
        const credits = (await client.query(`
            SELECT COALESCE(SUM(t.balance_amount_lc), 0)::float AS amt, COUNT(*)::int AS cnt
              FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
             WHERE t.customer_id = $1 AND t.status = 'Posted' AND t.balance_amount_lc > 0.005 AND d.sys_doc_type IN ('50','55','60')`,
            [id])).rows[0];

        const last = async (types) => (await client.query(`
            SELECT t.doc_no, t.doc_date::text AS doc_date
              FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
             WHERE t.customer_id = $1 AND t.status = 'Posted' AND d.sys_doc_type IN ${types}
             ORDER BY t.doc_date DESC, t.id DESC LIMIT 1`, [id])).rows[0] || null;

        // บัญชีลูกหนี้ตามประเภทเอกสาร (ระดับสุดท้าย) — เฉพาะประเภทที่ตั้งหนี้
        const docAccounts = (await client.query(`
            SELECT s.doc_code, d.sys_doc_type, a.account_code, a.account_name_thai, a.account_name_eng
              FROM ar_gl_account_setup s
              JOIN sa_module_document d ON d.doc_code = s.doc_code AND d.sys_module = '11'
              LEFT JOIN gl_account a ON a.id = s.ar_account_id
             WHERE d.sys_doc_type IN ${DEBIT} OR d.sys_doc_type IN ('50','55')
             ORDER BY d.sys_doc_type, s.doc_code`)).rows;

        res.json({
            as_of: asOf,
            outstanding: exposure?.ar_outstanding ?? 0,
            unbilled_delivery: exposure?.unbilled_delivery ?? 0,
            credit_used: exposure?.outstanding ?? 0,
            credit_limit: exposure?.credit_limit ?? 0,
            open_count: open.length,
            overdue: Math.round(overdue * 100) / 100,
            overdue_count: overdueCount,
            max_days_overdue: maxDays,
            open_credits: credits.amt,
            open_credit_count: credits.cnt,
            aging,
            oldest_docs: open.slice(0, 10).map(o => ({ ...o, days_overdue: Number(o.days_overdue) })),
            last_sale: await last(DEBIT),
            last_receipt: await last(`('80')`),
            ar_account: {
                customer: cust.ar_account_id
                    ? { id: cust.ar_account_id, code: cust.ar_account_code, name_thai: cust.ar_account_name_thai, name_eng: cust.ar_account_name_eng } : null,
                group_code: cust.group_code,
                group: cust.group_account_id
                    ? { id: cust.group_account_id, code: cust.group_account_code, name_thai: cust.group_account_name_thai, name_eng: cust.group_account_name_eng } : null,
                doc_types: docAccounts,
            },
        });
    } catch (err) {
        console.error('ar_customer summary error:', err);
        res.status(500).json({ message: err.message });
    } finally {
        client.release();
    }
};

// GET /ar_customer_group/:id/summary — ตัวเลขสรุปของกลุ่ม + ลูกค้าในกลุ่ม (ใช้ค่าของกลุ่มหรือตั้งเอง)
const fetchGroupSummary = async (req, res) => {
    const id = Number(req.params.id) || 0;
    try {
        const g = (await req.dbPool.query(
            `SELECT id, credit_term_months, credit_term_days, credit_limit, discount_percent FROM ar_customer_group WHERE id = $1`, [id])).rows[0];
        if (!g) return res.status(404).json({ message: 'Customer group not found' });
        const rows = (await req.dbPool.query(`
            SELECT c.id, c.customer_code, c.customer_name_th, c.customer_name_en, c.is_active,
                   c.credit_term_months, c.credit_term_days, COALESCE(c.credit_limit, 0)::float AS credit_limit,
                   COALESCE(c.discount_percent, 0)::float AS discount_percent, c.ar_account_id,
                   COALESCE(c.is_code_auto_generated, false) AS is_code_auto_generated,
                   COALESCE(b.outstanding, 0)::float AS outstanding, COALESCE(b.overdue, 0)::float AS overdue
              FROM ar_customer c
              LEFT JOIN LATERAL (
                  SELECT SUM(CASE WHEN d.sys_doc_type IN ${DEBIT} THEN t.balance_amount_lc ELSE -t.balance_amount_lc END) AS outstanding,
                         SUM(t.balance_amount_lc) FILTER (WHERE d.sys_doc_type IN ${DEBIT}
                             AND COALESCE(t.due_date, t.doc_date) < $2::date) AS overdue
                    FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
                   WHERE t.customer_id = c.id AND t.status = 'Posted' AND t.balance_amount_lc > 0.005
                     AND d.sys_doc_type IN ${OPEN_TYPES}) b ON true
             WHERE c.customer_group_id = $1
             ORDER BY c.customer_code`, [id, today()])).rows;
        const same = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.005;
        const customers = rows.map(r => ({
            ...r,
            same_term: Number(r.credit_term_months) === Number(g.credit_term_months) && Number(r.credit_term_days) === Number(g.credit_term_days),
            same_limit: same(r.credit_limit, g.credit_limit),
            same_discount: same(r.discount_percent, g.discount_percent),
        }));
        const sum = (k) => Math.round(customers.reduce((t, c) => t + Number(c[k] || 0), 0) * 100) / 100;
        res.json({
            customer_count: customers.length,
            active_count: customers.filter(c => c.is_active).length,
            outstanding: sum('outstanding'),
            overdue: sum('overdue'),
            overdue_customers: customers.filter(c => c.overdue > 0.005).length,
            own_terms_count: customers.filter(c => !(c.same_term && c.same_limit && c.same_discount)).length,
            own_account_count: customers.filter(c => c.ar_account_id).length,
            customers,
        });
    } catch (err) {
        console.error('ar_customer_group summary error:', err);
        res.status(500).json({ message: err.message });
    }
};

// GET /ar_collector/:id/summary — ลูกค้าที่ผู้วางบิล/ผู้เก็บเงินคนนี้รับผิดชอบ + ยอดค้าง/เกินกำหนด
const fetchCollectorSummary = async (req, res) => {
    const id = Number(req.params.id) || 0;
    try {
        const rows = (await req.dbPool.query(`
            SELECT c.id, c.customer_code, c.customer_name_th, c.customer_name_en, c.is_active,
                   (c.billing_collector_id = $1) AS is_biller, (c.collection_collector_id = $1) AS is_collector,
                   COALESCE(b.outstanding, 0)::float AS outstanding, COALESCE(b.overdue, 0)::float AS overdue,
                   COALESCE(b.open_count, 0)::int AS open_count
              FROM ar_customer c
              LEFT JOIN LATERAL (
                  SELECT SUM(CASE WHEN d.sys_doc_type IN ${DEBIT} THEN t.balance_amount_lc ELSE -t.balance_amount_lc END) AS outstanding,
                         SUM(t.balance_amount_lc) FILTER (WHERE d.sys_doc_type IN ${DEBIT}
                             AND COALESCE(t.due_date, t.doc_date) < $2::date) AS overdue,
                         COUNT(*) FILTER (WHERE d.sys_doc_type IN ${DEBIT}) AS open_count
                    FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
                   WHERE t.customer_id = c.id AND t.status = 'Posted' AND t.balance_amount_lc > 0.005
                     AND d.sys_doc_type IN ${OPEN_TYPES}) b ON true
             WHERE c.billing_collector_id = $1 OR c.collection_collector_id = $1
             ORDER BY c.customer_code`, [id, today()])).rows;
        const r2 = (v) => Math.round(v * 100) / 100;
        const coll = rows.filter(r => r.is_collector);
        res.json({
            billing_count: rows.filter(r => r.is_biller).length,
            collection_count: coll.length,
            // ยอดที่ต้องตามเก็บ = ลูกค้าที่คนนี้เป็นผู้เก็บเงิน
            outstanding: r2(coll.reduce((t, r) => t + r.outstanding, 0)),
            overdue: r2(coll.reduce((t, r) => t + r.overdue, 0)),
            overdue_customers: coll.filter(r => r.overdue > 0.005).length,
            open_docs: coll.reduce((t, r) => t + r.open_count, 0),
            customers: rows,
        });
    } catch (err) {
        console.error('ar_collector summary error:', err);
        res.status(500).json({ message: err.message });
    }
};

// GET /ar_year_end_setup/summary — ค่าเผื่อหนี้สงสัยจะสูญตามอัตราปัจจุบัน ณ วันนี้ (แยกตามช่วงอายุหนี้)
// คิดแบบเดียวกับ arAllowanceRunController.calcAllowanceDetails: ใบแจ้งหนี้/เพิ่มหนี้ที่ค้าง ครบกำหนดแล้ว,
// อายุ = วันนี้ − วันครบกำหนด, ใช้ช่วงแรกที่เข้า (ตามลำดับ) — ยอดสะสมเดิม = ยอดบัญชีค่าเผื่อใน GL, + ยอดค้างสกุลต่างประเทศ
const fetchYearEndSummary = async (req, res) => {
    const asOf = today();
    try {
        const db = req.dbPool;
        const setup = (await db.query('SELECT * FROM ar_year_end_setup LIMIT 1')).rows[0] || {};
        const rules = (await db.query(
            'SELECT * FROM ar_allowance_rule WHERE is_active = true ORDER BY sort_order, age_from_days')).rows;
        const inv = (await db.query(`
            SELECT t.balance_amount_lc::float AS bal, GREATEST(0, $1::date - COALESCE(t.due_date, t.doc_date)) AS age
              FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
             WHERE d.sys_doc_type IN ${DEBIT} AND t.status = 'Posted' AND t.balance_amount_lc > 0.005
               AND COALESCE(t.due_date, t.doc_date) <= $1::date`, [asOf])).rows;
        const by = rules.map(r => ({ id: r.id, age_from_days: r.age_from_days, age_to_days: r.age_to_days, rate: Number(r.rate),
            doc_count: 0, balance: 0, allowance: 0 }));
        let unmatchedBal = 0, unmatchedCount = 0;
        for (const i of inv) {
            const age = Number(i.age) || 0;
            const k = by.findIndex(r => age >= r.age_from_days && (r.age_to_days === null || age <= r.age_to_days));
            if (k < 0) { unmatchedBal += i.bal; unmatchedCount++; continue; }
            by[k].doc_count++;
            by[k].balance += i.bal;
            by[k].allowance += Math.round(i.bal * by[k].rate / 100 * 100) / 100;
        }
        const r2 = (v) => Math.round(v * 100) / 100;
        for (const b of by) { b.balance = r2(b.balance); b.allowance = r2(b.allowance); }
        const total = r2(by.reduce((t, b) => t + b.allowance, 0));
        let prior = 0;
        if (setup.allowance_contra_account_id) {
            const g = (await db.query(`
                SELECT COALESCE(SUM(ged.credit_lc - ged.debit_lc), 0)::float AS bal
                  FROM gl_entry_detail ged JOIN gl_entry_header geh ON geh.id = ged.header_id
                 WHERE ged.account_id = $1 AND geh.status = 'Posted'`, [setup.allowance_contra_account_id])).rows[0];
            prior = Math.abs(Number(g.bal) || 0);
        }
        const { BASE_CURRENCY_CODE_SQL } = require('../../utils/baseCurrency');
        const fx = (await db.query(`
            SELECT t.currency_code, COUNT(*)::int AS doc_count, SUM(t.balance_amount_lc)::float AS balance_lc
              FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
             WHERE d.sys_doc_type IN ${DEBIT} AND t.status = 'Posted' AND t.balance_amount_lc > 0.005
               AND t.currency_code <> ${BASE_CURRENCY_CODE_SQL}
             GROUP BY t.currency_code ORDER BY t.currency_code`)).rows;
        res.json({
            as_of: asOf,
            rules: by,
            total_allowance: total,
            prior_allowance: r2(prior),
            adjustment: r2(total - prior),
            unmatched_balance: r2(unmatchedBal),
            unmatched_count: unmatchedCount,
            fx_currencies: fx,
        });
    } catch (err) {
        console.error('ar_year_end summary error:', err);
        res.status(500).json({ message: err.message });
    }
};

module.exports = { fetchBalances, fetchSummary, fetchGroupSummary, fetchCollectorSummary, fetchYearEndSummary };
