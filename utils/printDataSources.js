// แหล่งข้อมูลของแบบฟอร์มพิมพ์ (im_print_form.data_source)
// แต่ละแหล่งข้อมูลกำหนด: ประเภทเอกสารที่ใช้ได้, รายการฟิลด์ให้เลือกวางในหน้าจอออกแบบ, คำสั่งดึงรายการเอกสาร/ข้อมูลพิมพ์
// เอกสารอ้างด้วย key "<module>:<id>" (เช่น IM:12, AR:5) เพราะแหล่งข้อมูลเดียวรวมเอกสารหลายโมดูลได้
// ฟิลด์ scope: H = หัวเอกสาร, L = รายการ (ใช้ในคอลัมน์ตาราง), P = คำนวณตอนพิมพ์ฝั่ง Flutter (เลขหน้า ชุดสำเนา วันที่พิมพ์)
// type: text / money / qty / number / date / image — Flutter จัดรูปแบบตาม type (ปรับได้ต่อชิ้นงาน)

const fs = require('fs');
const path = require('path');
const { bahtText, englishAmountText, thaiAddress } = require('./thaiText');

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
const currencyFields = (map, code) => {
  const c = map.get(s(code) || 'THB') || {};
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

// ยอดรวม + จำนวนเงินตัวอักษร
const totalsFields = (t, currency) => ({
  subtotal: round2(t.subtotal), discount_amount: round2(t.discount), before_vat: round2(t.beforeVat),
  vat_rate: t.vatRate, vat_amount: round2(t.vat), total_amount: round2(t.total), total_qty: t.qty,
  amount_text: (!currency || currency === 'THB') ? bahtText(t.total) : `${englishAmountText(t.total, currency)}`,
  amount_text_en: englishAmountText(t.total, currency || 'THB'),
});

// อัตรา VAT ที่พิมพ์หัวเอกสาร — อัตราสูงสุดของรายการที่มี VAT (ปกติทุกรายการอัตราเดียวกัน)
const headerVatRate = (lines) => lines.reduce((m, l) => Math.max(m, l.vat_amount ? num(l.vat_rate) : 0), 0);

// ── ใบส่งสินค้า/ใบกำกับภาษี: IM 30/31/32 + AR ใบแจ้งหนี้ 10 ───────────────────────
const SALES_INVOICE = {
  key: 'SALES_INVOICE',
  name_th: 'ใบส่งสินค้า/ใบกำกับภาษี',
  name_en: 'Delivery Note / Tax Invoice',
  // module = รหัสใน key, sys_module ตาม sa_module_document
  docTypes: [
    { module: 'IM', sys_module: '31', sys_doc_types: ['30', '31', '32'] },
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
    f('line_count', 'จำนวนรายการ', 'Line count', 'total', 'number'),
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
    f('amount', 'จำนวนเงิน', 'Amount', 'line', 'money', 'L'),
    f('vat_rate', 'อัตราภาษี (%)', 'VAT rate (%)', 'line', 'number', 'L'),
    f('vat_amount', 'ภาษี', 'VAT', 'line', 'money', 'L'),
    f('line_total', 'จำนวนเงินรวมภาษี', 'Amount incl. VAT', 'line', 'money', 'L'),
    f('free_label', 'ของแถม', 'Free item', 'line', 'text', 'L'),
    f('free_label_en', 'ของแถม (อังกฤษ)', 'Free item (EN)', 'line', 'text', 'L'),
  ],

  // เอกสารที่พิมพ์ได้ (โพสต์แล้วเท่านั้น) — docIds = ประเภทเอกสารที่ผู้ใช้มีสิทธิ์และเลือกไว้
  // keys = จำกัดเฉพาะเอกสารที่ระบุ (ใช้ตรวจก่อนพิมพ์)
  listDocs: async (db, { docIds, docNoFrom, docNoTo, dateFrom, dateTo, keys }) => {
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
               (SELECT COALESCE(SUM(ROUND(ABS(x.qty) * COALESCE(x.unit_price, 0), 2)
                        + CASE WHEN COALESCE(x.vat_type, 'NOVAT') = 'NOVAT' THEN 0
                               ELSE ROUND(ROUND(ABS(x.qty) * COALESCE(x.unit_price, 0), 2) * COALESCE(x.vat_rate, 0) / 100, 2) END), 0)
                  FROM im_transaction_detail x WHERE x.header_id = t.id)::float AS total_amount
          FROM im_transaction t JOIN sa_module_document d ON d.id = t.doc_id
         WHERE t.doc_id = ANY($1::int[]) AND t.status = 'Posted' ${c1}
        UNION ALL
        SELECT 'AR:' || t.id, 'AR', t.id, d.doc_code, t.doc_no, ${ymdSql('t.doc_date')},
               t.customer_code, t.customer_name_th, t.total_amount_fc::float
          FROM ar_transaction t JOIN sa_module_document d ON d.id = t.doc_id
         WHERE t.doc_id = ANY($1::int[]) AND t.status = 'Posted' ${cond('t', 'AR')}
      ) z ORDER BY z.doc_date, z.doc_no${keys ? '' : ' LIMIT 2000'}`;
    return (await db.query(sql, p)).rows;
  },

  // ข้อมูลพิมพ์ต่อเอกสาร: Map(key → { header, lines })
  loadDocs: async (db, keys) => {
    const ids = (m) => keys.filter(k => k.startsWith(m + ':')).map(k => Number(k.split(':')[1])).filter(Boolean);
    const imIds = ids('IM');
    const arIds = ids('AR');
    const out = new Map();

    const imHeads = imIds.length ? (await db.query(`
        SELECT t.id, t.doc_no, ${ymdSql('t.doc_date')} AS doc_date, t.ref_no, t.ref_doc_no, t.description,
               t.currency_code, t.exchange_rate::float AS exchange_rate, COALESCE(NULLIF(t.linked_ar_doc_no, ''), ar.doc_no) AS linked_ar_doc_no,
               t.customer_id, t.customer_code, t.customer_name_th, t.branch_id,
               d.doc_code, d.doc_name_thai, d.doc_name_eng,
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
               t.customer_id, t.customer_code, t.customer_name_th, t.branch_id,
               t.subtotal_fc::float AS subtotal_fc, t.discount_amount_fc::float AS discount_amount_fc,
               t.before_vat_fc::float AS before_vat_fc, t.vat_amount_fc::float AS vat_amount_fc, t.total_amount_fc::float AS total_amount_fc,
               d.doc_code, d.doc_name_thai, d.doc_name_eng, c.credit_term_days,
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
    const currencies = await loadCurrencies(db, [...imHeads, ...arHeads].map(h => s(h.currency_code) || 'THB'));
    const imSp = await loadSalespersonNames(db, 'im_transaction_salesperson', imIds);
    const arSp = await loadSalespersonNames(db, 'ar_transaction_salesperson', arIds);

    const imLines = imIds.length ? (await db.query(`
        SELECT dt.header_id, dt.line_no, COALESCE(NULLIF(dt.item_code, ''), it.item_code) AS item_code,
               COALESCE(NULLIF(dt.item_name, ''), it.item_name_th) AS item_name, dt.description,
               ABS(dt.qty)::float AS qty, COALESCE(dt.unit_price, 0)::float AS unit_price,
               COALESCE(dt.vat_type, 'NOVAT') AS vat_type, COALESCE(dt.vat_rate, 0)::float AS vat_rate, dt.is_free,
               u.uom_code, u.uom_name_th, u.uom_name_en, it.item_name_en
          FROM im_transaction_detail dt LEFT JOIN im_uom u ON u.id = dt.uom_id
          LEFT JOIN im_item it ON it.id = dt.item_id
         WHERE dt.header_id = ANY($1::int[]) ORDER BY dt.header_id, dt.line_no, dt.id`, [imIds])).rows : [];
    const arLines = arIds.length ? (await db.query(`
        SELECT dt.header_id, dt.line_no, dt.item_code, dt.item_name, dt.description, dt.quantity::float AS qty,
               dt.unit_code, u.uom_name_th, u.uom_name_en, dt.unit_price_fc::float AS unit_price,
               COALESCE(dt.discount_percent, 0)::float AS discount_percent, COALESCE(dt.discount_amount_fc, 0)::float AS discount_amount,
               dt.subtotal_fc::float AS amount, COALESCE(dt.vat_rate, 0)::float AS vat_rate,
               COALESCE(dt.vat_amount_fc, 0)::float AS vat_amount, dt.total_amount_fc::float AS line_total,
               it.item_name_en
          FROM ar_transaction_detail dt
          LEFT JOIN LATERAL (SELECT x.item_name_en FROM im_item x WHERE x.item_code = dt.item_code AND dt.item_code <> '' LIMIT 1) it ON TRUE
          LEFT JOIN LATERAL (SELECT * FROM im_uom x WHERE x.uom_code = dt.unit_code LIMIT 1) u ON TRUE
         WHERE dt.header_id = ANY($1::int[]) ORDER BY dt.header_id, dt.line_no, dt.id`, [arIds])).rows : [];
    // ใบแจ้งหนี้ AR ที่สร้างจากใบส่งสินค้า: รายการ AR ไม่มีรหัส/ชื่อสินค้า — เติมจากรายการใบส่งสินค้าตามลำดับเดียวกัน
    const srcImIds = arHeads.map(h => h.im_id).filter(Boolean);
    const srcImLines = srcImIds.length ? (await db.query(`
        SELECT dt.header_id, COALESCE(NULLIF(dt.item_code, ''), it.item_code) AS item_code,
               COALESCE(NULLIF(dt.item_name, ''), it.item_name_th) AS item_name, it.item_name_en,
               u.uom_code, u.uom_name_th, u.uom_name_en
          FROM im_transaction_detail dt LEFT JOIN im_uom u ON u.id = dt.uom_id
          LEFT JOIN im_item it ON it.id = dt.item_id
         WHERE dt.header_id = ANY($1::int[]) ORDER BY dt.header_id, dt.line_no, dt.id`, [srcImIds])).rows : [];
    const fillFromIm = (l, src) => (!src ? l : {
      ...l,
      item_code: s(l.item_code) || src.item_code, item_name: s(l.item_name) || src.item_name,
      item_name_en: s(l.item_name_en) || src.item_name_en,
      uom_code: src.uom_code, uom_name_th: s(l.uom_name_th) || src.uom_name_th, uom_name_en: s(l.uom_name_en) || src.uom_name_en,
    });

    const lineCommon = (l, i) => {
      const name = s(l.item_name);
      const desc = s(l.description);
      const nameEn = s(l.item_name_en) || name;
      const join = (n) => (n && desc && desc !== n && desc !== name ? `${n} ${desc}` : (n || desc));
      return {
        line_no: i + 1, item_code: s(l.item_code), item_name: name || desc, item_name_en: nameEn || desc, description: desc,
        item_desc: join(name), item_desc_en: join(nameEn),
        unit: s(l.uom_name_th) || s(l.uom_code) || s(l.unit_code), unit_en: s(l.uom_name_en) || s(l.uom_code) || s(l.unit_code),
      };
    };
    const creditFields = (days) => ({
      credit_days: days || 0,
      credit_term: days ? `เครดิต ${days} วัน` : 'เงินสด',
      credit_term_en: days ? `Credit ${days} day${days === 1 ? '' : 's'}` : 'Cash',
    });

    for (const h of imHeads) {
      const lines = imLines.filter(l => l.header_id === h.id).map((l, i) => {
        const amount = round2(l.qty * l.unit_price);
        const vat = l.vat_type === 'NOVAT' ? 0 : round2(amount * l.vat_rate / 100);
        return {
          ...lineCommon(l, i), qty: l.qty, unit_price: l.unit_price, discount_percent: 0, discount_amount: 0,
          amount, vat_rate: l.vat_type === 'NOVAT' ? 0 : l.vat_rate, vat_amount: vat, line_total: round2(amount + vat),
          free_label: l.is_free ? 'ของแถม' : '', free_label_en: l.is_free ? 'Free' : '',
        };
      });
      const sub = lines.reduce((a, l) => a + l.amount, 0);
      const vat = lines.reduce((a, l) => a + l.vat_amount, 0);
      const sp = imSp.get(h.id) || {};
      const days = h.credit_term_days || 0;
      out.set(`IM:${h.id}`, {
        header: {
          ...(branches.get(h.branch_id) || branches.get(0)),
          ...companyTaxFields(companyTaxId, branches.get(h.branch_id) || branches.get(0)),
          ...customerFields(customers.get(h.customer_id), h),
          doc_no: s(h.doc_no), doc_date: h.doc_date, due_date: h.ar_due_date || h.calc_due_date,
          ...creditFields(days),
          doc_type_code: s(h.doc_code), doc_type_name: s(h.doc_name_thai), doc_type_name_en: s(h.doc_name_eng) || s(h.doc_name_thai),
          ref_no: s(h.ref_no),
          ref_doc_no: s(h.so_doc_no) || s(h.ref_im_doc_no) || s(h.ref_doc_no),
          ref_doc_date: h.so_doc_date || h.ref_im_doc_date || '',
          linked_doc_no: s(h.linked_ar_doc_no), linked_doc_date: h.ar_doc_date || '',
          ...docRefFields(h, imAppr.get(h.id)),
          description: s(h.description), salespersons: s(sp.th), salespersons_en: s(sp.en), salesperson_codes: s(sp.codes),
          warehouse_name: s(h.warehouse_name_th), warehouse_name_en: s(h.warehouse_name_en) || s(h.warehouse_name_th),
          ...currencyFields(currencies, h.currency_code), currency_code: s(h.currency_code) || 'THB', exchange_rate: h.exchange_rate || 1,
          line_count: lines.length,
          ...totalsFields({
            subtotal: sub, discount: 0, beforeVat: sub, vat, total: sub + vat, vatRate: headerVatRate(lines),
            qty: lines.reduce((a, l) => a + l.qty, 0),
          }, s(h.currency_code) || 'THB'),
        },
        lines,
      });
    }

    for (const h of arHeads) {
      const srcLines = h.im_id ? srcImLines.filter(x => x.header_id === h.im_id) : [];
      const lines = arLines.filter(l => l.header_id === h.id).map((l, i) => ({
        ...lineCommon(fillFromIm(l, srcLines[i]), i), qty: l.qty, unit_price: l.unit_price, discount_percent: l.discount_percent,
        discount_amount: l.discount_amount, amount: l.amount, vat_rate: l.vat_amount ? l.vat_rate : 0,
        vat_amount: l.vat_amount, line_total: l.line_total, free_label: '', free_label_en: '',
      }));
      const sp = arSp.get(h.id) || {};
      const days = h.due_days ?? h.credit_term_days ?? 0;
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
          ...currencyFields(currencies, h.currency_code), currency_code: s(h.currency_code) || 'THB', exchange_rate: h.exchange_rate || 1,
          line_count: lines.length,
          ...totalsFields({
            subtotal: h.subtotal_fc, discount: h.discount_amount_fc, beforeVat: h.before_vat_fc, vat: h.vat_amount_fc,
            total: h.total_amount_fc, vatRate: headerVatRate(lines), qty: lines.reduce((a, l) => a + l.qty, 0),
          }, s(h.currency_code) || 'THB'),
        },
        lines,
      });
    }
    return out;
  },
};

const SOURCES = { SALES_INVOICE };

module.exports = { SOURCES, loadCompany };
