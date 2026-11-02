// controllers/sa/saSystemResetController.js — ล้างธุรกรรมทุกโมดูลเพื่อเริ่มต้นใหม่ (เครื่องมือผู้พัฒนาระบบ)
// เก็บข้อมูลหลัก/การตั้งค่าทั้งหมดไว้ (ผังบัญชี, ลูกค้า, ผู้ขาย, สินค้า, BOM, บัญชีธนาคาร, ผู้ใช้, เมนู, งวดบัญชี ฯลฯ)
// ข้อมูลหลักของแต่ละโมดูลล้างที่หน้าจอล้างข้อมูลรายโมดูล ซึ่งต้องล้างธุรกรรมที่หน้าจอนี้ก่อน
'use strict';
const fs   = require('fs');
const path = require('path');

const CONFIRM_TEXT = 'RESET ALL';
const ATTACHMENT_ROOT = path.join(__dirname, '..', '..', 'public', 'attachments');

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
        'cm_year_end', 'cm_inter_bank_transfer', 'cm_petty_cash_voucher', 'cm_petty_cash_replenishment'] },
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

async function countRows(db, table) {
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    return r.rows[0].n;
}

// GET /system_reset/counts
const getCounts = async (req, res) => {
    try {
        const db = req.dbPool;
        const exists = await existingTables(db);
        const groups = [];
        for (const g of GROUPS) {
            const tables = [];
            const list = g.code === 'IM' ? [PRICE_CHANGE_HEADER, ...g.tables] : g.tables;
            for (const t of list) if (exists.has(t)) tables.push({ table: t, count: await countRows(db, t) });
            groups.push({ code: g.code, tables, total: tables.reduce((s, t) => s + t.count, 0) });
        }
        const docNumbers = exists.has('sa_module_document')
            ? (await db.query(`SELECT COUNT(*)::int AS n FROM sa_module_document WHERE next_running_number > 1`)).rows[0].n
              + (exists.has('sa_doc_number_branch')
                ? (await db.query(`SELECT COUNT(*)::int AS n FROM sa_doc_number_branch WHERE next_running_number > 1`)).rows[0].n : 0)
            : 0;
        const checkbooks = exists.has('cm_checkbook')
            ? (await db.query(`SELECT COUNT(*)::int AS n FROM cm_checkbook
                                WHERE next_check_no IS DISTINCT FROM start_check_no OR status = 'Used'`)).rows[0].n
            : 0;
        res.json({ confirm_text: CONFIRM_TEXT, groups, doc_numbers: docNumbers, checkbooks });
    } catch (error) {
        console.error('Error getting system reset counts:', error);
        res.status(500).json({ message: error.message });
    }
};

// POST /system_reset  body: { confirm_text, resetDocNumbers = true, resetCheckbooks = true }
// ทำทั้งหมดใน transaction เดียว — ขั้นตอนใดผิดพลาดจะยกเลิกทั้งหมด (ไม่มีการล้างไปครึ่งทาง)
const resetAll = async (req, res) => {
    const { confirm_text, resetDocNumbers = true, resetCheckbooks = true } = req.body || {};
    if (confirm_text !== CONFIRM_TEXT) {
        return res.status(400).json({ message: `กรุณาพิมพ์ "${CONFIRM_TEXT}" เพื่อยืนยัน` });
    }
    const dbName = req.headers['x-database-name'];
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const exists = await existingTables(client);
        const deleted = {};

        const tables = GROUPS.flatMap(g => g.tables).filter(t => exists.has(t));
        for (const t of tables) deleted[t] = await countRows(client, t);
        // RESTART IDENTITY — เลข id เริ่มใหม่ (ไม่มีตารางนอกรายการอ้างอิง id เหล่านี้ เพราะ TRUNCATE ตรวจ FK ให้แล้ว)
        await client.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY`);

        if (exists.has(PRICE_CHANGE_HEADER)) {
            if (exists.has('im_price_list_detail')) {
                await client.query(`UPDATE im_price_list_detail SET source_price_change_id = NULL
                                     WHERE source_price_change_id IS NOT NULL`);
            }
            deleted[PRICE_CHANGE_HEADER] = (await client.query(`DELETE FROM ${PRICE_CHANGE_HEADER}`)).rowCount;
        }

        if (resetDocNumbers) {
            // เลขที่เอกสารทุกโมดูล (กลาง + แยกสาขา) และ running ของเอกสารที่มีตารางเลขของตัวเอง
            // running ของรหัสข้อมูลหลัก (ผู้ขาย/ลูกค้า/สินค้า) ไม่ยุ่ง เพราะข้อมูลหลักยังอยู่
            for (const t of ['sa_module_document', 'sa_doc_number_branch', 'ap_payment_run_running',
                             'im_price_change_running', 'im_stock_count_running']) {
                if (exists.has(t)) await client.query(`UPDATE ${t} SET next_running_number = 1 WHERE next_running_number <> 1`);
            }
            deleted.doc_numbers_reset = true;
        }

        if (resetCheckbooks && exists.has('cm_checkbook')) {
            // เลขเช็คถัดไปกลับไปเลขแรกของเล่ม — เล่มที่ใช้หมด (Used) กลับมาใช้งานได้ ส่วนเล่มที่ปิดเอง (Inactive) คงไว้
            deleted.cm_checkbook_reset = (await client.query(`
                UPDATE cm_checkbook SET next_check_no = start_check_no,
                       status = CASE WHEN status = 'Used' THEN 'Active' ELSE status END, updated_at = NOW()
                 WHERE next_check_no IS DISTINCT FROM start_check_no OR status = 'Used'`)).rowCount;
        }

        await client.query('COMMIT');

        // ไฟล์แนบอยู่นอกฐานข้อมูล — ลบหลัง COMMIT เท่านั้น (ถ้าลบก่อนแล้ว rollback ไฟล์จะหายแต่แถวยังอยู่)
        let filesRemoved = false;
        if (dbName && /^[A-Za-z0-9_-]+$/.test(dbName)) {
            const dir = path.join(ATTACHMENT_ROOT, dbName);
            try {
                if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); filesRemoved = true; }
            } catch (e) {
                console.error('System reset: remove attachment files failed:', e.message);
            }
        }

        console.log('System reset completed:', deleted);
        res.json({ message: 'ล้างธุรกรรมทุกโมดูลเรียบร้อย', deleted, attachment_files_removed: filesRemoved });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error in system reset:', error);
        res.status(500).json({ message: `ล้างข้อมูลไม่สำเร็จ ยกเลิกทั้งหมดแล้ว: ${error.message}` });
    } finally {
        client.release();
    }
};

module.exports = { getCounts, resetAll, GROUPS, CONFIRM_TEXT };
