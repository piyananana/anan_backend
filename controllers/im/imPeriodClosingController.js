// controllers/im/imPeriodClosingController.js — period-end closing entry for IM Periodic
// accounting mode. Computes COGS = Beginning + Purchases - Ending and posts ONE compound
// GL entry, module-wide (not per doc_code/sys_doc_type like postGlEntry). Purchases is a
// fixed 0 placeholder until GRN exists and posts into im_accounting_setting.purchases_account_id
// — see pattern_im_periodic_accounting_mode memory for the full design rationale.
'use strict';

const { fetchSettingRow } = require('./imAccountingSettingController');

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
};

// มูลค่าสต็อกคงเหลือ ณ ปัจจุบัน — im_stock_balance เป็น aggregate ที่อัปเดตจริงเสมอสำหรับทุก costing_method
// (แม้แต่ FIFO/SPECIFIC ก็เขียนกลับมาที่นี่ผ่าน recomputeBalanceFromLayers ใน imTransactionController.js)
// จึงไม่ต้องแยกอ่าน im_stock_layer เอง — นี่คือจุดคุ้มค่าของดีไซน์ hybrid: ไม่ต้องมีกลไกนับสต็อกแยกต่างหากสำหรับปิดงวด
const computeEndingValue = async (client) => {
    const res = await client.query(`SELECT COALESCE(SUM(qty_on_hand * avg_unit_cost), 0) AS total FROM im_stock_balance`);
    return Number(res.rows[0].total) || 0;
};

// TODO(GRN): เมื่อ GRN โพสต์เข้าบัญชีซื้อ (im_accounting_setting.purchases_account_id) แล้ว ให้รวมยอดจาก
// gl_entry_detail ของบัญชีนั้นในช่วงวันที่ของงวดนี้แทนค่า 0 คงที่ด้านล่าง — ตอนนี้ GRN ยังไม่มี (defer)
const computePurchasesValue = async (client, periodId) => 0;

// ต้นงวด = ปลายงวดของงวดก่อนหน้าที่ปิดไปแล้ว (chain) — แถวแรกสุดถูก seed ตอนสลับโหมดเป็น PERIODIC (ดู
// imAccountingSettingController.js: upsertSetting) ด้วยมูลค่าสต็อก ณ ตอนสลับ จึงมี anchor เสมอสำหรับงวดแรก
const resolveBeginningValue = async (client, periodId) => {
    const periodRes = await client.query(`SELECT period_start_date FROM gl_posting_period WHERE id = $1`, [periodId]);
    if (periodRes.rows.length === 0) throw new Error('ไม่พบงวดบัญชี');
    const startDate = periodRes.rows[0].period_start_date;
    const prevRes = await client.query(`
        SELECT c.ending_value FROM im_period_closing c
        JOIN gl_posting_period p ON p.id = c.period_id
        WHERE p.period_start_date < $1 AND c.status = 'Posted'
        ORDER BY p.period_start_date DESC LIMIT 1
    `, [startDate]);
    return prevRes.rows.length ? (Number(prevRes.rows[0].ending_value) || 0) : 0;
};

// หมายเหตุ: การ seed "ต้นงวด" ของงวดแรกตอนสลับโหมดเป็น PERIODIC อยู่ใน imAccountingSettingController.js
// (upsertSetting) ไม่ใช่ที่นี่ — เพื่อเลี่ยง circular require (ไฟล์นั้น require fetchSettingRow จากที่นี่)
// โครงสร้าง im_period_closing ที่ใช้ seed ต้องตรงกับ ensureImPeriodClosingTable ด้านบนเสมอ

const calculatePreview = async (req, res) => {
    const { periodId } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureImPeriodClosingTable(client);
        const periodRes = await client.query(`SELECT * FROM gl_posting_period WHERE id = $1`, [periodId]);
        if (periodRes.rows.length === 0) return res.status(404).json({ message: 'ไม่พบงวดบัญชี' });

        const beginningValue = await resolveBeginningValue(client, periodId);
        const purchasesValue = await computePurchasesValue(client, periodId);
        const endingValue = await computeEndingValue(client);
        const cogsValue = beginningValue + purchasesValue - endingValue;

        const existing = await client.query(`SELECT * FROM im_period_closing WHERE period_id = $1`, [periodId]);
        res.status(200).json({
            period_id: Number(periodId),
            beginning_value: beginningValue, purchases_value: purchasesValue,
            ending_value: endingValue, cogs_value: cogsValue,
            already_posted: existing.rows[0]?.status === 'Posted',
        });
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

        const draftCheck = await client.query(
            `SELECT COUNT(*) FROM im_transaction WHERE period_id = $1 AND status = 'Draft'`, [periodId]
        );
        const draftCount = Number(draftCheck.rows[0].count);
        if (draftCount > 0) {
            throw new Error(`มีธุรกรรม IM ที่ยังเป็น Draft อยู่ในงวดนี้ จำนวน ${draftCount} รายการ กรุณา Post หรือลบก่อนปิดงวด`);
        }

        const beginningValue = await resolveBeginningValue(client, periodId);
        const purchasesValue = await computePurchasesValue(client, periodId);
        const endingValue = await computeEndingValue(client);
        const cogsValue = beginningValue + purchasesValue - endingValue;

        const setting = await fetchSettingRow(client);
        if (!setting) throw new Error('ยังไม่ได้ตั้งค่าบัญชีปิดงวดสต็อก (ตั้งค่าบัญชีสินค้าคงคลัง IM)');
        if (!setting.closing_gl_doc_id) throw new Error('ยังไม่ได้ตั้งค่าประเภทเอกสาร GL สำหรับปิดงวดสต็อก');
        if (!setting.inventory_account_id || !setting.cogs_account_id) {
            throw new Error('ยังไม่ได้ตั้งค่าบัญชีสต็อกและ/หรือบัญชีต้นทุนขายสำหรับปิดงวดสต็อก');
        }

        // net > 0 = debit สุทธิ, net < 0 = credit สุทธิ — สูตรเดียวกับที่ postGlEntry ใช้ใน imTransactionController.js
        const netByAccount = {};
        const addNet = (accountId, amount) => {
            if (!accountId || amount === 0) return;
            netByAccount[accountId] = (netByAccount[accountId] || 0) + amount;
        };
        addNet(setting.inventory_account_id, endingValue - beginningValue);
        addNet(setting.cogs_account_id, cogsValue);
        if (purchasesValue !== 0) addNet(setting.purchases_account_id, -purchasesValue);

        const description = `ปิดงวดสต็อกสินค้า (Periodic) งวด ${period.period_name}`;
        const glDetails = [];
        for (const [accountId, amount] of Object.entries(netByAccount)) {
            if (amount === 0) continue;
            glDetails.push({
                account_id: Number(accountId), description,
                debit_lc: amount > 0 ? amount : 0, credit_lc: amount < 0 ? -amount : 0,
            });
        }

        let glEntryId = null;
        if (glDetails.length > 0) {
            const docDate = period.period_end_date;
            let docNo = await generateDocNo(client, setting.closing_gl_doc_id, docDate, null);
            if (!docNo) docNo = `IMCLOSE-${period.id}`;

            let createdByUserId = null;
            if (userName) {
                const userRes = await client.query(`SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [userName]);
                if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
            }

            const totalDebit = glDetails.reduce((s, l) => s + l.debit_lc, 0);
            const totalCredit = glDetails.reduce((s, l) => s + l.credit_lc, 0);

            const glHeaderRes = await client.query(`
                INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id, description,
                 currency_id, exchange_rate, status, total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,1,1,'Posted',$7,$8,0,0,$9)
                RETURNING id
            `, [setting.closing_gl_doc_id, docNo, docDate, docDate, periodId, description, totalDebit, totalCredit, createdByUserId]);
            glEntryId = glHeaderRes.rows[0].id;

            let lineNo = 1;
            for (const l of glDetails) {
                await client.query(`
                    INSERT INTO gl_entry_detail (header_id, line_no, account_id, description, debit_lc, credit_lc, debit_fc, credit_fc)
                    VALUES ($1,$2,$3,$4,$5,$6,0,0)
                `, [glEntryId, lineNo++, l.account_id, l.description, l.debit_lc, l.credit_lc]);
            }
        }

        if (existingRes.rows.length > 0) {
            await client.query(`
                UPDATE im_period_closing SET
                    status='Posted', beginning_value=$1, purchases_value=$2, ending_value=$3, cogs_value=$4,
                    gl_entry_id=$5, calculated_at=NOW(), posted_at=NOW(), posted_by=$6
                WHERE period_id = $7
            `, [beginningValue, purchasesValue, endingValue, cogsValue, glEntryId, userName, periodId]);
        } else {
            await client.query(`
                INSERT INTO im_period_closing
                (period_id, status, beginning_value, purchases_value, ending_value, cogs_value, gl_entry_id, calculated_at, posted_at, created_by, posted_by)
                VALUES ($1,'Posted',$2,$3,$4,$5,$6,NOW(),NOW(),$7,$7)
            `, [periodId, beginningValue, purchasesValue, endingValue, cogsValue, glEntryId, userName]);
        }

        await client.query('COMMIT');
        res.status(200).json({
            period_id: Number(periodId), status: 'Posted',
            beginning_value: beginningValue, purchases_value: purchasesValue, ending_value: endingValue, cogs_value: cogsValue,
            gl_entry_id: glEntryId,
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error confirming im_period_closing:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

module.exports = {
    ensureImPeriodClosingTable,
    calculatePreview, confirmClose,
};
