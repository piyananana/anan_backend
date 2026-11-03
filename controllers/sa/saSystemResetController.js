// controllers/sa/saSystemResetController.js — ล้างธุรกรรมทุกโมดูลเพื่อเริ่มต้นใหม่ (เครื่องมือผู้พัฒนาระบบ)
// เก็บข้อมูลหลัก/การตั้งค่าทั้งหมดไว้ (ผังบัญชี, ลูกค้า, ผู้ขาย, สินค้า, BOM, บัญชีธนาคาร, ผู้ใช้, เมนู, งวดบัญชี ฯลฯ)
// ข้อมูลหลักของแต่ละโมดูลล้างที่หน้าจอล้างข้อมูลรายโมดูล ซึ่งต้องล้างธุรกรรมที่หน้าจอนี้ก่อน
'use strict';
const fs   = require('fs');
const path = require('path');

const CONFIRM_TEXT = 'RESET ALL';
const ATTACHMENT_ROOT = path.join(__dirname, '..', '..', 'public', 'attachments');

const { GROUPS, PRICE_CHANGE_HEADER, existingTables } = require('../../utils/resetGuard');

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

module.exports = { getCounts, resetAll };
