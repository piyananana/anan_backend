// utils/depositRef.js — ใบมัดจำ (sys_doc_type '60') อ้างอิงใบสั่งขาย (AR → so_transaction) / ใบสั่งซื้อ (AP → po_transaction)
// (user-approved 2026-10-31) ใบรับ/ส่งสินค้าที่อ้างอิงใบสั่งเดียวกันแนะนำให้หักมัดจำนั้น และเตือนเมื่อยังไม่ได้หัก
// เก็บ doc_no เป็น snapshot ไว้ด้วย — หน้าจอ AR/AP ไม่ต้อง join ตาราง SO/PO (อาจยังไม่ถูกสร้างในบางฐานข้อมูล)
'use strict';

const SIDES = {
    ar: { table: 'ar_transaction', idCol: 'ref_so_id', noCol: 'ref_so_doc_no', order: 'so_transaction', party: 'customer_id',
          label: 'ใบสั่งขาย', partyLabel: 'ลูกค้า' },
    ap: { table: 'ap_transaction', idCol: 'ref_po_id', noCol: 'ref_po_doc_no', order: 'po_transaction', party: 'vendor_id',
          label: 'ใบสั่งซื้อ', partyLabel: 'ผู้ขาย' },
};
// ใบสั่งที่ยังรับมัดจำได้ — ไม่รวมที่ยกเลิก/ลบ/ปิด/ถูกปฏิเสธ
const CLOSED_ORDER_STATUSES = ['Void', 'Deleted', 'Closed', 'Rejected'];

const ensured = new Set();
const ensureDepositRefColumns = async (db) => {
    const dbName = db.options?.database || db.database;
    if (dbName && ensured.has(dbName)) return;
    for (const s of Object.values(SIDES)) {
        await db.query(`ALTER TABLE IF EXISTS ${s.table}
            ADD COLUMN IF NOT EXISTS ${s.idCol} INTEGER,
            ADD COLUMN IF NOT EXISTS ${s.noCol} VARCHAR(50)`);
    }
    if (dbName) ensured.add(dbName);
};

// บันทึกใบสั่งที่อ้างอิงหลัง INSERT/UPDATE หัวเอกสาร — เฉพาะใบมัดจำ ('60') ประเภทอื่นล้างค่าเสมอ
const saveDepositRef = async (client, side, headerId, header) => {
    const s = SIDES[side];
    await ensureDepositRefColumns(client);
    const refId = Number(header[s.idCol]) || null;
    let docNo = null;
    if (refId) {
        const dt = await client.query(`SELECT d.sys_doc_type FROM ${s.table} t JOIN sa_module_document d ON d.id = t.doc_id
            WHERE t.id=$1`, [headerId]);
        if (dt.rows[0]?.sys_doc_type !== '60') {
            await client.query(`UPDATE ${s.table} SET ${s.idCol}=NULL, ${s.noCol}=NULL WHERE id=$1`, [headerId]);
            return;
        }
        const o = await client.query(`SELECT doc_no, ${s.party} AS party_id, status FROM ${s.order} WHERE id=$1`, [refId]);
        if (o.rows.length === 0) throw new Error(`ไม่พบ${s.label}ที่อ้างอิง`);
        const r = o.rows[0];
        if (Number(r.party_id) !== Number(header[s.party])) throw new Error(`${s.label} ${r.doc_no} เป็นของ${s.partyLabel}อื่น`);
        if (CLOSED_ORDER_STATUSES.includes(r.status)) throw new Error(`${s.label} ${r.doc_no} อยู่สถานะ ${r.status} — อ้างอิงไม่ได้`);
        docNo = r.doc_no;
    }
    await client.query(`UPDATE ${s.table} SET ${s.idCol}=$1, ${s.noCol}=$2 WHERE id=$3`, [docNo ? refId : null, docNo, headerId]);
};

// ใบมัดจำที่อ้างอิงใบสั่งนี้ (ไม่รวมยกเลิก/ลบ) — แสดงในหน้าจอ SO/PO และเตือนตอนปิดใบสั่ง
const fetchOrderDeposits = async (db, side, orderId) => {
    const s = SIDES[side];
    try {
        await ensureDepositRefColumns(db);
        const r = await db.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.status, t.currency_code, t.total_amount_lc, t.balance_amount_lc
            FROM ${s.table} t JOIN sa_module_document d ON d.id = t.doc_id
            WHERE t.${s.idCol} = $1 AND d.sys_doc_type = '60' AND t.status NOT IN ('Void', 'Deleted')
            ORDER BY t.doc_date, t.id`, [orderId]);
        return r.rows;
    } catch (e) {
        // ฐานข้อมูลที่ยังไม่มีตาราง AR/AP — ไม่มีใบมัดจำ
        if (e.code === '42P01') return [];
        throw e;
    }
};

module.exports = { ensureDepositRefColumns, saveDepositRef, fetchOrderDeposits, CLOSED_ORDER_STATUSES };
