// controllers/ap/apTransactionController.js

// --- Helper: Generate Document Number ---
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

// --- Helper: Insert VAT records for AP (Input VAT) ---
const insertVtRecords = async (client, headerId, header, details, sysDocType) => {
    const vatDetails = details.filter(d =>
        d.vat_type && d.vat_type !== 'NOVAT' &&
        Number(d.vat_amount_fc) !== 0 &&
        !d.is_deferred_vat
    );
    // CN-AP (30) → VAT is negative (reduces input VAT)
    const vatSign = (sysDocType === '30') ? -1 : 1;

    for (const d of vatDetails) {
        await client.query(`
            INSERT INTO vt_transaction
            (module_code, vat_type, doc_id, source_header_id, source_detail_id,
             doc_no, doc_date, vat_rate,
             base_amount_lc, vat_amount_lc, base_amount_fc, vat_amount_fc,
             currency_id, exchange_rate,
             vendor_id, entity_name, entity_tax_id,
             created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        `, [
            'AP', 'INPUT_VAT', header.doc_id, headerId, d.id || null,
            header.doc_no, header.doc_date, d.vat_rate ?? 7,
            (d.subtotal_lc || 0) * vatSign, (d.vat_amount_lc || 0) * vatSign,
            (d.subtotal_fc || 0) * vatSign, (d.vat_amount_fc || 0) * vatSign,
            header.currency_id || null, header.exchange_rate || 1,
            header.vendor_id, header.vendor_name_th || '',
            header.vendor_tax_id || null,
            header.created_by || null
        ]);
    }
};

// --- Helper: Resolve payment GL account ---
const resolvePaymentGlAccount = async (client, payment, setup, fallbackCashAccountId) => {
    if (payment.gl_account_id) return Number(payment.gl_account_id);
    if (payment.cm_bank_account_id) {
        const baRes = await client.query(
            `SELECT gl_account_id FROM cm_bank_account WHERE id = $1`, [payment.cm_bank_account_id]
        );
        if (baRes.rows.length > 0 && baRes.rows[0].gl_account_id)
            return Number(baRes.rows[0].gl_account_id);
    }
    if (setup) {
        const typeMap = {
            'CHECK':          setup.check_account_id,
            'TRANSFER':       setup.transfer_account_id,
        };
        const perTypeId = typeMap[payment.payment_method_type];
        if (perTypeId) return Number(perTypeId);
    }
    return fallbackCashAccountId || null;
};

// --- Helper: Post GL Entry for AP transaction ---
const postGlEntry = async (client, headerId, header, details, docNo) => {
    const periodRes = await client.query(
        `SELECT id FROM gl_posting_period
         WHERE $1::date BETWEEN period_start_date AND period_end_date
         AND gl_status = 'OPEN' LIMIT 1`,
        [header.doc_date]
    );
    if (periodRes.rows.length === 0) throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่ ${header.doc_date}`);
    const periodId = periodRes.rows[0].id;

    const docTypeRes = await client.query(
        `SELECT sys_doc_type FROM sa_module_document WHERE id = $1 LIMIT 1`, [header.doc_id]
    );
    const sysDocType       = docTypeRes.rows[0]?.sys_doc_type || '';
    const isPayment        = sysDocType === '80';
    const isCreditNote     = sysDocType === '30'; // CN from vendor (reduces AP)
    const isAdvancePayment = sysDocType === '60';
    const isAdvanceRefund  = sysDocType === '65';
    const isExpenseBased   = ['10', '30', '50'].includes(sysDocType); // PI, CN, DN
    const isRa             = sysDocType === '70'; // RA: no GL

    if (isRa) return null;

    // --- Resolve AP account ---
    let apAccountId = null;
    if (!isAdvancePayment && !isAdvanceRefund) {
        apAccountId = Number(header.ap_account_id) || null;
        if (!apAccountId && header.doc_id) {
            const apSetupRes = await client.query(
                `SELECT s.ap_account_id FROM ap_gl_account_setup s
                 JOIN sa_module_document d ON d.doc_code = s.doc_code
                 WHERE d.id = $1 LIMIT 1`,
                [header.doc_id]
            );
            if (apSetupRes.rows.length > 0 && apSetupRes.rows[0].ap_account_id)
                apAccountId = apSetupRes.rows[0].ap_account_id;
        }
        if (!apAccountId && header.vendor_id) {
            const vendorRes = await client.query(
                `SELECT ap_account_id FROM ap_vendor WHERE id = $1 LIMIT 1`, [header.vendor_id]
            );
            if (vendorRes.rows.length > 0 && vendorRes.rows[0].ap_account_id)
                apAccountId = vendorRes.rows[0].ap_account_id;
        }
        if (!apAccountId && !isPayment)
            throw new Error('ไม่พบบัญชีเจ้าหนี้สำหรับการลงบัญชี กรุณาตั้งค่าใน ap_gl_account_setup หรือเจ้าหนี้');
    }

    // --- Fetch AP GL account setup ---
    const setupRes = await client.query(
        `SELECT s.gl_doc_id, s.vat_input_account_id, s.vat_pending_input_account_id,
                s.discount_account_id, s.cash_account_id, s.advance_account_id,
                s.expense_account_id, s.wht_payable_account_id,
                s.check_account_id, s.transfer_account_id,
                s.fx_gain_account_id, s.fx_loss_account_id
         FROM ap_gl_account_setup s
         JOIN sa_module_document d ON d.doc_code = s.doc_code
         WHERE d.id = $1 LIMIT 1`,
        [header.doc_id]
    );
    const setup = setupRes.rows[0] || {};

    const glDocId = setup.gl_doc_id;
    if (!glDocId) throw new Error('ยังไม่ได้ตั้งค่า GL Document Type ใน ap_gl_account_setup สำหรับประเภทเอกสารนี้');

    let glDocNo = await generateDocNo(client, glDocId, header.doc_date, header.branch_id);
    if (!glDocNo) glDocNo = `GL-${docNo}`;

    const vatAccountId        = Number(setup.vat_input_account_id)         || null;
    const vatPendingAccountId = Number(setup.vat_pending_input_account_id) || null;
    const discountAccountId   = Number(setup.discount_account_id)          || null;
    const cashAccountId       = Number(setup.cash_account_id)              || null;
    const advanceAccountId    = Number(setup.advance_account_id)           || null;
    const defaultExpenseAccountId = Number(setup.expense_account_id)       || null;
    const whtPayableAccountId = Number(setup.wht_payable_account_id)       || null;
    const fxGainAccountId     = Number(setup.fx_gain_account_id)           || null;
    const fxLossAccountId     = Number(setup.fx_loss_account_id)           || null;
    const exchangeRate        = Number(header.exchange_rate) || 1;

    let createdByUserId = null;
    if (header.created_by) {
        const userRes = await client.query(
            `SELECT id FROM sa_user WHERE user_name = $1 LIMIT 1`, [header.created_by]
        );
        if (userRes.rows.length > 0) createdByUserId = userRes.rows[0].id;
    }

    const totalAmount = Number(header.total_amount_lc) || 0;

    // Insert GL entry header (placeholder totals)
    const glHeaderRes = await client.query(`
        INSERT INTO gl_entry_header
        (doc_id, doc_no, doc_date, posting_date, period_id, ref_no, description,
         currency_id, exchange_rate, status,
         total_debit_lc, total_credit_lc, total_debit_fc, total_credit_fc,
         created_by, ref_doc_id, ref_doc_no, external_source_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Posted',$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING id
    `, [
        glDocId, glDocNo, header.doc_date, header.doc_date, periodId,
        header.ref_no || null, header.description || null,
        header.currency_id || 1, header.exchange_rate || 1,
        totalAmount, totalAmount,
        Number(header.total_amount_fc) || 0, Number(header.total_amount_fc) || 0,
        createdByUserId, header.doc_id, docNo, headerId
    ]);
    const glEntryId = glHeaderRes.rows[0].id;

    const glDetails = [];

    if (isExpenseBased) {
        // ===== PI (10) / DN-AP (50) / CN-AP (30) =====
        // PI/DN: DR Expense + DR VAT Input / CR AP
        // CN-AP: DR AP / CR Expense + CR VAT Input
        const isCredit = isCreditNote; // CN-AP = credit to expense (reversed)

        // AP account line
        if (apAccountId) {
            glDetails.push({
                account_id: apAccountId,
                description: `AP ${docNo}`,
                debit_lc: isCredit ? totalAmount : 0,
                credit_lc: isCredit ? 0 : totalAmount,
                debit_fc: isCredit ? (Number(header.total_amount_fc) || 0) : 0,
                credit_fc: isCredit ? 0 : (Number(header.total_amount_fc) || 0),
            });
        }

        // Expense lines (from detail)
        for (const d of details) {
            const expAccId = d.expense_account_id || defaultExpenseAccountId;
            if (expAccId) {
                const discFc = Number(d.discount_amount_fc) || 0;
                const discLc = discFc * exchangeRate;
                const netLc  = Number(d.subtotal_lc) || 0;
                const netFc  = Number(d.subtotal_fc) || 0;

                if (discountAccountId && discLc > 0) {
                    const grossLc = netLc + discLc;
                    const grossFc = netFc + discFc;
                    if (grossLc !== 0) {
                        glDetails.push({
                            account_id: Number(expAccId),
                            description: d.description || '',
                            debit_lc: isCredit ? 0 : grossLc,
                            credit_lc: isCredit ? grossLc : 0,
                            debit_fc: isCredit ? 0 : grossFc,
                            credit_fc: isCredit ? grossFc : 0,
                        });
                    }
                    glDetails.push({
                        account_id: discountAccountId,
                        description: `ส่วนลด ${docNo}`,
                        debit_lc: isCredit ? discLc : 0,
                        credit_lc: isCredit ? 0 : discLc,
                        debit_fc: isCredit ? discFc : 0,
                        credit_fc: isCredit ? 0 : discFc,
                    });
                } else if (netLc !== 0) {
                    glDetails.push({
                        account_id: Number(expAccId),
                        description: d.description || '',
                        debit_lc: isCredit ? 0 : netLc,
                        credit_lc: isCredit ? netLc : 0,
                        debit_fc: isCredit ? 0 : netFc,
                        credit_fc: isCredit ? netFc : 0,
                    });
                }
            }
            // VAT Input
            if (Number(d.vat_amount_lc) !== 0 && vatAccountId) {
                const vatLc = Number(d.vat_amount_lc);
                const vatFc = Number(d.vat_amount_fc);
                glDetails.push({
                    account_id: vatAccountId,
                    description: `VAT Input ${docNo}`,
                    debit_lc: isCredit ? 0 : vatLc,
                    credit_lc: isCredit ? vatLc : 0,
                    debit_fc: isCredit ? 0 : vatFc,
                    credit_fc: isCredit ? vatFc : 0,
                });
            }
        }

        // fallback expense when no details
        if (glDetails.length === 1 && defaultExpenseAccountId && totalAmount > 0) {
            glDetails.push({
                account_id: defaultExpenseAccountId,
                description: `ค่าใช้จ่าย ${docNo}`,
                debit_lc: isCredit ? 0 : totalAmount,
                credit_lc: isCredit ? totalAmount : 0,
                debit_fc: isCredit ? 0 : (Number(header.total_amount_fc) || 0),
                credit_fc: isCredit ? (Number(header.total_amount_fc) || 0) : 0,
            });
        }

    } else if (isAdvancePayment) {
        // ===== จ่ายเงินมัดจำ (60) =====
        // DR: Advance AP / CR: Cash/Bank
        if (advanceAccountId) {
            glDetails.push({
                account_id: advanceAccountId,
                description: `มัดจำจ่าย ${docNo}`,
                debit_lc: totalAmount,
                credit_lc: 0,
                debit_fc: Number(header.total_amount_fc) || 0,
                credit_fc: 0,
            });
        }
        const payments60 = header._payments || [];
        if (payments60.length > 0) {
            for (const p of payments60) {
                const pAmount = Number(p.amount_lc) || 0;
                if (pAmount === 0) continue;
                const pGlAccountId = await resolvePaymentGlAccount(client, p, setup, cashAccountId);
                if (pGlAccountId) {
                    glDetails.push({
                        account_id: pGlAccountId,
                        description: `จ่ายมัดจำ ${p.payment_method_code || ''} ${docNo}`,
                        debit_lc: 0,
                        credit_lc: pAmount,
                        debit_fc: 0,
                        credit_fc: Number(p.amount_fc) || pAmount,
                    });
                }
            }
        } else if (cashAccountId && totalAmount > 0) {
            glDetails.push({
                account_id: cashAccountId,
                description: `จ่ายมัดจำ ${docNo}`,
                debit_lc: 0,
                credit_lc: totalAmount,
                debit_fc: 0,
                credit_fc: Number(header.total_amount_fc) || 0,
            });
        }

    } else if (isAdvanceRefund) {
        // ===== ได้รับเงินมัดจำคืน (65) =====
        // DR: Cash/Bank / CR: Advance AP
        if (cashAccountId) {
            glDetails.push({
                account_id: cashAccountId,
                description: `รับคืนมัดจำ ${docNo}`,
                debit_lc: totalAmount,
                credit_lc: 0,
                debit_fc: Number(header.total_amount_fc) || 0,
                credit_fc: 0,
            });
        }
        if (advanceAccountId) {
            glDetails.push({
                account_id: advanceAccountId,
                description: `ตัดมัดจำจ่าย ${docNo}`,
                debit_lc: 0,
                credit_lc: totalAmount,
                debit_fc: 0,
                credit_fc: Number(header.total_amount_fc) || 0,
            });
        }

    } else if (isPayment) {
        // ===== ชำระเงิน (80) =====
        // DR: AP (at invoice rate) / CR: Bank (net of WHT) + CR: WHT Payable
        const allApplies    = header._applies || [];
        const invoiceApplies = allApplies.filter(a => (a.apply_type || 'invoice') === 'invoice');
        const advanceDeductions = allApplies.filter(a => a.apply_type === 'advance');
        const totalInvoiceApplied  = invoiceApplies.reduce((s, a) => s + (Number(a.applied_amount_lc) || 0), 0);
        const totalAdvanceDeducted = advanceDeductions.reduce((s, a) => s + (Number(a.applied_amount_lc) || 0), 0);
        const totalAdvanceDeductedFc = advanceDeductions.reduce((s, a) => s + (Number(a.applied_amount_fc) || 0), 0);
        const totalInvoiceAppliedFc = invoiceApplies.reduce((s, a) => s + (Number(a.applied_amount_fc) || 0), 0);

        // Compute AP debit = sum(FC × invoice_rate) to correctly clear AP balances
        const invoiceRateMap = {};
        for (const a of invoiceApplies) {
            if (a.applied_to_id && !invoiceRateMap[a.applied_to_id]) {
                const rr = await client.query(
                    'SELECT exchange_rate FROM ap_transaction WHERE id=$1', [a.applied_to_id]);
                invoiceRateMap[a.applied_to_id] = Number(rr.rows[0]?.exchange_rate || 1);
            }
        }
        const totalInvoiceAtInvRate = invoiceApplies.reduce((s, a) =>
            s + (Number(a.applied_amount_fc) || 0) * (invoiceRateMap[a.applied_to_id] || 1), 0);

        // WHT
        const whtRows = header._whts || [];
        const totalWhtLc = whtRows.reduce((s, w) => s + (Number(w.wht_amount_lc) || 0), 0);

        // Cash paid = total_amount_lc from header (net after WHT & advance deduction)
        const cashPaid = Number(header.total_amount_lc) || 0;

        // DR: AP account (amount at invoice exchange rate)
        const apDebitLc = totalInvoiceAtInvRate > 0 ? totalInvoiceAtInvRate : (cashPaid + totalWhtLc);
        const apDebitFc = totalInvoiceAppliedFc;
        if (apAccountId && apDebitLc > 0) {
            glDetails.push({
                account_id: apAccountId,
                description: `ชำระเจ้าหนี้ ${docNo}`,
                debit_lc: apDebitLc,
                credit_lc: 0,
                debit_fc: apDebitFc,
                credit_fc: 0,
            });
        }

        // CR: Cash/Bank (payment methods)
        const payments80 = header._payments || [];
        if (payments80.length > 0 && cashPaid > 0) {
            for (const p of payments80) {
                const pAmount = Number(p.amount_lc) || 0;
                if (pAmount === 0) continue;
                const pGlAccountId = await resolvePaymentGlAccount(client, p, setup, cashAccountId);
                if (pGlAccountId) {
                    glDetails.push({
                        account_id: pGlAccountId,
                        description: `จ่ายชำระ ${p.payment_method_code || ''} ${docNo}`,
                        debit_lc: 0,
                        credit_lc: pAmount,
                        debit_fc: 0,
                        credit_fc: Number(p.amount_fc) || pAmount,
                    });
                }
            }
        } else if (cashAccountId && cashPaid > 0) {
            glDetails.push({
                account_id: cashAccountId,
                description: `จ่ายชำระ ${docNo}`,
                debit_lc: 0,
                credit_lc: cashPaid,
                debit_fc: 0,
                credit_fc: Number(header.total_amount_fc) || 0,
            });
        }

        // CR: WHT Payable
        if (totalWhtLc > 0 && whtPayableAccountId) {
            glDetails.push({
                account_id: whtPayableAccountId,
                description: `ภาษีหัก ณ ที่จ่าย ${docNo}`,
                debit_lc: 0,
                credit_lc: totalWhtLc,
                debit_fc: 0,
                credit_fc: totalWhtLc / exchangeRate,
            });
        }

        // DR: Advance AP (if deducting advance)
        if (totalAdvanceDeducted > 0 && advanceAccountId) {
            glDetails.push({
                account_id: advanceAccountId,
                description: `ตัดมัดจำ ${docNo}`,
                debit_lc: 0,
                credit_lc: totalAdvanceDeducted,
                debit_fc: 0,
                credit_fc: totalAdvanceDeductedFc,
            });
        }

        // FX Gain/Loss
        const fxNet = totalInvoiceApplied - totalInvoiceAtInvRate;
        if (Math.abs(fxNet) >= 0.005) {
            if (fxNet > 0 && fxGainAccountId) {
                // payment rate < invoice rate → gain for us (we pay less in LC)
                glDetails.push({
                    account_id: fxGainAccountId,
                    description: `กำไรจากอัตราแลกเปลี่ยน ${docNo}`,
                    debit_lc: 0, credit_lc: fxNet,
                    debit_fc: 0, credit_fc: 0,
                });
            } else if (fxNet < 0 && fxLossAccountId) {
                glDetails.push({
                    account_id: fxLossAccountId,
                    description: `ขาดทุนจากอัตราแลกเปลี่ยน ${docNo}`,
                    debit_lc: Math.abs(fxNet), credit_lc: 0,
                    debit_fc: 0, credit_fc: 0,
                });
            }
        }
    }

    // Update GL header totals
    const totalDbLc = glDetails.reduce((s, r) => s + (r.debit_lc  || 0), 0);
    const totalCrLc = glDetails.reduce((s, r) => s + (r.credit_lc || 0), 0);
    const totalDbFc = glDetails.reduce((s, r) => s + (r.debit_fc  || 0), 0);
    const totalCrFc = glDetails.reduce((s, r) => s + (r.credit_fc || 0), 0);
    await client.query(
        `UPDATE gl_entry_header SET total_debit_lc=$1, total_credit_lc=$2, total_debit_fc=$3, total_credit_fc=$4 WHERE id=$5`,
        [totalDbLc, totalCrLc, totalDbFc, totalCrFc, glEntryId]
    );

    // Dimension validation
    const hDim1 = header.dim1_id || null;
    const hDim2 = header.dim2_id || null;
    const hDim3 = header.dim3_id || null;
    const hDim4 = header.dim4_id || null;
    const hDim5 = header.dim5_id || null;

    {
        const dimTypeRes = await client.query(
            `SELECT type_code, slot_no FROM gl_dimension_type WHERE is_active = true`
        );
        const slotByType = {};
        for (const r of dimTypeRes.rows) slotByType[r.type_code] = r.slot_no;
        const accountIds = [...new Set(glDetails.map(r => r.account_id).filter(Boolean))];
        if (accountIds.length > 0) {
            const accRes = await client.query(
                `SELECT id, account_code FROM gl_account WHERE id = ANY($1::int[])`, [accountIds]
            );
            const accCodeMap = {};
            for (const r of accRes.rows) accCodeMap[r.id] = r.account_code;
            const headerDims = { 1: hDim1, 2: hDim2, 3: hDim3, 4: hDim4, 5: hDim5 };
            const errors = [];
            for (const accountId of accountIds) {
                const rulesRes = await client.query(
                    `SELECT type_code FROM gl_account_dim_rule WHERE account_id = $1 AND is_required = true`,
                    [accountId]
                );
                for (const rule of rulesRes.rows) {
                    const slot = slotByType[rule.type_code];
                    if (!slot) continue;
                    if (!headerDims[slot]) {
                        errors.push(`บัญชี ${accCodeMap[accountId] || accountId}: ต้องระบุ ${rule.type_code}`);
                    }
                }
            }
            if (errors.length > 0) throw new Error(`Dimension ไม่ครบ:\n${errors.join('\n')}`);
        }
    }

    const detailSql = `
        INSERT INTO gl_entry_detail
        (header_id, line_no, account_id, description,
         debit_lc, credit_lc, debit_fc, credit_fc,
         branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `;
    let lineNo = 1;
    for (const row of glDetails) {
        await client.query(detailSql, [
            glEntryId, lineNo++, row.account_id, row.description,
            row.debit_lc, row.credit_lc, row.debit_fc, row.credit_fc,
            row.branch_id || null,
            hDim1, hDim2, hDim3, hDim4, hDim5,
        ]);
    }

    return glEntryId;
};

// --- Ensure payment table exists ---
const ensurePaymentTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS ap_transaction_payment (
            id                   SERIAL PRIMARY KEY,
            header_id            INT NOT NULL REFERENCES ap_transaction(id) ON DELETE CASCADE,
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
            created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
            created_by           VARCHAR(100)
        )
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_ap_transaction_payment_header ON ap_transaction_payment(header_id)
    `);
};

// --- Fetch helper ---
const fetchRowById = async (pool, id) => {
    const [hRes, dRes, aRes, pRes, whtRes] = await Promise.all([
        pool.query(`
            SELECT t.*,
                   d.doc_code, d.doc_name_thai, d.sys_doc_type, d.is_auto_numbering,
                   v.vendor_code, v.vendor_name_th, v.tax_id AS vendor_tax_id,
                   b.branch_code, b.branch_name_thai,
                   dim1.value_name AS dim1_name, dim2.value_name AS dim2_name,
                   dim3.value_name AS dim3_name, dim4.value_name AS dim4_name,
                   dim5.value_name AS dim5_name
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            LEFT JOIN ap_vendor   v   ON v.id = t.vendor_id
            LEFT JOIN cd_branch   b   ON b.id = t.branch_id
            LEFT JOIN gl_dimension_value dim1 ON dim1.id = t.dim1_id
            LEFT JOIN gl_dimension_value dim2 ON dim2.id = t.dim2_id
            LEFT JOIN gl_dimension_value dim3 ON dim3.id = t.dim3_id
            LEFT JOIN gl_dimension_value dim4 ON dim4.id = t.dim4_id
            LEFT JOIN gl_dimension_value dim5 ON dim5.id = t.dim5_id
            WHERE t.id = $1`, [id]),
        pool.query(`SELECT * FROM ap_transaction_detail WHERE header_id=$1 ORDER BY line_no`, [id]),
        pool.query(`SELECT a.*, t.doc_no AS applied_to_doc_no, t.doc_date AS applied_to_doc_date
                    FROM ap_transaction_apply a
                    LEFT JOIN ap_transaction t ON t.id = a.applied_to_id
                    WHERE a.transaction_id=$1 ORDER BY a.id`, [id]),
        pool.query(`SELECT * FROM ap_transaction_payment WHERE header_id=$1 ORDER BY line_no`
            .replace('ap_transaction_payment', 'ap_transaction_payment'), [id])
            .catch(() => ({ rows: [] })),
        pool.query(`SELECT * FROM ap_transaction_wht WHERE header_id=$1 ORDER BY id`, [id])
            .catch(() => ({ rows: [] })),
    ]);
    if (hRes.rows.length === 0) return null;
    return { ...hRes.rows[0], details: dRes.rows, applies: aRes.rows, payments: pRes.rows, whts: whtRes.rows };
};

// --- GET list ---
const fetchRows = async (req, res) => {
    const { vendor_id, doc_code, status, date_from, date_to, search } = req.query;
    try {
        let query = `
            SELECT t.id, t.doc_no, t.doc_date, t.due_date, t.status,
                   t.vendor_id, v.vendor_code, v.vendor_name_th,
                   t.currency_code, t.exchange_rate,
                   t.total_amount_lc, t.paid_amount_lc, t.balance_amount_lc,
                   t.ref_no, t.description,
                   d.doc_code, d.doc_name_thai, d.sys_doc_type,
                   b.branch_code, b.branch_name_thai
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            LEFT JOIN ap_vendor   v   ON v.id = t.vendor_id
            LEFT JOIN cd_branch   b   ON b.id = t.branch_id
            WHERE 1=1`;
        const params = [];
        let pi = 1;
        if (vendor_id)  { params.push(vendor_id);  query += ` AND t.vendor_id = $${pi++}`; }
        if (doc_code)   { params.push(doc_code);   query += ` AND d.doc_code = $${pi++}`; }
        if (status)     { params.push(status);     query += ` AND t.status = $${pi++}`; }
        if (date_from)  { params.push(date_from);  query += ` AND t.doc_date >= $${pi++}`; }
        if (date_to)    { params.push(date_to);    query += ` AND t.doc_date <= $${pi++}`; }
        if (search) {
            params.push(`%${search.toUpperCase()}%`);
            query += ` AND (UPPER(t.doc_no) LIKE $${pi} OR UPPER(COALESCE(t.ref_no,'')) LIKE $${pi}
                           OR UPPER(v.vendor_code) LIKE $${pi} OR UPPER(v.vendor_name_th) LIKE $${pi})`;
            pi++;
        }
        query += ` ORDER BY t.doc_date DESC, t.id DESC`;
        const result = await req.dbPool.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching ap_transaction list:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET one ---
const fetchRow = async (req, res) => {
    const { id } = req.params;
    try {
        const data = await fetchRowById(req.dbPool, id);
        if (!data) return res.status(404).json({ message: 'Not found.' });
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching ap_transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET open PIs (for Payment) ---
const fetchOpenInvoices = async (req, res) => {
    const { vendor_id } = req.query;
    if (!vendor_id) return res.status(400).json({ message: 'vendor_id required' });
    try {
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date, t.due_date,
                   t.total_amount_lc, t.balance_amount_lc,
                   t.currency_code, t.exchange_rate,
                   d.doc_code, d.sys_doc_type
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE t.vendor_id = $1
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0.005
              AND d.sys_doc_type IN ('10','50')
            ORDER BY t.doc_date, t.id`, [vendor_id]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching open AP invoices:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET open Advances (for deduction in Payment) ---
const fetchOpenAdvances = async (req, res) => {
    const { vendor_id } = req.query;
    if (!vendor_id) return res.status(400).json({ message: 'vendor_id required' });
    try {
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date,
                   t.total_amount_lc, t.balance_amount_lc,
                   t.currency_code, t.exchange_rate,
                   d.doc_code, d.sys_doc_type
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE t.vendor_id = $1
              AND t.status = 'Posted'
              AND t.balance_amount_lc > 0.005
              AND d.sys_doc_type = '60'
            ORDER BY t.doc_date, t.id`, [vendor_id]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching open AP advances:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET open RAs (for Payment reference) ---
const fetchOpenRemittanceAdvices = async (req, res) => {
    const { vendor_id } = req.query;
    if (!vendor_id) return res.status(400).json({ message: 'vendor_id required' });
    try {
        const result = await req.dbPool.query(`
            SELECT t.id, t.doc_no, t.doc_date,
                   t.total_amount_lc, t.balance_amount_lc,
                   t.currency_code, t.exchange_rate,
                   d.doc_code, d.sys_doc_type, t.description
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE t.vendor_id = $1
              AND t.status IN ('Posted','Draft')
              AND t.balance_amount_lc > 0.005
              AND d.sys_doc_type = '70'
            ORDER BY t.doc_date, t.id`, [vendor_id]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching open AP remittance advices:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- GET invoices in RA (for auto-fill in Payment) ---
const fetchRaInvoices = async (req, res) => {
    const { ra_id } = req.query;
    if (!ra_id) return res.status(400).json({ message: 'ra_id required' });
    try {
        // RA uses ap_transaction_apply to store PI references
        const result = await req.dbPool.query(`
            SELECT a.applied_to_id AS id,
                   t.doc_no, t.doc_date, t.due_date,
                   t.total_amount_lc, t.balance_amount_lc,
                   a.applied_amount_lc, a.applied_amount_fc,
                   t.currency_code, t.exchange_rate
            FROM ap_transaction_apply a
            JOIN ap_transaction t ON t.id = a.applied_to_id
            WHERE a.transaction_id = $1
            ORDER BY t.doc_date, t.id`, [ra_id]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching RA invoices:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// --- 1. Create Transaction (Draft/Post) ---
const createTransaction = async (req, res) => {
    const { header, details, applies, payments, whts, action } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        // idempotent schema migrations
        await client.query(`ALTER TABLE ap_transaction_detail ADD COLUMN IF NOT EXISTS item_code VARCHAR(50)`).catch(() => {});
        await client.query(`ALTER TABLE ap_transaction_detail ADD COLUMN IF NOT EXISTS item_name VARCHAR(200)`).catch(() => {});

        if (action === 'Post') {
            const periodRes = await client.query(
                `SELECT id FROM gl_posting_period
                 WHERE $1::date BETWEEN period_start_date AND period_end_date
                 AND gl_status = 'OPEN' LIMIT 1`, [header.doc_date]
            );
            if (periodRes.rows.length === 0)
                throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        }

        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`, [header.doc_date]
        );
        if (periodRes.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        const periodId = periodRes.rows[0].id;

        let finalDocNo = header.doc_no;
        if (!finalDocNo || finalDocNo === 'AUTO') {
            finalDocNo = await generateDocNo(client, header.doc_id, header.doc_date, header.branch_id);
            if (!finalDocNo) throw new Error('Auto numbering failed or manual doc_no required');
        }

        const status = action === 'Post' ? 'Posted' : 'Draft';

        const hRes = await client.query(`
            INSERT INTO ap_transaction
            (doc_id, doc_no, doc_date, due_date, period_id,
             vendor_id, vendor_code, vendor_name_th,
             ap_account_id, currency_id, currency_code, exchange_rate,
             subtotal_fc, discount_amount_fc, before_vat_fc, vat_amount_fc, total_amount_fc,
             subtotal_lc, discount_amount_lc, before_vat_lc, vat_amount_lc, total_amount_lc,
             paid_amount_lc, balance_amount_lc,
             ref_no, ref_doc_id, ref_doc_no, description, status,
             dim1_id, dim2_id, dim3_id, dim4_id, dim5_id,
             branch_id, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                    $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                    $25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
            RETURNING id
        `, [
            header.doc_id, finalDocNo, header.doc_date, header.due_date || null, periodId,
            header.vendor_id, header.vendor_code || null, header.vendor_name_th || null,
            header.ap_account_id || null, header.currency_id || null, header.currency_code || 'THB',
            header.exchange_rate || 1,
            header.subtotal_fc || 0, header.discount_amount_fc || 0,
            header.before_vat_fc || 0, header.vat_amount_fc || 0, header.total_amount_fc || 0,
            header.subtotal_lc || 0, header.discount_amount_lc || 0,
            header.before_vat_lc || 0, header.vat_amount_lc || 0, header.total_amount_lc || 0,
            0, header.total_amount_lc || 0,
            header.ref_no || null, header.ref_doc_id || null, header.ref_doc_no || null,
            header.description || null, status,
            header.dim1_id || null, header.dim2_id || null,
            header.dim3_id || null, header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, header.created_by || null,
        ]);
        const newHeaderId = hRes.rows[0].id;

        // Insert details
        let lineNo = 1;
        for (const d of (details || [])) {
            await client.query(`
                INSERT INTO ap_transaction_detail
                (header_id, line_no, item_code, item_name, description,
                 quantity, unit_price_fc, discount_percent, discount_amount_fc,
                 subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
                 expense_account_id, subtotal_lc, vat_amount_lc, total_amount_lc, is_deferred_vat)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            `, [
                newHeaderId, lineNo++, d.item_code || null, d.item_name || null, d.description || null,
                d.quantity ?? 1, d.unit_price_fc || 0, d.discount_percent || 0, d.discount_amount_fc || 0,
                d.subtotal_fc || 0, d.vat_type || 'NOVAT', d.vat_rate ?? 0,
                d.vat_amount_fc || 0, d.total_amount_fc || 0,
                d.expense_account_id || null,
                d.subtotal_lc || 0, d.vat_amount_lc || 0, d.total_amount_lc || 0,
                d.is_deferred_vat || false
            ]);
        }

        // Insert apply records
        for (const a of (applies || [])) {
            await client.query(`
                INSERT INTO ap_transaction_apply
                (transaction_id, applied_to_id, applied_amount_lc, applied_amount_fc, applied_date, apply_type, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
            `, [newHeaderId, a.applied_to_id, a.applied_amount_lc || 0, a.applied_amount_fc || 0,
                header.doc_date, a.apply_type || 'invoice', header.created_by || null]);
        }

        // Update invoice balances
        const affectedIds = [...new Set(
            (applies || []).filter(a => (a.apply_type || 'invoice') === 'invoice')
                           .map(a => a.applied_to_id).filter(Boolean)
        )];
        for (const invoiceId of affectedIds) {
            await client.query(`
                UPDATE ap_transaction t SET
                    paid_amount_lc = (
                        SELECT COALESCE(SUM(a.applied_amount_fc * t.exchange_rate), 0)
                        FROM ap_transaction_apply a
                        WHERE a.applied_to_id = t.id AND a.apply_type = 'invoice'
                    ),
                    balance_amount_lc = t.total_amount_lc -
                        COALESCE((SELECT SUM(a.applied_amount_fc * t.exchange_rate)
                                  FROM ap_transaction_apply a
                                  WHERE a.applied_to_id = t.id AND a.apply_type = 'invoice'), 0),
                    updated_at = NOW()
                WHERE id = $1
            `, [invoiceId]);
        }

        // Insert payment rows
        await ensurePaymentTable(client);
        let pmLineNo = 1;
        for (const p of (payments || [])) {
            await client.query(`
                INSERT INTO ap_transaction_payment
                (header_id, line_no, payment_method_id, payment_method_code, payment_method_name,
                 payment_method_type, cm_bank_account_id, gl_account_id,
                 amount_lc, amount_fc, ref_no, payment_date, remark,
                 drawer_bank_name, drawer_bank_branch, drawer_account_no, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            `, [
                newHeaderId, pmLineNo++,
                p.payment_method_id || null, p.payment_method_code || null, p.payment_method_name || null,
                p.payment_method_type || 'CASH', p.cm_bank_account_id || null, p.gl_account_id || null,
                p.amount_lc || 0, p.amount_fc || 0,
                p.ref_no || null, p.payment_date || header.doc_date, p.remark || null,
                p.drawer_bank_name || null, p.drawer_bank_branch || null, p.drawer_account_no || null,
                header.created_by || null
            ]);
        }

        // Insert WHT rows
        await client.query(`
            CREATE TABLE IF NOT EXISTS ap_transaction_wht (
                id SERIAL PRIMARY KEY,
                header_id INT NOT NULL REFERENCES ap_transaction(id) ON DELETE CASCADE,
                wht_type VARCHAR(100),
                wht_type_id INT REFERENCES cd_wht_type(id),
                income_type VARCHAR(20),
                wht_rate NUMERIC(5,2) DEFAULT 0,
                base_amount_lc NUMERIC(15,2) DEFAULT 0,
                wht_amount_lc NUMERIC(15,2) DEFAULT 0,
                description TEXT
            )
        `);
        await client.query(`ALTER TABLE ap_transaction_wht ADD COLUMN IF NOT EXISTS wht_type_id INT REFERENCES cd_wht_type(id)`).catch(() => {});
        await client.query(`ALTER TABLE ap_transaction_wht ADD COLUMN IF NOT EXISTS income_type VARCHAR(20)`).catch(() => {});
        for (const w of (whts || [])) {
            await client.query(`
                INSERT INTO ap_transaction_wht (header_id, wht_type, wht_type_id, income_type, wht_rate, base_amount_lc, wht_amount_lc, description)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `, [newHeaderId, w.wht_type || null, w.wht_type_id || null, w.income_type || null,
                w.wht_rate || 0, w.base_amount_lc || 0, w.wht_amount_lc || 0, w.description || null]);
        }
        // Update header wht_amount_lc
        const totalWhtLc = (whts || []).reduce((s, w) => s + (Number(w.wht_amount_lc) || 0), 0);
        if (totalWhtLc > 0) {
            await client.query(`UPDATE ap_transaction SET wht_amount_lc=$1 WHERE id=$2`, [totalWhtLc, newHeaderId]);
        }

        // Post GL
        let glEntryId = null;
        if (action === 'Post') {
            const sysDocTypeRes = await client.query(
                `SELECT sys_doc_type FROM sa_module_document WHERE id = $1 LIMIT 1`, [header.doc_id]
            );
            const sysDocType1 = sysDocTypeRes.rows[0]?.sys_doc_type || '';
            const isRaPost = sysDocType1 === '70';

            if (!isRaPost) {
                const headerWithDocNo = { ...header, doc_no: finalDocNo, _applies: applies || [], _payments: payments || [], _whts: whts || [] };
                glEntryId = await postGlEntry(client, newHeaderId, headerWithDocNo, details || [], finalDocNo);
                await insertVtRecords(client, newHeaderId, headerWithDocNo, details || [], sysDocType1);
                if (glEntryId) {
                    await client.query(`UPDATE ap_transaction SET gl_entry_id=$1 WHERE id=$2`, [glEntryId, newHeaderId]);
                }
                if (['65'].includes(sysDocType1)) {
                    await client.query(`UPDATE ap_transaction SET balance_amount_lc=0 WHERE id=$1`, [newHeaderId]);
                }
            }
        }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, newHeaderId);
        res.status(201).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating ap_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally {
        client.release();
    }
};

// --- 2. Update Transaction (Draft only) ---
const updateTransaction = async (req, res) => {
    const { id } = req.params;
    const { header, details, applies, payments, whts } = req.body;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        // idempotent schema migrations
        await client.query(`ALTER TABLE ap_transaction_detail ADD COLUMN IF NOT EXISTS item_code VARCHAR(50)`).catch(() => {});
        await client.query(`ALTER TABLE ap_transaction_detail ADD COLUMN IF NOT EXISTS item_name VARCHAR(200)`).catch(() => {});

        const existing = await client.query(`SELECT status FROM ap_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) throw new Error('Not found');
        if (existing.rows[0].status === 'Posted') throw new Error('ไม่สามารถแก้ไขเอกสารที่ Post แล้ว');

        const periodRes = await client.query(
            `SELECT id FROM gl_posting_period
             WHERE $1::date BETWEEN period_start_date AND period_end_date
             AND gl_status = 'OPEN' LIMIT 1`, [header.doc_date]
        );
        if (periodRes.rows.length === 0)
            throw new Error(`ไม่พบงวดบัญชีที่เปิดใช้งาน สำหรับวันที่เอกสาร ${header.doc_date}`);
        const periodId = periodRes.rows[0].id;

        await client.query(`
            UPDATE ap_transaction SET
                doc_date = $1, due_date = $2, period_id = $3,
                vendor_id = $4, vendor_code = $5, vendor_name_th = $6,
                ap_account_id = $7, currency_id = $8, currency_code = $9, exchange_rate = $10,
                subtotal_fc = $11, discount_amount_fc = $12, before_vat_fc = $13,
                vat_amount_fc = $14, total_amount_fc = $15,
                subtotal_lc = $16, discount_amount_lc = $17, before_vat_lc = $18,
                vat_amount_lc = $19, total_amount_lc = $20,
                balance_amount_lc = $20,
                ref_no = $21, ref_doc_id = $22, ref_doc_no = $23, description = $24,
                dim1_id = $25, dim2_id = $26, dim3_id = $27, dim4_id = $28, dim5_id = $29,
                branch_id = $30, updated_by = $31, updated_at = NOW()
            WHERE id = $32
        `, [
            header.doc_date, header.due_date || null, periodId,
            header.vendor_id, header.vendor_code || null, header.vendor_name_th || null,
            header.ap_account_id || null, header.currency_id || null, header.currency_code || 'THB',
            header.exchange_rate || 1,
            header.subtotal_fc || 0, header.discount_amount_fc || 0, header.before_vat_fc || 0,
            header.vat_amount_fc || 0, header.total_amount_fc || 0,
            header.subtotal_lc || 0, header.discount_amount_lc || 0, header.before_vat_lc || 0,
            header.vat_amount_lc || 0, header.total_amount_lc || 0,
            header.ref_no || null, header.ref_doc_id || null, header.ref_doc_no || null,
            header.description || null,
            header.dim1_id || null, header.dim2_id || null, header.dim3_id || null,
            header.dim4_id || null, header.dim5_id || null,
            header.branch_id || null, header.updated_by || null, id
        ]);

        await client.query(`DELETE FROM ap_transaction_detail WHERE header_id=$1`, [id]);
        await client.query(`DELETE FROM ap_transaction_apply  WHERE transaction_id=$1`, [id]);
        await client.query(`DELETE FROM ap_transaction_wht    WHERE header_id=$1`, [id]);

        let lineNo = 1;
        for (const d of (details || [])) {
            await client.query(`
                INSERT INTO ap_transaction_detail
                (header_id, line_no, item_code, item_name, description,
                 quantity, unit_price_fc, discount_percent, discount_amount_fc,
                 subtotal_fc, vat_type, vat_rate, vat_amount_fc, total_amount_fc,
                 expense_account_id, subtotal_lc, vat_amount_lc, total_amount_lc, is_deferred_vat)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
            `, [
                id, lineNo++, d.item_code || null, d.item_name || null, d.description || null,
                d.quantity ?? 1, d.unit_price_fc || 0, d.discount_percent || 0, d.discount_amount_fc || 0,
                d.subtotal_fc || 0, d.vat_type || 'NOVAT', d.vat_rate ?? 0,
                d.vat_amount_fc || 0, d.total_amount_fc || 0,
                d.expense_account_id || null,
                d.subtotal_lc || 0, d.vat_amount_lc || 0, d.total_amount_lc || 0,
                d.is_deferred_vat || false
            ]);
        }
        for (const a of (applies || [])) {
            await client.query(`
                INSERT INTO ap_transaction_apply
                (transaction_id, applied_to_id, applied_amount_lc, applied_amount_fc, applied_date, apply_type, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
            `, [id, a.applied_to_id, a.applied_amount_lc || 0, a.applied_amount_fc || 0,
                header.doc_date, a.apply_type || 'invoice', header.updated_by || null]);
        }
        for (const w of (whts || [])) {
            await client.query(`
                INSERT INTO ap_transaction_wht (header_id, wht_type, wht_type_id, income_type, wht_rate, base_amount_lc, wht_amount_lc, description)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            `, [id, w.wht_type || null, w.wht_type_id || null, w.income_type || null,
                w.wht_rate || 0, w.base_amount_lc || 0, w.wht_amount_lc || 0, w.description || null]);
        }
        const totalWhtLc = (whts || []).reduce((s, w) => s + (Number(w.wht_amount_lc) || 0), 0);
        await client.query(`UPDATE ap_transaction SET wht_amount_lc=$1 WHERE id=$2`, [totalWhtLc, id]);

        // Payments: delete/re-insert
        await client.query(`DELETE FROM ap_transaction_payment WHERE header_id=$1`, [id]).catch(() => {});
        await ensurePaymentTable(client);
        let pmLineNo = 1;
        for (const p of (payments || [])) {
            await client.query(`
                INSERT INTO ap_transaction_payment
                (header_id, line_no, payment_method_id, payment_method_code, payment_method_name,
                 payment_method_type, cm_bank_account_id, gl_account_id,
                 amount_lc, amount_fc, ref_no, payment_date, remark,
                 drawer_bank_name, drawer_bank_branch, drawer_account_no, created_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            `, [
                id, pmLineNo++,
                p.payment_method_id || null, p.payment_method_code || null, p.payment_method_name || null,
                p.payment_method_type || 'CASH', p.cm_bank_account_id || null, p.gl_account_id || null,
                p.amount_lc || 0, p.amount_fc || 0,
                p.ref_no || null, p.payment_date || header.doc_date, p.remark || null,
                p.drawer_bank_name || null, p.drawer_bank_branch || null, p.drawer_account_no || null,
                header.updated_by || null
            ]);
        }

        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating ap_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally {
        client.release();
    }
};

// --- 3. Void Transaction ---
const voidTransaction = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`
            SELECT t.*, d.sys_doc_type
            FROM ap_transaction t
            JOIN sa_module_document d ON d.id = t.doc_id
            WHERE t.id=$1`, [id]
        );
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        const tx = existing.rows[0];
        if (tx.status === 'Void') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'เอกสารถูก Void แล้ว' }); }

        // Reverse invoice balances
        const applies = (await client.query(
            `SELECT * FROM ap_transaction_apply WHERE transaction_id=$1 AND apply_type='invoice'`, [id]
        )).rows;
        for (const a of applies) {
            await client.query(`
                UPDATE ap_transaction t SET
                    paid_amount_lc = GREATEST(0, t.paid_amount_lc - (SELECT SUM(a2.applied_amount_fc * t.exchange_rate)
                        FROM ap_transaction_apply a2 WHERE a2.transaction_id=$1 AND a2.applied_to_id=t.id AND a2.apply_type='invoice')),
                    balance_amount_lc = t.total_amount_lc -
                        GREATEST(0, t.paid_amount_lc - (SELECT SUM(a2.applied_amount_fc * t.exchange_rate)
                        FROM ap_transaction_apply a2 WHERE a2.transaction_id=$1 AND a2.applied_to_id=t.id AND a2.apply_type='invoice')),
                    updated_at = NOW()
                WHERE id = $2
            `, [id, a.applied_to_id]);
        }

        // Void GL entry
        if (tx.gl_entry_id) {
            await client.query(
                `UPDATE gl_entry_header SET status='Void', updated_at=NOW() WHERE id=$1`, [tx.gl_entry_id]
            );
        }

        await client.query(
            `UPDATE ap_transaction SET status='Void', updated_at=NOW() WHERE id=$1`, [id]
        );
        await client.query('COMMIT');
        const full = await fetchRowById(req.dbPool, id);
        res.status(200).json(full);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error voiding ap_transaction:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally {
        client.release();
    }
};

// --- 4. Delete Transaction (Draft only) ---
const deleteTransaction = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(`SELECT status FROM ap_transaction WHERE id=$1`, [id]);
        if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Not found' }); }
        if (existing.rows[0].status !== 'Draft') { await client.query('ROLLBACK'); return res.status(400).json({ message: 'ลบได้เฉพาะเอกสาร Draft เท่านั้น' }); }
        await client.query(`DELETE FROM ap_transaction WHERE id=$1`, [id]);
        await client.query('COMMIT');
        res.status(204).send();
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting ap_transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally {
        client.release();
    }
};

module.exports = {
    fetchRows, fetchRow,
    fetchOpenInvoices, fetchOpenAdvances,
    fetchOpenRemittanceAdvices, fetchRaInvoices,
    createTransaction, updateTransaction, voidTransaction, deleteTransaction,
};
