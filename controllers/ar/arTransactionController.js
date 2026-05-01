// controllers/ar/arTransactionController.js

// --- Helper: Generate Document Number (same pattern as GL) ---
const generateDocNo = async (client, docId, date) => {
    const docConfigRes = await client.query(
        `SELECT * FROM sa_module_document WHERE id = $1 FOR UPDATE`, [docId]
    );
    const config = docConfigRes.rows[0];
    if (!config.is_auto_numbering) return null;

    let docNo = config.format_prefix || '';
    if (config.format_suffix_date) {
        const d = new Date(date);
        const year = d.getFullYear().toString();
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const day = d.getDate().toString().padStart(2, '0');
        if (config.format_suffix_date === 'YY') docNo += year.substring(2);
        else if (config.format_suffix_date === 'YYYY') docNo += year;
        else if (config.format_suffix_date === 'YYMM') docNo += year.substring(2) + month;
        else if (config.format_suffix_date === 'YYYYMM') docNo += year + month;
        else if (config.format_suffix_date === 'YYYYMMDD') docNo += year + month + day;
    }
    if (config.format_separator) docNo += config.format_separator;
    const running = config.next_running_number.toString().padStart(config.running_length, '0');
    docNo += running;
    await client.query(
        `UPDATE sa_module_document SET next_running_number = next_running_number + 1 WHERE id = $1`,
        [docId]
    );
    return docNo;
};

// --- Helper: Insert VAT records (เฉพาะรายการที่ไม่ใช่ VAT รอตัดบัญชี) ---
const insertVtRecords = async (client, headerId, header, details, sysDocType) => {
    // is_deferred_vat = true → ข้าม เพราะจะบันทึกตอนรับชำระแทน
    const vatDetails = details.filter(d =>
        d.vat_type && d.vat_type !== 'NOVAT' &&
        Number(d.vat_amount_fc) !== 0 &&
        !d.is_deferred_vat
    );
    // Credit Note (sys_doc_type='50','55') → VAT เป็นลบ (ลดยอดภาษีขาย)
    const vatSign = (['50', '55'].includes(sysDocType)) ? -1 : 1;

    for (const d of vatDetails) {
        await client.query(`
            INSERT INTO vt_transaction
            (module_code, vat_type, doc_id, source_header_id, source_detail_id,
             doc_no, doc_date, vat_rate,
             base_amount_lc, vat_amount_lc, base_amount_fc, vat_amount_fc,
             currency_id, exchange_rate,
             customer_id, entity_name, entity_tax_id,
             created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        `, [
            'AR', 'OUTPUT_VAT', header.doc_id, headerId, d.id || null,
            header.doc_no, header.doc_date, d.vat_rate ?? 7,
            (d.subtotal_lc || 0) * vatSign, (d.vat_amount_lc || 0) * vatSign,
            (d.subtotal_fc || 0) * vatSign, (d.vat_amount_fc || 0) * vatSign,
            header.currency_id || null, header.exchange_rate || 1,
            header.customer_id, header.customer_name_th || '',
            header.customer_tax_id || null,
            header.created_by || null
        ]);
    }
};

// --- Helper: Insert deferred VAT records at receipt time ---
// คำนวณ VAT รอตัดบัญชี สำหรับ invoice ที่มี deferred VAT lines ตามสัดส่วนที่ชำระ
const insertDeferredVtRecordsForReceipt = async (client, receiptHeaderId, receiptHeader, applies) => {
    // Migration: widen vat_type column if still VARCHAR(15)
    await client.query(`
        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'vt_transaction'
                  AND column_name = 'vat_type'
                  AND character_maximum_length < 30
            ) THEN
                ALTER TABLE vt_transaction ALTER COLUMN vat_type TYPE VARCHAR(30);
            END IF;
        END $$
    `);
    for (const a of applies) {
        const invoiceId = a.applied_to_id;
        const appliedAmount = Number(a.applied_amount_lc) || 0;
        if (!invoiceId || appliedAmount === 0) continue;

        // ดึงข้อมูล invoice header
        const invRes = await client.query(
            `SELECT * FROM ar_transaction WHERE id = $1`, [invoiceId]
        );
        if (invRes.rows.length === 0) continue;
        const inv = invRes.rows[0];
        const invoiceTotal = Number(inv.total_amount_lc) || 0;
        if (invoiceTotal === 0) continue;

        // ดึง deferred VAT lines ของ invoice
        const detailRes = await client.query(
            `SELECT * FROM ar_transaction_detail WHERE header_id = $1 AND is_deferred_vat = TRUE AND vat_type != 'NOVAT'`,
            [invoiceId]
        );
        if (detailRes.rows.length === 0) continue;

        const ratio = appliedAmount / invoiceTotal;

        // ดึง doc_id ของ receipt สำหรับ vt_transaction
        for (const d of detailRes.rows) {
            const baseLc = Number(d.subtotal_lc) * ratio;
            const vatLc  = Number(d.vat_amount_lc) * ratio;
            if (vatLc === 0) continue;
            await client.query(`
                INSERT INTO vt_transaction
                (module_code, vat_type, doc_id, source_header_id, source_detail_id,
                 doc_no, doc_date, vat_rate,
                 base_amount_lc, vat_amount_lc, base_amount_fc, vat_amount_fc,
                 currency_id, exchange_rate,
                 customer_id, entity_name, entity_tax_id,
                 created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
            `, [
                'AR', 'VAT_DEFERRED', receiptHeader.doc_id, receiptHeaderId, d.id,
                receiptHeader.doc_no, receiptHeader.doc_date, d.vat_rate ?? 7,
                baseLc, vatLc,
                baseLc / (receiptHeader.exchange_rate || 1),
                vatLc  / (receiptHeader.exchange_rate || 1),
                receiptHeader.currency_id || null, receiptHeader.exchange_rate || 1,
                receiptHeader.customer_id, receiptHeader.customer_name_th || '',
                receiptHeader.customer_tax_id || null,
                receiptHeader.created_by || null
            ]);
        }
    }
};

// --- Helper: Resolve GL account for a payment row ---
// Priority: payment_method.gl_account_id → cm_bank_account.gl_account_id → ar_gl_account_setup.cash_account_id
const resolvePaymentGlAccount = async (client, payment, setup, fallbackCashAccountId) => {
    // 1. payment_method.gl_account_id (already resolved on Flutter side and stored in payment.gl_account_id)
    if (payment.gl_account_id) return Number(payment.gl_account_id);
    // 2. cm_bank_account.gl_account_id
    if (payment.cm_bank_account_id) {
        const baRes = await client.query(
            `SELECT gl_account_id FROM cm_bank_account WHERE id = $1`, [payment.cm_bank_account_id]
        );
        if (baRes.rows.length > 0 && baRes.rows[0].gl_account_id)
            return Number(baRes.rows[0].gl_account_id);
    }
    // 3. ar_gl_account_setup per-payment-type account
    if (setup) {
        const typeMap = {
            'CHECK':            setup.check_account_id,
            'TRANSFER':         setup.transfer_account_id,
            'CREDIT_CARD':      setup.credit_card_account_id,
            'DEBIT_CARD':       setup.debit_card_account_id,
            'QR_CODE':          setup.qr_code_account_id,
            'MOBILE_BANKING':   setup.mobile_banking_account_id,
            'BILL_OF_EXCHANGE': setup.bill_of_exchange_account_id,
        };
        const perTypeId = typeMap[payment.payment_method_type];
        if (perTypeId) return Number(perTypeId);
    }
    // 4. fallback: ar_gl_account_setup.cash_account_id
    return fallbackCashAccountId || null;
};

// --- Helper: Post GL Entry for AR transaction ---
const postGlEntry = async (client, headerId, header, details, docNo) => {
    // Find open period
    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period
         WHERE $1::date BETWEEN period_start_date AND period_end_date
         AND gl_status = 'OPEN' LIMIT 1`,
        [header.doc_date]
    );
    if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.doc_date}`);
    const periodId = periodRes.rows[0].id;

    // Fetch sysDocType early to determine which accounts are needed
    const docTypeRes = await client.query(
        `SELECT sys_doc_type FROM sa_module_document WHERE id = $1 LIMIT 1`, [header.doc_id]
    );
    const sysDocType       = docTypeRes.rows[0]?.sys_doc_type || '';
    const isReceipt        = sysDocType === '70';
    const isCreditNote     = ['50', '55'].includes(sysDocType);
    const isAdvanceReceipt = sysDocType === '60';
    const isAdvanceRefund  = sysDocType === '65';
    const isRevenueBased   = ['10', '30', '35', '50', '55'].includes(sysDocType);

    // --- Resolve AR account (priority: ar_gl_account_setup > customer_group > customer) ---
    // ไม่ต้องใช้บัญชีลูกหนี้สำหรับ รับเงินมัดจำ (60) และ คืนเงินมัดจำ (65)
    let arAccountId = null;
    if (!isAdvanceReceipt && !isAdvanceRefund) {
        arAccountId = Number(header.ar_account_id) || null;

        // 1. ar_gl_account_setup.ar_account_id (ตามประเภทเอกสาร)
        if (!arAccountId && header.doc_id) {
            const arSetupRes = await client.query(
                `SELECT s.ar_account_id FROM ar_gl_account_setup s
                 JOIN sa_module_document d ON d.doc_code = s.doc_code
                 WHERE d.id = $1 LIMIT 1`,
                [header.doc_id]
            );
            if (arSetupRes.rows.length > 0 && arSetupRes.rows[0].ar_account_id)
                arAccountId = arSetupRes.rows[0].ar_account_id;
        }

        // 2. ar_customer_group.gl_account_id (กลุ่มลูกค้า)
        if (!arAccountId && header.customer_id) {
            const groupRes = await client.query(
                `SELECT g.gl_account_id FROM ar_customer c
                 JOIN ar_customer_group g ON g.id = c.customer_group_id
                 WHERE c.id = $1 LIMIT 1`,
                [header.customer_id]
            );
            if (groupRes.rows.length > 0 && groupRes.rows[0].gl_account_id)
                arAccountId = groupRes.rows[0].gl_account_id;
        }

        // 3. ar_customer.ar_account_id (ลูกค้า)
        if (!arAccountId && header.customer_id) {
            const custRes = await client.query(
                `SELECT ar_account_id FROM ar_customer WHERE id = $1 LIMIT 1`,
                [header.customer_id]
            );
            if (custRes.rows.length > 0 && custRes.rows[0].ar_account_id)
                arAccountId = custRes.rows[0].ar_account_id;
        }

        if (!arAccountId) throw new Error('ไม่พบบัญชีลูกหนี้สำหรับการลงบัญชี กรุณาตั้งค่าใน ar_gl_account_setup, กลุ่มลูกค้า หรือลูกค้า');
    }

    // --- Query ar_gl_account_setup เพื่อดึงบัญชีที่ต้องใช้ใน GL ---
    const setupRes = await client.query(
        `SELECT s.gl_doc_id, s.vat_output_account_id, s.vat_pending_output_account_id,
                s.discount_account_id, s.cash_account_id, s.advance_account_id,
                s.revenue_account_id,
                s.check_account_id, s.transfer_account_id, s.credit_card_account_id,
                s.debit_card_account_id, s.qr_code_account_id, s.mobile_banking_account_id,
                s.bill_of_exchange_account_id
         FROM ar_gl_account_setup s
         JOIN sa_module_document d ON d.doc_code = s.doc_code
         WHERE d.id = $1 LIMIT 1`,
        [header.doc_id]
    );
    const setup = setupRes.rows[0] || {};

    // gl_doc_id ต้องได้มาจาก ar_gl_account_setup เท่านั้น ห้ามใช้ AR doc_id แทน
    const glDocId = setup.gl_doc_id;
    if (!glDocId) throw new Error('ยังไม่ได้ตั้งค่า GL Document Type ใน ar_gl_account_setup สำหรับประเภทเอกสารนี้');

    let glDocNo = await generateDocNo(client, glDocId, header.doc_date);
    if (!glDocNo) glDocNo = `GL-${docNo}`;

    // บัญชี VAT output, VAT รอตัดบัญชี, ส่วนลด, เงินสด, มัดจำรับ
    const vatAccountId        = Number(setup.vat_output_account_id)         || Number(header.vat_account_id) || null;
    const vatPendingAccountId = Number(setup.vat_pending_output_account_id) || null;
    const discountAccountId   = Number(setup.discount_account_id)           || null;
    const cashAccountId           = Number(setup.cash_account_id)           || null;
    const advanceAccountId        = Number(setup.advance_account_id)        || null;
    const defaultRevenueAccountId = Number(setup.revenue_account_id)        || null;
    const exchangeRate        = Number(header.exchange_rate) || 1;

    // Resolve created_by เป็น integer user_id (gl_entry_header.created_by เป็น INT FK)
    let createdByUserId = null;
    if (header.created_by) {
        const userRes = await client.query(
            `SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`,
            [header.created_by]
        );
        if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
    }

    // Insert GL entry header
    // doc_no = เลขที่ GL ที่ generate ใหม่, ref_doc_no = เลขที่เอกสาร AR ต้นทาง
    const glHeaderSql = `
        INSERT INTO gl_entry_header
        (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
         currency_id, exchange_rate, status,
         total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
         created_by, ref_doc_id, ref_doc_no, external_source_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Posted',$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING id
    `;
    const totalDebit = Number(header.total_amount_lc) || 0;
    const glHeaderParams = [
        glDocId, glDocNo, header.doc_date, header.doc_date, periodId,
        header.ref_no || null, header.description || null,
        header.currency_id || 1, header.exchange_rate || 1,
        totalDebit, totalDebit,
        Number(header.total_amount_fc) || 0, Number(header.total_amount_fc) || 0,
        createdByUserId, header.doc_id, docNo, headerId
    ];
    const glHeaderRes = await client.query(glHeaderSql, glHeaderParams);
    const glEntryId = glHeaderRes.rows[0].id;

    // Build GL detail lines
    const glDetails = [];

    if (isRevenueBased) {
        // ===== Invoice / Debit Note (30,35) / Credit Note (50,55) =====
        // DR: AR Account (total_amount_lc)
        glDetails.push({
            account_id: arAccountId,
            description: `AR ${docNo}`,
            debit_lc: totalDebit,
            credit_lc: 0,
            debit_fc: Number(header.total_amount_fc) || 0,
            credit_fc: 0,
        });
        // CR: Revenue per line + VAT (แยก immediate vs deferred)
        // ถ้าตั้งค่า discount_account_id ไว้: CR Revenue = ยอดรวม (ก่อนหักส่วนลด), DR Discount = ยอดส่วนลด
        // ถ้าไม่ได้ตั้งค่า: CR Revenue = ยอดสุทธิ (หลังหักส่วนลดแล้ว)
        for (const d of details) {
            if (d.revenue_account_id) {
                const discFc = Number(d.discount_amount_fc) || 0;
                const discLc = discFc * exchangeRate;
                const netLc  = Number(d.subtotal_lc) || 0;
                const netFc  = Number(d.subtotal_fc) || 0;

                if (discountAccountId && discLc > 0) {
                    // บรรทัดรายได้: CR ยอดรวมก่อนส่วนลด (gross)
                    const grossLc = netLc + discLc;
                    const grossFc = netFc + discFc;
                    if (grossLc !== 0) {
                        glDetails.push({
                            account_id: Number(d.revenue_account_id),
                            description: d.description || d.item_name || '',
                            debit_lc: 0,
                            credit_lc: grossLc,
                            debit_fc: 0,
                            credit_fc: grossFc,
                        });
                    }
                    // บรรทัดส่วนลด: DR ส่วนลดรายได้
                    glDetails.push({
                        account_id: discountAccountId,
                        description: `ส่วนลด ${docNo}`,
                        debit_lc: discLc,
                        credit_lc: 0,
                        debit_fc: discFc,
                        credit_fc: 0,
                    });
                } else if (netLc !== 0) {
                    // ไม่มีบัญชีส่วนลด: CR รายได้สุทธิ
                    glDetails.push({
                        account_id: Number(d.revenue_account_id),
                        description: d.description || d.item_name || '',
                        debit_lc: 0,
                        credit_lc: netLc,
                        debit_fc: 0,
                        credit_fc: netFc,
                    });
                }
            }
            if (Number(d.vat_amount_lc) !== 0) {
                if (d.is_deferred_vat) {
                    // CR: ภาษีขายรอตัดบัญชี (Deferred VAT Output)
                    if (vatPendingAccountId) {
                        glDetails.push({
                            account_id: vatPendingAccountId,
                            description: `VAT รอตัดบัญชี ${docNo}`,
                            debit_lc: 0,
                            credit_lc: Number(d.vat_amount_lc) || 0,
                            debit_fc: 0,
                            credit_fc: Number(d.vat_amount_fc) || 0,
                        });
                    }
                } else {
                    // CR: ภาษีขายผลผลิต (Immediate VAT Output)
                    if (vatAccountId) {
                        glDetails.push({
                            account_id: vatAccountId,
                            description: `VAT ${docNo}`,
                            debit_lc: 0,
                            credit_lc: Number(d.vat_amount_lc) || 0,
                            debit_fc: 0,
                            credit_fc: Number(d.vat_amount_fc) || 0,
                        });
                    }
                }
            }
        }

        // กรณีไม่มี detail rows (เช่น '35', '55' ระบุใบแจ้งหนี้) → ใช้ default revenue account จาก setup
        // glDetails ตอนนี้มีแค่ AR entry (1 บรรทัด) หมายความว่าไม่มีรายได้/VAT จาก detail
        if (glDetails.length === 1 && defaultRevenueAccountId && totalDebit > 0) {
            glDetails.push({
                account_id: defaultRevenueAccountId,
                description: `รายได้ ${docNo}`,
                debit_lc: 0,
                credit_lc: totalDebit,
                debit_fc: 0,
                credit_fc: Number(header.total_amount_fc) || 0,
            });
        }

        // สำหรับ Credit Note (50,55): กลับทิศทาง Debit/Credit ทั้งหมด
        // Invoice/DN: DR AR, CR Revenue, CR VAT
        // Credit Note: DR Revenue, DR VAT, CR AR
        if (isCreditNote) {
            for (const d of glDetails) {
                [d.debit_lc, d.credit_lc] = [d.credit_lc, d.debit_lc];
                [d.debit_fc, d.credit_fc] = [d.credit_fc, d.debit_fc];
            }
        }
    } else if (isAdvanceReceipt) {
        // ===== รับเงินมัดจำ (60) =====
        // DR: เงินสด/ธนาคาร (แยกตามวิธีรับชำระ ถ้ามี ถ้าไม่มีใช้ cash_account_id)
        // CR: เงินมัดจำรับ (advance_account_id)
        const payments60 = header._payments || [];
        if (payments60.length > 0) {
            for (const p of payments60) {
                const pAmount = Number(p.amount_lc) || 0;
                if (pAmount === 0) continue;
                const pGlAccountId = await resolvePaymentGlAccount(client, p, setup, cashAccountId);
                if (pGlAccountId) {
                    glDetails.push({
                        account_id: pGlAccountId,
                        description: `รับมัดจำ ${p.payment_method_code || ''} ${docNo}`,
                        debit_lc: pAmount,
                        credit_lc: 0,
                        debit_fc: Number(p.amount_fc) || pAmount,
                        credit_fc: 0,
                    });
                }
            }
        } else if (cashAccountId && totalDebit > 0) {
            glDetails.push({
                account_id: cashAccountId,
                description: `รับมัดจำ ${docNo}`,
                debit_lc: totalDebit,
                credit_lc: 0,
                debit_fc: Number(header.total_amount_fc) || 0,
                credit_fc: 0,
            });
        }
        if (advanceAccountId) {
            glDetails.push({
                account_id: advanceAccountId,
                description: `มัดจำรับ ${docNo}`,
                debit_lc: 0,
                credit_lc: totalDebit,
                debit_fc: 0,
                credit_fc: Number(header.total_amount_fc) || 0,
            });
        }
    } else if (isAdvanceRefund) {
        // ===== คืนเงินมัดจำ (65) =====
        // DR: เงินมัดจำรับ (advance_account_id)
        // CR: เงินสด/ธนาคาร (cash_account_id)
        if (advanceAccountId) {
            glDetails.push({
                account_id: advanceAccountId,
                description: `คืนมัดจำ ${docNo}`,
                debit_lc: totalDebit,
                credit_lc: 0,
                debit_fc: Number(header.total_amount_fc) || 0,
                credit_fc: 0,
            });
        }
        if (cashAccountId) {
            glDetails.push({
                account_id: cashAccountId,
                description: `จ่ายคืนมัดจำ ${docNo}`,
                debit_lc: 0,
                credit_lc: totalDebit,
                debit_fc: 0,
                credit_fc: Number(header.total_amount_fc) || 0,
            });
        }
    } else {
        // ===== Receipt (70) =====

        // แยก applies ออกเป็น invoice applies, advance deductions และ CN deductions
        const allApplies = header._applies || [];
        const invoiceApplies    = allApplies.filter(a => (a.apply_type || 'invoice') === 'invoice');
        const advanceDeductions = allApplies.filter(a => a.apply_type === 'advance');
        const cnDeductions      = allApplies.filter(a => a.apply_type === 'cn');

        const totalInvoiceApplied   = invoiceApplies.reduce((s, a) => s + (Number(a.applied_amount_lc) || 0), 0);
        const totalAdvanceDeducted  = advanceDeductions.reduce((s, a) => s + (Number(a.applied_amount_lc) || 0), 0);
        const totalCnDeducted       = cnDeductions.reduce((s, a) => s + (Number(a.applied_amount_lc) || 0), 0);
        const totalInvoiceAppliedFc  = invoiceApplies.reduce((s, a) => s + (Number(a.applied_amount_fc) || 0), 0);
        const totalAdvanceDeductedFc = advanceDeductions.reduce((s, a) => s + (Number(a.applied_amount_fc) || 0), 0);
        const totalCnDeductedFc      = cnDeductions.reduce((s, a) => s + (Number(a.applied_amount_fc) || 0), 0);

        // DR: Cash/Bank Account — แยกตามวิธีรับชำระ (ถ้ามี) ถ้าไม่มีใช้ cash_account_id เดียว
        // totalDebit = header.total_amount_lc = cash component only
        // (Flutter คำนวณ total = invoiceApplied - advanceDeducted - cnDeducted แล้วส่งมา)
        const payments70 = header._payments || [];
        if (payments70.length > 0 && totalDebit > 0) {
            for (const p of payments70) {
                const pAmount = Number(p.amount_lc) || 0;
                if (pAmount === 0) continue;
                const pGlAccountId = await resolvePaymentGlAccount(client, p, setup, cashAccountId);
                if (pGlAccountId) {
                    glDetails.push({
                        account_id: pGlAccountId,
                        description: `รับชำระ ${p.payment_method_code || ''} ${docNo}`,
                        debit_lc: pAmount,
                        credit_lc: 0,
                        debit_fc: Number(p.amount_fc) || pAmount,
                        credit_fc: 0,
                    });
                }
            }
        } else if (cashAccountId && totalDebit > 0) {
            glDetails.push({
                account_id: cashAccountId,
                description: `รับชำระ ${docNo}`,
                debit_lc: totalDebit,
                credit_lc: 0,
                debit_fc: Number(header.total_amount_fc) || 0,
                credit_fc: 0,
            });
        }

        // CR: AR Account
        // cash + advance = invoice applied (advance ใช้แทนเงินสด ดังนั้น CR AR = invoice ทั้งหมด)
        // CN ลด AR ไปแล้วตอน Post CN → หัก CN ออกจาก CR AR ไม่ให้ double-credit
        // ใช้ explicit ternary แทน || เพื่อหลีกเลี่ยง 0 ถูกมองเป็น falsy ใน JS
        const arCreditLc = totalInvoiceApplied > 0
            ? (totalInvoiceApplied - totalCnDeducted)
            : totalDebit;
        const arCreditFc = totalInvoiceAppliedFc > 0
            ? (totalInvoiceAppliedFc - totalCnDeductedFc)
            : (Number(header.total_amount_fc) || 0);
        // บันทึก CR AR เฉพาะเมื่อมียอดจริง (กรณี DN+CN หักกลบ=0 ไม่มีรายการบัญชี แต่ GL header ยังคงอยู่เพื่อเป็นหลักฐาน)
        if (arAccountId && arCreditLc > 0) {
            glDetails.push({
                account_id: arAccountId,
                description: `ชำระหนี้ ${docNo}`,
                debit_lc: 0,
                credit_lc: arCreditLc,
                debit_fc: 0,
                credit_fc: arCreditFc,
            });
        }

        // DR: เงินมัดจำรับ (ตัดมัดจำ)
        if (totalAdvanceDeducted > 0 && advanceAccountId) {
            glDetails.push({
                account_id: advanceAccountId,
                description: `ตัดมัดจำ ${docNo}`,
                debit_lc: totalAdvanceDeducted,
                credit_lc: 0,
                debit_fc: totalAdvanceDeductedFc,
                credit_fc: 0,
            });
        }

        // คำนวณ Deferred VAT ที่ต้องรับรู้ จาก applied invoices (เฉพาะ invoice applies เท่านั้น)
        let totalDeferredVatLc = 0;
        let totalDeferredVatFc = 0;
        for (const a of invoiceApplies) {
            const invoiceId = a.applied_to_id;
            const appliedAmount = Number(a.applied_amount_lc) || 0;
            if (!invoiceId || appliedAmount === 0) continue;

            const invRes = await client.query(
                `SELECT total_amount_lc FROM ar_transaction WHERE id = $1`, [invoiceId]
            );
            if (invRes.rows.length === 0) continue;
            const invoiceTotal = Number(invRes.rows[0].total_amount_lc) || 0;
            if (invoiceTotal === 0) continue;
            const ratio = appliedAmount / invoiceTotal;

            const dRes = await client.query(
                `SELECT vat_amount_lc, vat_amount_fc FROM ar_transaction_detail
                 WHERE header_id = $1 AND is_deferred_vat = TRUE AND vat_type != 'NOVAT'`,
                [invoiceId]
            );
            for (const d of dRes.rows) {
                totalDeferredVatLc += Number(d.vat_amount_lc) * ratio;
                totalDeferredVatFc += Number(d.vat_amount_fc) * ratio;
            }
        }

        // DR: ภาษีขายรอตัดบัญชี → CR: ภาษีขายผลผลิต (รับรู้ VAT รอตัดบัญชี)
        if (totalDeferredVatLc > 0 && vatPendingAccountId && vatAccountId) {
            glDetails.push({
                account_id: vatPendingAccountId,
                description: `รับรู้ VAT รอตัดบัญชี ${docNo}`,
                debit_lc: totalDeferredVatLc,
                credit_lc: 0,
                debit_fc: totalDeferredVatFc,
                credit_fc: 0,
            });
            glDetails.push({
                account_id: vatAccountId,
                description: `VAT รอตัดบัญชี ${docNo}`,
                debit_lc: 0,
                credit_lc: totalDeferredVatLc,
                debit_fc: 0,
                credit_fc: totalDeferredVatFc,
            });
        }
    }

    // อัปเดต total_debit/credit ของ GL header ให้ตรงกับ detail lines จริง
    const totalDbLc = glDetails.reduce((s, r) => s + (r.debit_lc  || 0), 0);
    const totalCrLc = glDetails.reduce((s, r) => s + (r.credit_lc || 0), 0);
    const totalDbFc = glDetails.reduce((s, r) => s + (r.debit_fc  || 0), 0);
    const totalCrFc = glDetails.reduce((s, r) => s + (r.credit_fc || 0), 0);
    await client.query(
        `UPDATE gl_entry_header SET total_debit_lc=$1, total_credit_lc=$2, total_debit_fc=$3, total_credit_fc=$4 WHERE id=$5`,
        [totalDbLc, totalCrLc, totalDbFc, totalCrFc, glEntryId]
    );

    const detailSql = `
        INSERT INTO gl_entry_detail
        (header_id, line_no, account_id, description,
         debit_lc, credit_lc, debit_fc, credit_fc,
         branch_id, project_id, business_unit_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `;
    let lineNo = 1;
    for (const row of glDetails) {
        await client.query(detailSql, [
            glEntryId, lineNo++, row.account_id, row.description,
            row.debit_lc, row.credit_lc, row.debit_fc, row.credit_fc,
            null, null, null
        ]);
    }

    return glEntryId;
};

// --- Helper: create ar_transaction_payment if it doesn't exist yet ---
const ensurePaymentTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS ar_transaction_payment (
            id                   SERIAL PRIMARY KEY,
            header_id            INT NOT NULL REFERENCES ar_transaction(id) ON DELETE CASCADE,
            line_no              INT NOT NULL DEFAULT 1,
            payment_method_id    INT REFERENCES cm_payment_method(id),
            payment_method_code  VARCHAR(50),
            payment_method_name  VARCHAR(200),
            payment_method_type  VARCHAR(30) NOT NULL DEFAULT 'CASH',
            cm_bank_account_id   INT REFERENCES cm_bank_account(id),
            gl_account_id        INT REFERENCES gl_account(id),
            amount_lc            NUMERIC(18,4) NOT NULL DEFAULT 0,
            amount_fc            NUMERIC(18,4) NOT NULL DEFAULT 0,
            ref_no               VARCHAR(100),
            payment_date         DATE,
            remark               TEXT,
            drawer_bank_name     VARCHAR(100),
            drawer_bank_branch   VARCHAR(100),
            drawer_account_no    VARCHAR(50),
            card_type            VARCHAR(20),
            card_last4           CHAR(4),
            approval_code        VARCHAR(20),
            terminal_id          VARCHAR(20),
            batch_no             VARCHAR(20),
            created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
            created_by           VARCHAR(100)
        )
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_ar_transaction_payment_header ON ar_transaction_payment(header_id)
    `);
    // Migration: ถ้าตารางถูกสร้างด้วย created_by INT (ก่อนแก้ไข) → แปลงเป็น VARCHAR
    await client.query(`
        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'ar_transaction_payment'
                  AND column_name = 'created_by'
                  AND data_type = 'integer'
            ) THEN
                ALTER TABLE ar_transaction_payment
                    ALTER COLUMN created_by TYPE VARCHAR(100) USING created_by::VARCHAR;
            END IF;
        END $$
    `);
};

// --- 1. Create Transaction (Draft/Post) ---
const createTransaction = async (req, res) => {
    const { header, details, applies, payments, action } = req.body; // action: 'Draft' | 'Post'
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // Validate period for Post
        if (action === 'Post') {
            const periodRes = await client.query(
                `SELECT id FROM gl_posting_period
                 WHERE $1::date BETWEEN period_start_date AND period_end_date
                 AND gl_status = 'OPEN' LIMIT 1`,
                [header.doc_date]
            );
            if (periodRes.rows.length === 0)
                throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        }

        // Find period_id (always needed)
        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`,
            [header.doc_date]
        );
        if (periodRes.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        const periodId = periodRes.rows[0].id;

        // Generate doc_no
        let finalDocNo = header.doc_no;
        if (!finalDocNo || finalDocNo === 'AUTO') {
            finalDocNo = await generateDocNo(client, header.doc_id, header.doc_date);
            if (!finalDocNo) throw new Error('Auto numbering failed or manual doc_no required');
        }

        const status = action === 'Post' ? 'Posted' : 'Draft';

        // Insert header
        const headerSql = `
            INSERT INTO ar_transaction
            (doc_id, doc_no, doc_date, due_date, period_id,
             customer_id, customer_code, customer_name_th,
             ar_account_id, currency_id, currency_code, exchange_rate,
             subtotal_fc, discount_amount_fc, before_vat_fc, vat_amount_fc, total_amount_fc,
             subtotal_lc, discount_amount_lc, before_vat_lc, vat_amount_lc, total_amount_lc,
             paid_amount_lc, balance_amount_lc,
             ref_no, ref_doc_id, ref_doc_no, description, status,
             created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                    $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                    $25,$26,$27,$28,$29,$30)
            RETURNING id
        `;
        const hRes = await client.query(headerSql, [
            header.doc_id, finalDocNo, header.doc_date, header.due_date || null, periodId,
            header.customer_id, header.customer_code || null, header.customer_name_th || null,
            header.ar_account_id || null, header.currency_id || null, header.currency_code || 'THB',
            header.exchange_rate || 1,
            header.subtotal_fc || 0, header.discount_amount_fc || 0,
            header.before_vat_fc || 0, header.vat_amount_fc || 0, header.total_amount_fc || 0,
            header.subtotal_lc || 0, header.discount_amount_lc || 0,
            header.before_vat_lc || 0, header.vat_amount_lc || 0, header.total_amount_lc || 0,
            0, header.total_amount_lc || 0,  // paid=0, balance=total
            header.ref_no || null, header.ref_doc_id || null, header.ref_doc_no || null,
            header.description || null, status,
            header.created_by || null
        ]);
        const newHeaderId = hRes.rows[0].id;

        // Insert details
        const detailSql = `
            INSERT INTO ar_transaction_detail
            (header_id, line_no, item_code, item_name, description,
             quantity, unit_code, unit_price_fc, discount_percent, discount_amount_fc,
             subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
             revenue_account_id, subtotal_lc, vat_amount_lc, total_amount_lc, is_deferred_vat)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
            RETURNING id
        `;
        let lineNo = 1;
        for (const d of (details || [])) {
            await client.query(detailSql, [
                newHeaderId, lineNo++,
                d.item_code || null, d.item_name || null, d.description || null,
                d.quantity ?? 1, d.unit_code || null,
                d.unit_price_fc || 0, d.discount_percent || 0, d.discount_amount_fc || 0,
                d.subtotal_fc || 0, d.vat_type || 'VAT7', d.vat_rate ?? 7,
                d.vat_amount_fc || 0, d.total_amount_fc || 0,
                d.revenue_account_id || null,
                d.subtotal_lc || 0, d.vat_amount_lc || 0, d.total_amount_lc || 0,
                d.is_deferred_vat || false
            ]);
        }

        // Insert apply records (for Receipt/CN/DN-35) — invoice applies and advance deductions
        for (const a of (applies || [])) {
            const applyType = a.apply_type || 'invoice';
            await client.query(`
                INSERT INTO ar_transaction_apply
                (transaction_id, applied_to_id, applied_amount_lc, applied_amount_fc, applied_date, apply_type, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
            `, [newHeaderId, a.applied_to_id, a.applied_amount_lc || 0, a.applied_amount_fc || 0,
                header.doc_date, applyType, header.created_by || null]);

            if (applyType === 'dn_ref') {
                // DN-35: เพิ่มยอดค้างชำระในใบแจ้งหนี้อ้างอิง (สมมาตรกับ CN-55 ที่ลดยอด)
                await client.query(`
                    UPDATE ar_transaction SET
                        balance_amount_lc = balance_amount_lc + $1,
                        updated_at = NOW()
                    WHERE id = $2
                `, [a.applied_amount_lc || 0, a.applied_to_id]);
            } else {
                await client.query(`
                    UPDATE ar_transaction SET
                        paid_amount_lc = paid_amount_lc + $1,
                        balance_amount_lc = balance_amount_lc - $1,
                        updated_at = NOW()
                    WHERE id = $2
                `, [a.applied_amount_lc || 0, a.applied_to_id]);
            }
        }

        // Insert payment rows (ar_transaction_payment)
        await ensurePaymentTable(client);
        let pmLineNo = 1;
        for (const p of (payments || [])) {
            await client.query(`
                INSERT INTO ar_transaction_payment
                (header_id, line_no, payment_method_id, payment_method_code, payment_method_name,
                 payment_method_type, cm_bank_account_id, gl_account_id,
                 amount_lc, amount_fc, ref_no, payment_date, remark,
                 drawer_bank_name, drawer_bank_branch, drawer_account_no,
                 card_type, card_last4, approval_code, terminal_id, batch_no,
                 created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
            `, [
                newHeaderId, pmLineNo++,
                p.payment_method_id || null, p.payment_method_code || null, p.payment_method_name || null,
                p.payment_method_type || 'CASH', p.cm_bank_account_id || null, p.gl_account_id || null,
                p.amount_lc || 0, p.amount_fc || 0,
                p.ref_no || null, p.payment_date || header.doc_date, p.remark || null,
                p.drawer_bank_name || null, p.drawer_bank_branch || null, p.drawer_account_no || null,
                p.card_type || null, p.card_last4 || null, p.approval_code || null,
                p.terminal_id || null, p.batch_no || null,
                header.created_by || null
            ]);
        }

        // Post: create GL entry & VAT records
        let glEntryId = null;
        if (action === 'Post') {
            const headerWithDocNo = { ...header, doc_no: finalDocNo, _applies: applies || [], _payments: payments || [] };
            glEntryId = await postGlEntry(client, newHeaderId, headerWithDocNo, details || [], finalDocNo);
            const sysDocTypeRes1 = await client.query(
                `SELECT sys_doc_type FROM sa_module_document WHERE id = $1 LIMIT 1`, [header.doc_id]
            );
            const sysDocType1 = sysDocTypeRes1.rows[0]?.sys_doc_type || '';
            await insertVtRecords(client, newHeaderId, headerWithDocNo, details || [], sysDocType1);
            await insertDeferredVtRecordsForReceipt(client, newHeaderId, headerWithDocNo, applies || []);
            // Update GL entry reference
            await client.query(`UPDATE ar_transaction SET gl_entry_id=$1 WHERE id=$2`, [glEntryId, newHeaderId]);
            // DN-35, CN-55, RDP-65 ไม่มียอดค้างชำระตัวเอง (ยอดถูกรวมไว้ที่ใบแจ้งหนี้อ้างอิง หรือถูก apply ไปแล้ว)
            if (['35', '55', '65'].includes(sysDocType1)) {
                await client.query(`UPDATE ar_transaction SET balance_amount_lc=0 WHERE id=$1`, [newHeaderId]);
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'Success', id: newHeaderId, doc_no: finalDocNo });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- 2. Update Transaction (Draft only) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, details, applies, payments, action } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');

        // Check status
        const checkRes = await client.query('SELECT status FROM ar_transaction WHERE id=$1', [id]);
        if (!checkRes.rows[0]) return res.status(404).json({ error: 'Not found' });
        if (checkRes.rows[0].status !== 'Draft') throw new Error('Only Draft can be edited');

        // Find period_id
        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`,
            [header.doc_date]
        );
        if (periodRes.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        const periodId = periodRes.rows[0].id;

        const status = action === 'Post' ? 'Posted' : 'Draft';

        await client.query(`
            UPDATE ar_transaction SET
            doc_date=$1, due_date=$2, period_id=$3,
            ar_account_id=$4, currency_id=$5, currency_code=$6, exchange_rate=$7,
            subtotal_fc=$8, discount_amount_fc=$9, before_vat_fc=$10, vat_amount_fc=$11, total_amount_fc=$12,
            subtotal_lc=$13, discount_amount_lc=$14, before_vat_lc=$15, vat_amount_lc=$16, total_amount_lc=$17,
            balance_amount_lc=$18,
            ref_no=$19, ref_doc_id=$20, ref_doc_no=$21, description=$22, status=$23,
            updated_by=$24, updated_at=NOW()
            WHERE id=$25
        `, [
            header.doc_date, header.due_date || null, periodId,
            header.ar_account_id || null, header.currency_id || null, header.currency_code || 'THB',
            header.exchange_rate || 1,
            header.subtotal_fc || 0, header.discount_amount_fc || 0,
            header.before_vat_fc || 0, header.vat_amount_fc || 0, header.total_amount_fc || 0,
            header.subtotal_lc || 0, header.discount_amount_lc || 0,
            header.before_vat_lc || 0, header.vat_amount_lc || 0, header.total_amount_lc || 0,
            header.total_amount_lc || 0,
            header.ref_no || null, header.ref_doc_id || null, header.ref_doc_no || null,
            header.description || null, status,
            header.updated_by || null, id
        ]);

        // Replace details
        await client.query('DELETE FROM ar_transaction_detail WHERE header_id=$1', [id]);
        const detailSql = `
            INSERT INTO ar_transaction_detail
            (header_id, line_no, item_code, item_name, description,
             quantity, unit_code, unit_price_fc, discount_percent, discount_amount_fc,
             subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
             revenue_account_id, subtotal_lc, vat_amount_lc, total_amount_lc, is_deferred_vat)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        `;
        let lineNo = 1;
        for (const d of (details || [])) {
            await client.query(detailSql, [
                id, lineNo++,
                d.item_code || null, d.item_name || null, d.description || null,
                d.quantity ?? 1, d.unit_code || null,
                d.unit_price_fc || 0, d.discount_percent || 0, d.discount_amount_fc || 0,
                d.subtotal_fc || 0, d.vat_type || 'VAT7', d.vat_rate ?? 7,
                d.vat_amount_fc || 0, d.total_amount_fc || 0,
                d.revenue_account_id || null,
                d.subtotal_lc || 0, d.vat_amount_lc || 0, d.total_amount_lc || 0,
                d.is_deferred_vat || false
            ]);
        }

        // Replace applies (for Receipt/CN)
        await client.query('DELETE FROM ar_transaction_apply WHERE transaction_id=$1', [id]);
        for (const a of (applies || [])) {
            const applyType = a.apply_type || 'invoice';
            await client.query(`
                INSERT INTO ar_transaction_apply
                (transaction_id, applied_to_id, applied_amount_lc, applied_amount_fc, applied_date, apply_type, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
            `, [id, a.applied_to_id, a.applied_amount_lc || 0, a.applied_amount_fc || 0,
                header.doc_date, applyType, header.updated_by || null]);
        }

        // Replace payment rows
        await ensurePaymentTable(client);
        await client.query('DELETE FROM ar_transaction_payment WHERE header_id=$1', [id]);
        let pmLineNo2 = 1;
        for (const p of (payments || [])) {
            await client.query(`
                INSERT INTO ar_transaction_payment
                (header_id, line_no, payment_method_id, payment_method_code, payment_method_name,
                 payment_method_type, cm_bank_account_id, gl_account_id,
                 amount_lc, amount_fc, ref_no, payment_date, remark,
                 drawer_bank_name, drawer_bank_branch, drawer_account_no,
                 card_type, card_last4, approval_code, terminal_id, batch_no,
                 created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
            `, [
                id, pmLineNo2++,
                p.payment_method_id || null, p.payment_method_code || null, p.payment_method_name || null,
                p.payment_method_type || 'CASH', p.cm_bank_account_id || null, p.gl_account_id || null,
                p.amount_lc || 0, p.amount_fc || 0,
                p.ref_no || null, p.payment_date || header.doc_date, p.remark || null,
                p.drawer_bank_name || null, p.drawer_bank_branch || null, p.drawer_account_no || null,
                p.card_type || null, p.card_last4 || null, p.approval_code || null,
                p.terminal_id || null, p.batch_no || null,
                header.updated_by || null
            ]);
        }

        // If Post: recalculate balances on applied invoices/advances and create GL + VAT
        let glEntryId = null;
        if (action === 'Post') {
            // Recalculate balances for all referenced documents
            // DN-35 (dn_ref): เพิ่ม balance ของใบแจ้งหนี้อ้างอิง (total + dn_ref - payments)
            const affectedIds = [...new Set((applies || []).map(a => a.applied_to_id).filter(Boolean))];
            for (const invoiceId of affectedIds) {
                await client.query(`
                    UPDATE ar_transaction t SET
                        paid_amount_lc = (
                            SELECT COALESCE(SUM(applied_amount_lc),0)
                            FROM ar_transaction_apply WHERE applied_to_id = t.id AND apply_type != 'dn_ref'
                        ),
                        balance_amount_lc = total_amount_lc
                            + COALESCE((SELECT SUM(applied_amount_lc) FROM ar_transaction_apply WHERE applied_to_id = t.id AND apply_type = 'dn_ref'), 0)
                            - COALESCE((SELECT SUM(applied_amount_lc) FROM ar_transaction_apply WHERE applied_to_id = t.id AND apply_type != 'dn_ref'), 0),
                        updated_at = NOW()
                    WHERE id = $1
                `, [invoiceId]);
            }

            const docNoRes = await client.query('SELECT doc_no FROM ar_transaction WHERE id=$1', [id]);
            const docNo = docNoRes.rows[0].doc_no;
            const headerWithDocNo = { ...header, doc_no: docNo, _applies: applies || [], _payments: payments || [] };
            glEntryId = await postGlEntry(client, id, headerWithDocNo, details || [], docNo);
            const sysDocTypeRes2 = await client.query(
                `SELECT sys_doc_type FROM sa_module_document WHERE id = $1 LIMIT 1`, [header.doc_id]
            );
            const sysDocType2 = sysDocTypeRes2.rows[0]?.sys_doc_type || '';
            await insertVtRecords(client, id, headerWithDocNo, details || [], sysDocType2);
            await insertDeferredVtRecordsForReceipt(client, id, headerWithDocNo, applies || []);
            await client.query(`UPDATE ar_transaction SET gl_entry_id=$1 WHERE id=$2`, [glEntryId, id]);
            // DN-35, CN-55, RDP-65 ไม่มียอดค้างชำระตัวเอง
            if (['35', '55', '65'].includes(sysDocType2)) {
                await client.query(`UPDATE ar_transaction SET balance_amount_lc=0 WHERE id=$1`, [id]);
            }
        }

        await client.query('COMMIT');
        res.json({ message: 'Updated', id: Number(id) });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- 3. Void Transaction (Posted only) ---
// --- Helper: เพิ่มคอลัมน์ void metadata ถ้ายังไม่มี ---
const ensureVoidFields = async (client) => {
    await client.query(`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='ar_transaction' AND column_name='void_reason')
            THEN
                ALTER TABLE ar_transaction
                    ADD COLUMN void_reason    VARCHAR(500),
                    ADD COLUMN voided_by      VARCHAR(100),
                    ADD COLUMN voided_at      TIMESTAMPTZ,
                    ADD COLUMN void_gl_entry_id INT;
            END IF;
        END $$
    `);
};

// --- 3b. Void Transaction (Posted → Void) ---
// กลยุทธ์: เก็บ GL entry ต้นทางไว้ครบถ้วน + สร้าง Reversing GL entry ใหม่
// เพื่อรักษา audit trail และให้ยอดสุทธิในGL = 0
const voidTransaction = async (req, res) => {
    const { id } = req.params;
    const { void_reason, updated_by } = req.body;
    if (!void_reason || !void_reason.trim()) {
        return res.status(400).json({ error: 'กรุณาระบุเหตุผลการยกเลิก' });
    }
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        await ensureVoidFields(client);

        // 1. ตรวจสอบ status
        const checkRes = await client.query(
            'SELECT status, gl_entry_id, doc_no FROM ar_transaction WHERE id=$1', [id]
        );
        if (!checkRes.rows[0]) return res.status(404).json({ error: 'Not found' });
        if (checkRes.rows[0].status !== 'Posted') throw new Error('Only Posted can be voided');

        const origGlId   = checkRes.rows[0].gl_entry_id;
        const arDocNo    = checkRes.rows[0].doc_no;
        const today      = new Date().toISOString().slice(0, 10);

        // 2. สร้าง Reversing GL Entry จาก GL entry ต้นทาง
        let reversingGlId = null;
        if (origGlId) {
            // ดึง GL header ต้นทาง
            const origHdrRes = await client.query(
                `SELECT * FROM gl_entry_header WHERE id=$1`, [origGlId]
            );
            const origHdr = origHdrRes.rows[0];

            // หา period สำหรับวันนี้ (ถ้าไม่มีให้ใช้ period ของ doc_date ต้นทาง)
            let reversePeriodId = origHdr.period_id;
            const periodRes = await client.query(
                `SELECT id FROM gl_posting_period
                 WHERE $1::date BETWEEN period_start_date AND period_end_date
                 AND gl_status='OPEN' LIMIT 1`, [today]
            );
            if (periodRes.rows.length > 0) reversePeriodId = periodRes.rows[0].id;

            // Generate doc_no ใหม่สำหรับ Reversing entry
            let reverseDocNo = null;
            if (origHdr.doc_id) {
                reverseDocNo = await generateDocNo(client, origHdr.doc_id, today);
            }
            if (!reverseDocNo) reverseDocNo = `RV-${arDocNo}`;

            // Insert Reversing GL header (DR/CR สลับกัน)
            const revHdrRes = await client.query(`
                INSERT INTO gl_entry_header
                (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
                 currency_id, exchange_rate, status,
                 total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
                 created_by, ref_doc_id, ref_doc_no, external_source_id)
                VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,'Posted',
                        $9,$10,$11,$12,$13,$14,$15,$16)
                RETURNING id
            `, [
                origHdr.doc_id, reverseDocNo, today, reversePeriodId,
                origHdr.ref_no,
                `[ยกเลิก ${arDocNo}] ${void_reason}`,
                origHdr.currency_id, origHdr.exchange_rate,
                origHdr.total_credit_lc, origHdr.total_debit_lc,   // สลับ debit↔credit
                origHdr.total_credit_fc, origHdr.total_debit_fc,
                null,           // created_by (ไม่ resolve user_id ตอนนี้)
                origHdr.doc_id, arDocNo,
                id              // external_source_id = ar_transaction.id → ป้องกัน GL ถอยเอง
            ]);
            reversingGlId = revHdrRes.rows[0].id;

            // ดึง GL detail ต้นทาง แล้ว insert สลับ DR/CR
            const origDtlRes = await client.query(
                `SELECT * FROM gl_entry_detail WHERE header_id=$1 ORDER BY line_no`, [origGlId]
            );
            let lineNo = 1;
            for (const d of origDtlRes.rows) {
                await client.query(`
                    INSERT INTO gl_entry_detail
                    (header_id, line_no, account_id, description,
                     debit_lc, credit_lc, debit_fc, credit_fc,
                     branch_id, project_id, business_unit_id)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                `, [
                    reversingGlId, lineNo++, d.account_id,
                    `[ยกเลิก] ${d.description || ''}`,
                    d.credit_lc, d.debit_lc,    // สลับ DR↔CR
                    d.credit_fc, d.debit_fc,
                    d.branch_id, d.project_id, d.business_unit_id
                ]);
            }
        }

        // 3. อัปเดต ar_transaction
        await client.query(`
            UPDATE ar_transaction SET
                status     = 'Void',
                void_reason     = $1,
                voided_by       = $2,
                voided_at       = NOW(),
                void_gl_entry_id = $3,
                updated_by      = $2,
                updated_at      = NOW()
            WHERE id = $4
        `, [void_reason.trim(), updated_by || null, reversingGlId, id]);

        // 4. Mark vt_transaction as voided
        await client.query(
            `UPDATE vt_transaction SET is_voided=TRUE WHERE source_header_id=$1 AND module_code='AR'`,
            [id]
        );

        // 5. Reverse applied amounts — คืนยอด outstanding ให้ Invoice/Advance ที่ถูก Apply ไว้
        const appliesRes = await client.query(
            `SELECT * FROM ar_transaction_apply WHERE transaction_id=$1`, [id]
        );
        const affectedIds = [...new Set(appliesRes.rows.map(a => a.applied_to_id).filter(Boolean))];
        for (const invoiceId of affectedIds) {
            await client.query(`
                UPDATE ar_transaction t SET
                    paid_amount_lc = (
                        SELECT COALESCE(SUM(applied_amount_lc),0)
                        FROM ar_transaction_apply
                        WHERE applied_to_id = t.id AND transaction_id != $1 AND apply_type != 'dn_ref'
                    ),
                    balance_amount_lc = total_amount_lc
                        + COALESCE((SELECT SUM(applied_amount_lc) FROM ar_transaction_apply
                                    WHERE applied_to_id = t.id AND transaction_id != $1 AND apply_type = 'dn_ref'), 0)
                        - COALESCE((SELECT SUM(applied_amount_lc) FROM ar_transaction_apply
                                    WHERE applied_to_id = t.id AND transaction_id != $1 AND apply_type != 'dn_ref'), 0),
                    updated_at = NOW()
                WHERE id = $2
            `, [id, invoiceId]);
        }

        await client.query('COMMIT');
        res.json({ message: 'Voided', reversing_gl_entry_id: reversingGlId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- 4. Delete Draft ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    try {
        const result = await req.dbPool.query(
            `UPDATE ar_transaction SET status='Deleted' WHERE id=$1 AND status='Draft' RETURNING id`, [id]
        );
        if (result.rowCount === 0) return res.status(400).json({ error: 'Cannot delete: Not Draft or not found' });
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 5. Fetch List ---
const fetchRows = async (req, res) => {
    const { search, status, doc_type, customer_id, date_from, date_to } = req.query;
    let sql = `
        SELECT t.id, t.doc_no, t.doc_date, t.due_date, t.status,
               t.customer_code, t.customer_name_th,
               t.total_amount_lc, t.paid_amount_lc, t.balance_amount_lc,
               t.currency_code, t.ref_no,
               d.doc_code, d.doc_name_thai, d.sys_doc_type
        FROM ar_transaction t
        JOIN sa_module_document d ON t.doc_id = d.id
        WHERE t.status != 'Deleted' AND d.sys_module = '11'
    `;
    const params = [];

    if (doc_type) {
        sql += ` AND d.sys_doc_type = $${params.length + 1}`;
        params.push(doc_type);
    }
    if (customer_id) {
        sql += ` AND t.customer_id = $${params.length + 1}`;
        params.push(customer_id);
    }
    if (date_from) {
        sql += ` AND t.doc_date >= $${params.length + 1}`;
        params.push(date_from);
    }
    if (date_to) {
        sql += ` AND t.doc_date <= $${params.length + 1}`;
        params.push(date_to);
    }
    if (search) {
        sql += ` AND (t.doc_no ILIKE $${params.length + 1} OR t.customer_code ILIKE $${params.length + 1} OR t.customer_name_th ILIKE $${params.length + 1} OR COALESCE(t.ref_no,'') ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
    }
    if (status) {
        sql += ` AND t.status = $${params.length + 1}`;
        params.push(status);
    }

    sql += ` ORDER BY CASE WHEN t.status='Draft' THEN 0 ELSE 1 END, t.doc_date DESC, t.doc_no DESC LIMIT 200`;

    try {
        const result = await req.dbPool.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 6. Fetch Single Transaction ---
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        const hRes = await req.dbPool.query(`
            SELECT t.*, d.doc_code, d.doc_name_thai, d.sys_doc_type, d.is_auto_numbering
            FROM ar_transaction t
            JOIN sa_module_document d ON t.doc_id = d.id
            WHERE t.id = $1
        `, [id]);
        if (hRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });

        const [detailsRes, appliesRes] = await Promise.all([
            req.dbPool.query(`SELECT * FROM ar_transaction_detail WHERE header_id=$1 ORDER BY line_no`, [id]),
            req.dbPool.query(`
                SELECT a.*, inv.doc_no AS applied_to_doc_no, inv.doc_date AS applied_to_doc_date,
                       inv.total_amount_lc AS applied_to_total
                FROM ar_transaction_apply a
                JOIN ar_transaction inv ON a.applied_to_id = inv.id
                WHERE a.transaction_id=$1 ORDER BY a.id
            `, [id]),
        ]);

        // ar_transaction_payment may not exist in older databases — create it and return empty if needed
        let paymentsRows = [];
        try {
            await ensurePaymentTable(req.dbPool);
            const paymentsRes = await req.dbPool.query(`
                SELECT p.*,
                       ga.account_code AS gl_account_code, ga.account_name_thai AS gl_account_name,
                       ba.account_code AS bank_account_code, ba.account_name_th AS bank_account_name_th,
                       b.bank_name_th
                FROM ar_transaction_payment p
                LEFT JOIN gl_account ga ON ga.id = p.gl_account_id
                LEFT JOIN cm_bank_account ba ON ba.id = p.cm_bank_account_id
                LEFT JOIN cm_bank b ON b.id = ba.bank_id
                WHERE p.header_id=$1 ORDER BY p.line_no
            `, [id]);
            paymentsRows = paymentsRes.rows;
        } catch (e) {
            console.warn('ar_transaction_payment query failed (table may not exist):', e.message);
        }

        res.json({ header: hRes.rows[0], details: detailsRes.rows, applies: appliesRes.rows, payments: paymentsRows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 7. Fetch open invoices for a customer (for Receipt application) ---
const fetchOpenInvoices = async (req, res) => {
    const { customer_id } = req.query;
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
    try {
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.due_date,
                   t.total_amount_lc, t.paid_amount_lc, t.balance_amount_lc,
                   d.doc_name_thai, d.sys_doc_type
            FROM ar_transaction t
            JOIN sa_module_document d ON t.doc_id = d.id
            WHERE t.customer_id = $1
              AND t.status = 'Posted'
              AND t.balance_amount_lc <> 0
              AND d.sys_doc_type IN ('10', '30')
            ORDER BY t.doc_date ASC, t.doc_no ASC
        `, [customer_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 8. Fetch open advance receipts for a customer (for advance deduction in Receipt) ---
const fetchOpenAdvances = async (req, res) => {
    const { customer_id } = req.query;
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
    try {
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.due_date,
                   t.total_amount_lc, t.paid_amount_lc, t.balance_amount_lc,
                   d.doc_name_thai, d.sys_doc_type
            FROM ar_transaction t
            JOIN sa_module_document d ON t.doc_id = d.id
            WHERE t.customer_id = $1
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0
              AND d.sys_doc_type = '60'
            ORDER BY t.doc_date ASC, t.doc_no ASC
        `, [customer_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 9b. Fetch open advance receipts for refund (for RDP-65) ---
const fetchOpenAdvancesForRefund = async (req, res) => {
    const { customer_id } = req.query;
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
    try {
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.due_date,
                   t.total_amount_lc, t.paid_amount_lc, t.balance_amount_lc,
                   d.doc_name_thai, d.sys_doc_type
            FROM ar_transaction t
            JOIN sa_module_document d ON t.doc_id = d.id
            WHERE t.customer_id = $1
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0
              AND d.sys_doc_type = '60'
            ORDER BY t.doc_date ASC, t.doc_no ASC
        `, [customer_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// --- 9. Fetch open credit notes for a customer (for CN deduction in Receipt) ---
const fetchOpenCreditNotes = async (req, res) => {
    const { customer_id } = req.query;
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
    try {
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.due_date,
                   t.total_amount_lc, t.paid_amount_lc, t.balance_amount_lc,
                   d.doc_name_thai, d.sys_doc_type
            FROM ar_transaction t
            JOIN sa_module_document d ON t.doc_id = d.id
            WHERE t.customer_id = $1
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0
              AND d.sys_doc_type = '50'
            ORDER BY t.doc_date ASC, t.doc_no ASC
        `, [customer_id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    createTransaction,
    updateTransaction,
    voidTransaction,
    deleteTransaction,
    fetchRows,
    fetchRow,
    fetchOpenInvoices,
    fetchOpenAdvances,
    fetchOpenAdvancesForRefund,
    fetchOpenCreditNotes,
};
