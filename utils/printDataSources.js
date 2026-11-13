// แหล่งข้อมูลของแบบฟอร์มพิมพ์ (im_print_form.data_source)
// แต่ละแหล่งข้อมูลกำหนด: ประเภทเอกสารที่ใช้ได้, รายการฟิลด์ให้เลือกวางในหน้าจอออกแบบ, คำสั่งดึงรายการเอกสาร/ข้อมูลพิมพ์
// เอกสารอ้างด้วย key "<module>:<id>" (เช่น IM:12, AR:5) เพราะแหล่งข้อมูลเดียวรวมเอกสารหลายโมดูลได้
// ฟิลด์ scope: H = หัวเอกสาร, L = รายการ (ใช้ในคอลัมน์ตาราง), P = คำนวณตอนพิมพ์ฝั่ง Flutter (เลขหน้า ชุดสำเนา วันที่พิมพ์)
// type: text / money / qty / number / date / image — Flutter จัดรูปแบบตาม type (ปรับได้ต่อชิ้นงาน)

const fs = require('fs');
const path = require('path');
const { bahtText, englishAmountText, thaiAddress } = require('./thaiText');
const { getBaseCurrency } = require('./baseCurrency');

const f = (key, th, en, group, type = 'text', scope = 'H') => ({ key, label_th: th, label_en: en, group, type, scope });

// ── ฟิลด์ที่ใช้ร่วมทุกแหล่งข้อมูล ────────────────────────────────────────────
const COMPANY_FIELDS = [
  f('company_name', 'ชื่อบริษัท', 'Company name', 'company'),
  f('company_name_en', 'ชื่อบริษัท (อังกฤษ)', 'Company name (EN)', 'company'),
  f('company_address', 'ที่อยู่บริษัท', 'Company address', 'company'),
  f('company_address1', 'ที่อยู่บริษัท บรรทัด 1', 'Company address line 1', 'company'),
  f('company_address2', 'ที่อยู่บริษัท บรรทัด 2', 'Company address line 2', 'company'),
  f('company_tax_id', 'เลขประจำตัวผู้เสียภาษีบริษัท', 'Company tax ID', 'company'),
  f('company_phone', 'โทรศัพท์บริษัท', 'Company phone', 'company'),
  f('company_fax', 'แฟกซ์บริษัท', 'Company fax', 'company'),
  f('company_email', 'อีเมลบริษัท', 'Company e-mail', 'company'),
  f('company_website', 'เว็บไซต์บริษัท', 'Company website', 'company'),
  f('company_logo', 'โลโก้บริษัท', 'Company logo', 'company', 'image'),
  f('branch_code', 'รหัสสาขา (ผู้ขาย)', 'Branch code (seller)', 'company'),
  f('branch_name', 'ชื่อสาขา (ผู้ขาย)', 'Branch name (seller)', 'company'),
  f('branch_name_en', 'ชื่อสาขา (ผู้ขาย) อังกฤษ', 'Branch name (seller, EN)', 'company'),
  f('branch_address', 'ที่อยู่สาขา (ผู้ขาย)', 'Branch address (seller)', 'company'),
  f('branch_phone', 'โทรศัพท์สาขา (ผู้ขาย)', 'Branch phone (seller)', 'company'),
  f('company_branch_label', 'สำนักงานใหญ่/สาขาที่ xxxxx (ผู้ขาย)', 'Head office/Branch xxxxx (seller)', 'company'),
  f('company_branch_label_en', 'สำนักงานใหญ่/สาขาที่ (ผู้ขาย) อังกฤษ', 'Head office/Branch (seller, EN)', 'company'),
  f('company_tax_id_branch', 'เลขผู้เสียภาษี + สาขา (ผู้ขาย)', 'Tax ID + branch (seller)', 'company'),
  f('company_tax_id_branch_en', 'เลขผู้เสียภาษี + สาขา (ผู้ขาย) อังกฤษ', 'Tax ID + branch (seller, EN)', 'company'),
];

const PRINT_FIELDS = [
  f('print_no', 'พิมพ์ครั้งที่', 'Print no.', 'print', 'number'),
  f('reprint_label', 'พิมพ์ซ้ำครั้งที่ x (ว่างเมื่อพิมพ์ครั้งแรก)', 'Reprint label (blank on first print)', 'print'),
  f('reprint_label_en', 'พิมพ์ซ้ำครั้งที่ x (อังกฤษ)', 'Reprint label (EN)', 'print'),
  f('print_date', 'วันที่พิมพ์', 'Print date', 'print', 'date', 'P'),
  f('print_time', 'เวลาที่พิมพ์', 'Print time', 'print', 'text', 'P'),
  f('printed_by', 'ผู้พิมพ์', 'Printed by', 'print', 'text', 'P'),
  f('page_label', 'หน้า x/y', 'Page x/y', 'print', 'text', 'P'),
  f('page_label_en', 'หน้า x/y (อังกฤษ)', 'Page x/y (EN)', 'print', 'text', 'P'),
  f('page_no', 'เลขหน้า', 'Page no.', 'print', 'number', 'P'),
  f('page_count', 'จำนวนหน้า', 'Page count', 'print', 'number', 'P'),
  f('copy_name', 'ชื่อสำเนา (ต้นฉบับ/สำเนา)', 'Copy name', 'print', 'text', 'P'),
  f('copy_name_en', 'ชื่อสำเนา (อังกฤษ)', 'Copy name (EN)', 'print', 'text', 'P'),
];

const ymdSql = (col) => `to_char(${col}, 'YYYY-MM-DD')`;
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const { calcLineAmounts, netUnitPriceSql, ensureImPriceColumns, ensureArDiscountColumns } = require('./vatCalc');
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const s = (v) => (v === null || v === undefined ? '' : String(v).trim());

// ข้อมูลบริษัท (แถวแรกที่ใช้งาน) + โลโก้เป็น data URL (ไฟล์อยู่ public/sa — ไม่มีไฟล์ = ว่าง)
const loadCompany = async (db) => {
  const c = (await db.query(`SELECT * FROM sa_company ORDER BY is_active DESC NULLS LAST, id LIMIT 1`)).rows[0] || {};
  const addr = thaiAddress(c);
  let logo = '';
  if (c.logo_url) {
    try {
      const file = path.join(__dirname, '..', 'public', 'sa', path.basename(String(c.logo_url).replace(/\\/g, '/')));
      if (fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase().replace('.', '');
        logo = `data:image/${ext === 'jpg' ? 'jpeg' : ext || 'png'};base64,${fs.readFileSync(file).toString('base64')}`;
      }
    } catch (_) { logo = ''; }
  }
  return {
    company_name: s(c.thai_name), company_name_en: s(c.english_name) || s(c.thai_name),
    company_address: addr.full, company_address1: addr.line1, company_address2: addr.line2,
    company_tax_id: s(c.tax_id_number), company_phone: s(c.phone_number), company_fax: s(c.fax_number),
    company_email: s(c.email), company_website: s(c.website), company_logo: logo,
  };
};

// สาขาผู้ขายต่อเอกสาร — เอกสารที่ไม่ระบุสาขาใช้สำนักงานใหญ่ (key 0): รหัส 00000 ก่อน แล้วจึงชื่อ "สำนักงานใหญ่"
const loadBranches = async (db, ids) => {
  const list = [...new Set(ids.filter(Boolean))];
  const toFields = (b) => ({
    branch_code: s(b.branch_code), branch_name: s(b.branch_name_thai), branch_name_en: s(b.branch_name_eng) || s(b.branch_name_thai),
    branch_address: thaiAddress(b).full, branch_phone: s(b.phone_number),
    ...sellerTaxBranch(b),
  });
  const rows = list.length ? (await db.query(`SELECT * FROM cd_branch WHERE id = ANY($1::int[])`, [list])).rows : [];
  const out = new Map(rows.map(b => [b.id, toFields(b)]));
  const ho = (await db.query(`
      SELECT * FROM cd_branch WHERE branch_code = '00000' OR branch_name_thai LIKE '%สำนักงานใหญ่%'
       ORDER BY (branch_code = '00000') DESC, is_active DESC NULLS LAST, id LIMIT 1`)).rows[0];
  out.set(0, ho ? toFields(ho) : { company_branch_label: 'สำนักงานใหญ่', company_branch_label_en: 'Head Office' });
  return out;
};

// ลูกค้า: ชื่ออังกฤษ, เลขภาษี, รหัสสาขาภาษี, เครดิต, ที่อยู่ออกบิลค่าเริ่มต้น
const loadCustomers = async (db, ids) => {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = (await db.query(`
      SELECT c.id, c.customer_code, c.customer_name_th, c.customer_name_en, c.tax_id,
             to_jsonb(c)->>'tax_branch_code' AS tax_branch_code, c.credit_term_days,
             to_jsonb(a) AS addr, ct.contact_name, ct.phone AS contact_phone, ct.mobile AS contact_mobile
        FROM ar_customer c
        LEFT JOIN LATERAL (
             SELECT * FROM ar_customer_contact x WHERE x.customer_id = c.id
              ORDER BY x.is_default DESC NULLS LAST, x.id LIMIT 1) ct ON TRUE
        LEFT JOIN LATERAL (
             SELECT * FROM ar_customer_address x WHERE x.customer_id = c.id
              ORDER BY (x.address_type = 'billing') DESC, x.is_default DESC, x.id LIMIT 1) a ON TRUE
       WHERE c.id = ANY($1::int[])`, [list])).rows;
  return new Map(rows.map(r => [r.id, r]));
};

// สาขาผู้ขายตามประมวลรัษฎากร — รหัสสาขา 5 หลัก (00000 = สำนักงานใหญ่) หรือชื่อสาขาเป็น "สำนักงานใหญ่"
const sellerTaxBranch = (b) => {
  const code = s(b.branch_code);
  const tax = /^[0-9]{5}$/.test(code) ? code : (/สำนักงานใหญ่/.test(s(b.branch_name_thai)) ? '00000' : '');
  return { company_branch_label: taxBranchTh(tax), company_branch_label_en: taxBranchEn(tax) };
};
const companyTaxFields = (taxId, header) => ({
  company_tax_id_branch: [taxId, s(header.company_branch_label)].filter(Boolean).join(' '),
  company_tax_id_branch_en: [taxId, s(header.company_branch_label_en)].filter(Boolean).join(' '),
});

const taxBranchTh = (code) => (!code ? '' : code === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${code}`);
const taxBranchEn = (code) => (!code ? '' : code === '00000' ? 'Head Office' : `Branch ${code}`);

// เบอร์โทรจากผู้ติดต่อหลัก (is_default ก่อน) — บรรทัด 3 ของที่อยู่ = "โทร. โทรศัพท์, มือถือ"
const customerPhones = (cust) => {
  const phone = s(cust?.contact_phone);
  const mobile = s(cust?.contact_mobile);
  const phones = [phone, mobile].filter((v, i, a) => v && a.indexOf(v) === i).join(', ');
  return {
    customer_phone: phone, customer_mobile: mobile, customer_phones: phones, customer_contact_name: s(cust?.contact_name),
    customer_address3: phones ? `โทร. ${phones}` : '', customer_address3_en: phones ? `Tel. ${phones}` : '',
  };
};

const customerFields = (cust, snapshot) => {
  // ขายเงินสด: ระบุชื่อผู้ซื้อในเอกสาร = ใช้ชื่อ ที่อยู่ เลขผู้เสียภาษี สาขาของผู้ซื้อทั้งชุดแทนลูกค้าเงินสด
  // (กฎเดียวกับรายงานภาษีขาย — ช่องที่ว่างพิมพ์ว่าง ไม่ใช้ข้อมูลของลูกค้าเงินสด)
  if (s(snapshot.bill_to_name)) {
    const [line1, ...rest] = s(snapshot.bill_to_address).split(/\r?\n/);
    const code = s(snapshot.bill_to_branch);
    const taxId = s(snapshot.bill_to_tax_id);
    return {
      customer_code: s(snapshot.customer_code) || s(cust?.customer_code),
      customer_name: s(snapshot.bill_to_name), customer_name_en: s(snapshot.bill_to_name),
      customer_address: s(snapshot.bill_to_address).replace(/\s*\r?\n\s*/g, ' '),
      customer_address1: s(line1), customer_address2: rest.map(s).filter(Boolean).join(' '),
      ...customerPhones(null),
      customer_tax_id: taxId, customer_branch_code: code,
      customer_branch_label: taxBranchTh(code), customer_branch_label_en: taxBranchEn(code),
      customer_tax_id_branch: [taxId, taxBranchTh(code)].filter(Boolean).join(' '),
      customer_tax_id_branch_en: [taxId, taxBranchEn(code)].filter(Boolean).join(' '),
    };
  }
  const addr = thaiAddress(cust?.addr);
  const code = s(cust?.tax_branch_code);
  const taxId = s(cust?.tax_id);
  return {
    customer_code: s(snapshot.customer_code) || s(cust?.customer_code),
    customer_name: s(snapshot.customer_name_th) || s(cust?.customer_name_th),
    customer_name_en: s(cust?.customer_name_en) || s(snapshot.customer_name_th) || s(cust?.customer_name_th),
    customer_address: addr.full, customer_address1: addr.line1, customer_address2: addr.line2,
    ...customerPhones(cust),
    customer_tax_id: taxId, customer_branch_code: code,
    customer_branch_label: taxBranchTh(code), customer_branch_label_en: taxBranchEn(code),
    customer_tax_id_branch: [taxId, taxBranchTh(code)].filter(Boolean).join(' '),
    customer_tax_id_branch_en: [taxId, taxBranchEn(code)].filter(Boolean).join(' '),
  };
};

// ผู้อนุมัติ (doc_approval ที่อนุมัติแล้ว เรียงตามลำดับ) — Map(record_id → { codes, names, date })
const userDisplayName = (u) => [s(u.first_name), s(u.last_name)].filter(x => x && x !== '.').join(' ') || s(u.user_name);
const loadApprovers = async (db, kind, ids) => {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const ok = (await db.query(`SELECT to_regclass('doc_approval') IS NOT NULL AS ok`)).rows[0].ok;
  if (!ok) return new Map();
  const rows = (await db.query(`
      SELECT a.record_id, a.approver_user_name, to_char(a.approved_at, 'YYYY-MM-DD') AS approved_date,
             u.user_name, u.first_name, u.last_name
        FROM doc_approval a LEFT JOIN sa_user u ON u.id = a.approver_user_id
       WHERE a.doc_kind = $1 AND a.record_id = ANY($2::int[]) AND a.status = 'Approved'
       ORDER BY a.record_id, a.sequence_no, a.id`, [kind, list])).rows;
  const out = new Map();
  for (const r of rows) {
    const o = out.get(r.record_id) || { codes: [], names: [], date: '' };
    o.codes.push(s(r.user_name) || s(r.approver_user_name));
    o.names.push(r.user_name ? userDisplayName(r) : s(r.approver_user_name));
    if (r.approved_date && r.approved_date > o.date) o.date = r.approved_date;
    out.set(r.record_id, o);
  }
  return out;
};
const approverFields = (a, prefix) => ({
  [`${prefix}approver_code`]: a ? a.codes.join(', ') : '',
  [`${prefix}approver_name`]: a ? a.names.join(', ') : '',
  [`${prefix}approve_date`]: a?.date || '',
});

// ชื่อสกุลเงิน ไทย/อังกฤษ
const loadCurrencies = async (db, codes) => {
  const list = [...new Set(codes.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = (await db.query(`SELECT currency_code, currency_name_th, currency_name_en FROM cd_currency WHERE currency_code = ANY($1::text[])`, [list])).rows;
  return new Map(rows.map(r => [r.currency_code, r]));
};
// สกุลเงินหลักของระบบ (utils/baseCurrency.js)
const loadBaseCurrency = async (db) => (await getBaseCurrency(db)).code;
const currencyFields = (map, code) => {
  const c = map.get(s(code)) || {};
  return { currency_name: s(c.currency_name_th), currency_name_en: s(c.currency_name_en) || s(c.currency_name_th) };
};

// รายชื่อพนักงานขายต่อเอกสาร (ตามลำดับพิมพ์) — table ไม่มี = ว่าง
const loadSalespersonNames = async (db, table, ids) => {
  const ok = (await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table])).rows[0].ok;
  if (!ok || !ids.length) return new Map();
  const rows = (await db.query(`
      SELECT x.header_id,
             string_agg(sp.salesperson_name_thai, ', ' ORDER BY x.line_no, x.id) AS th,
             string_agg(COALESCE(NULLIF(sp.salesperson_name_eng, ''), sp.salesperson_name_thai), ', ' ORDER BY x.line_no, x.id) AS en,
             string_agg(sp.salesperson_code, ', ' ORDER BY x.line_no, x.id) AS codes
        FROM ${table} x JOIN cd_salesperson sp ON sp.id = x.salesperson_id
       WHERE x.header_id = ANY($1::int[]) GROUP BY x.header_id`, [ids])).rows;
  return new Map(rows.map(r => [r.header_id, r]));
};

// จำนวนเงินตัวอักษร — บาทใช้คำอ่านภาษาไทย (บาทถ้วน) สกุลอื่นใช้คำอ่านภาษาอังกฤษพร้อมรหัสสกุลเงิน
const amountWords = (amount, currency) => (currency === 'THB' ? bahtText(amount) : englishAmountText(amount, currency));

// ยอดรวม + จำนวนเงินตัวอักษร — t = ยอดตามสกุลเงินเอกสาร, lc = ยอดสกุลเงินหลัก (ใบกำกับภาษีเงินตราต่างประเทศ
// ต้องแสดงมูลค่า/ภาษีเป็นเงินบาทด้วย — เอกสารสกุลเงินหลัก lc = t)
const totalsFields = (t, currency, base, lc) => ({
  subtotal: round2(t.subtotal), discount_amount: round2(t.discount), before_vat: round2(t.beforeVat),
  vat_rate: t.vatRate, vat_amount: round2(t.vat), total_amount: round2(t.total), total_qty: t.qty,
  amount_text: amountWords(t.total, currency),
  amount_text_en: englishAmountText(t.total, currency),
  base_currency_code: base,
  subtotal_lc: round2(lc.subtotal), discount_amount_lc: round2(lc.discount), before_vat_lc: round2(lc.beforeVat),
  vat_amount_lc: round2(lc.vat), total_amount_lc: round2(lc.total),
  amount_text_lc: amountWords(lc.total, base),
  amount_text_lc_en: englishAmountText(lc.total, base),
});

// เงินมัดจำที่หักในใบกำกับ (AR ใบแจ้งหนี้: ar_transaction_apply 'inv_advance', IM ใบส่งสินค้า: im_transaction_advance)
// ตามแนวปฏิบัติใบกำกับภาษีหักมัดจำ: มูลค่าก่อนภาษีลดลงด้วยส่วนก่อน VAT ของมัดจำ และ VAT ลดลงด้วย VAT ของมัดจำ
// (ออกใบกำกับไปแล้วตอนรับมัดจำ) แยกส่วนตามสัดส่วน VAT ของใบมัดจำ — สกุลเงินหลักคิดที่อัตราของใบมัดจำ ตรงกับรายงานภาษีขาย
// ไม่มีมัดจำ = ยอดหลังหักมัดจำเท่ากับยอดเดิม จึงวางฟิลด์ "หลังหักมัดจำ" ในแบบฟอร์มได้เสมอ
const loadDeposits = async (db, sql, ids) => {
  if (!ids.length) return new Map();
  const rows = await db.query(sql, [ids]).then(r => r.rows).catch(e => { if (e.code === '42P01') return []; throw e; });
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.hid)) m.set(r.hid, []);
    m.get(r.hid).push(r);
  }
  return m;
};
const DEPOSIT_COLS = `dep.doc_no, ${ymdSql('dep.doc_date')} AS doc_date, dep.exchange_rate::float AS rate,
       (dep.vat_amount_lc - (SELECT COALESCE(SUM(dt.vat_amount_lc), 0) FROM ar_transaction_detail dt
          WHERE dt.header_id = dep.id AND dt.is_deferred_vat = TRUE AND dt.vat_type <> 'NOVAT'))::float AS vat_lc, -- VAT รอตัดยังไม่เคยเสีย = มัดจำไม่มี VAT
       dep.total_amount_lc::float AS total_lc`;
// มัดจำที่มี VAT: ภาษีนำส่งไปแล้วตอนรับมัดจำ → หักจากฐานภาษี (มูลค่าก่อนภาษีและ VAT ลดลง)
// มัดจำที่ไม่มี VAT: ยังไม่เคยเสียภาษี → ใบกำกับคิด VAT เต็ม แล้วหักมัดจำจากยอดรวมหลัง VAT
// (ตรงกับการลงบัญชี: depositParts ใช้สัดส่วน VAT ของใบมัดจำ — ไม่มี VAT = หักลูกหนี้ด้วยยอดเต็ม ไม่คืนภาษีขาย)
const depositFields = (deps, t, lc, currency, base) => {
  let fc = 0, vatFc = 0, legLc = 0, vatLc = 0, vatDepFc = 0, vatDepLc = 0;
  for (const d of deps || []) {
    const amt = num(d.fc);
    const ratio = num(d.total_lc) ? num(d.vat_lc) / num(d.total_lc) : 0;
    const leg = round2(amt * (num(d.rate) || 1));
    fc += amt; vatFc += round2(amt * ratio); legLc += leg; vatLc += round2(leg * ratio);
    if (ratio) { vatDepFc += amt; vatDepLc += leg; }
  }
  const netFc = round2(vatDepFc - vatFc), netLc = round2(vatDepLc - vatLc);          // มัดจำที่มี VAT ส่วนก่อนภาษี
  const noVatFc = round2(fc - vatDepFc), noVatLc = round2(legLc - vatDepLc);         // มัดจำที่ไม่มี VAT (หักหลังภาษี)
  const beforeVat = round2(t.beforeVat - netFc), vat = round2(t.vat - vatFc);
  const beforeVatLc = round2(lc.beforeVat - netLc), vatLcAfter = round2(lc.vat - vatLc);
  const subtotal = round2(beforeVat + vat), subtotalLc = round2(beforeVatLc + vatLcAfter);
  const total = round2(subtotal - noVatFc), totalLc = round2(subtotalLc - noVatLc);
  const sorted = [...(deps || [])].sort((a, b) => s(a.doc_date).localeCompare(s(b.doc_date)));
  return {
    deposit_doc_nos: sorted.map(d => s(d.doc_no)).join(', '),
    deposit_doc_date: sorted.length ? sorted[sorted.length - 1].doc_date : '',
    deposit_amount: netFc, deposit_vat_amount: round2(vatFc), deposit_total: round2(fc),
    deposit_no_vat_amount: noVatFc, total_before_no_vat_deposit: subtotal,
    before_vat_after_deposit: beforeVat, vat_after_deposit: vat, total_after_deposit: total,
    amount_text_after_deposit: amountWords(total, currency),
    amount_text_after_deposit_en: englishAmountText(total, currency),
    deposit_amount_lc: netLc, deposit_vat_amount_lc: round2(vatLc),
    deposit_no_vat_amount_lc: noVatLc, total_before_no_vat_deposit_lc: subtotalLc,
    before_vat_after_deposit_lc: beforeVatLc, vat_after_deposit_lc: vatLcAfter, total_after_deposit_lc: totalLc,
    amount_text_after_deposit_lc: amountWords(totalLc, base),
  };
};

// ขายเงินสด ('33') — วิธีรับชำระ (สกุลเงินเอกสาร) ภาษีถูกหัก ณ ที่จ่าย เงินที่รับมา/เงินทอน และใบเสร็จที่สร้างตอน Post
// ใบแจ้งหนี้ AR ที่สร้างจากขายเงินสดพิมพ์ข้อมูลเดียวกันจากเอกสาร IM ต้นทาง เอกสารอื่นได้ค่าว่าง/0
// เครื่องหมาย (cash_mark ฯลฯ) ใช้ 'X' สำหรับช่องติ๊กในแบบฟอร์มพิมพ์สำเร็จ — ฟอนต์ THSarabun ไม่มีเครื่องหมาย ✓
const PAYMENT_FIELDS = [
  f('receipt_no', 'เลขที่ใบเสร็จรับเงิน', 'Receipt no.', 'payment'),
  f('receipt_date', 'วันที่ใบเสร็จรับเงิน', 'Receipt date', 'payment', 'date'),
  f('payment_methods', 'วิธีรับชำระ (ชื่อ + จำนวนเงิน)', 'Payment methods (name + amount)', 'payment'),
  f('payment_methods_en', 'วิธีรับชำระ (อังกฤษ)', 'Payment methods (EN)', 'payment'),
  f('paid_amount', 'ยอดรับชำระรวม', 'Total paid', 'payment', 'money'),
  f('cash_amount', 'รับเป็นเงินสด', 'Paid in cash', 'payment', 'money'),
  f('check_amount', 'รับเป็นเช็ค', 'Paid by cheque', 'payment', 'money'),
  f('transfer_amount', 'รับเป็นเงินโอน', 'Paid by transfer', 'payment', 'money'),
  f('qr_amount', 'รับผ่าน QR/พร้อมเพย์', 'Paid by QR/PromptPay', 'payment', 'money'),
  f('card_amount', 'รับเป็นบัตรเครดิต/เดบิต', 'Paid by card', 'payment', 'money'),
  f('other_amount', 'รับชำระวิธีอื่น', 'Paid by other methods', 'payment', 'money'),
  f('cash_mark', 'เครื่องหมาย X เงินสด', 'X mark: cash', 'payment'),
  f('check_mark', 'เครื่องหมาย X เช็ค', 'X mark: cheque', 'payment'),
  f('transfer_mark', 'เครื่องหมาย X เงินโอน/QR', 'X mark: transfer/QR', 'payment'),
  f('card_mark', 'เครื่องหมาย X บัตร', 'X mark: card', 'payment'),
  f('check_details', 'รายละเอียดเช็ค (เลขที่ ธนาคาร สาขา)', 'Cheque details (no., bank, branch)', 'payment'),
  f('check_details_en', 'รายละเอียดเช็ค (อังกฤษ)', 'Cheque details (EN)', 'payment'),
  f('payment_refs', 'เลขที่อ้างอิงการชำระ', 'Payment reference nos.', 'payment'),
  f('card_details', 'บัตร (ประเภท + 4 หลักท้าย)', 'Card (type + last 4 digits)', 'payment'),
  f('wht_amount', 'ภาษีที่ลูกค้าหัก ณ ที่จ่าย', 'Withholding tax deducted', 'payment', 'money'),
  f('wht_certificate_nos', 'เลขที่หนังสือรับรองการหักภาษี', 'WHT certificate nos.', 'payment'),
  f('cash_received', 'รับเงินมา', 'Cash received', 'payment', 'money'),
  f('change_amount', 'เงินทอน', 'Change', 'payment', 'money'),
];
const PAY_TYPE_TH = { CASH: 'เงินสด', CHECK: 'เช็ค', TRANSFER: 'เงินโอน', MOBILE_BANKING: 'เงินโอน', QR_CODE: 'QR/พร้อมเพย์',
  CREDIT_CARD: 'บัตรเครดิต', DEBIT_CARD: 'บัตรเดบิต', BILL_OF_EXCHANGE: 'ตั๋วแลกเงิน', OTHER: 'อื่นๆ' };
const PAY_TYPE_EN = { CASH: 'Cash', CHECK: 'Cheque', TRANSFER: 'Transfer', MOBILE_BANKING: 'Transfer', QR_CODE: 'QR/PromptPay',
  CREDIT_CARD: 'Credit card', DEBIT_CARD: 'Debit card', BILL_OF_EXCHANGE: 'Bill of exchange', OTHER: 'Other' };
const money2 = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// p = { pays, whts, rate, cash_received, change_amount, receipt_no, receipt_date } หรือ undefined
const paymentFields = (p) => {
  const pays = p?.pays || [];
  const sumOf = (types) => round2(pays.filter(x => types.includes(x.payment_method_type)).reduce((t, x) => t + num(x.amount_fc), 0));
  const label = (x, map) => `${map[x.payment_method_type] || s(x.payment_method_name)} ${money2(num(x.amount_fc))}`;
  const checks = pays.filter(x => x.payment_method_type === 'CHECK');
  const checkText = (no, bank, br) => checks.map(x => [s(x.ref_no) && `${no} ${s(x.ref_no)}`, s(x.drawer_bank_name) && `${bank} ${s(x.drawer_bank_name)}`,
    s(x.drawer_bank_branch) && `${br} ${s(x.drawer_bank_branch)}`].filter(Boolean).join(' ')).filter(Boolean).join(', ');
  const cash = sumOf(['CASH']), check = sumOf(['CHECK']), transfer = sumOf(['TRANSFER', 'MOBILE_BANKING']), qr = sumOf(['QR_CODE']);
  const card = sumOf(['CREDIT_CARD', 'DEBIT_CARD']), other = sumOf(['BILL_OF_EXCHANGE', 'OTHER']);
  const whts = p?.whts || [];
  const rate = num(p?.rate) || 1;
  return {
    receipt_no: s(p?.receipt_no), receipt_date: p?.receipt_date || '',
    payment_methods: pays.map(x => label(x, PAY_TYPE_TH)).join(', '),
    payment_methods_en: pays.map(x => label(x, PAY_TYPE_EN)).join(', '),
    paid_amount: round2(cash + check + transfer + qr + card + other),
    cash_amount: cash, check_amount: check, transfer_amount: transfer, qr_amount: qr, card_amount: card, other_amount: other,
    cash_mark: cash ? 'X' : '', check_mark: check ? 'X' : '', transfer_mark: transfer || qr ? 'X' : '', card_mark: card ? 'X' : '',
    check_details: checkText('เลขที่', 'ธนาคาร', 'สาขา'), check_details_en: checkText('No.', 'Bank', 'Branch'),
    payment_refs: pays.map(x => s(x.ref_no)).filter(Boolean).join(', '),
    card_details: pays.filter(x => ['CREDIT_CARD', 'DEBIT_CARD'].includes(x.payment_method_type))
      .map(x => [s(x.card_type), s(x.card_last4) && `xxxx${s(x.card_last4)}`].filter(Boolean).join(' ')).filter(Boolean).join(', '),
    wht_amount: round2(whts.reduce((t, w) => t + num(w.wht_amount_lc), 0) / rate),
    wht_certificate_nos: whts.map(w => s(w.certificate_no)).filter(Boolean).join(', '),
    cash_received: round2(num(p?.cash_received)), change_amount: round2(num(p?.change_amount)),
  };
};
// ข้อมูลรับชำระของเอกสาร IM (ขายเงินสด) — Map(im_id → p) ตาราง/คอลัมน์ยังไม่มี = ว่าง
const loadCashSalePayments = async (db, imIds) => {
  const ids = [...new Set(imIds.filter(Boolean))];
  const out = new Map();
  if (!ids.length || !(await db.query(`SELECT to_regclass('im_transaction_payment') IS NOT NULL AS ok`)).rows[0].ok) return out;
  const heads = (await db.query(`
      SELECT t.id, t.exchange_rate::float AS rate, to_jsonb(t)->>'cash_received' AS cash_received, to_jsonb(t)->>'change_amount' AS change_amount,
             rc.doc_no AS receipt_no, ${ymdSql('rc.doc_date')} AS receipt_date
        FROM im_transaction t
        LEFT JOIN ar_transaction rc ON rc.id = (to_jsonb(t)->>'linked_ar_receipt_id')::int AND rc.status = 'Posted'
       WHERE t.id = ANY($1::int[])`, [ids])).rows;
  const pays = (await db.query(`SELECT * FROM im_transaction_payment WHERE header_id = ANY($1::int[]) ORDER BY header_id, line_no, id`, [ids])).rows;
  const whts = (await db.query(`SELECT * FROM im_transaction_wht WHERE header_id = ANY($1::int[]) ORDER BY header_id, line_no, id`, [ids])).rows;
  for (const h of heads) {
    out.set(h.id, { ...h, pays: pays.filter(x => x.header_id === h.id), whts: whts.filter(x => x.header_id === h.id) });
  }
  return out;
};

// อัตรา VAT ที่พิมพ์หัวเอกสาร — อัตราสูงสุดของรายการที่มี VAT (ปกติทุกรายการอัตราเดียวกัน)
const headerVatRate = (lines) => lines.reduce((m, l) => Math.max(m, l.vat_amount ? num(l.vat_rate) : 0), 0);

// ── ใบส่งสินค้า/ใบกำกับภาษี: IM 30/31/32 + AR ใบแจ้งหนี้ 10 ───────────────────────
const SALES_INVOICE = {
  key: 'SALES_INVOICE',
  name_th: 'ใบส่งสินค้า/ใบกำกับภาษี',
  name_en: 'Delivery Note / Tax Invoice',
  // module = รหัสใน key, sys_module ตาม sa_module_document
  docTypes: [
    { module: 'IM', sys_module: '31', sys_doc_types: ['30', '31', '32', '33'] },
    { module: 'AR', sys_module: '11', sys_doc_types: ['10'] },
  ],
  fields: [
    ...COMPANY_FIELDS,
    f('customer_code', 'รหัสลูกค้า', 'Customer code', 'customer'),
    f('customer_name', 'ชื่อลูกค้า', 'Customer name', 'customer'),
    f('customer_name_en', 'ชื่อลูกค้า (อังกฤษ)', 'Customer name (EN)', 'customer'),
    f('customer_address', 'ที่อยู่ลูกค้า', 'Customer address', 'customer'),
    f('customer_address1', 'ที่อยู่ลูกค้า บรรทัด 1', 'Customer address line 1', 'customer'),
    f('customer_address2', 'ที่อยู่ลูกค้า บรรทัด 2', 'Customer address line 2', 'customer'),
    f('customer_address3', 'ที่อยู่ลูกค้า บรรทัด 3 (โทร. โทรศัพท์, มือถือ)', 'Customer address line 3 (Tel.)', 'customer'),
    f('customer_address3_en', 'ที่อยู่ลูกค้า บรรทัด 3 (Tel.) อังกฤษ', 'Customer address line 3 (Tel., EN)', 'customer'),
    f('customer_phone', 'โทรศัพท์ลูกค้า', 'Customer phone', 'customer'),
    f('customer_mobile', 'มือถือลูกค้า', 'Customer mobile', 'customer'),
    f('customer_phones', 'โทรศัพท์ + มือถือลูกค้า', 'Customer phone + mobile', 'customer'),
    f('customer_contact_name', 'ชื่อผู้ติดต่อ (ลูกค้า)', 'Customer contact name', 'customer'),
    f('customer_tax_id', 'เลขประจำตัวผู้เสียภาษีลูกค้า', 'Customer tax ID', 'customer'),
    f('customer_branch_code', 'รหัสสาขาภาษีลูกค้า (5 หลัก)', 'Customer tax branch no.', 'customer'),
    f('customer_branch_label', 'สำนักงานใหญ่/สาขาที่ xxxxx (ลูกค้า)', 'Head office/Branch xxxxx (customer)', 'customer'),
    f('customer_branch_label_en', 'สำนักงานใหญ่/สาขาที่ (ลูกค้า) อังกฤษ', 'Head office/Branch (customer, EN)', 'customer'),
    f('customer_tax_id_branch', 'เลขผู้เสียภาษี + สาขา (ลูกค้า)', 'Tax ID + branch (customer)', 'customer'),
    f('customer_tax_id_branch_en', 'เลขผู้เสียภาษี + สาขา (ลูกค้า) อังกฤษ', 'Tax ID + branch (customer, EN)', 'customer'),
    f('doc_no', 'เลขที่เอกสาร', 'Document no.', 'document'),
    f('doc_date', 'วันที่เอกสาร', 'Document date', 'document', 'date'),
    f('due_date', 'วันครบกำหนด', 'Due date', 'document', 'date'),
    f('credit_term', 'เงื่อนไขการชำระ (เครดิต x วัน)', 'Credit term', 'document'),
    f('credit_term_en', 'เงื่อนไขการชำระ (อังกฤษ)', 'Credit term (EN)', 'document'),
    f('credit_days', 'จำนวนวันเครดิต', 'Credit days', 'document', 'number'),
    f('doc_type_code', 'รหัสประเภทเอกสาร', 'Doc type code', 'document'),
    f('doc_type_name', 'ชื่อประเภทเอกสาร', 'Doc type name', 'document'),
    f('doc_type_name_en', 'ชื่อประเภทเอกสาร (อังกฤษ)', 'Doc type name (EN)', 'document'),
    f('ref_no', 'เลขที่อ้างอิง', 'Reference no.', 'document'),
    f('ref_doc_no', 'เลขที่เอกสารอ้างอิง', 'Ref. document no.', 'document'),
    f('ref_doc_date', 'วันที่เอกสารอ้างอิง', 'Ref. document date', 'document', 'date'),
    f('so_doc_no', 'เลขที่ใบสั่งขาย', 'Sales order no.', 'document'),
    f('so_doc_date', 'วันที่ใบสั่งขาย', 'Sales order date', 'document', 'date'),
    f('customer_po_no', 'เลขที่ใบสั่งซื้อลูกค้า', 'Customer PO no.', 'document'),
    f('customer_po_date', 'วันที่ใบสั่งซื้อลูกค้า', 'Customer PO date', 'document', 'date'),
    f('linked_doc_no', 'เลขที่ใบแจ้งหนี้/ใบส่งสินค้าที่เชื่อมกัน', 'Linked invoice / delivery no.', 'document'),
    f('linked_doc_date', 'วันที่ใบแจ้งหนี้/ใบส่งสินค้าที่เชื่อมกัน', 'Linked invoice / delivery date', 'document', 'date'),
    f('approver_code', 'รหัสผู้อนุมัติ (เอกสารนี้)', 'Approver code (this document)', 'document'),
    f('approver_name', 'ชื่อผู้อนุมัติ (เอกสารนี้)', 'Approver name (this document)', 'document'),
    f('approve_date', 'วันที่อนุมัติ (เอกสารนี้)', 'Approval date (this document)', 'document', 'date'),
    f('so_approver_code', 'รหัสผู้อนุมัติใบสั่งขาย', 'Sales order approver code', 'document'),
    f('so_approver_name', 'ชื่อผู้อนุมัติใบสั่งขาย', 'Sales order approver name', 'document'),
    f('so_approve_date', 'วันที่อนุมัติใบสั่งขาย', 'Sales order approval date', 'document', 'date'),
    f('description', 'หมายเหตุ', 'Remark', 'document'),
    f('salespersons', 'พนักงานขาย', 'Salespersons', 'document'),
    f('salespersons_en', 'พนักงานขาย (อังกฤษ)', 'Salespersons (EN)', 'document'),
    f('salesperson_codes', 'รหัสพนักงานขาย', 'Salesperson codes', 'document'),
    f('warehouse_name', 'คลังสินค้า', 'Warehouse', 'document'),
    f('warehouse_name_en', 'คลังสินค้า (อังกฤษ)', 'Warehouse (EN)', 'document'),
    f('currency_code', 'สกุลเงิน', 'Currency', 'document'),
    f('currency_name', 'ชื่อสกุลเงิน', 'Currency name', 'document'),
    f('currency_name_en', 'ชื่อสกุลเงิน (อังกฤษ)', 'Currency name (EN)', 'document'),
    f('exchange_rate', 'อัตราแลกเปลี่ยน', 'Exchange rate', 'document', 'number'),
    f('subtotal', 'รวมเงิน', 'Subtotal', 'total', 'money'),
    f('discount_amount', 'ส่วนลด', 'Discount', 'total', 'money'),
    f('before_vat', 'มูลค่าก่อนภาษี', 'Amount before VAT', 'total', 'money'),
    f('vat_rate', 'อัตราภาษี (%)', 'VAT rate (%)', 'total', 'number'),
    f('vat_amount', 'ภาษีมูลค่าเพิ่ม', 'VAT amount', 'total', 'money'),
    f('total_amount', 'จำนวนเงินรวมทั้งสิ้น', 'Grand total', 'total', 'money'),
    f('total_qty', 'จำนวนรวม', 'Total quantity', 'total', 'qty'),
    f('amount_text', 'จำนวนเงินตัวอักษร (บาทถ้วน)', 'Amount in words (Thai)', 'total'),
    f('amount_text_en', 'จำนวนเงินตัวอักษร (อังกฤษ)', 'Amount in words (EN)', 'total'),
    f('base_currency_code', 'สกุลเงินหลัก', 'Base currency', 'total'),
    f('subtotal_lc', 'รวมเงิน (สกุลเงินหลัก)', 'Subtotal (base currency)', 'total', 'money'),
    f('discount_amount_lc', 'ส่วนลด (สกุลเงินหลัก)', 'Discount (base currency)', 'total', 'money'),
    f('before_vat_lc', 'มูลค่าก่อนภาษี (สกุลเงินหลัก)', 'Amount before VAT (base currency)', 'total', 'money'),
    f('vat_amount_lc', 'ภาษีมูลค่าเพิ่ม (สกุลเงินหลัก)', 'VAT amount (base currency)', 'total', 'money'),
    f('total_amount_lc', 'จำนวนเงินรวมทั้งสิ้น (สกุลเงินหลัก)', 'Grand total (base currency)', 'total', 'money'),
    f('amount_text_lc', 'จำนวนเงินตัวอักษร (สกุลเงินหลัก)', 'Amount in words (base currency)', 'total'),
    f('amount_text_lc_en', 'จำนวนเงินตัวอักษร (สกุลเงินหลัก อังกฤษ)', 'Amount in words (base currency, EN)', 'total'),
    f('line_count', 'จำนวนรายการ', 'Line count', 'total', 'number'),
    f('bill_discount_percent', 'ส่วนลดท้ายบิล %', 'Bill discount %', 'total', 'number'),
    f('bill_discount_amount', 'ส่วนลดท้ายบิล (จาก %)', 'Bill discount (from %)', 'total', 'money'),
    f('cash_discount_amount', 'ส่วนลดเงินสดท้ายบิล', 'Cash discount', 'total', 'money'),
    f('line_discount_total', 'ส่วนลดรายการรวม (ก่อนส่วนลดท้ายบิล)', 'Line discounts total (before bill discounts)', 'total', 'money'),
    f('deposit_doc_nos', 'เลขที่ใบรับเงินมัดจำที่หัก', 'Deducted deposit receipt no.', 'deposit'),
    f('deposit_doc_date', 'วันที่ใบรับเงินมัดจำที่หัก (ใบล่าสุด)', 'Deducted deposit receipt date (latest)', 'deposit', 'date'),
    f('deposit_amount', 'หักเงินมัดจำที่มี VAT (ก่อนภาษี)', 'Less VAT-bearing deposit (before VAT)', 'deposit', 'money'),
    f('deposit_vat_amount', 'ภาษีของเงินมัดจำที่หัก', 'VAT of deducted deposit', 'deposit', 'money'),
    f('deposit_total', 'หักเงินมัดจำทั้งหมด (รวมภาษี)', 'Less all deposits (incl. VAT)', 'deposit', 'money'),
    f('total_before_no_vat_deposit', 'รวมเงินก่อนหักมัดจำที่ไม่มี VAT', 'Total before non-VAT deposit', 'deposit', 'money'),
    f('deposit_no_vat_amount', 'หักเงินมัดจำที่ไม่มี VAT (หักหลังภาษี)', 'Less non-VAT deposit (after VAT)', 'deposit', 'money'),
    f('before_vat_after_deposit', 'มูลค่าก่อนภาษีหลังหักมัดจำ', 'Amount before VAT after deposit', 'deposit', 'money'),
    f('vat_after_deposit', 'ภาษีมูลค่าเพิ่มหลังหักมัดจำ', 'VAT after deposit', 'deposit', 'money'),
    f('total_after_deposit', 'จำนวนเงินรวมทั้งสิ้นหลังหักมัดจำ', 'Grand total after deposit', 'deposit', 'money'),
    f('amount_text_after_deposit', 'จำนวนเงินตัวอักษรหลังหักมัดจำ', 'Amount in words after deposit (Thai)', 'deposit'),
    f('amount_text_after_deposit_en', 'จำนวนเงินตัวอักษรหลังหักมัดจำ (อังกฤษ)', 'Amount in words after deposit (EN)', 'deposit'),
    f('deposit_amount_lc', 'หักเงินมัดจำก่อนภาษี (สกุลเงินหลัก)', 'Less deposit before VAT (base currency)', 'deposit', 'money'),
    f('deposit_vat_amount_lc', 'ภาษีของเงินมัดจำ (สกุลเงินหลัก)', 'VAT of deposit (base currency)', 'deposit', 'money'),
    f('total_before_no_vat_deposit_lc', 'รวมเงินก่อนหักมัดจำที่ไม่มี VAT (สกุลเงินหลัก)', 'Total before non-VAT deposit (base currency)', 'deposit', 'money'),
    f('deposit_no_vat_amount_lc', 'หักเงินมัดจำที่ไม่มี VAT (สกุลเงินหลัก)', 'Less non-VAT deposit (base currency)', 'deposit', 'money'),
    f('before_vat_after_deposit_lc', 'มูลค่าก่อนภาษีหลังหักมัดจำ (สกุลเงินหลัก)', 'Amount before VAT after deposit (base currency)', 'deposit', 'money'),
    f('vat_after_deposit_lc', 'ภาษีหลังหักมัดจำ (สกุลเงินหลัก)', 'VAT after deposit (base currency)', 'deposit', 'money'),
    f('total_after_deposit_lc', 'รวมทั้งสิ้นหลังหักมัดจำ (สกุลเงินหลัก)', 'Grand total after deposit (base currency)', 'deposit', 'money'),
    f('amount_text_after_deposit_lc', 'จำนวนเงินตัวอักษรหลังหักมัดจำ (สกุลเงินหลัก)', 'Amount in words after deposit (base currency)', 'deposit'),
    ...PAYMENT_FIELDS,
    ...PRINT_FIELDS,
    f('line_no', 'ลำดับ', 'No.', 'line', 'number', 'L'),
    f('item_code', 'รหัสสินค้า', 'Item code', 'line', 'text', 'L'),
    f('item_name', 'ชื่อสินค้า', 'Item name', 'line', 'text', 'L'),
    f('item_name_en', 'ชื่อสินค้า (อังกฤษ)', 'Item name (EN)', 'line', 'text', 'L'),
    f('description', 'รายละเอียด', 'Description', 'line', 'text', 'L'),
    f('item_desc', 'ชื่อสินค้า + รายละเอียด', 'Item name + description', 'line', 'text', 'L'),
    f('item_desc_en', 'ชื่อสินค้า (อังกฤษ) + รายละเอียด', 'Item name (EN) + description', 'line', 'text', 'L'),
    f('qty', 'จำนวน', 'Quantity', 'line', 'qty', 'L'),
    f('unit', 'หน่วย', 'Unit', 'line', 'text', 'L'),
    f('unit_en', 'หน่วย (อังกฤษ)', 'Unit (EN)', 'line', 'text', 'L'),
    f('unit_price', 'ราคาต่อหน่วย', 'Unit price', 'line', 'money', 'L'),
    f('discount_percent', 'ส่วนลด %', 'Discount %', 'line', 'number', 'L'),
    f('discount_amount', 'ส่วนลด', 'Discount', 'line', 'money', 'L'),
    f('discount_text', 'ส่วนลดขั้นบันได (เช่น 10+5)', 'Step discount (e.g. 10+5)', 'line', 'text', 'L'),
    f('line_discount_amount', 'ส่วนลดเงินของรายการ', 'Line discount amount', 'line', 'money', 'L'),
    f('line_own_discount', 'ส่วนลดของรายการ (ขั้นบันได + เงิน)', 'Line discount (steps + amount)', 'line', 'money', 'L'),
    f('bill_discount_share', 'ส่วนลดท้ายบิลที่ปันส่วน', 'Allocated bill discount', 'line', 'money', 'L'),
    f('amount', 'จำนวนเงิน', 'Amount', 'line', 'money', 'L'),
    f('vat_rate', 'อัตราภาษี (%)', 'VAT rate (%)', 'line', 'number', 'L'),
    f('vat_amount', 'ภาษี', 'VAT', 'line', 'money', 'L'),
    f('line_total', 'จำนวนเงินรวมภาษี', 'Amount incl. VAT', 'line', 'money', 'L'),
    f('amount_lc', 'จำนวนเงิน (สกุลเงินหลัก)', 'Amount (base currency)', 'line', 'money', 'L'),
    f('vat_amount_lc', 'ภาษี (สกุลเงินหลัก)', 'VAT (base currency)', 'line', 'money', 'L'),
    f('line_total_lc', 'จำนวนเงินรวมภาษี (สกุลเงินหลัก)', 'Amount incl. VAT (base currency)', 'line', 'money', 'L'),
    f('free_label', 'ของแถม', 'Free item', 'line', 'text', 'L'),
    f('free_label_en', 'ของแถม (อังกฤษ)', 'Free item (EN)', 'line', 'text', 'L'),
  ],

  // เอกสารที่พิมพ์ได้ (โพสต์แล้วเท่านั้น) — docIds = ประเภทเอกสารที่ผู้ใช้มีสิทธิ์และเลือกไว้
  // keys = จำกัดเฉพาะเอกสารที่ระบุ (ใช้ตรวจก่อนพิมพ์)
  listDocs: async (db, { docIds, docNoFrom, docNoTo, dateFrom, dateTo, keys }) => {
    await ensureImPriceColumns(db);
    const p = [docIds];
    const cond = (alias, module) => {
      let c = '';
      if (keys) {
        p.push(keys.filter(k => k.startsWith(module + ':')).map(k => Number(k.split(':')[1])).filter(Boolean));
        c += ` AND ${alias}.id = ANY($${p.length}::int[])`;
      }
      if (docNoFrom) { p.push(docNoFrom); c += ` AND ${alias}.doc_no >= $${p.length}`; }
      if (docNoTo) { p.push(docNoTo); c += ` AND ${alias}.doc_no <= $${p.length}`; }
      if (dateFrom) { p.push(dateFrom); c += ` AND ${alias}.doc_date >= $${p.length}::date`; }
      if (dateTo) { p.push(dateTo); c += ` AND ${alias}.doc_date <= $${p.length}::date`; }
      return c;
    };
    const c1 = cond('t', 'IM');
    const sql = `
      SELECT * FROM (
        SELECT 'IM:' || t.id AS key, 'IM' AS module, t.id, d.doc_code, t.doc_no, ${ymdSql('t.doc_date')} AS doc_date,
               t.customer_code, t.customer_name_th AS customer_name,
               (SELECT COALESCE(SUM(ROUND(ABS(x.qty) * ${netUnitPriceSql('x.unit_price', 'x', 't')}, 2)
                        + CASE WHEN COALESCE(x.vat_type, 'NOVAT') = 'NOVAT' THEN 0
                               ELSE ROUND(ROUND(ABS(x.qty) * ${netUnitPriceSql('x.unit_price', 'x', 't')}, 2) * COALESCE(x.vat_rate, 0) / 100, 2) END), 0)
                  FROM im_transaction_detail x WHERE x.header_id = t.id)::float AS total_amount,
               t.currency_code
          FROM im_transaction t JOIN sa_module_document d ON d.id = t.doc_id
         WHERE t.doc_id = ANY($1::int[]) AND t.status = 'Posted' ${c1}
        UNION ALL
        SELECT 'AR:' || t.id, 'AR', t.id, d.doc_code, t.doc_no, ${ymdSql('t.doc_date')},
               t.customer_code, t.customer_name_th, t.total_amount_fc::float, t.currency_code
          FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
         WHERE t.doc_id = ANY($1::int[]) AND t.status = 'Posted' ${cond('t', 'AR')}
      ) z ORDER BY z.doc_date, z.doc_no${keys ? '' : ' LIMIT 2000'}`;
    // currency_code ว่าง = สกุลเงินหลัก; is_base_currency ให้หน้าจอแสดงรหัสเฉพาะสกุลเงินต่างประเทศ
    const base = await loadBaseCurrency(db);
    return (await db.query(sql, p)).rows.map(r => ({
      ...r, currency_code: s(r.currency_code) || base, is_base_currency: (s(r.currency_code) || base) === base,
    }));
  },

  // ข้อมูลพิมพ์ต่อเอกสาร: Map(key → { header, lines })
  loadDocs: async (db, keys) => {
    await ensureImPriceColumns(db);
    await ensureArDiscountColumns(db);
    const ids = (m) => keys.filter(k => k.startsWith(m + ':')).map(k => Number(k.split(':')[1])).filter(Boolean);
    const imIds = ids('IM');
    const arIds = ids('AR');
    const out = new Map();

    const imHeads = imIds.length ? (await db.query(`
        SELECT t.id, t.doc_no, ${ymdSql('t.doc_date')} AS doc_date, t.ref_no, t.ref_doc_no, t.description,
               t.currency_code, t.exchange_rate::float AS exchange_rate, COALESCE(NULLIF(t.linked_ar_doc_no, ''), ar.doc_no) AS linked_ar_doc_no,
               t.customer_id, t.customer_code, t.customer_name_th, t.branch_id, t.price_includes_vat,
               COALESCE(t.bill_discount_percent, 0)::float AS bill_discount_percent, COALESCE(t.cash_discount_amount, 0)::float AS cash_discount_amount,
               d.doc_code, d.doc_name_thai, d.doc_name_eng, d.sys_doc_type,
               to_jsonb(t)->>'bill_to_name' AS bill_to_name, to_jsonb(t)->>'bill_to_address' AS bill_to_address,
               to_jsonb(t)->>'bill_to_tax_id' AS bill_to_tax_id, to_jsonb(t)->>'bill_to_branch' AS bill_to_branch,
               so.id AS so_id, so.doc_no AS so_doc_no, ${ymdSql('so.doc_date')} AS so_doc_date,
               so.approved_by AS so_approved_by, ${ymdSql('so.approved_at')} AS so_approved_at,
               to_jsonb(t)->>'customer_po_no' AS po_no, to_jsonb(t)->>'customer_po_date' AS po_date,
               to_jsonb(so)->>'customer_po_no' AS so_po_no, to_jsonb(so)->>'customer_po_date' AS so_po_date,
               ri.doc_no AS ref_im_doc_no, ${ymdSql('ri.doc_date')} AS ref_im_doc_date, ${ymdSql('ar.doc_date')} AS ar_doc_date,
               w.warehouse_name_th, w.warehouse_name_en,
               ${ymdSql('ar.due_date')} AS ar_due_date, ${ymdSql('t.doc_date + COALESCE(c.credit_term_days, 0)')} AS calc_due_date,
               c.credit_term_days
          FROM im_transaction t
          JOIN sa_module_document d ON d.id = t.doc_id
          LEFT JOIN so_transaction so ON so.id = t.ref_so_id
          LEFT JOIN im_transaction ri ON ri.id = t.ref_im_transaction_id
          LEFT JOIN im_warehouse w ON w.id = t.warehouse_id
          LEFT JOIN ar_transaction ar ON ar.id = t.linked_ar_transaction_id
          LEFT JOIN ar_customer c ON c.id = t.customer_id
         WHERE t.id = ANY($1::int[])`, [imIds])).rows : [];
    const arHeads = arIds.length ? (await db.query(`
        SELECT t.id, t.doc_no, ${ymdSql('t.doc_date')} AS doc_date, ${ymdSql('t.due_date')} AS due_date, t.ref_no, t.ref_doc_no,
               t.description, t.currency_code, t.exchange_rate::float AS exchange_rate,
               t.customer_id, t.customer_code, t.customer_name_th, t.branch_id, t.price_includes_vat,
               COALESCE(t.bill_discount_percent, 0)::float AS bill_discount_percent, COALESCE(t.cash_discount_amount, 0)::float AS cash_discount_amount,
               t.subtotal_fc::float AS subtotal_fc, t.discount_amount_fc::float AS discount_amount_fc,
               t.before_vat_fc::float AS before_vat_fc, t.vat_amount_fc::float AS vat_amount_fc, t.total_amount_fc::float AS total_amount_fc,
               t.subtotal_lc::float AS subtotal_lc, t.discount_amount_lc::float AS discount_amount_lc,
               t.before_vat_lc::float AS before_vat_lc, t.vat_amount_lc::float AS vat_amount_lc, t.total_amount_lc::float AS total_amount_lc,
               d.doc_code, d.doc_name_thai, d.doc_name_eng, c.credit_term_days,
               to_jsonb(t)->>'bill_to_name' AS bill_to_name, to_jsonb(t)->>'bill_to_address' AS bill_to_address,
               to_jsonb(t)->>'bill_to_tax_id' AS bill_to_tax_id, to_jsonb(t)->>'bill_to_branch' AS bill_to_branch,
               (t.due_date - t.doc_date) AS due_days,
               im.id AS im_id, im.doc_no AS im_doc_no, ${ymdSql('im.doc_date')} AS im_doc_date,
               to_jsonb(t)->>'customer_po_no' AS po_no, to_jsonb(t)->>'customer_po_date' AS po_date,
               to_jsonb(im)->>'customer_po_no' AS im_po_no, to_jsonb(im)->>'customer_po_date' AS im_po_date,
               to_jsonb(so)->>'customer_po_no' AS so_po_no, to_jsonb(so)->>'customer_po_date' AS so_po_date,
               so.id AS so_id, so.doc_no AS so_doc_no, ${ymdSql('so.doc_date')} AS so_doc_date,
               so.approved_by AS so_approved_by, ${ymdSql('so.approved_at')} AS so_approved_at
          FROM ar_transaction t
          JOIN sa_module_document d ON d.id = t.doc_id
          LEFT JOIN ar_customer c ON c.id = t.customer_id
          LEFT JOIN LATERAL (SELECT x.* FROM im_transaction x WHERE x.linked_ar_transaction_id = t.id ORDER BY x.id LIMIT 1) im ON TRUE
          LEFT JOIN so_transaction so ON so.id = im.ref_so_id
         WHERE t.id = ANY($1::int[])`, [arIds])).rows : [];

    const customers = await loadCustomers(db, [...imHeads, ...arHeads].map(h => h.customer_id));
    const branches = await loadBranches(db, [...imHeads, ...arHeads].map(h => h.branch_id));
    const companyTaxId = s((await db.query(`SELECT tax_id_number FROM sa_company ORDER BY is_active DESC NULLS LAST, id LIMIT 1`)).rows[0]?.tax_id_number);
    const imAppr = await loadApprovers(db, 'IM_CREDIT', imIds);
    const arAppr = await loadApprovers(db, 'AR_CREDIT', arIds);
    const allHeads = [...imHeads, ...arHeads];
    const soAppr = await loadApprovers(db, 'SO', allHeads.map(h => h.so_id));
    const legacySo = allHeads.filter(h => h.so_id && !soAppr.has(h.so_id) && s(h.so_approved_by));
    if (legacySo.length) {
      const users = new Map((await db.query(`SELECT user_name, first_name, last_name FROM sa_user WHERE user_name = ANY($1::text[])`,
        [[...new Set(legacySo.map(h => s(h.so_approved_by)))]])).rows.map(u => [u.user_name, u]));
      for (const h of legacySo) {
        const u = users.get(s(h.so_approved_by));
        soAppr.set(h.so_id, { codes: [s(h.so_approved_by)], names: [u ? userDisplayName(u) : s(h.so_approved_by)], date: h.so_approved_at || '' });
      }
    }
    // ใบสั่งซื้อลูกค้า: ใช้ของเอกสารก่อน แล้วจึงใบส่งสินค้าต้นทาง (AR) และใบสั่งขาย — เลขที่กับวันที่มาจากแหล่งเดียวกันเสมอ
    const customerPo = (h) => {
      const src = [[h.po_no, h.po_date], [h.im_po_no, h.im_po_date], [h.so_po_no, h.so_po_date]].find(([n, d]) => s(n) || d);
      return { customer_po_no: s(src?.[0]), customer_po_date: src?.[1] || '' };
    };
    const docRefFields = (h, appr) => ({
      ...customerPo(h),
      so_doc_no: s(h.so_doc_no), so_doc_date: h.so_doc_date || '',
      ...approverFields(appr, ''),
      ...approverFields(h.so_id ? soAppr.get(h.so_id) : null, 'so_'),
    });
    const base = await loadBaseCurrency(db);
    const curOf = (h) => s(h.currency_code) || base;
    const currencies = await loadCurrencies(db, [...imHeads, ...arHeads].map(curOf));
    const imSp = await loadSalespersonNames(db, 'im_transaction_salesperson', imIds);
    const imDeps = await loadDeposits(db, `
        SELECT a.header_id AS hid, a.applied_amount_fc::float AS fc, ${DEPOSIT_COLS}
          FROM im_transaction_advance a JOIN ar_transaction dep ON dep.id = a.advance_id
         WHERE a.header_id = ANY($1::int[]) AND COALESCE(a.applied_amount_fc, 0) <> 0`, imIds);
    const arDeps = await loadDeposits(db, `
        SELECT a.transaction_id AS hid, a.applied_amount_fc::float AS fc, ${DEPOSIT_COLS}
          FROM ar_transaction_apply a JOIN ar_transaction dep ON dep.id = a.applied_to_id
         WHERE a.transaction_id = ANY($1::int[]) AND a.apply_type = 'inv_advance'`, arIds);
    const arSp = await loadSalespersonNames(db, 'ar_transaction_salesperson', arIds);
    const cashPays = await loadCashSalePayments(db, [...imHeads.filter(h => h.sys_doc_type === '33').map(h => h.id), ...arHeads.map(h => h.im_id)]);

    const imLines = imIds.length ? (await db.query(`
        SELECT dt.header_id, dt.line_no, COALESCE(NULLIF(dt.item_code, ''), it.item_code) AS item_code,
               COALESCE(NULLIF(dt.item_name, ''), it.item_name_th) AS item_name, dt.description,
               ABS(dt.qty)::float AS qty, COALESCE(dt.unit_price, 0)::float AS unit_price, COALESCE(dt.discount_percent, 0)::float AS discount_percent,
               dt.discount_amount::float AS disc_amount_entered, dt.discount_text, COALESCE(dt.line_discount_amount, 0)::float AS line_discount_amount,
               COALESCE(dt.bill_discount_amount, 0)::float AS bill_discount_amount,
               COALESCE(dt.vat_type, 'NOVAT') AS vat_type, COALESCE(dt.vat_rate, 0)::float AS vat_rate, dt.is_free,
               u.uom_code, u.uom_name_th, u.uom_name_en, it.item_name_en, COALESCE(dt.is_non_stock, false) AS is_service
          FROM im_transaction_detail dt LEFT JOIN im_uom u ON u.id = dt.uom_id
          LEFT JOIN im_item it ON it.id = dt.item_id
         WHERE dt.header_id = ANY($1::int[]) ORDER BY dt.header_id, dt.line_no, dt.id`, [imIds])).rows : [];
    const arLines = arIds.length ? (await db.query(`
        SELECT dt.header_id, dt.line_no, dt.item_code, dt.item_name, dt.description, dt.quantity::float AS qty,
               dt.unit_code, u.uom_name_th, u.uom_name_en, dt.unit_price_fc::float AS unit_price,
               COALESCE(dt.discount_percent, 0)::float AS discount_percent, COALESCE(dt.discount_amount_fc, 0)::float AS discount_amount,
               dt.discount_text, COALESCE(dt.line_discount_amount, 0)::float AS line_discount_amount,
               COALESCE(dt.bill_discount_amount, 0)::float AS bill_discount_amount, dt.vat_type,
               dt.subtotal_fc::float AS amount, COALESCE(dt.vat_rate, 0)::float AS vat_rate,
               COALESCE(dt.vat_amount_fc, 0)::float AS vat_amount, dt.total_amount_fc::float AS line_total,
               COALESCE(dt.subtotal_lc, 0)::float AS amount_lc, COALESCE(dt.vat_amount_lc, 0)::float AS vat_amount_lc,
               COALESCE(dt.total_amount_lc, 0)::float AS line_total_lc,
               it.item_name_en, COALESCE(it.item_type, 'STOCK') <> 'STOCK' AS is_service
          FROM ar_transaction_detail dt
          LEFT JOIN LATERAL (SELECT x.item_name_en, x.item_type FROM im_item x WHERE x.item_code = dt.item_code AND dt.item_code <> '' LIMIT 1) it ON TRUE
          LEFT JOIN LATERAL (SELECT * FROM im_uom x WHERE x.uom_code = dt.unit_code LIMIT 1) u ON TRUE
         WHERE dt.header_id = ANY($1::int[]) ORDER BY dt.header_id, dt.line_no, dt.id`, [arIds])).rows : [];
    // ใบแจ้งหนี้ AR ที่สร้างจากใบส่งสินค้า: รายการ AR ไม่มีรหัส/ชื่อสินค้า — เติมจากรายการใบส่งสินค้าตามลำดับเดียวกัน
    const srcImIds = arHeads.map(h => h.im_id).filter(Boolean);
    const srcImLines = srcImIds.length ? (await db.query(`
        SELECT dt.header_id, COALESCE(NULLIF(dt.item_code, ''), it.item_code) AS item_code,
               COALESCE(NULLIF(dt.item_name, ''), it.item_name_th) AS item_name, it.item_name_en,
               u.uom_code, u.uom_name_th, u.uom_name_en, dt.description, COALESCE(dt.is_non_stock, false) AS is_service
          FROM im_transaction_detail dt LEFT JOIN im_uom u ON u.id = dt.uom_id
          LEFT JOIN im_item it ON it.id = dt.item_id
         WHERE dt.header_id = ANY($1::int[]) ORDER BY dt.header_id, dt.line_no, dt.id`, [srcImIds])).rows : [];
    const fillFromIm = (l, src) => (!src ? l : {
      ...l,
      item_code: s(l.item_code) || src.item_code, item_name: s(l.item_name) || src.item_name,
      item_name_en: s(l.item_name_en) || src.item_name_en,
      uom_code: src.uom_code, uom_name_th: s(l.uom_name_th) || src.uom_name_th, uom_name_en: s(l.uom_name_en) || src.uom_name_en,
      // รายการบริการของใบส่งสินค้า: หมายเหตุของรายการใบส่งสินค้าพิมพ์แทนชื่อ (ดู lineCommon)
      is_service: l.is_service || src.is_service,
      description: src.is_service && s(src.description) ? src.description : l.description,
    });

    const lineCommon = (l, i) => {
      const desc = s(l.description);
      // สินค้าบริการ/ไม่นับสต็อกที่มีหมายเหตุ: พิมพ์หมายเหตุแทนชื่อสินค้า (user request 2026-11-08) ไม่มีหมายเหตุใช้ชื่อตามเดิม
      const asRemark = l.is_service && !!desc;
      const name = asRemark ? desc : s(l.item_name);
      const nameEn = asRemark ? desc : (s(l.item_name_en) || name);
      const join = (n) => (n && desc && desc !== n && desc !== name ? `${n} ${desc}` : (n || desc));
      return {
        line_no: i + 1, item_code: s(l.item_code), item_name: name || desc, item_name_en: nameEn || desc, description: desc,
        item_desc: join(name), item_desc_en: join(nameEn),
        unit: s(l.uom_name_th) || s(l.uom_code) || s(l.unit_code), unit_en: s(l.uom_name_en) || s(l.uom_code) || s(l.unit_code),
      };
    };
    // ส่วนลดท้ายบิล: % และเงินสด (ยอดก่อน VAT) — ส่วนที่ปันเข้ารายการรวมกัน = ส่วนลดจาก % + เงินสด
    const billDiscountFields = (h, lines) => {
      // ยอดที่ปันเข้ารายการ (ก่อน VAT) แยกเป็นส่วนลดเงินสด / ส่วนลด % ตามสัดส่วนของยอดที่กรอก (ราคาไม่รวม VAT = ตรงเป๊ะ)
      const shareEx = round2(lines.reduce((t, l) => t + (l.bill_discount_share || 0), 0));
      const shareEntered = lines.reduce((t, l) => t + (l.bill_discount_entered || 0), 0);
      const cashEx = shareEntered > 0 ? round2(Math.min(h.cash_discount_amount, shareEntered) * shareEx / shareEntered) : 0;
      return {
        bill_discount_percent: h.bill_discount_percent || 0,
        bill_discount_amount: round2(shareEx - cashEx),
        cash_discount_amount: cashEx,
        line_discount_total: round2(lines.reduce((t, l) => t + (l.line_own_discount || 0), 0)),
      };
    };
    const creditFields = (days) => ({
      credit_days: days || 0,
      credit_term: days ? `เครดิต ${days} วัน` : 'เงินสด',
      credit_term_en: days ? `Credit ${days} day${days === 1 ? '' : 's'}` : 'Cash',
    });

    for (const h of imHeads) {
      const rate = curOf(h) === base ? 1 : (num(h.exchange_rate) || 1);
      const lines = imLines.filter(l => l.header_id === h.id).map((l, i) => {
        // ราคาที่กรอก (ส่วนลด/ราคารวม VAT ตามหัวเอกสาร) — พิมพ์ราคาต่อหน่วยก่อน VAT, ส่วนลดและยอดก่อน VAT
        const vr = l.vat_type === 'NOVAT' ? 0 : l.vat_rate;
        const incl = h.price_includes_vat === true && vr > 0;
        const a = calcLineAmounts({ qty: l.qty, price: l.unit_price, discountPercent: l.discount_percent, discountAmount: l.disc_amount_entered,
          vatRate: vr, priceIncludesVat: incl });
        // ส่วนลดในหน่วยก่อน VAT (ราคารวม VAT แปลงด้วยสัดส่วนเดียวกับ calcLineAmounts)
        const exVat = (v) => round2(incl ? v * 100 / (100 + vr) : v);
        const amount = a.net;
        const vat = a.vat;
        const amountLc = round2(amount * rate);
        const vatLc = incl ? round2(round2(a.total * rate) - amountLc) : round2(amountLc * vr / 100);
        return {
          ...lineCommon(l, i), qty: l.qty, unit_price: incl ? round2(l.unit_price * 100 / (100 + vr)) : l.unit_price,
          discount_percent: l.discount_percent, discount_amount: a.discount, gross_amount: a.gross,
          discount_text: s(l.discount_text), line_discount_amount: exVat(l.line_discount_amount),
          line_own_discount: round2(a.discount - exVat(l.bill_discount_amount)), bill_discount_share: exVat(l.bill_discount_amount), bill_discount_entered: l.bill_discount_amount,
          amount, vat_rate: vr, vat_amount: vat, line_total: round2(amount + vat),
          amount_lc: amountLc, vat_amount_lc: vatLc, line_total_lc: round2(amountLc + vatLc),
          free_label: l.is_free ? 'ของแถม' : '', free_label_en: l.is_free ? 'Free' : '',
        };
      });
      const sub = lines.reduce((a, l) => a + l.amount, 0);
      const gross = lines.reduce((a, l) => a + l.gross_amount, 0);
      const vat = lines.reduce((a, l) => a + l.vat_amount, 0);
      const subLc = lines.reduce((a, l) => a + l.amount_lc, 0);
      const vatLc = lines.reduce((a, l) => a + l.vat_amount_lc, 0);
      const sp = imSp.get(h.id) || {};
      // ขายเงินสด: รับเงินครบวันเดียวกัน — เงื่อนไข "เงินสด" ครบกำหนดวันที่เอกสาร
      const isCashSale = h.sys_doc_type === '33';
      const days = isCashSale ? 0 : (h.credit_term_days || 0);
      const imT = {
        subtotal: gross, discount: gross - sub, beforeVat: sub, vat, total: sub + vat, vatRate: headerVatRate(lines),
        qty: lines.reduce((a, l) => a + l.qty, 0),
      };
      const imLc = { subtotal: round2(gross * rate), discount: round2(gross * rate) - subLc, beforeVat: subLc, vat: vatLc, total: subLc + vatLc };
      out.set(`IM:${h.id}`, {
        header: {
          ...(branches.get(h.branch_id) || branches.get(0)),
          ...companyTaxFields(companyTaxId, branches.get(h.branch_id) || branches.get(0)),
          ...customerFields(customers.get(h.customer_id), h),
          doc_no: s(h.doc_no), doc_date: h.doc_date, due_date: isCashSale ? h.doc_date : (h.ar_due_date || h.calc_due_date),
          ...creditFields(days),
          doc_type_code: s(h.doc_code), doc_type_name: s(h.doc_name_thai), doc_type_name_en: s(h.doc_name_eng) || s(h.doc_name_thai),
          ref_no: s(h.ref_no),
          ref_doc_no: s(h.so_doc_no) || s(h.ref_im_doc_no) || s(h.ref_doc_no),
          ref_doc_date: h.so_doc_date || h.ref_im_doc_date || '',
          linked_doc_no: s(h.linked_ar_doc_no), linked_doc_date: h.ar_doc_date || '',
          ...docRefFields(h, imAppr.get(h.id)),
          description: s(h.description), salespersons: s(sp.th), salespersons_en: s(sp.en), salesperson_codes: s(sp.codes),
          warehouse_name: s(h.warehouse_name_th), warehouse_name_en: s(h.warehouse_name_en) || s(h.warehouse_name_th),
          ...currencyFields(currencies, curOf(h)), currency_code: curOf(h), exchange_rate: rate,
          line_count: lines.length,
          ...billDiscountFields(h, lines),
          ...totalsFields(imT, curOf(h), base, imLc),
          ...depositFields(imDeps.get(h.id), imT, imLc, curOf(h), base),
          ...paymentFields(cashPays.get(h.id)),
        },
        lines,
      });
    }

    for (const h of arHeads) {
      const srcLines = h.im_id ? srcImLines.filter(x => x.header_id === h.im_id) : [];
      // ส่วนประกอบส่วนลดเก็บในหน่วยราคาที่กรอก — ราคารวม VAT แปลงเป็นยอดก่อน VAT ตามอัตราของบรรทัด (เหมือนเอกสาร IM)
      const exVat = (l, v) => round2(h.price_includes_vat && l.vat_type !== 'NOVAT' ? v * 100 / (100 + l.vat_rate) : v);
      const lines = arLines.filter(l => l.header_id === h.id).map((l, i) => ({
        ...lineCommon(fillFromIm(l, srcLines[i]), i), qty: l.qty, unit_price: l.unit_price, discount_percent: l.discount_percent,
        discount_text: s(l.discount_text), line_discount_amount: exVat(l, l.line_discount_amount),
        line_own_discount: round2(l.discount_amount - exVat(l, l.bill_discount_amount)), bill_discount_share: exVat(l, l.bill_discount_amount),
        bill_discount_entered: l.bill_discount_amount,
        discount_amount: l.discount_amount, amount: l.amount, vat_rate: l.vat_amount ? l.vat_rate : 0,
        vat_amount: l.vat_amount, line_total: l.line_total, free_label: '', free_label_en: '',
        amount_lc: l.amount_lc, vat_amount_lc: l.vat_amount_lc, line_total_lc: l.line_total_lc,
      }));
      const sp = arSp.get(h.id) || {};
      const days = h.due_days ?? h.credit_term_days ?? 0;
      const arT = {
        subtotal: h.subtotal_fc, discount: h.discount_amount_fc, beforeVat: h.before_vat_fc, vat: h.vat_amount_fc,
        total: h.total_amount_fc, vatRate: headerVatRate(lines), qty: lines.reduce((a, l) => a + l.qty, 0),
      };
      const arLc = { subtotal: h.subtotal_lc, discount: h.discount_amount_lc, beforeVat: h.before_vat_lc, vat: h.vat_amount_lc, total: h.total_amount_lc };
      out.set(`AR:${h.id}`, {
        header: {
          ...(branches.get(h.branch_id) || branches.get(0)),
          ...companyTaxFields(companyTaxId, branches.get(h.branch_id) || branches.get(0)),
          ...customerFields(customers.get(h.customer_id), h),
          doc_no: s(h.doc_no), doc_date: h.doc_date, due_date: h.due_date, ...creditFields(days),
          doc_type_code: s(h.doc_code), doc_type_name: s(h.doc_name_thai), doc_type_name_en: s(h.doc_name_eng) || s(h.doc_name_thai),
          ref_no: s(h.ref_no),
          ref_doc_no: s(h.ref_doc_no) || s(h.im_doc_no), ref_doc_date: h.im_doc_date || '',
          linked_doc_no: s(h.im_doc_no) || s(h.ref_doc_no), linked_doc_date: h.im_doc_date || '',
          ...docRefFields(h, arAppr.get(h.id)),
          description: s(h.description), salespersons: s(sp.th), salespersons_en: s(sp.en), salesperson_codes: s(sp.codes),
          warehouse_name: '', warehouse_name_en: '',
          ...currencyFields(currencies, curOf(h)), currency_code: curOf(h), exchange_rate: h.exchange_rate || 1,
          line_count: lines.length,
          ...billDiscountFields(h, lines),
          ...totalsFields(arT, curOf(h), base, arLc),
          ...depositFields(arDeps.get(h.id), arT, arLc, curOf(h), base),
          ...paymentFields(h.im_id ? cashPays.get(h.im_id) : null),
        },
        lines,
      });
    }
    return out;
  },
};

// ── ใบสำคัญจ่าย: ซื้อเงินสด IM '14' (โพสต์แล้ว) ─────────────────────────────────────────
// ผู้ขาย = ผู้ขายจริงที่ระบุในเอกสาร (bill_to_*) ถ้ามี ไม่งั้นผู้ขายในระบบ; ยอดรวมจากใบตั้งหนี้ AP ที่สร้าง (ตรงกับบัญชี)
// วิธีจ่าย/ภาษีหัก ณ ที่จ่าย จากเอกสาร IM; ผู้อนุมัติ = คิวอนุมัติจ่าย (doc_approval 'IM_CASHPUR')
const TAX_KIND_TH = { FULL: 'ใบกำกับภาษีเต็มรูป', ABB: 'ใบกำกับภาษีอย่างย่อ', NONE: 'ไม่มีใบกำกับภาษี' };
const TAX_KIND_EN = { FULL: 'Full tax invoice', ABB: 'Abbreviated tax invoice', NONE: 'No tax invoice' };
const PAYMENT_VOUCHER = {
  key: 'PAYMENT_VOUCHER',
  name_th: 'ใบสำคัญจ่าย',
  name_en: 'Payment Voucher',
  docTypes: [{ module: 'IM', sys_module: '31', sys_doc_types: ['14'] }],
  fields: [
    ...COMPANY_FIELDS,
    f('vendor_code', 'รหัสผู้ขาย', 'Vendor code', 'vendor'),
    f('vendor_name', 'ชื่อผู้ขาย (ผู้รับเงิน)', 'Vendor name (payee)', 'vendor'),
    f('vendor_name_en', 'ชื่อผู้ขาย (อังกฤษ)', 'Vendor name (EN)', 'vendor'),
    f('vendor_address', 'ที่อยู่ผู้ขาย', 'Vendor address', 'vendor'),
    f('vendor_address1', 'ที่อยู่ผู้ขาย บรรทัด 1', 'Vendor address line 1', 'vendor'),
    f('vendor_address2', 'ที่อยู่ผู้ขาย บรรทัด 2', 'Vendor address line 2', 'vendor'),
    f('vendor_tax_id', 'เลขประจำตัวผู้เสียภาษีผู้ขาย', 'Vendor tax ID', 'vendor'),
    f('vendor_branch_label', 'สำนักงานใหญ่/สาขาที่ xxxxx (ผู้ขาย)', 'Head office/Branch xxxxx (vendor)', 'vendor'),
    f('vendor_tax_id_branch', 'เลขผู้เสียภาษี + สาขา (ผู้ขาย)', 'Tax ID + branch (vendor)', 'vendor'),
    f('doc_no', 'เลขที่เอกสาร', 'Document no.', 'document'),
    f('doc_date', 'วันที่เอกสาร', 'Document date', 'document', 'date'),
    f('doc_type_code', 'รหัสประเภทเอกสาร', 'Doc type code', 'document'),
    f('doc_type_name', 'ชื่อประเภทเอกสาร', 'Doc type name', 'document'),
    f('doc_type_name_en', 'ชื่อประเภทเอกสาร (อังกฤษ)', 'Doc type name (EN)', 'document'),
    f('tax_invoice_no', 'เลขที่ใบกำกับภาษี/ใบเสร็จผู้ขาย', 'Vendor tax invoice / receipt no.', 'document'),
    f('tax_invoice_date', 'วันที่ใบกำกับภาษีผู้ขาย', 'Vendor tax invoice date', 'document', 'date'),
    f('tax_invoice_kind', 'ประเภทใบกำกับภาษี', 'Tax invoice type', 'document'),
    f('tax_invoice_kind_en', 'ประเภทใบกำกับภาษี (อังกฤษ)', 'Tax invoice type (EN)', 'document'),
    f('ap_invoice_no', 'เลขที่ใบตั้งหนี้ AP', 'AP invoice no.', 'document'),
    f('payment_no', 'เลขที่ใบจ่ายชำระ AP', 'AP payment no.', 'document'),
    f('payment_date', 'วันที่จ่าย', 'Payment date', 'document', 'date'),
    f('gl_doc_no', 'เลขที่รายการบัญชี (ใบจ่าย)', 'GL voucher no. (payment)', 'document'),
    f('description', 'หมายเหตุ', 'Remark', 'document'),
    f('warehouse_name', 'คลังสินค้า', 'Warehouse', 'document'),
    f('warehouse_name_en', 'คลังสินค้า (อังกฤษ)', 'Warehouse (EN)', 'document'),
    f('prepared_by', 'ผู้จัดทำ', 'Prepared by', 'document'),
    f('requested_by', 'ผู้ขออนุมัติจ่าย', 'Payment requested by', 'document'),
    f('approver_code', 'รหัสผู้อนุมัติจ่าย', 'Payment approver code', 'document'),
    f('approver_name', 'ชื่อผู้อนุมัติจ่าย', 'Payment approver name', 'document'),
    f('approve_date', 'วันที่อนุมัติจ่าย', 'Payment approval date', 'document', 'date'),
    f('currency_code', 'สกุลเงิน', 'Currency', 'document'),
    f('currency_name', 'ชื่อสกุลเงิน', 'Currency name', 'document'),
    f('currency_name_en', 'ชื่อสกุลเงิน (อังกฤษ)', 'Currency name (EN)', 'document'),
    f('exchange_rate', 'อัตราแลกเปลี่ยน', 'Exchange rate', 'document', 'number'),
    f('subtotal', 'รวมเงิน', 'Subtotal', 'total', 'money'),
    f('discount_amount', 'ส่วนลด', 'Discount', 'total', 'money'),
    f('before_vat', 'มูลค่าก่อนภาษี', 'Amount before VAT', 'total', 'money'),
    f('vat_rate', 'อัตราภาษี (%)', 'VAT rate (%)', 'total', 'number'),
    f('vat_amount', 'ภาษีซื้อ', 'Input VAT', 'total', 'money'),
    f('total_amount', 'จำนวนเงินรวมทั้งสิ้น', 'Grand total', 'total', 'money'),
    f('total_qty', 'จำนวนรวม', 'Total quantity', 'total', 'qty'),
    f('amount_text', 'จำนวนเงินรวมตัวอักษร', 'Grand total in words', 'total'),
    f('deposit_doc_nos', 'เลขที่ใบจ่ายมัดจำที่หัก', 'Deducted deposit no.', 'total'),
    f('deposit_total', 'หักเงินมัดจำ', 'Less deposits', 'total', 'money'),
    f('amount_due', 'ยอดที่ต้องจ่าย (หลังหักมัดจำ)', 'Amount due (after deposits)', 'total', 'money'),
    f('net_paid', 'ยอดจ่ายสุทธิ (หลังหัก ณ ที่จ่าย)', 'Net paid (after WHT)', 'total', 'money'),
    f('net_paid_text', 'ยอดจ่ายสุทธิตัวอักษร', 'Net paid in words', 'total'),
    f('net_paid_text_en', 'ยอดจ่ายสุทธิตัวอักษร (อังกฤษ)', 'Net paid in words (EN)', 'total'),
    f('base_currency_code', 'สกุลเงินหลัก', 'Base currency', 'total'),
    f('total_amount_lc', 'จำนวนเงินรวม (สกุลเงินหลัก)', 'Grand total (base currency)', 'total', 'money'),
    f('net_paid_lc', 'ยอดจ่ายสุทธิ (สกุลเงินหลัก)', 'Net paid (base currency)', 'total', 'money'),
    f('line_count', 'จำนวนรายการ', 'Line count', 'total', 'number'),
    f('payment_methods', 'วิธีจ่าย (ชื่อ + จำนวนเงิน)', 'Payment methods (name + amount)', 'payment'),
    f('payment_methods_en', 'วิธีจ่าย (อังกฤษ)', 'Payment methods (EN)', 'payment'),
    f('cash_amount', 'จ่ายเป็นเงินสด', 'Paid in cash', 'payment', 'money'),
    f('check_amount', 'จ่ายเป็นเช็ค', 'Paid by cheque', 'payment', 'money'),
    f('transfer_amount', 'จ่ายเป็นเงินโอน', 'Paid by transfer', 'payment', 'money'),
    f('qr_amount', 'จ่ายผ่าน QR/พร้อมเพย์', 'Paid by QR/PromptPay', 'payment', 'money'),
    f('card_amount', 'จ่ายด้วยบัตร', 'Paid by card', 'payment', 'money'),
    f('other_amount', 'จ่ายวิธีอื่น', 'Paid by other methods', 'payment', 'money'),
    f('cash_mark', 'เครื่องหมาย X เงินสด', 'X mark: cash', 'payment'),
    f('check_mark', 'เครื่องหมาย X เช็ค', 'X mark: cheque', 'payment'),
    f('transfer_mark', 'เครื่องหมาย X เงินโอน/QR', 'X mark: transfer/QR', 'payment'),
    f('card_mark', 'เครื่องหมาย X บัตร', 'X mark: card', 'payment'),
    f('check_details', 'รายละเอียดเช็ค (เลขที่ ธนาคาร สาขา)', 'Cheque details (no., bank, branch)', 'payment'),
    f('check_details_en', 'รายละเอียดเช็ค (อังกฤษ)', 'Cheque details (EN)', 'payment'),
    f('payment_refs', 'เลขที่อ้างอิงการจ่าย', 'Payment reference nos.', 'payment'),
    f('wht_amount', 'ภาษีหัก ณ ที่จ่าย', 'Withholding tax', 'payment', 'money'),
    f('wht_certificate_nos', 'เลขที่หนังสือรับรองการหักภาษี', 'WHT certificate nos.', 'payment'),
    ...PRINT_FIELDS,
    f('line_no', 'ลำดับ', 'No.', 'line', 'number', 'L'),
    f('item_code', 'รหัสสินค้า', 'Item code', 'line', 'text', 'L'),
    f('item_name', 'ชื่อสินค้า', 'Item name', 'line', 'text', 'L'),
    f('item_name_en', 'ชื่อสินค้า (อังกฤษ)', 'Item name (EN)', 'line', 'text', 'L'),
    f('description', 'รายละเอียด', 'Description', 'line', 'text', 'L'),
    f('item_desc', 'ชื่อสินค้า + รายละเอียด', 'Item name + description', 'line', 'text', 'L'),
    f('qty', 'จำนวน', 'Quantity', 'line', 'qty', 'L'),
    f('unit', 'หน่วย', 'Unit', 'line', 'text', 'L'),
    f('unit_en', 'หน่วย (อังกฤษ)', 'Unit (EN)', 'line', 'text', 'L'),
    f('unit_price', 'ราคาต่อหน่วย', 'Unit price', 'line', 'money', 'L'),
    f('discount_percent', 'ส่วนลด %', 'Discount %', 'line', 'number', 'L'),
    f('discount_amount', 'ส่วนลด', 'Discount', 'line', 'money', 'L'),
    f('amount', 'จำนวนเงิน', 'Amount', 'line', 'money', 'L'),
    f('vat_rate', 'อัตราภาษี (%)', 'VAT rate (%)', 'line', 'number', 'L'),
    f('vat_amount', 'ภาษี', 'VAT', 'line', 'money', 'L'),
    f('line_total', 'จำนวนเงินรวมภาษี', 'Amount incl. VAT', 'line', 'money', 'L'),
  ],

  listDocs: async (db, { docIds, docNoFrom, docNoTo, dateFrom, dateTo, keys }) => {
    const p = [docIds];
    let c = '';
    if (keys) { p.push(keys.filter(k => k.startsWith('IM:')).map(k => Number(k.split(':')[1])).filter(Boolean)); c += ` AND t.id = ANY($${p.length}::int[])`; }
    if (docNoFrom) { p.push(docNoFrom); c += ` AND t.doc_no >= $${p.length}`; }
    if (docNoTo) { p.push(docNoTo); c += ` AND t.doc_no <= $${p.length}`; }
    if (dateFrom) { p.push(dateFrom); c += ` AND t.doc_date >= $${p.length}::date`; }
    if (dateTo) { p.push(dateTo); c += ` AND t.doc_date <= $${p.length}::date`; }
    const base = await loadBaseCurrency(db);
    return (await db.query(`
        SELECT 'IM:' || t.id AS key, 'IM' AS module, t.id, d.doc_code, t.doc_no, ${ymdSql('t.doc_date')} AS doc_date,
               t.vendor_code AS customer_code, COALESCE(NULLIF(to_jsonb(t)->>'bill_to_name', ''), t.vendor_name_th) AS customer_name,
               COALESCE(b.total_amount_fc, 0)::float AS total_amount, t.currency_code
          FROM im_transaction t JOIN sa_module_document d ON d.id = t.doc_id
          LEFT JOIN ap_transaction b ON b.id = t.linked_ap_transaction_id
         WHERE t.doc_id = ANY($1::int[]) AND t.status = 'Posted' ${c}
         ORDER BY t.doc_date, t.doc_no${keys ? '' : ' LIMIT 2000'}`, p)).rows.map(r => ({
      ...r, currency_code: s(r.currency_code) || base, is_base_currency: (s(r.currency_code) || base) === base,
    }));
  },

  loadDocs: async (db, keys) => {
    await ensureImPriceColumns(db);
    const ids = keys.filter(k => k.startsWith('IM:')).map(k => Number(k.split(':')[1])).filter(Boolean);
    const out = new Map();
    if (!ids.length) return out;
    const heads = (await db.query(`
        SELECT t.id, t.doc_no, ${ymdSql('t.doc_date')} AS doc_date, t.ref_no, t.description, t.currency_code,
               t.exchange_rate::float AS exchange_rate, t.price_includes_vat, t.branch_id, t.created_by, t.vendor_id,
               t.vendor_code, t.vendor_name_th, d.doc_code, d.doc_name_thai, d.doc_name_eng,
               to_jsonb(t)->>'bill_to_name' AS bill_to_name, to_jsonb(t)->>'bill_to_address' AS bill_to_address,
               to_jsonb(t)->>'bill_to_tax_id' AS bill_to_tax_id, to_jsonb(t)->>'bill_to_branch' AS bill_to_branch,
               to_jsonb(t)->>'tax_invoice_kind' AS tax_invoice_kind, to_jsonb(t)->>'pay_requested_by' AS pay_requested_by,
               ${ymdSql('t.vendor_invoice_date')} AS vendor_invoice_date,
               w.warehouse_name_th, w.warehouse_name_en,
               b.doc_no AS ap_invoice_no, ${ymdSql('b.doc_date')} AS ap_invoice_date,
               b.subtotal_fc::float AS b_subtotal, COALESCE(b.discount_amount_fc, 0)::float AS b_discount, b.before_vat_fc::float AS b_before_vat,
               b.vat_amount_fc::float AS b_vat, b.total_amount_fc::float AS b_total, b.total_amount_lc::float AS b_total_lc,
               pay.doc_no AS payment_no, ${ymdSql('pay.doc_date')} AS payment_date, pay.gl_doc_no AS pay_gl_doc_no,
               COALESCE(pay.total_amount_fc, 0)::float AS pay_total, COALESCE(pay.total_amount_lc, 0)::float AS pay_total_lc,
               v.vendor_name_en, v.tax_id AS v_tax_id, to_jsonb(v)->>'tax_branch_code' AS v_branch, to_jsonb(a) AS v_addr
          FROM im_transaction t
          JOIN sa_module_document d ON d.id = t.doc_id
          LEFT JOIN im_warehouse w ON w.id = t.warehouse_id
          LEFT JOIN ap_transaction b ON b.id = t.linked_ap_transaction_id
          LEFT JOIN ap_transaction pay ON pay.id = (to_jsonb(t)->>'linked_ap_payment_id')::int
          LEFT JOIN ap_vendor v ON v.id = t.vendor_id
          LEFT JOIN LATERAL (SELECT * FROM ap_vendor_address x WHERE x.vendor_id = t.vendor_id
                              ORDER BY (x.address_type = 'billing') DESC, x.is_default DESC, x.id LIMIT 1) a ON TRUE
         WHERE t.id = ANY($1::int[])`, [ids])).rows;
    const lines = (await db.query(`
        SELECT dt.header_id, dt.line_no, COALESCE(NULLIF(dt.item_code, ''), it.item_code) AS item_code,
               COALESCE(NULLIF(dt.item_name, ''), it.item_name_th) AS item_name, it.item_name_en, dt.description,
               ABS(dt.qty)::float AS qty, COALESCE(dt.unit_cost_fc, dt.unit_cost, 0)::float AS price,
               COALESCE(dt.discount_percent, 0)::float AS discount_percent, COALESCE(dt.vat_type, 'NOVAT') AS vat_type,
               COALESCE(dt.vat_rate, 0)::float AS vat_rate, u.uom_code, u.uom_name_th, u.uom_name_en
          FROM im_transaction_detail dt LEFT JOIN im_uom u ON u.id = dt.uom_id LEFT JOIN im_item it ON it.id = dt.item_id
         WHERE dt.header_id = ANY($1::int[]) ORDER BY dt.header_id, dt.line_no, dt.id`, [ids])).rows;
    const deps = (await db.query(`
        SELECT t.id AS hid, string_agg(dep.doc_no, ', ' ORDER BY dep.doc_date) AS nos, SUM(a.applied_amount_fc)::float AS fc
          FROM im_transaction t JOIN ap_transaction_apply a ON a.transaction_id = t.linked_ap_transaction_id AND a.apply_type = 'inv_advance'
          JOIN ap_transaction dep ON dep.id = a.applied_to_id
         WHERE t.id = ANY($1::int[]) GROUP BY t.id`, [ids])).rows;
    const branches = await loadBranches(db, heads.map(h => h.branch_id));
    const companyTaxId = s((await db.query(`SELECT tax_id_number FROM sa_company ORDER BY is_active DESC NULLS LAST, id LIMIT 1`)).rows[0]?.tax_id_number);
    const appr = await loadApprovers(db, 'IM_CASHPUR', ids);
    const pays = await loadCashSalePayments(db, ids);
    const base = await loadBaseCurrency(db);
    const curOf = (h) => s(h.currency_code) || base;
    const currencies = await loadCurrencies(db, heads.map(curOf));
    const preparers = new Map((await db.query(`SELECT user_name, first_name, last_name FROM sa_user WHERE user_name = ANY($1::text[])`,
      [[...new Set(heads.flatMap(h => [s(h.created_by), s(h.pay_requested_by)]).filter(Boolean))]])).rows.map(u => [u.user_name, userDisplayName(u)]));

    for (const h of heads) {
      const bt = s(h.bill_to_name);
      const addr = bt ? null : thaiAddress(h.v_addr);
      const [btLine1, ...btRest] = s(h.bill_to_address).split(/\r?\n/);
      const code = bt ? s(h.bill_to_branch) : s(h.v_branch);
      const taxId = bt ? s(h.bill_to_tax_id) : s(h.v_tax_id);
      const ls = lines.filter(l => l.header_id === h.id).map((l, i) => {
        const vr = l.vat_type === 'NOVAT' ? 0 : l.vat_rate;
        const incl = h.price_includes_vat === true && vr > 0;
        const a = calcLineAmounts({ qty: l.qty, price: l.price, discountPercent: l.discount_percent, vatRate: vr, priceIncludesVat: incl });
        const name = s(l.item_name), desc = s(l.description);
        return {
          line_no: i + 1, item_code: s(l.item_code), item_name: name || desc, item_name_en: s(l.item_name_en) || name || desc, description: desc,
          item_desc: name && desc && desc !== name ? `${name} ${desc}` : (name || desc),
          qty: l.qty, unit: s(l.uom_name_th) || s(l.uom_code), unit_en: s(l.uom_name_en) || s(l.uom_code),
          unit_price: incl ? round2(l.price * 100 / (100 + vr)) : l.price, discount_percent: l.discount_percent, discount_amount: a.discount,
          amount: a.net, vat_rate: vr, vat_amount: a.vat, line_total: round2(a.net + a.vat),
        };
      });
      const p = pays.get(h.id);
      const pf = paymentFields(p ? { ...p, rate: h.exchange_rate } : null);
      const dep = deps.find(x => x.hid === h.id);
      const total = round2(num(h.b_total));
      const due = round2(total - num(dep?.fc));
      const netPaid = round2(num(h.pay_total));
      const a = appr.get(h.id);
      out.set(`IM:${h.id}`, {
        header: {
          ...(branches.get(h.branch_id) || branches.get(0)),
          ...companyTaxFields(companyTaxId, branches.get(h.branch_id) || branches.get(0)),
          vendor_code: s(h.vendor_code), vendor_name: bt || s(h.vendor_name_th), vendor_name_en: bt || s(h.vendor_name_en) || s(h.vendor_name_th),
          vendor_address: bt ? s(h.bill_to_address).replace(/\s*\r?\n\s*/g, ' ') : addr.full,
          vendor_address1: bt ? s(btLine1) : addr.line1, vendor_address2: bt ? btRest.map(s).filter(Boolean).join(' ') : addr.line2,
          vendor_tax_id: taxId, vendor_branch_label: taxBranchTh(code),
          vendor_tax_id_branch: [taxId, taxBranchTh(code)].filter(Boolean).join(' '),
          doc_no: s(h.doc_no), doc_date: h.doc_date,
          doc_type_code: s(h.doc_code), doc_type_name: s(h.doc_name_thai), doc_type_name_en: s(h.doc_name_eng) || s(h.doc_name_thai),
          tax_invoice_no: s(h.ref_no), tax_invoice_date: h.vendor_invoice_date || h.ap_invoice_date || h.doc_date,
          tax_invoice_kind: TAX_KIND_TH[s(h.tax_invoice_kind) || 'FULL'], tax_invoice_kind_en: TAX_KIND_EN[s(h.tax_invoice_kind) || 'FULL'],
          ap_invoice_no: s(h.ap_invoice_no), payment_no: s(h.payment_no), payment_date: h.payment_date || h.doc_date,
          gl_doc_no: s(h.pay_gl_doc_no), description: s(h.description),
          warehouse_name: s(h.warehouse_name_th), warehouse_name_en: s(h.warehouse_name_en) || s(h.warehouse_name_th),
          prepared_by: preparers.get(s(h.created_by)) || s(h.created_by),
          requested_by: preparers.get(s(h.pay_requested_by)) || s(h.pay_requested_by),
          ...approverFields(a, ''),
          ...currencyFields(currencies, curOf(h)), currency_code: curOf(h), exchange_rate: num(h.exchange_rate) || 1,
          subtotal: round2(num(h.b_subtotal)), discount_amount: round2(num(h.b_discount)), before_vat: round2(num(h.b_before_vat)),
          vat_rate: headerVatRate(ls), vat_amount: round2(num(h.b_vat)), total_amount: total,
          total_qty: ls.reduce((t, l) => t + l.qty, 0), amount_text: amountWords(total, curOf(h)),
          deposit_doc_nos: s(dep?.nos), deposit_total: round2(num(dep?.fc)), amount_due: due,
          net_paid: netPaid, net_paid_text: amountWords(netPaid, curOf(h)), net_paid_text_en: englishAmountText(netPaid, curOf(h)),
          base_currency_code: base, total_amount_lc: round2(num(h.b_total_lc)), net_paid_lc: round2(num(h.pay_total_lc)),
          line_count: ls.length,
          ...pf,
        },
        lines: ls,
      });
    }
    return out;
  },
};

const SOURCES = { SALES_INVOICE, PAYMENT_VOUCHER };

module.exports = { SOURCES, loadCompany };
