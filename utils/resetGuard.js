// utils/resetGuard.js — รายการตารางธุรกรรมทุกโมดูล ใช้ร่วมกันระหว่างหน้าจอล้างธุรกรรมกลาง (saSystemResetController)
// และหน้าจอล้างข้อมูลหลักรายโมดูล (ar/ap/cm/gl/imResetController) ซึ่งต้องล้างธุรกรรมที่หน้าจอกลางก่อนเสมอ
'use strict';

// ตารางธุรกรรมทั้งหมด แยกกลุ่มตามโมดูลเพื่อแสดงจำนวนบนหน้าจอ — ลบด้วย TRUNCATE คำสั่งเดียว
// TRUNCATE (ไม่ใส่ CASCADE) จะ error ถ้ามีตารางนอกรายการนี้อ้างอิง FK มาที่ตารางในรายการ จึงไม่มีทางลบข้อมูลหลัก
// โดยไม่ตั้งใจ — ถ้าเพิ่มตารางธุรกรรมใหม่ที่อ้างอิงตารางเหล่านี้ ต้องเพิ่มเข้ารายการนี้ด้วย ไม่เช่นนั้นการล้างจะล้มทั้งหมด
// และไม่ fire trigger รายแถว (gl_balance_accum ถูกล้างตรงๆ ในรายการเดียวกัน)
const GROUPS = [
    { code: 'AR', tables: ['ar_transaction', 'ar_transaction_detail', 'ar_transaction_payment', 'ar_transaction_apply',
        'ar_transaction_wht', 'ar_transaction_salesperson', 'ar_allowance_run', 'ar_allowance_run_detail',
        'ar_fx_revaluation', 'ar_fx_revaluation_detail', 'credit_approval'] },
    { code: 'AP', tables: ['ap_transaction', 'ap_transaction_detail', 'ap_transaction_payment', 'ap_transaction_apply',
        'ap_transaction_wht', 'ap_transaction_approval', 'ap_payment_run', 'ap_payment_run_detail',
        'ap_payment_run_payment', 'ap_payment_run_approval', 'ap_fx_revaluation', 'ap_fx_revaluation_detail'] },
    { code: 'CM', tables: ['cm_transaction', 'cm_transaction_detail', 'cm_transaction_payment', 'cm_transaction_apply',
        'cm_transaction_wht', 'cm_receipt', 'cm_payment', 'cm_bank_opening_balance', 'cm_bank_statement',
        'cm_bank_statement_line', 'cm_bank_fx_revaluation', 'cm_bank_fx_revaluation_line', 'cm_post_dated_check',
        'cm_year_end', 'cm_inter_bank_transfer', 'cm_petty_cash_voucher', 'cm_petty_cash_replenishment',
        'cm_bank_charge'] },
    { code: 'IM', tables: ['im_transaction', 'im_transaction_detail', 'im_transaction_salesperson', 'im_transaction_advance',
        'im_stock_balance', 'im_stock_layer', 'im_stock_layer_consumption', 'im_stock_count', 'im_stock_count_detail',
        'im_period_closing', 'im_opening_balance_batch', 'im_opening_balance_batch_detail', 'im_price_change_detail',
        'im_print_log'] },
    { code: 'MO', tables: ['mo_header', 'mo_component_detail', 'mo_output_detail', 'mo_operation_detail', 'mo_operation_time_log'] },
    { code: 'PO', tables: ['pr_transaction', 'pr_transaction_detail', 'pr_transaction_approval', 'po_transaction',
        'po_transaction_detail'] },
    { code: 'SO', tables: ['quote_transaction', 'quote_transaction_detail', 'quote_transaction_approval',
        'quote_transaction_salesperson', 'so_transaction', 'so_transaction_detail', 'so_transaction_salesperson'] },
    { code: 'VT', tables: ['vt_transaction'] },
    { code: 'GL', tables: ['gl_entry_header', 'gl_entry_detail', 'gl_balance_accum', 'gl_balance_accum_phase1',
        'gl_period_close_request', 'gl_period_close_approval', 'gl_period_close_log', 'gl_year_end_closing'] },
    { code: 'SA', tables: ['doc_approval', 'sa_document_reverse_log', 'sa_attachment', 'sa_user_audit_log'] },
];

// im_price_change_header ลบแยก (DELETE) — im_price_list_detail.source_price_change_id (ข้อมูลหลัก) อ้างอิงอยู่
// TRUNCATE จึงทำไม่ได้ ต้องล้างคอลัมน์นี้เป็น NULL ก่อน
const PRICE_CHANGE_HEADER = 'im_price_change_header';

async function existingTables(db) {
    const r = await db.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    return new Set(r.rows.map(x => x.table_name));
}

// Audit log เพิ่มขึ้นทุกครั้งที่ผู้ใช้ login — ไม่นับเป็นธุรกรรมค้าง
const NOT_BLOCKING = new Set(['sa_user_audit_log']);

// จำนวนแถวธุรกรรมที่ยังค้างอยู่ทั้งระบบ (0 = ล้างข้อมูลหลักได้)
async function transactionTotal(db) {
    const exists = await existingTables(db);
    const tables = [...GROUPS.flatMap(g => g.tables), PRICE_CHANGE_HEADER]
        .filter(t => exists.has(t) && !NOT_BLOCKING.has(t));
    if (tables.length === 0) return 0;
    const r = await db.query(`SELECT ${tables.map(t => `(SELECT COUNT(*) FROM ${t})`).join(' + ')} AS n`);
    return Number(r.rows[0].n);
}

const MASTER_BLOCKED_MESSAGE = 'ยังมีธุรกรรมในระบบ — ต้องล้างธุรกรรมที่หน้าจอ "ล้างธุรกรรมทุกโมดูล" ก่อน จึงจะล้างข้อมูลหลักได้';

// ใช้ต้น handler ล้างข้อมูลหลัก — คืน true ถ้าตอบ 409 ไปแล้ว
async function rejectIfTransactions(req, res) {
    const n = await transactionTotal(req.dbPool);
    if (n > 0) {
        res.status(409).json({ message: MASTER_BLOCKED_MESSAGE, transactions_total: n });
        return true;
    }
    return false;
}

module.exports = { GROUPS, PRICE_CHANGE_HEADER, existingTables, transactionTotal, rejectIfTransactions };
