// controllers/ar/arBulkBillingController.js
// สร้างเอกสารวางบิลแบบกลุ่ม (Bulk Bill Collection)
// สร้าง BC (sys_doc_type='70') ทีละหลายลูกค้าในคราวเดียว
// BC 1 ใบต่อ 1 ลูกค้า โดย reference ใบแจ้งหนี้หลายใบได้

// ─── copy from arTransactionController: generateDocNo ─────────────────────────
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
            const globalRes = await client.query(
                `SELECT * FROM sa_module_document WHERE id = $1`, [docId]
            );
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
        const globalRes = await client.query(
            `SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]
        );
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

// ─── Main controller ──────────────────────────────────────────────────────────
const createBulkBilling = async (req, res) => {
    // billing_date:     วันที่เอกสารวางบิล (doc_date ของ BC)
    // bc_doc_id:        id ของประเภทเอกสารวางบิล (จาก sa_module_document)
    // customer_groups:  [{customer_id, customer_code, customer_name_th,
    //                     invoices: [{txn_id, amount}]}]
    const { billing_date, bc_doc_id, customer_groups } = req.body;
    const userName = req.headers['username'] || '';

    if (!billing_date || !customer_groups || customer_groups.length === 0) {
        return res.status(400).json({ error: 'billing_date and customer_groups are required' });
    }
    if (!bc_doc_id) {
        return res.status(400).json({ error: 'bc_doc_id (ประเภทเอกสารวางบิล) is required' });
    }

    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // ตรวจสอบว่า bc_doc_id ถูกต้องและเป็น sys_doc_type='70'
        const docTypeRes = await client.query(
            `SELECT id FROM sa_module_document
             WHERE id = $1 AND sys_doc_type = '70' AND is_active = true LIMIT 1`,
            [parseInt(bc_doc_id)]
        );
        if (docTypeRes.rows.length === 0)
            throw new Error('ไม่พบประเภทเอกสารวางบิลที่เลือก กรุณาตรวจสอบการตั้งค่า');
        const bcDocId = docTypeRes.rows[0].id;

        // หา period_id สำหรับวันที่วางบิล
        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`,
            [billing_date]
        );
        if (periodRes.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${billing_date}`);
        const periodId = periodRes.rows[0].id;

        const created = [];

        for (const cg of customer_groups) {
            if (!cg.invoices || cg.invoices.length === 0) continue;

            const totalAmount = cg.invoices.reduce(
                (s, i) => s + Number(i.amount || 0), 0
            );
            if (totalAmount <= 0) continue;

            // สร้างเลขที่เอกสารอัตโนมัติ
            const docNo = await generateDocNo(client, bcDocId, billing_date, null);
            if (!docNo)
                throw new Error('ไม่สามารถสร้างเลขที่เอกสารอัตโนมัติได้ กรุณาตั้งค่า Auto Numbering ของเอกสารวางบิล');

            // Insert หัวเอกสารวางบิล (BC)
            // BC: ไม่มีภาษี, ไม่ลงบัญชี GL, balance = total (ยังไม่ถูกรับชำระ)
            const hRes = await client.query(`
                INSERT INTO ar_transaction
                (doc_id, doc_no, doc_date, period_id,
                 customer_id, customer_code, customer_name_th,
                 currency_code, exchange_rate,
                 subtotal_fc, discount_amount_fc, before_vat_fc,
                 vat_amount_fc, total_amount_fc,
                 subtotal_lc, discount_amount_lc, before_vat_lc,
                 vat_amount_lc, total_amount_lc,
                 paid_amount_lc, balance_amount_lc,
                 billing_date, status, created_by, updated_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'THB',1,
                        $8,0,$8,0,$8,
                        $8,0,$8,0,$8,
                        0,$8,
                        $3,'Posted',$9,$9)
                RETURNING id
            `, [
                bcDocId, docNo, billing_date, periodId,
                cg.customer_id, cg.customer_code || null, cg.customer_name_th || null,
                totalAmount, userName,
            ]);
            const bcId = hRes.rows[0].id;

            // Insert apply records (bc_invoice ไม่กระทบ balance ของใบแจ้งหนี้)
            for (const inv of cg.invoices) {
                const amt = Number(inv.amount || 0);
                if (amt <= 0) continue;
                await client.query(`
                    INSERT INTO ar_transaction_apply
                    (transaction_id, applied_to_id,
                     applied_amount_lc, applied_amount_fc,
                     applied_date, apply_type, created_by)
                    VALUES ($1,$2,$3,$3,$4,'bc_invoice',$5)
                `, [bcId, inv.txn_id, amt, billing_date, userName]);
            }

            created.push({
                doc_no:           docNo,
                customer_id:      cg.customer_id,
                customer_code:    cg.customer_code    || '',
                customer_name_th: cg.customer_name_th || '',
                invoice_count:    cg.invoices.length,
                total_amount:     totalAmount,
            });
        }

        await client.query('COMMIT');
        res.json({ success: true, created_count: created.length, created });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Bulk billing error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// ─── ดึงรายการประเภทเอกสารวางบิล (sys_doc_type='70') ─────────────────────────
// ตรวจสิทธิ์ผ่าน sa_user_document เหมือนที่ saModuleDocumentController ทำ
const getBcDocTypes = async (req, res) => {
    const userId = req.headers['userid'];
    const client = await req.dbPool.connect();
    try {
        // ถ้ามี userId → ตรวจสิทธิ์ผ่าน sa_user_document
        // ถ้าไม่มี (fallback) → ดึงทุกรายการ is_active
        let result;
        if (userId) {
            result = await client.query(`
                SELECT m.id, m.doc_code, m.doc_name_thai, m.doc_name_eng
                FROM sa_module_document m
                JOIN sa_user_document u ON u.doc_id = m.id
                WHERE u.user_id    = $1
                  AND m.sys_module = '11'
                  AND m.sys_doc_type = '70'
                  AND m.is_active    = TRUE
                  AND m.is_doc_type  = TRUE
                ORDER BY m.doc_code
            `, [parseInt(userId)]);
        } else {
            result = await client.query(`
                SELECT id, doc_code, doc_name_thai, doc_name_eng
                FROM sa_module_document
                WHERE sys_module  = 11
                  AND sys_doc_type = '70'
                  AND is_active    = TRUE
                  AND is_doc_type  = TRUE
                ORDER BY doc_code
            `);
        }
        res.json(result.rows);
    } catch (err) {
        console.error('BC doc types error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { createBulkBilling, getBcDocTypes };
