// controllers/gl/glAccountToolsController.js
// เครื่องมือของหน้าจอผังบัญชีแบบใหม่ (user 2026-11-28, IM design B):
//   - GET /gl_account/balances?fiscal_year_id=   ยอดสุทธิ (เดบิต-เครดิต) ทั้งปีบัญชีต่อบัญชี — ต้นไม้แสดงยอดข้างบัญชี
//                                                 (หัวบัญชีรวมยอดลูกฝั่งหน้าจอ)
//   - GET /gl_account/:id/summary?fiscal_year_id= ยอดรายงวด, ยอด ณ วันนี้, จำนวนบรรทัด, เคลื่อนไหวล่าสุด (หัวบัญชี = รวมทั้งกิ่ง)
//                                                 + ที่ที่ตั้งค่าใช้บัญชีนี้ (ตั้งค่า AR/AP/IM/CM/MO, ลูกค้า/ผู้ขาย/สินค้า ฯลฯ)
//   - PUT /gl_account/:id/move { parent_id }      ย้ายไปอยู่ใต้หัวบัญชีอื่น (ลากบนต้นไม้) — ต้องเป็นหัวบัญชี ประเภทเดียวกัน
//                                                 ไม่ใช่ลูกหลานของตัวเอง (null = ระดับบนสุด)
// ยอดมาจาก gl_balance_accum (trigger ดูแล, จำนวนเงินเป็นสกุลหลัก) — งวดแรกของปี (period_number ต่ำสุด) = งวดยอดยกมา
'use strict';

const { today } = require('../../utils/dateUtil');

const tableExists = async (client, name) =>
    !!(await client.query(`SELECT to_regclass($1) AS t`, [`public.${name}`])).rows[0].t;

// ปีบัญชีที่ขอ / ปีที่ครอบวันนี้ / ปีล่าสุด
const resolveFiscalYear = async (client, fiscalYearId) => {
    const fy = Number(fiscalYearId) || 0;
    if (fy) {
        const r = await client.query(`SELECT id, fy_code, year_start_date::text AS start_date, year_end_date::text AS end_date FROM gl_fiscal_year WHERE id = $1`, [fy]);
        if (r.rows.length) return r.rows[0];
    }
    const r = await client.query(`
        SELECT id, fy_code, year_start_date::text AS start_date, year_end_date::text AS end_date FROM gl_fiscal_year
         ORDER BY (year_start_date <= $1::date AND year_end_date >= $1::date) DESC, year_start_date DESC LIMIT 1`, [today()]);
    return r.rows[0] || null;
};

const fiscalYears = async (client) => (await client.query(
    `SELECT id, fy_code FROM gl_fiscal_year ORDER BY year_start_date`)).rows;

// id ของบัญชีนี้ + บัญชีย่อยทุกระดับ
const subtreeIds = async (client, id) => (await client.query(`
    WITH RECURSIVE t AS (SELECT id FROM gl_account WHERE id = $1
                         UNION ALL SELECT a.id FROM gl_account a JOIN t ON a.parent_id = t.id)
    SELECT id FROM t`, [id])).rows.map(r => r.id);

// GET /gl_account/balances
const fetchBalances = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const fy = await resolveFiscalYear(client, req.query.fiscal_year_id);
        if (!fy) return res.json({ fiscal_year: null, rows: [] });
        const r = await client.query(`
            SELECT b.account_id, SUM(b.debit_amount)::float8 AS debit, SUM(b.credit_amount)::float8 AS credit
              FROM gl_balance_accum b JOIN gl_posting_period p ON p.id = b.period_id
             WHERE p.fiscal_year_id = $1
             GROUP BY b.account_id`, [fy.id]);
        res.json({ fiscal_year: fy, rows: r.rows });
    } catch (err) {
        console.error('gl_account balances:', err);
        res.status(500).json({ message: err.message });
    } finally {
        client.release();
    }
};

// ── ที่ที่ตั้งค่าใช้บัญชี ──
// table → โมดูล, ชื่อหน้าจอ, หน้าจอที่เปิด (Menu target_path), รหัส/ชื่อของแถวที่อ้าง
const USAGE_TABLES = {
    ar_gl_account_setup:     { module: 'AR', th: 'ตั้งค่าบัญชี GL ตามประเภทเอกสาร', en: 'GL setup by document type', screen: 'ArGlAccountSetupScreen', code: 'doc_code' },
    ap_gl_account_setup:     { module: 'AP', th: 'ตั้งค่าบัญชี GL ตามประเภทเอกสาร', en: 'GL setup by document type', screen: 'ApGlAccountSetupScreen', code: 'doc_code' },
    im_gl_account_setup:     { module: 'IM', th: 'ตั้งค่าบัญชี GL ตามประเภทเอกสาร', en: 'GL setup by document type', screen: 'ImGlAccountSetupScreen', code: 'doc_code' },
    cm_transaction_gl_setup: { module: 'CM', th: 'ตั้งค่าบัญชี GL ตามประเภทเอกสาร', en: 'GL setup by document type', screen: 'CmTransactionGlSetupScreen', code: 'doc_code' },
    mo_gl_account_setup:     { module: 'MO', th: 'ตั้งค่าบัญชี GL ตามประเภทเอกสาร', en: 'GL setup by document type', screen: 'MoGlAccountSetupScreen', code: 'doc_code' },
    ar_customer:             { module: 'AR', th: 'ลูกค้า', en: 'Customer', screen: 'ArCustomerScreen', code: 'customer_code', th_name: 'customer_name_th', en_name: 'customer_name_en' },
    ar_customer_group:       { module: 'AR', th: 'กลุ่มลูกค้า', en: 'Customer group', screen: 'ArCustomerGroupScreen', code: 'group_code', th_name: 'group_name_thai', en_name: 'group_name_eng' },
    ar_year_end_setup:       { module: 'AR', th: 'ตั้งค่าสิ้นปี AR', en: 'AR year-end setup', screen: 'ArYearEndSetupScreen' },
    ap_vendor:               { module: 'AP', th: 'ผู้ขาย', en: 'Vendor', screen: 'ApVendorScreen', code: 'vendor_code', th_name: 'vendor_name_th', en_name: 'vendor_name_en' },
    ap_vendor_group:         { module: 'AP', th: 'กลุ่มผู้ขาย', en: 'Vendor group', screen: 'ApVendorGroupScreen', code: 'group_code', th_name: 'group_name_thai', en_name: 'group_name_eng' },
    ap_year_end_setup:       { module: 'AP', th: 'ตั้งค่าสิ้นปี AP', en: 'AP year-end setup', screen: 'ApYearEndSetupScreen' },
    im_accounting_setting:   { module: 'IM', th: 'ตั้งค่าบัญชีสินค้า (ค่าเริ่มต้นบริษัท)', en: 'Inventory accounting (company default)', screen: 'ImAccountingSettingScreen' },
    im_item:                 { module: 'IM', th: 'สินค้า', en: 'Item', screen: 'ImItemScreen', code: 'item_code', th_name: 'item_name_th', en_name: 'item_name_en' },
    im_item_category:        { module: 'IM', th: 'หมวดสินค้า', en: 'Item category', screen: 'ImItemCategoryScreen', code: 'category_code', th_name: 'category_name_th', en_name: 'category_name_en' },
    im_warehouse:            { module: 'IM', th: 'คลังสินค้า', en: 'Warehouse', screen: 'ImWarehouseScreen', code: 'warehouse_code', th_name: 'warehouse_name_th', en_name: 'warehouse_name_en' },
    cm_bank_account:         { module: 'CM', th: 'บัญชีธนาคาร', en: 'Bank account', screen: 'CmBankAccountScreen', code: 'account_code', th_name: 'account_name_th', en_name: 'account_name_en' },
    cm_payment_method:       { module: 'CM', th: 'วิธีการชำระเงิน', en: 'Payment method', screen: 'CmPaymentMethodScreen', code: 'method_code', th_name: 'method_name_th', en_name: 'method_name_en' },
    cm_gl_account_setup:     { module: 'CM', th: 'ตั้งค่าบัญชี CM', en: 'CM GL setup' },
    cd_vat_rate:             { module: 'CD', th: 'อัตราภาษีมูลค่าเพิ่ม', en: 'VAT rate', screen: 'VatRateScreen', code: 'vat_code', th_name: 'vat_name_th', en_name: 'vat_name_en' },
    cd_wht_type:             { module: 'CD', th: 'ประเภทภาษีหัก ณ ที่จ่าย', en: 'WHT type', screen: 'CdWhtTypeScreen', code: 'wht_code', th_name: 'wht_name', en_name: 'wht_name_en' },
    gl_closing_config:       { module: 'GL', th: 'ตั้งค่าปิดบัญชีสิ้นปี', en: 'Year-end closing setup', screen: 'YearEndClosingConfigScreen' },
    gl_adjusting_template:   { module: 'GL', th: 'แม่แบบรายการปรับปรุง', en: 'Adjusting template', th_name: 'template_name' },
};
// คอลัมน์ที่อ้าง gl_account แต่ไม่มี foreign key
const NON_FK = [
    ['ap_year_end_setup', 'fx_gain_account_id'], ['ap_year_end_setup', 'fx_loss_account_id'],
    ['ap_year_end_setup', 'unrealized_fx_gain_account_id'], ['ap_year_end_setup', 'unrealized_fx_loss_account_id'],
    ['ar_customer', 'ar_account_id'], ['cm_gl_account_setup', 'gl_account_id'],
];
// ชื่อช่องบัญชี (ตัด _account_id / _id ออกแล้ว)
const FIELD_LABELS = {
    ar: ['บัญชีลูกหนี้', 'AR account'], ap: ['บัญชีเจ้าหนี้', 'AP account'], revenue: ['บัญชีรายได้', 'Revenue'],
    expense: ['บัญชีค่าใช้จ่าย', 'Expense'], vat_output: ['ภาษีขาย', 'Output VAT'], vat_input: ['ภาษีซื้อ', 'Input VAT'],
    vat_pending_output: ['ภาษีขายรอเรียกเก็บ', 'Pending output VAT'], vat_pending_input: ['ภาษีซื้อยังไม่ถึงกำหนด', 'Pending input VAT'],
    discount: ['ส่วนลด', 'Discount'], advance: ['เงินมัดจำ/รับล่วงหน้า', 'Advance / deposit'], cash: ['เงินสด', 'Cash'],
    check: ['เช็ค', 'Cheque'], transfer: ['เงินโอน', 'Transfer'], credit_card: ['บัตรเครดิต', 'Credit card'], debit_card: ['บัตรเดบิต', 'Debit card'],
    qr_code: ['QR Code', 'QR code'], mobile_banking: ['Mobile banking', 'Mobile banking'], bill_of_exchange: ['ตั๋วแลกเงิน', 'Bill of exchange'],
    wht: ['ภาษีถูกหัก ณ ที่จ่าย', 'WHT'], wht_payable: ['ภาษีหัก ณ ที่จ่ายค้างจ่าย', 'WHT payable'], wht_prepaid: ['ภาษีถูกหัก ณ ที่จ่าย', 'Prepaid WHT'],
    fx_gain: ['กำไรอัตราแลกเปลี่ยน', 'FX gain'], fx_loss: ['ขาดทุนอัตราแลกเปลี่ยน', 'FX loss'],
    unrealized_fx_gain: ['กำไรอัตราแลกเปลี่ยนยังไม่เกิดขึ้น', 'Unrealized FX gain'], unrealized_fx_loss: ['ขาดทุนอัตราแลกเปลี่ยนยังไม่เกิดขึ้น', 'Unrealized FX loss'],
    allowance_expense: ['หนี้สงสัยจะสูญ', 'Bad debt expense'], allowance_contra: ['ค่าเผื่อหนี้สงสัยจะสูญ', 'Allowance for doubtful accounts'],
    inventory: ['สินค้าคงคลัง', 'Inventory'], cogs: ['ต้นทุนขาย', 'COGS'], purchases: ['ซื้อสินค้า', 'Purchases'],
    variance: ['ผลต่างต้นทุน', 'Cost variance'], wip: ['งานระหว่างผลิต', 'WIP'], grir: ['รับสินค้ารอใบแจ้งหนี้ (GR/IR)', 'GR/IR clearing'],
    consignment_payable: ['เจ้าหนี้สินค้าฝากขาย', 'Consignment payable'], applied_labor: ['ค่าแรงปันเข้างาน', 'Applied labor'],
    applied_overhead: ['โสหุ้ยปันเข้างาน', 'Applied overhead'], petty_cash_payable: ['เจ้าหนี้เงินสดย่อย', 'Petty cash payable'],
    gl: ['บัญชี GL', 'GL account'], income_summary: ['บัญชีสรุปกำไรขาดทุน', 'Income summary'], retained_earnings: ['บัญชีกำไรสะสม', 'Retained earnings'],
    debit: ['บัญชีเดบิต', 'Debit account'], credit: ['บัญชีเครดิต', 'Credit account'],
};
const fieldLabel = (col) => {
    const k = col.replace(/_account_id$/, '').replace(/_id$/, '');
    return FIELD_LABELS[k] || [col, col];
};
const USAGE_LIMIT = 20; // แถวต่อหน้าจอตั้งค่า (สินค้าอาจมีหลายร้อย)

const accountUsage = async (client, accountId) => {
    const fk = (await client.query(`
        SELECT DISTINCT kcu.table_name, kcu.column_name
          FROM information_schema.referential_constraints rc
          JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema
          JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
         WHERE ccu.table_name = 'gl_account'`)).rows.map(r => [r.table_name, r.column_name]);
    const cols = (await client.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`)).rows;
    const have = new Set(cols.map(x => `${x.table_name}.${x.column_name}`));
    const byTable = {};
    for (const [t, c] of [...fk, ...NON_FK]) {
        if (!USAGE_TABLES[t] || !have.has(`${t}.${c}`)) continue;
        (byTable[t] ||= new Set()).add(c);
    }
    const out = [];
    for (const [t, set] of Object.entries(byTable)) {
        const cfg = USAGE_TABLES[t];
        const col = (c) => (c && have.has(`${t}.${c}`) ? `"${c}"::text` : `NULL::text`);
        const parts = [...set].map(c => `SELECT '${c}' AS field, ${col(cfg.code)} AS ref_code, ${col(cfg.th_name)} AS ref_name_th, ${col(cfg.en_name)} AS ref_name_en
                                               FROM "${t}" WHERE "${c}" = $1`);
        const r = await client.query(`SELECT *, COUNT(*) OVER ()::int AS total FROM (${parts.join(' UNION ALL ')}) u
                                      ORDER BY ref_code NULLS FIRST, field LIMIT ${USAGE_LIMIT}`, [accountId]);
        for (const x of r.rows) {
            const [fth, fen] = fieldLabel(x.field);
            out.push({ module: cfg.module, table: t, screen_th: cfg.th, screen_en: cfg.en, target_path: cfg.screen || null,
                ref_code: x.ref_code, ref_name_th: x.ref_name_th, ref_name_en: x.ref_name_en, field_th: fth, field_en: fen, total: x.total });
        }
    }
    // หัวบัญชีที่งบการเงินใช้รวมยอด
    if (have.has('gl_fin_report_row_acct.header_account_code') && have.has('gl_fin_report_row.report_id')) {
        const r = await client.query(`
            SELECT DISTINCT f.report_code, f.report_name_thai, f.report_name_eng, w.label_thai, w.label_eng
              FROM gl_fin_report_row_acct ra
              JOIN gl_fin_report_row w ON w.id = ra.row_id
              JOIN gl_fin_report f ON f.id = w.report_id
             WHERE ra.header_account_code = (SELECT account_code FROM gl_account WHERE id = $1)
             ORDER BY f.report_code LIMIT ${USAGE_LIMIT}`, [accountId]);
        for (const x of r.rows) {
            out.push({ module: 'GL', table: 'gl_fin_report_row_acct', screen_th: 'งบการเงิน', screen_en: 'Financial report', target_path: 'FinancialReportBuilderScreen',
                ref_code: x.report_code, ref_name_th: x.report_name_thai, ref_name_en: x.report_name_eng || x.report_name_thai,
                field_th: x.label_thai || 'หัวบัญชี', field_en: x.label_eng || x.label_thai || 'Header account', total: r.rows.length });
        }
    }
    return out;
};

// GET /gl_account/:id/summary
const fetchSummary = async (req, res) => {
    const id = Number(req.params.id) || 0;
    const client = await req.dbPool.connect();
    try {
        const acc = (await client.query(`SELECT id, account_type, normal_balance FROM gl_account WHERE id = $1`, [id])).rows[0];
        if (!acc) return res.status(404).json({ message: 'Not found.' });
        const ids = await subtreeIds(client, id);
        const fy = await resolveFiscalYear(client, req.query.fiscal_year_id);
        let periods = [];
        let lines = { posted: 0, draft: 0 };
        let last = null;
        if (fy) {
            periods = (await client.query(`
                SELECT p.id, p.period_number, p.period_name, p.period_start_date::text AS start_date, p.period_end_date::text AS end_date,
                       p.gl_status, COALESCE(SUM(b.debit_amount), 0)::float8 AS debit, COALESCE(SUM(b.credit_amount), 0)::float8 AS credit
                  FROM gl_posting_period p
                  LEFT JOIN gl_balance_accum b ON b.period_id = p.id AND b.account_id = ANY($2::int[])
                 WHERE p.fiscal_year_id = $1
                 GROUP BY p.id ORDER BY p.period_number`, [fy.id, ids])).rows;
            const ln = (await client.query(`
                SELECT COUNT(*) FILTER (WHERE h.status = 'Posted')::int AS posted, COUNT(*) FILTER (WHERE h.status = 'Draft')::int AS draft
                  FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
                  JOIN gl_posting_period p ON p.id = h.period_id
                 WHERE d.account_id = ANY($1::int[]) AND p.fiscal_year_id = $2`, [ids, fy.id])).rows[0];
            lines = ln;
        }
        last = (await client.query(`
            SELECT h.doc_no, h.posting_date::text AS posting_date
              FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
             WHERE d.account_id = ANY($1::int[]) AND h.status = 'Posted'
             ORDER BY h.posting_date DESC, h.id DESC LIMIT 1`, [ids])).rows[0] || null;
        const t = today();
        const balanceToday = periods.filter(p => p.start_date <= t).reduce((s, p) => s + p.debit - p.credit, 0);
        res.json({
            fiscal_years: await fiscalYears(client),
            fiscal_year: fy,
            periods,
            balance_today: balanceToday,
            lines_posted: lines.posted || 0,
            lines_draft: lines.draft || 0,
            last_movement: last,
            usage: await accountUsage(client, id),
        });
    } catch (err) {
        console.error('gl_account summary:', err);
        res.status(500).json({ message: err.message });
    } finally {
        client.release();
    }
};

// PUT /gl_account/:id/move { parent_id }
const moveNode = async (req, res) => {
    const id = Number(req.params.id);
    const parentId = req.body?.parent_id == null ? null : Number(req.body.parent_id);
    const client = await req.dbPool.connect();
    try {
        const node = (await client.query(`SELECT id, account_type, parent_id FROM gl_account WHERE id = $1`, [id])).rows[0];
        if (!node) return res.status(404).json({ message: 'Not found.' });
        if (parentId != null) {
            const p = (await client.query(`SELECT id, account_type, is_normal_account FROM gl_account WHERE id = $1`, [parentId])).rows[0];
            if (!p) return res.status(400).json({ message: 'ไม่พบหัวบัญชีปลายทาง' });
            if (p.is_normal_account) return res.status(400).json({ message: 'ย้ายได้เฉพาะไปอยู่ใต้หัวบัญชี (บัญชีที่ลงรายการไม่ได้)' });
            if (p.account_type !== node.account_type) return res.status(400).json({ message: 'ย้ายได้เฉพาะไปอยู่ใต้หัวบัญชีประเภทเดียวกัน' });
            if ((await subtreeIds(client, id)).includes(parentId)) return res.status(400).json({ message: 'ย้ายไปอยู่ใต้บัญชีย่อยของตัวเองไม่ได้' });
        }
        await client.query(`UPDATE gl_account SET parent_id = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $3`,
            [parentId, req.headers.username || null, id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('gl_account move:', err);
        res.status(500).json({ message: err.message });
    } finally {
        client.release();
    }
};

module.exports = { resolveFiscalYear, fiscalYears, fetchBalances, fetchSummary, moveNode, tableExists };
