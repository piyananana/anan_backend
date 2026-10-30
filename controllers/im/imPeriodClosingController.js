// controllers/im/imPeriodClosingController.js — period-end closing entry for IM Periodic stock.
// True-up per inventory account (user-approved 2026-10-30): adjusts each inventory account that holds Periodic stock
// to the stock value at period end, closes every purchases account's net movement in the period, and books the
// difference as COGS (by item/category COGS account from the subledger, residual to the company default).
// See computeClosing below and project_im_mixed_accounting_mode memory.
'use strict';

const { fetchSettingRow } = require('./imAccountingSettingController');
const { getBaseCurrency } = require('../../utils/baseCurrency');
const { resolveItemModes } = require('../../utils/imAccountingMode');

// คัดลอกจาก imTransactionController.js — เป็นธรรมเนียมของโปรเจกต์นี้ให้แต่ละ controller มีสำเนาของตัวเอง
// (เหมือน ap/ar/cm/gl) แทนที่จะ require ข้ามกัน เพื่อเลี่ยง circular require กับ imAccountingSettingController.js
const generateDocNo = async (client, docId, date, branchId = null) => {
    let config = null;
    let useBranchCounter = false;
    let branchRowId = null;

    if (branchId) {
        const branchRes = await client.query(
            `SELECT * FROM sa_doc_number_branch WHERE doc_id = $1 AND branch_id = $2 FOR UPDATE`,
            [docId, branchId]
        );
        if (branchRes.rows.length > 0) {
            const globalRes = await client.query(`SELECT * FROM sa_module_document WHERE id = $1`, [docId]);
            const global = globalRes.rows[0];
            if (!global || !global.is_auto_numbering) return null;
            const bc = branchRes.rows[0];
            config = {
                format_prefix:       bc.format_prefix      ?? global.format_prefix      ?? '',
                format_separator:    bc.format_separator   ?? global.format_separator   ?? '',
                format_suffix_date:  bc.format_suffix_date ?? global.format_suffix_date ?? '',
                running_length:      bc.running_length     ?? global.running_length     ?? 4,
                next_running_number: bc.next_running_number,
            };
            useBranchCounter = true;
            branchRowId = bc.id;
        }
    }
    if (!useBranchCounter) {
        const globalRes = await client.query(`SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]);
        const global = globalRes.rows[0];
        if (!global || !global.is_auto_numbering) return null;
        config = {
            format_prefix:       global.format_prefix      || '',
            format_separator:    global.format_separator   || '',
            format_suffix_date:  global.format_suffix_date || '',
            running_length:      global.running_length     || 4,
            next_running_number: global.next_running_number,
        };
    }

    let docNo = config.format_prefix;
    if (config.format_suffix_date) {
        const d = new Date(date);
        const year  = d.getFullYear().toString();
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const day   = d.getDate().toString().padStart(2, '0');
        if      (config.format_suffix_date === 'YY')       docNo += year.substring(2);
        else if (config.format_suffix_date === 'YYYY')     docNo += year;
        else if (config.format_suffix_date === 'YYMM')     docNo += year.substring(2) + month;
        else if (config.format_suffix_date === 'YYYYMM')   docNo += year + month;
        else if (config.format_suffix_date === 'YYYYMMDD') docNo += year + month + day;
    }
    if (config.format_separator) docNo += config.format_separator;
    docNo += config.next_running_number.toString().padStart(config.running_length, '0');

    if (useBranchCounter) {
        await client.query(
            `UPDATE sa_doc_number_branch SET next_running_number = next_running_number + 1 WHERE id = $1`,
            [branchRowId]
        );
    } else {
        await client.query(
            `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
            [docId]
        );
    }
    return docNo;
};

const ensureImPeriodClosingTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_period_closing (
            id              SERIAL PRIMARY KEY,
            period_id       INTEGER NOT NULL UNIQUE REFERENCES gl_posting_period(id),
            status          VARCHAR(20) NOT NULL DEFAULT 'Draft',
            beginning_value NUMERIC(18,4),
            purchases_value NUMERIC(18,4),
            ending_value    NUMERIC(18,4),
            cogs_value      NUMERIC(18,4),
            gl_entry_id     INTEGER REFERENCES gl_entry_header(id),
            calculated_at   TIMESTAMPTZ,
            posted_at       TIMESTAMPTZ,
            created_by      VARCHAR(100),
            posted_by       VARCHAR(100)
        )
    `);
    // รายละเอียดการปิดงวดแบบปรับยอดให้ตรง (บัญชีสต็อก/ซื้อ/ต้นทุน + การกระทบยอด) ณ ตอนโพสต์ — ไว้ตรวจย้อนหลัง
    await client.query(`ALTER TABLE im_period_closing ADD COLUMN IF NOT EXISTS detail_json JSONB`).catch(() => {});
};

const POSTED_STATUSES = `('Posted','Received','Delivered')`; // เอกสารที่ขยับสต็อกแล้ว (Void คืนสต็อกไปแล้ว ไม่นับ)
const COGS_TYPES = ['30', '31', '32', '35', '40', '45', '60'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const unitKey = (itemId, whId) => `${itemId}|${whId}`;

// การปิดงวดแบบปรับยอดให้ตรง (user-approved 2026-10-30, ดู project_im_mixed_accounting_mode):
// 1. มูลค่าสต็อก ณ วันสิ้นงวด ต่อ (สินค้า × คลัง) = มูลค่าปัจจุบัน − การเคลื่อนไหวของเอกสารที่ลงวันที่หลังสิ้นงวด
// 2. แต่ละสต็อกผูกกับบัญชีสต็อก: คลัง → สินค้า → หมวดสินค้า → ค่าเริ่มต้นของบริษัท
// 3. บัญชีสต็อกที่มีสต็อก Periodic อยู่ ปรับยอด GL ณ วันสิ้นงวดให้เท่ามูลค่าสต็อกของบัญชีนั้น (บัญชีที่มีแต่ Perpetual
//    แสดงในการกระทบยอดอย่างเดียว ไม่ปรับ เพื่อไม่ให้ความผิดพลาดของ Perpetual ถูกกลบเป็นต้นทุนขาย)
// 4. ปิดยอดสุทธิในงวดของบัญชีซื้อสินค้าทุกบัญชี (Dr − Cr จึงหักรับคืน/ลดหนี้แล้ว)
// 5. ต้นทุนขาย = ซื้อสุทธิ − ส่วนที่ปรับเพิ่มบัญชีสต็อก — ลงตามบัญชีต้นทุนของสินค้าตามมูลค่าที่ขาย/เบิกจริงใน subledger
//    (บรรทัด Periodic) ส่วนที่เหลือ (สูญหาย ปรับยอด ส่วนต่างราคา รายการ GL อื่น) ลงบัญชีต้นทุนเริ่มต้นของบริษัท
// ปรับจากยอด GL จริงทุกครั้ง จึงไม่ต้องมียอดต้นงวด และไม่เพี้ยนเมื่อเปลี่ยนโหมดกลางงวดหรือ MOI/MOR ลงบัญชีไว้ก่อนแล้ว
const computeClosing = async (client, periodId) => {
    const periodRes = await client.query(
        `SELECT id, period_name, period_start_date::text AS s, period_end_date::text AS e, im_status FROM gl_posting_period WHERE id = $1`, [periodId]);
    if (periodRes.rows.length === 0) throw new Error('ไม่พบงวดบัญชี');
    const period = periodRes.rows[0];
    const setting = (await fetchSettingRow(client)) || {};
    const errors = [];
    const warnings = [];

    // 1. มูลค่าสต็อก ณ วันสิ้นงวด
    const valueAtEnd = {};
    const add = (k, v) => { valueAtEnd[k] = (valueAtEnd[k] || 0) + Number(v || 0); };
    const cur = await client.query(`SELECT item_id, warehouse_id, SUM(qty_on_hand * avg_unit_cost) AS v FROM im_stock_balance GROUP BY 1, 2`);
    cur.rows.forEach(r => add(unitKey(r.item_id, r.warehouse_id), r.v));
    const after = await client.query(`
        SELECT d.item_id, t.warehouse_id, t.to_warehouse_id, md.sys_doc_type, SUM(d.total_value_lc) AS v
          FROM im_transaction_detail d
          JOIN im_transaction t ON t.id = d.header_id
          JOIN sa_module_document md ON md.id = t.doc_id
         WHERE t.status IN ${POSTED_STATUSES} AND t.doc_date > $1
         GROUP BY 1, 2, 3, 4`, [period.e]);
    for (const r of after.rows) {
        add(unitKey(r.item_id, r.warehouse_id), -Number(r.v || 0));
        if (r.sys_doc_type === '70' && r.to_warehouse_id) add(unitKey(r.item_id, r.to_warehouse_id), Number(r.v || 0));
    }

    // บรรทัดในงวด (โหมดที่ใช้ตอน Post + ต้นทุนขาย/เบิกของบรรทัด Periodic)
    const lines = (await client.query(`
        SELECT d.item_id, d.gl_mode, d.to_gl_mode, d.total_value_lc, t.warehouse_id, t.to_warehouse_id, t.doc_code, t.status, md.sys_doc_type
          FROM im_transaction_detail d
          JOIN im_transaction t ON t.id = d.header_id
          JOIN sa_module_document md ON md.id = t.doc_id
         WHERE t.status IN ${POSTED_STATUSES} AND t.doc_date BETWEEN $1 AND $2`, [period.s, period.e])).rows;

    const units = new Set(Object.keys(valueAtEnd).filter(k => Math.abs(valueAtEnd[k]) >= 0.005));
    for (const l of lines) {
        units.add(unitKey(l.item_id, l.warehouse_id));
        if (l.sys_doc_type === '70' && l.to_warehouse_id) units.add(unitKey(l.item_id, l.to_warehouse_id));
    }
    // โหมดปัจจุบันของแต่ละสต็อก — สต็อกที่ไม่มีการเคลื่อนไหวในงวด และบรรทัดที่ Post ก่อนมีการบันทึกโหมด (gl_mode ว่าง)
    // ใช้โหมดนี้; บรรทัดที่บันทึกโหมดไว้แล้วใช้โหมดตอน Post
    const currentMode = {};
    const byWh = {};
    for (const k of units) { const [i, w] = k.split('|'); (byWh[w] = byWh[w] || []).push(Number(i)); }
    for (const [w, ids] of Object.entries(byWh)) {
        const modes = await resolveItemModes(client, ids, Number(w));
        for (const i of ids) currentMode[unitKey(i, w)] = modes[i];
    }
    const periodicUnits = new Set(Object.keys(currentMode).filter(k => currentMode[k] === 'PERIODIC'));
    for (const l of lines) {
        l.eff_mode = l.gl_mode || currentMode[unitKey(l.item_id, l.warehouse_id)];
        if (l.eff_mode === 'PERIODIC') periodicUnits.add(unitKey(l.item_id, l.warehouse_id));
        if (l.sys_doc_type === '70' && l.to_warehouse_id) {
            const toMode = l.to_gl_mode || currentMode[unitKey(l.item_id, l.to_warehouse_id)];
            if (toMode === 'PERIODIC') periodicUnits.add(unitKey(l.item_id, l.to_warehouse_id));
        }
    }

    // 2. บัญชีสต็อกต่อสต็อก
    const itemIds = [...new Set([...units].map(k => Number(k.split('|')[0])).concat(lines.map(l => Number(l.item_id))))];
    const itemRows = itemIds.length ? (await client.query(`
        SELECT i.id, i.item_code, i.inventory_account_id AS i_inv, c.inventory_account_id AS c_inv,
               i.cogs_account_id AS i_cogs, c.cogs_account_id AS c_cogs
          FROM im_item i LEFT JOIN im_item_category c ON c.id = i.category_id
         WHERE i.id = ANY($1::int[])`, [itemIds])).rows : [];
    const itemMap = Object.fromEntries(itemRows.map(r => [r.id, r]));
    const whRows = (await client.query(`SELECT id, warehouse_code, inventory_account_id FROM im_warehouse`)).rows;
    const whMap = Object.fromEntries(whRows.map(r => [r.id, r]));
    const pick = (...ids) => ids.map(Number).find(n => n > 0) || null;

    const inv = {}; // account_id -> { target, periodic_value, perpetual_value, has_periodic }
    for (const k of units) {
        const [i, w] = k.split('|').map(Number);
        const it = itemMap[i] || {};
        const acc = pick(whMap[w]?.inventory_account_id, it.i_inv, it.c_inv, setting.inventory_account_id);
        const v = valueAtEnd[k] || 0;
        const isPeriodic = periodicUnits.has(k);
        if (!acc) {
            if (Math.abs(v) >= 0.005 || isPeriodic) {
                errors.push(`ไม่พบบัญชีสต็อกของ ${it.item_code || i} คลัง ${whMap[w]?.warehouse_code || w} — ตั้งค่าที่คลัง สินค้า หมวดสินค้า หรือหน้าโหมดบัญชีสินค้าคงคลัง`);
            }
            continue;
        }
        const a = inv[acc] = inv[acc] || { target: 0, periodic_value: 0, perpetual_value: 0, has_periodic: false };
        a.target += v;
        if (isPeriodic) { a.periodic_value += v; a.has_periodic = true; } else a.perpetual_value += v;
    }

    // 3. ยอด GL ณ วันสิ้นงวดของบัญชีสต็อก
    const invIds = Object.keys(inv).map(Number);
    const glBal = invIds.length ? (await client.query(`
        SELECT d.account_id, SUM(d.debit_lc - d.credit_lc) AS bal
          FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
         WHERE h.status = 'Posted' AND h.doc_date <= $1 AND d.account_id = ANY($2::int[])
         GROUP BY 1`, [period.e, invIds])).rows : [];
    const glMap = Object.fromEntries(glBal.map(r => [r.account_id, Number(r.bal) || 0]));

    // 4. บัญชีซื้อสินค้าทุกบัญชีที่ตั้งไว้ — ยอดสุทธิในงวด
    const purIds = (await client.query(`
        SELECT purchases_account_id AS id FROM im_warehouse WHERE purchases_account_id IS NOT NULL
        UNION SELECT purchases_account_id FROM im_item WHERE purchases_account_id IS NOT NULL
        UNION SELECT purchases_account_id FROM im_item_category WHERE purchases_account_id IS NOT NULL
        UNION SELECT purchases_account_id FROM im_accounting_setting WHERE purchases_account_id IS NOT NULL`)).rows.map(r => r.id);
    const purBal = purIds.length ? (await client.query(`
        SELECT d.account_id, SUM(d.debit_lc - d.credit_lc) AS bal
          FROM gl_entry_detail d JOIN gl_entry_header h ON h.id = d.header_id
         WHERE h.status = 'Posted' AND h.doc_date BETWEEN $1 AND $2 AND d.account_id = ANY($3::int[])
         GROUP BY 1`, [period.s, period.e, purIds])).rows : [];

    // 5. ต้นทุนขาย/เบิกของบรรทัด Periodic ตาม subledger — บัญชี: สินค้า → หมวดสินค้า → ประเภทเอกสาร → ค่าเริ่มต้นของบริษัท
    const setupCogs = {};
    for (const code of [...new Set(lines.map(l => l.doc_code))]) {
        const r = await client.query(`SELECT cogs_account_id FROM im_gl_account_setup WHERE doc_code = $1`, [code]);
        setupCogs[code] = r.rows[0]?.cogs_account_id || null;
    }
    const subCogs = {}; // account_id -> ต้นทุน (บวก = Dr)
    for (const l of lines) {
        if (l.eff_mode !== 'PERIODIC' || !COGS_TYPES.includes(l.sys_doc_type)) continue;
        const it = itemMap[l.item_id] || {};
        const acc = pick(it.i_cogs, it.c_cogs, setupCogs[l.doc_code], setting.cogs_account_id);
        if (!acc) { errors.push(`ไม่พบบัญชีต้นทุนขายของ ${it.item_code || l.item_id}`); continue; }
        subCogs[acc] = (subCogs[acc] || 0) - Number(l.total_value_lc || 0);
    }

    // สรุปรายการบัญชี (บวก = Dr, ลบ = Cr)
    const net = {};
    const addNet = (acc, amt) => { if (acc && Math.abs(amt) >= 0.005) net[acc] = (net[acc] || 0) + amt; };
    let inventoryAdj = 0, glBefore = 0, ending = 0;
    const reconciliation = [];
    for (const [acc, a] of Object.entries(inv)) {
        const gl = glMap[acc] || 0;
        const diff = r2(a.target - gl);
        reconciliation.push({
            account_id: Number(acc), gl_balance: r2(gl), stock_value: r2(a.target),
            periodic_value: r2(a.periodic_value), perpetual_value: r2(a.perpetual_value),
            difference: diff, adjusted: a.has_periodic,
        });
        if (!a.has_periodic) {
            if (Math.abs(diff) >= 0.005) warnings.push(`บัญชีสต็อกที่มีแต่สินค้า Perpetual มีผลต่างกับยอดสต็อก ${diff.toFixed(2)} — ไม่ปรับในการปิดงวด กรุณาตรวจสอบ`);
            continue;
        }
        if (Math.abs(a.perpetual_value) >= 0.005) {
            warnings.push('บัญชีสต็อกที่ปรับยอดมีสินค้า Perpetual ผสมอยู่ — ถ้าเอกสาร Perpetual ลงบัญชีสต็อกอื่น (เช่น บัญชีของประเภทเอกสาร) ส่วนต่างจะถูกรวมเป็นต้นทุนขาย');
        }
        inventoryAdj += diff; glBefore += gl; ending += a.target;
        addNet(Number(acc), diff);
    }
    let purchasesNet = 0;
    const purchasesLines = [];
    for (const r of purBal) {
        const bal = r2(r.bal);
        if (Math.abs(bal) < 0.005) continue;
        purchasesNet += bal;
        purchasesLines.push({ account_id: r.account_id, amount: bal });
        addNet(r.account_id, -bal);
    }
    inventoryAdj = r2(inventoryAdj); purchasesNet = r2(purchasesNet);
    const cogsTotal = r2(purchasesNet - inventoryAdj);
    let subTotal = 0;
    const cogsLines = [];
    for (const [acc, amt] of Object.entries(subCogs)) {
        const v = r2(amt);
        if (Math.abs(v) < 0.005) continue;
        subTotal += v;
        cogsLines.push({ account_id: Number(acc), amount: v, source: 'SUBLEDGER' });
        addNet(Number(acc), v);
    }
    const residual = r2(cogsTotal - subTotal);
    if (Math.abs(residual) >= 0.005) {
        if (!setting.cogs_account_id) errors.push('ยังไม่ได้ตั้งค่าบัญชีต้นทุนขายเริ่มต้นในหน้าโหมดบัญชีสินค้าคงคลัง (ใช้ลงส่วนต่างจากการปรับยอด)');
        else {
            cogsLines.push({ account_id: Number(setting.cogs_account_id), amount: residual, source: 'RESIDUAL' });
            addNet(Number(setting.cogs_account_id), residual);
        }
    }

    // ข้อห้าม/ข้อควรรู้
    const draft = await client.query(`SELECT COUNT(*) FROM im_transaction WHERE period_id = $1 AND status = 'Draft'`, [periodId]);
    if (Number(draft.rows[0].count) > 0) errors.push(`มีธุรกรรม IM ที่ยังเป็น Draft ในงวดนี้ ${draft.rows[0].count} รายการ กรุณา Post หรือลบก่อนปิดงวด`);
    const grUnbilled = lines.filter(l => l.sys_doc_type === '12' && l.status === 'Received' && l.eff_mode === 'PERIODIC').length;
    if (grUnbilled > 0) errors.push(`มีรับสินค้า (รอตั้งหนี้) ของสต็อก Periodic ที่ยังไม่ Post AP/GL ในงวดนี้ ${grUnbilled} บรรทัด — ยอดซื้อยังไม่ครบ กรุณา Post AP/GL ก่อนปิดงวด`);
    const dlnUnbilled = lines.filter(l => l.sys_doc_type === '32' && l.status === 'Delivered').length;
    if (dlnUnbilled > 0) warnings.push(`มีส่งสินค้า (รอตั้งหนี้) ที่ยังไม่ออกใบแจ้งหนี้ในงวดนี้ ${dlnUnbilled} บรรทัด — ไม่กระทบต้นทุนขาย แต่รายได้ยังไม่ถูกบันทึก`);
    const prevOpen = await client.query(`
        SELECT p.period_name FROM gl_posting_period p
         WHERE p.period_end_date < $1 AND p.im_status <> 'CLOSED'
           AND NOT EXISTS (SELECT 1 FROM im_period_closing c WHERE c.period_id = p.id AND c.status = 'Posted')
           AND EXISTS (SELECT 1 FROM im_transaction t WHERE t.period_id = p.id AND t.status IN ${POSTED_STATUSES})
         ORDER BY p.period_start_date LIMIT 1`, [period.s]);
    if (prevOpen.rows.length) warnings.push(`งวดก่อนหน้า (${prevOpen.rows[0].period_name}) ยังไม่ได้ปิดงวดสต็อก — ต้นทุนของงวดนั้นจะถูกรวมในงวดนี้`);

    const journal = Object.entries(net)
        .map(([acc, amt]) => ({ account_id: Number(acc), debit: amt > 0 ? r2(amt) : 0, credit: amt < 0 ? r2(-amt) : 0 }))
        .filter(l => l.debit || l.credit);

    // ชื่อบัญชีสำหรับหน้าจอ
    const accIds = [...new Set([...journal.map(j => j.account_id), ...reconciliation.map(r => r.account_id),
        ...purchasesLines.map(p => p.account_id), ...cogsLines.map(c => c.account_id)])];
    const names = accIds.length ? Object.fromEntries((await client.query(
        `SELECT id, account_code, account_name_thai, account_name_eng FROM gl_account WHERE id = ANY($1::int[])`, [accIds])).rows
        .map(r => [r.id, r])) : {};
    const named = (x) => ({ ...x, account_code: names[x.account_id]?.account_code || '', account_name_th: names[x.account_id]?.account_name_thai || '', account_name_en: names[x.account_id]?.account_name_eng || '' });

    return {
        period,
        beginning_value: r2(glBefore), purchases_value: purchasesNet, ending_value: r2(ending), cogs_value: cogsTotal,
        inventory_adjustment: inventoryAdj, subledger_cogs: r2(subTotal), residual_cogs: residual,
        reconciliation: reconciliation.map(named).sort((a, b) => a.account_code.localeCompare(b.account_code)),
        purchases: purchasesLines.map(named), cogs: cogsLines.map(named),
        journal: journal.map(named).sort((a, b) => (b.debit - a.debit) || a.account_code.localeCompare(b.account_code)),
        errors: [...new Set(errors)], warnings: [...new Set(warnings)],
    };
};

const calculatePreview = async (req, res) => {
    const { periodId } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPeriodClosingTable(client);
        const c = await computeClosing(client, periodId);
        const existing = await client.query(`SELECT status FROM im_period_closing WHERE period_id = $1`, [periodId]);
        const { period, ...rest } = c;
        res.status(200).json({ period_id: Number(periodId), ...rest, already_posted: existing.rows[0]?.status === 'Posted' });
    } catch (error) {
        console.error('Error calculating im_period_closing preview:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

const confirmClose = async (req, res) => {
    const { periodId } = req.params;
    const userName = req.headers.username || null;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureImPeriodClosingTable(client);

        const periodRes = await client.query(`SELECT * FROM gl_posting_period WHERE id = $1 FOR UPDATE`, [periodId]);
        if (periodRes.rows.length === 0) throw new Error('ไม่พบงวดบัญชี');
        const period = periodRes.rows[0];
        if (period.im_status === 'CLOSED') throw new Error('งวดนี้ถูกปิดสำหรับ IM ไปแล้ว');

        const existingRes = await client.query(`SELECT * FROM im_period_closing WHERE period_id = $1`, [periodId]);
        if (existingRes.rows[0]?.status === 'Posted') throw new Error('งวดนี้ถูกปิดงวดสต็อกไปแล้ว');

        const setting = await fetchSettingRow(client);
        if (!setting?.closing_gl_doc_id) throw new Error('ยังไม่ได้ตั้งค่าประเภทเอกสาร GL สำหรับปิดงวดสต็อก (หน้าโหมดบัญชีสินค้าคงคลัง)');

        const c = await computeClosing(client, periodId);
        if (c.errors.length) throw new Error(c.errors.join('\n'));

        const description = `ปิดงวดสต็อกสินค้า (Periodic) งวด ${period.period_name}`;
        let glEntryId = null;
        if (c.journal.length > 0) {
            const docDate = period.period_end_date;
            let docNo = await generateDocNo(client, setting.closing_gl_doc_id, docDate, null);
            if (!docNo) docNo = `IMCLOSE-${period.id}`;

            let createdByUserId = null;
            if (userName) {
                const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
                if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
            }
            const totalDebit = r2(c.journal.reduce((s, l) => s + l.debit, 0));
            const totalCredit = r2(c.journal.reduce((s, l) => s + l.credit, 0));
            if (Math.abs(totalDebit - totalCredit) >= 0.005) throw new Error(`รายการปิดงวดไม่สมดุล (Dr ${totalDebit} / Cr ${totalCredit})`);

            const glHeaderRes = await client.query(`
                INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id, description,
                 currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$10,1,'Posted',$7,$8,0,0,$9)
                RETURNING id
            `, [setting.closing_gl_doc_id, docNo, docDate, docDate, periodId, description, totalDebit, totalCredit, createdByUserId,
                (await getBaseCurrency(client)).id]); // สกุลเงินหลัก ไม่ใช่ id 1 ตายตัว
            glEntryId = glHeaderRes.rows[0].id;

            let lineNo = 1;
            for (const l of c.journal) {
                await client.query(`
                    INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                    VALUES ($1,$2,$3,$4,$5,$6,0,0)
                `, [glEntryId, lineNo++, l.account_id, description, l.debit, l.credit]);
            }
        }

        const detail = JSON.stringify({ reconciliation: c.reconciliation, purchases: c.purchases, cogs: c.cogs, warnings: c.warnings,
            inventory_adjustment: c.inventory_adjustment, subledger_cogs: c.subledger_cogs, residual_cogs: c.residual_cogs });
        const vals = [c.beginning_value, c.purchases_value, c.ending_value, c.cogs_value, glEntryId, userName, periodId, detail];
        if (existingRes.rows.length > 0) {
            await client.query(`
                UPDATE im_period_closing SET
                    status='Posted', beginning_value=$1, purchases_value=$2, ending_value=$3, cogs_value=$4,
                    gl_entry_id=$5, calculated_at=NOW(), posted_at=NOW(), posted_by=$6, detail_json=$8
                WHERE period_id = $7
            `, vals);
        } else {
            await client.query(`
                INSERT INTO im_period_closing
                (period_id, status, beginning_value, purchases_value, ending_value, cogs_value, gl_entry_id, calculated_at, posted_at, created_by, posted_by, detail_json)
                VALUES ($7,'Posted',$1,$2,$3,$4,$5,NOW(),NOW(),$6,$6,$8)
            `, vals);
        }

        await client.query('COMMIT');
        res.status(200).json({
            period_id: Number(periodId), status: 'Posted',
            beginning_value: c.beginning_value, purchases_value: c.purchases_value, ending_value: c.ending_value, cogs_value: c.cogs_value,
            gl_entry_id: glEntryId,
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error confirming im_period_closing:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = {
    ensureImPeriodClosingTable, computeClosing,
    calculatePreview, confirmClose,
};
