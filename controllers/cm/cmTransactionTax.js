// controllers/cm/cmTransactionTax.js
// VAT / ภาษีหัก ณ ที่จ่าย / คู่ค้า ของธุรกรรม CM (user-approved 2026-11-01, ดู project_cm_recheck_2026_11)
// - รายรับ (10) / รายจ่าย (20): หลายบรรทัด แต่ละบรรทัดมีบัญชี + ประเภท VAT, เลือก "ราคารวม VAT" ได้ (utils/vatCalc.js)
//   amount_fc/lc ของบรรทัด = ยอดก่อน VAT, entered_amount_fc = ยอดที่กรอก, vat_amount_fc/lc = VAT ของบรรทัด
//   ยอดเอกสาร: subtotal + VAT = total_amount, ภาษีหัก ณ ที่จ่าย (cm_transaction_wht) = wht_amount,
//   ช่องทางรับ/จ่ายเงินรวม = total − wht (20: เราหักไว้นำส่งแทนผู้รับ, 10: ผู้จ่ายหักเราไว้ = ภาษีถูกหัก ณ ที่จ่าย)
// - คู่ค้า: เลือกจากผู้ขาย AP (10: ลูกค้า AR) แล้วระบบดึงชื่อ/เลขผู้เสียภาษี/สาขา/ประเภท/ที่อยู่จากข้อมูลหลักเสมอ
//   (แก้ไขไม่ได้) หรือไม่เลือกแล้วพิมพ์เอง — เก็บเป็น snapshot ที่หัวเอกสาร (counterparty_name + party_*)
const { calcLineAmounts } = require('../../utils/vatCalc');
const { thaiAddress } = require('../../utils/thaiText');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ประเภทเอกสารที่มีบรรทัดรายการแบบ VAT (เอกสารเก่าที่ไม่มีบรรทัดยังใช้บัญชีเดียวจากหัวเอกสารเหมือนเดิม)
const TAX_LINE_TYPES = ['10', '20'];

const ensured = new Set();
const ensureCmTaxColumns = async (db) => {
    const key = db.options?.database || db.database || 'default';
    if (ensured.has(key)) return;
    await require('./cmTransactionGlSetupController').ensureTable(db);
    const head = [
        'price_includes_vat BOOLEAN NOT NULL DEFAULT false',
        'party_source VARCHAR(5)', 'party_id INTEGER', 'party_code VARCHAR(50)',
        'party_tax_id VARCHAR(20)', 'party_branch_code VARCHAR(10)', 'party_type VARCHAR(20)', 'party_address TEXT',
        'tax_invoice_no VARCHAR(50)', 'tax_invoice_date DATE',
        'subtotal_fc NUMERIC(18,4) DEFAULT 0', 'subtotal_lc NUMERIC(18,4) DEFAULT 0',
        'vat_amount_fc NUMERIC(18,4) DEFAULT 0', 'vat_amount_lc NUMERIC(18,4) DEFAULT 0',
        'wht_amount_fc NUMERIC(18,4) DEFAULT 0', 'wht_amount_lc NUMERIC(18,4) DEFAULT 0',
    ];
    for (const c of head) await db.query(`ALTER TABLE cm_transaction ADD COLUMN IF NOT EXISTS ${c}`);
    const det = [
        'entered_amount_fc NUMERIC(18,4)', "vat_type VARCHAR(20) DEFAULT 'NOVAT'", 'vat_rate NUMERIC(7,4) DEFAULT 0',
        'vat_amount_fc NUMERIC(18,4) DEFAULT 0', 'vat_amount_lc NUMERIC(18,4) DEFAULT 0',
        // เบิกเงินสดย่อย (40): ผู้ขายและใบกำกับภาษีต่อบรรทัด
        'seller_name VARCHAR(200)', 'seller_tax_id VARCHAR(20)', 'seller_branch_code VARCHAR(10)',
        'tax_invoice_no VARCHAR(50)', 'tax_invoice_date DATE',
    ];
    for (const c of det) await db.query(`ALTER TABLE cm_transaction_detail ADD COLUMN IF NOT EXISTS ${c}`);
    await db.query(`
        CREATE TABLE IF NOT EXISTS cm_transaction_wht (
            id             SERIAL PRIMARY KEY,
            header_id      INTEGER NOT NULL REFERENCES cm_transaction(id) ON DELETE CASCADE,
            wht_type_id    INTEGER REFERENCES cd_wht_type(id),
            wht_type       VARCHAR(100),
            income_type    VARCHAR(20),
            wht_rate       NUMERIC(5,2) DEFAULT 0,
            base_amount_fc NUMERIC(18,4) DEFAULT 0,
            base_amount_lc NUMERIC(18,4) DEFAULT 0,
            wht_amount_fc  NUMERIC(18,4) DEFAULT 0,
            wht_amount_lc  NUMERIC(18,4) DEFAULT 0,
            description    TEXT
        )`);
    ensured.add(key);
};

// คู่ค้าจากข้อมูลหลัก: ดึงค่าจาก AP/AR ทับค่าที่หน้าจอส่งมาเสมอ — ไม่เลือก = ใช้ค่าที่พิมพ์เอง
const resolveParty = async (client, header) => {
    const src = header.party_source, id = Number(header.party_id) || null;
    if (src === 'AP' && id) {
        const v = (await client.query(`
            SELECT v.vendor_code, v.vendor_name_th, v.tax_id, v.tax_branch_code, v.vendor_type,
                   a.address_no, a.address_building_village, a.address_alley, a.address_road,
                   a.address_sub_district, a.address_district, a.address_province, a.address_zip_code
              FROM ap_vendor v
              LEFT JOIN LATERAL (SELECT * FROM ap_vendor_address x WHERE x.vendor_id = v.id
                                  ORDER BY (x.address_type = 'billing') DESC, x.is_default DESC, x.id LIMIT 1) a ON TRUE
             WHERE v.id = $1`, [id])).rows[0];
        if (!v) throw new Error('ไม่พบผู้ขายที่เลือก');
        Object.assign(header, {
            party_id: id, party_code: v.vendor_code, counterparty_name: v.vendor_name_th, party_tax_id: v.tax_id,
            party_branch_code: v.tax_branch_code, party_type: v.vendor_type, party_address: thaiAddress(v).full || null,
        });
    } else if (src === 'AR' && id) {
        const c = (await client.query(`
            SELECT c.customer_code, c.customer_name_th, c.tax_id, c.tax_branch_code,
                   a.address_no, a.address_building_village, a.address_alley, a.address_road,
                   a.address_sub_district, a.address_district, a.address_province, a.address_zip_code
              FROM ar_customer c
              LEFT JOIN LATERAL (SELECT * FROM ar_customer_address x WHERE x.customer_id = c.id
                                  ORDER BY (x.address_type = 'billing') DESC, x.is_default DESC, x.id LIMIT 1) a ON TRUE
             WHERE c.id = $1`, [id])).rows[0];
        if (!c) throw new Error('ไม่พบลูกค้าที่เลือก');
        Object.assign(header, {
            party_id: id, party_code: c.customer_code, counterparty_name: c.customer_name_th, party_tax_id: c.tax_id,
            party_branch_code: c.tax_branch_code, party_type: null, party_address: thaiAddress(c).full || null,
        });
    } else {
        header.party_source = null; header.party_id = null; header.party_code = null;
    }
};

// บรรทัดรายการ + ภาษีหัก ณ ที่จ่าย: คำนวณยอดก่อน VAT / VAT / ยอดบาท (ปัดเศษ ส่วนต่างลงบรรทัดสุดท้าย) — แก้ค่าในอ็อบเจกต์
const calcTaxDoc = (header, details, whts) => {
    const rate = Number(header.exchange_rate) || 1;
    const incl = header.price_includes_vat === true;
    let subFc = 0, vatFc = 0, subLc = 0, vatLc = 0;
    for (const d of details) {
        const entered = round2(d.entered_amount_fc ?? d.amount_fc);
        const noVat = !d.vat_type || d.vat_type === 'NOVAT';
        const a = calcLineAmounts({ qty: 1, price: entered, vatRate: d.vat_rate, noVat, priceIncludesVat: incl });
        Object.assign(d, {
            entered_amount_fc: entered, vat_type: noVat ? 'NOVAT' : d.vat_type, vat_rate: noVat ? 0 : Number(d.vat_rate) || 0,
            amount_fc: a.net, vat_amount_fc: a.vat, amount_lc: round2(a.net * rate), vat_amount_lc: round2(a.vat * rate),
        });
        subFc += a.net; vatFc += a.vat; subLc += d.amount_lc; vatLc += d.vat_amount_lc;
    }
    const totalFc = round2(subFc + vatFc);
    const totalLc = round2(totalFc * rate);
    const diff = round2(totalLc - round2(subLc + vatLc));
    if (diff && details.length) { const last = details[details.length - 1]; last.amount_lc = round2(last.amount_lc + diff); subLc += diff; }
    let whtFc = 0, whtLc = 0;
    for (const w of whts) {
        w.base_amount_fc = round2(w.base_amount_fc ?? w.base_amount_lc);
        w.wht_amount_fc = round2(w.wht_amount_fc ?? w.wht_amount_lc);
        w.base_amount_lc = round2(w.base_amount_fc * rate);
        w.wht_amount_lc = round2(w.wht_amount_fc * rate);
        whtFc += w.wht_amount_fc; whtLc += w.wht_amount_lc;
    }
    Object.assign(header, {
        subtotal_fc: round2(subFc), subtotal_lc: round2(subLc), vat_amount_fc: round2(vatFc), vat_amount_lc: round2(vatLc),
        total_amount_fc: totalFc, total_amount_lc: totalLc, wht_amount_fc: round2(whtFc), wht_amount_lc: round2(whtLc),
    });
};

// คอลัมน์เพิ่มเติมของหัวเอกสาร + ภาษีหัก ณ ที่จ่าย (บันทึกหลัง insert/update หัวเอกสาร)
const saveTaxExtras = async (client, id, header, whts) => {
    await client.query(`
        UPDATE cm_transaction SET price_includes_vat = $2, counterparty_name = $3, party_source = $4, party_id = $5,
               party_code = $6, party_tax_id = $7, party_branch_code = $8, party_type = $9, party_address = $10,
               tax_invoice_no = $11, tax_invoice_date = $12, subtotal_fc = $13, subtotal_lc = $14,
               vat_amount_fc = $15, vat_amount_lc = $16, wht_amount_fc = $17, wht_amount_lc = $18
         WHERE id = $1`, [
        id, header.price_includes_vat === true, header.counterparty_name || null, header.party_source || null,
        header.party_id || null, header.party_code || null, (header.party_tax_id || '').trim() || null,
        (header.party_branch_code || '').trim() || null, header.party_type || null, (header.party_address || '').trim() || null,
        (header.tax_invoice_no || '').trim() || null, (header.tax_invoice_no || '').trim() ? (header.tax_invoice_date || header.doc_date) : null,
        header.subtotal_fc || 0, header.subtotal_lc || 0, header.vat_amount_fc || 0, header.vat_amount_lc || 0,
        header.wht_amount_fc || 0, header.wht_amount_lc || 0,
    ]);
    await client.query(`DELETE FROM cm_transaction_wht WHERE header_id = $1`, [id]);
    for (const w of whts) {
        await client.query(`
            INSERT INTO cm_transaction_wht (header_id, wht_type_id, wht_type, income_type, wht_rate,
                   base_amount_fc, base_amount_lc, wht_amount_fc, wht_amount_lc, description)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
            id, w.wht_type_id || null, w.wht_type || null, w.income_type || null, w.wht_rate || 0,
            w.base_amount_fc || 0, w.base_amount_lc || 0, w.wht_amount_fc || 0, w.wht_amount_lc || 0, w.description || null,
        ]);
    }
};

// ตรวจก่อน Post: เลขที่ใบกำกับของผู้ขาย (20 ที่มีภาษีซื้อ) และข้อมูลคู่ค้าที่รายงานภาษีต้องใช้
const assertTaxPostable = (header, sys) => {
    const has = (v) => (v ?? '').toString().trim() !== '';
    const vat = Number(header.vat_amount_fc) || 0, wht = Number(header.wht_amount_fc) || 0;
    if (sys === '20') {
        if (vat && !has(header.tax_invoice_no)) throw new Error('กรุณาระบุเลขที่ใบกำกับภาษีของผู้ขาย (เอกสารมีภาษีซื้อ)');
        if ((vat || wht) && (!has(header.counterparty_name) || !has(header.party_tax_id))) {
            throw new Error('กรุณาระบุชื่อและเลขประจำตัวผู้เสียภาษีของผู้รับเงิน (เอกสารมีภาษีซื้อ/ภาษีหัก ณ ที่จ่าย)');
        }
        if (wht && (!has(header.party_type) || !has(header.party_address))) {
            throw new Error('กรุณาระบุประเภท (บุคคลธรรมดา/นิติบุคคล) และที่อยู่ของผู้รับเงิน — ใช้ในหนังสือรับรองและ ภ.ง.ด.');
        }
    }
    if (sys === '10' && vat && !has(header.counterparty_name)) throw new Error('กรุณาระบุชื่อผู้ซื้อ (เอกสารมีภาษีขาย)');
};

// รายงานภาษี: 20 = ภาษีซื้อ (เลขที่/วันที่ใบกำกับของผู้ขาย), 10 = ภาษีขาย (เลขที่เอกสารนี้คือใบกำกับภาษี)
const insertCmVt = async (client, id, sys) => {
    if (!TAX_LINE_TYPES.includes(sys)) return;
    const h = (await client.query(`SELECT * FROM cm_transaction WHERE id = $1`, [id])).rows[0];
    const lines = (await client.query(
        `SELECT * FROM cm_transaction_detail WHERE header_id = $1 AND COALESCE(vat_amount_fc, 0) <> 0 ORDER BY line_no`, [id])).rows;
    const createdBy = h.updated_by || h.created_by || null; // vt_transaction.created_by = ชื่อผู้ใช้
    const isInput = sys === '20';
    for (const d of lines) {
        await client.query(`
            INSERT INTO vt_transaction
            (module_code, vat_type, doc_id, source_header_id, source_detail_id, doc_no, doc_date, vat_rate,
             base_amount_lc, vat_amount_lc, base_amount_fc, vat_amount_fc, currency_id, exchange_rate,
             vendor_id, customer_id, entity_name, entity_tax_id, entity_branch_code, created_by, tax_invoice_no, tax_invoice_date)
            VALUES ('CM',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, [
            isInput ? 'INPUT_VAT' : 'OUTPUT_VAT', h.doc_id, id, d.id, h.doc_no, h.doc_date, d.vat_rate || 0,
            d.amount_lc, d.vat_amount_lc, d.amount_fc, d.vat_amount_fc, h.currency_id || null, h.exchange_rate || 1,
            h.party_source === 'AP' ? h.party_id : null, h.party_source === 'AR' ? h.party_id : null,
            h.counterparty_name || '', h.party_tax_id || null, h.party_branch_code || '00000', createdBy,
            isInput ? h.tax_invoice_no : null, isInput && h.tax_invoice_no ? h.tax_invoice_date : null,
        ]);
    }
};

const deleteCmVt = (client, id) => client.query(`DELETE FROM vt_transaction WHERE module_code = 'CM' AND source_header_id = $1`, [id]);

// ยกเลิก: เดือนเดียวกับเอกสาร = ไม่นับรายการเดิม, ข้ามเดือน = ลงรายการกลับในเดือนที่ยกเลิก (มิเรอร์ AP)
const voidCmVt = async (client, id, docDate, voidDate, userName) => {
    const ym = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : String(d).slice(0, 7));
    if (ym(docDate) === String(voidDate).slice(0, 7)) {
        await client.query(`UPDATE vt_transaction SET is_voided = TRUE WHERE module_code = 'CM' AND source_header_id = $1`, [id]);
        return;
    }
    await client.query(`
        INSERT INTO vt_transaction
        (module_code, vat_type, doc_id, source_header_id, source_detail_id, doc_no, doc_date,
         tax_invoice_no, tax_invoice_date, vat_rate,
         base_amount_lc, vat_amount_lc, base_amount_fc, vat_amount_fc, currency_id, exchange_rate,
         customer_id, vendor_id, entity_name, entity_tax_id, entity_branch_code, created_by)
        SELECT module_code, vat_type, doc_id, source_header_id, source_detail_id, doc_no, $2::date,
               COALESCE(tax_invoice_no, doc_no), COALESCE(tax_invoice_date, doc_date), vat_rate,
               -base_amount_lc, -vat_amount_lc, -base_amount_fc, -vat_amount_fc, currency_id, exchange_rate,
               customer_id, vendor_id, entity_name, entity_tax_id, entity_branch_code,
               $3
          FROM vt_transaction WHERE module_code = 'CM' AND source_header_id = $1 AND is_voided = FALSE`,
        [id, voidDate, userName]);
};

module.exports = {
    TAX_LINE_TYPES, ensureCmTaxColumns, resolveParty, calcTaxDoc, saveTaxExtras, assertTaxPostable,
    insertCmVt, deleteCmVt, voidCmVt, round2,
};
