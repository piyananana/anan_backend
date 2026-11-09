// ยอดของบรรทัดเอกสารซื้อ/ขาย ตามตัวเลือก "ราคารวม VAT" — มิเรอร์ lib/utils/vat_calc.dart ฝั่ง Flutter
// (user-approved 2026-10-31, ดู project_vat_discount_deposit) ค่าที่คืนเป็นยอดก่อน VAT เสมอ (ยกเว้น total)
//   ราคาไม่รวม VAT: gross = จำนวน × ราคา, ส่วนลด = gross × %, net = gross − ส่วนลด, vat = net × อัตรา
//   ราคารวม VAT:   total = จำนวน × ราคา × (1 − %), vat = total × อัตรา / (100 + อัตรา), net = total − vat
// ปัดทศนิยม 2 ตำแหน่งต่อบรรทัด — ส่วนลดคือส่วนต่าง gross − net เพื่อให้ gross − ส่วนลด = net พอดี
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// discountAmount (ระบุ = ใช้แทน %) = ส่วนลดรวมของบรรทัดในหน่วยเดียวกับราคาที่กรอก — เอกสารขายที่มีส่วนลดขั้นบันได/
// ส่วนลดเงิน/ส่วนลดท้ายบิล (ดู computeSalesDiscounts) เก็บเป็น discount_amount เพื่อให้ยอดตรงเป๊ะไม่ผ่าน %
const calcLineAmounts = ({ qty, price, discountPercent = 0, discountAmount = null, vatRate = 0, noVat = false, priceIncludesVat = false }) => {
    const rate = noVat ? 0 : (Number(vatRate) || 0);
    const entered = (Number(qty) || 0) * (Number(price) || 0);
    const afterDisc = discountAmount != null ? entered - (Number(discountAmount) || 0) : entered * (1 - (Number(discountPercent) || 0) / 100);
    if (!priceIncludesVat || rate === 0) {
        const gross = round2(entered);
        const net = round2(afterDisc);
        const vat = round2(net * rate / 100);
        return { gross, discount: round2(gross - net), net, vat, total: round2(net + vat) };
    }
    const total = round2(afterDisc);
    const vat = round2(total * rate / (100 + rate));
    const net = round2(total - vat);
    const gross = round2(entered * 100 / (100 + rate));
    return { gross, discount: round2(gross - net), net, vat, total };
};

// ราคาต่อหน่วยหลังส่วนลด ก่อน VAT (ไม่ปัด) — ใช้เป็นต้นทุนสต็อกต่อหน่วยของเอกสารรับสินค้า
const netUnitPrice = ({ price, discountPercent = 0, vatRate = 0, noVat = false, priceIncludesVat = false }) => {
    const rate = noVat ? 0 : (Number(vatRate) || 0);
    const p = (Number(price) || 0) * (1 - (Number(discountPercent) || 0) / 100);
    return priceIncludesVat && rate ? p * 100 / (100 + rate) : p;
};

// SQL ของ netUnitPrice — price = นิพจน์ราคาที่กรอก, dt = alias บรรทัด (discount_percent/vat_type/vat_rate),
// t = alias หัวเอกสาร (price_includes_vat), withDiscount = false ได้ราคาก่อนส่วนลด ก่อน VAT
const netUnitPriceSql = (price, dt, t, withDiscount = true) => `(COALESCE(${price}, 0) * ${withDiscount ? `(1 - COALESCE(${dt}.discount_percent, 0) / 100)` : '1'}
    / CASE WHEN COALESCE(${t}.price_includes_vat, false) AND COALESCE(${dt}.vat_type, 'NOVAT') <> 'NOVAT'
           THEN 1 + COALESCE(${dt}.vat_rate, 0) / 100 ELSE 1 END)`;

// คอลัมน์ราคารวม VAT / ส่วนลดของ IM — เรียกก่อน query อื่นนอก IM ที่อ้างถึง (วงเงินเครดิต/พิมพ์/รายงาน) เผื่อยังไม่เคย
// เปิดเอกสาร IM หลังอัปเดต (ensureImTransactionTable เพิ่มคอลัมน์เดียวกัน) — ทำครั้งเดียวต่อฐานข้อมูล
const ensuredIm = new Set();
const ensureImPriceColumns = async (db) => {
    const dbName = db.options?.database || db.database;
    if (dbName && ensuredIm.has(dbName)) return;
    await db.query(`ALTER TABLE IF EXISTS im_transaction ADD COLUMN IF NOT EXISTS price_includes_vat BOOLEAN NOT NULL DEFAULT false`);
    await db.query(`ALTER TABLE IF EXISTS im_transaction_detail ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(7,4) NOT NULL DEFAULT 0`);
    // บรรทัดสินค้าบริการ/ไม่นับสต็อก — รายงานสต็อกกรองออก (ดู markNonStockLines ใน imTransactionController)
    await db.query(`ALTER TABLE IF EXISTS im_transaction_detail ADD COLUMN IF NOT EXISTS is_non_stock BOOLEAN NOT NULL DEFAULT false`);
    // ส่วนลดเอกสารขาย (ดู computeSalesDiscounts) — คอลัมน์เดียวกับ ensureImTransactionTable
    await db.query(`ALTER TABLE IF EXISTS im_transaction_detail
        ADD COLUMN IF NOT EXISTS discount_text VARCHAR(40),
        ADD COLUMN IF NOT EXISTS line_discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bill_discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(18,4)`);
    await db.query(`ALTER TABLE IF EXISTS im_transaction
        ADD COLUMN IF NOT EXISTS bill_discount_percent NUMERIC(7,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cash_discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0`);
    if (dbName) ensuredIm.add(dbName);
};

// ส่วนลดเอกสารขายของ AR (ใบแจ้งหนี้/ใบเพิ่มหนี้/ใบลดหนี้ — ดู computeSalesDiscounts) discount_percent = % เทียบเท่า
// จึงต้องเก็บทศนิยมละเอียด, discount_amount_fc ยังเป็นส่วนลดรวมก่อน VAT เหมือนเดิม
const ensuredAr = new Set();
const ensureArDiscountColumns = async (db) => {
    const dbName = db.options?.database || db.database;
    if (dbName && ensuredAr.has(dbName)) return;
    await db.query(`ALTER TABLE IF EXISTS ar_transaction_detail ALTER COLUMN discount_percent TYPE NUMERIC(14,8)`).catch(() => {});
    await db.query(`ALTER TABLE IF EXISTS ar_transaction_detail
        ADD COLUMN IF NOT EXISTS discount_text VARCHAR(40),
        ADD COLUMN IF NOT EXISTS line_discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bill_discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE IF EXISTS ar_transaction
        ADD COLUMN IF NOT EXISTS bill_discount_percent NUMERIC(7,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cash_discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0`);
    if (dbName) ensuredAr.add(dbName);
};

// คอลัมน์ราคารวม VAT / ส่วนลด / VAT ต่อบรรทัดของใบสั่งขายและใบเสนอราคา — เรียกก่อน query นอก SO ที่อ้างถึง
// (วงเงินเครดิต/DLN) vat_type ว่าง = เอกสารเก่าก่อนมี VAT (ยอดไม่มี VAT, เอกสารที่ดึงไปใช้ VAT ตั้งต้นของสินค้า)
const addSalesPriceColumns = async (db, table) => {
    await db.query(`ALTER TABLE IF EXISTS ${table}
        ADD COLUMN IF NOT EXISTS price_includes_vat BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS discount_value_lc NUMERIC(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS vat_amount_lc NUMERIC(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_amount_lc NUMERIC(18,4) NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE IF EXISTS ${table}_detail
        ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(7,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS vat_type VARCHAR(20),
        ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(7,4) NOT NULL DEFAULT 0`);
};
// ส่วนลดเอกสารขาย (ดู computeSalesDiscounts) ของใบสั่งขาย/ใบเสนอราคา — discount_percent = % เทียบเท่าของส่วนลดรวม
// (รายงาน/วงเงิน/ใบส่งสินค้าที่ดึงจาก SO ใช้ % นี้กับจำนวนคงเหลือได้ตรงสัดส่วน) จึงต้องเก็บทศนิยมละเอียด
const addSalesDiscountColumns = async (db, table) => {
    await db.query(`ALTER TABLE IF EXISTS ${table}_detail ALTER COLUMN discount_percent TYPE NUMERIC(14,8)`).catch(() => {});
    await db.query(`ALTER TABLE IF EXISTS ${table}_detail
        ADD COLUMN IF NOT EXISTS discount_text VARCHAR(40),
        ADD COLUMN IF NOT EXISTS line_discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bill_discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(18,4)`);
    await db.query(`ALTER TABLE IF EXISTS ${table}
        ADD COLUMN IF NOT EXISTS bill_discount_percent NUMERIC(7,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cash_discount_amount NUMERIC(18,4) NOT NULL DEFAULT 0`);
};
const ensuredSo = new Set();
const ensureSoPriceColumns = async (db) => {
    const dbName = db.options?.database || db.database;
    if (dbName && ensuredSo.has(dbName)) return;
    await addSalesPriceColumns(db, 'so_transaction');
    await addSalesPriceColumns(db, 'quote_transaction');
    await addSalesDiscountColumns(db, 'so_transaction');
    await addSalesDiscountColumns(db, 'quote_transaction');
    if (dbName) ensuredSo.add(dbName);
};

// ยอดบรรทัดเป็นบาทของเอกสารสกุลเงินต่างประเทศ — มิเรอร์ imDocAmount: ราคารวม VAT ใช้ยอดรวมแปลงเป็นบาท,
// ไม่รวม VAT คิด VAT จากยอดบาท  d = { qty, price, discount_percent, vat_type, vat_rate }
const lineAmountsLc = (d, exchangeRate = 1, priceIncludesVat = false) => {
    const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 1;
    const vat = !d.vat_type || d.vat_type === 'NOVAT' ? 0 : (Number(d.vat_rate) || 0);
    // discount_amount = ส่วนลดรวมของทั้งบรรทัด (หน่วยราคาที่กรอก) ของเอกสารขาย — มีแล้วใช้แทน %
    const a = calcLineAmounts({ qty: d.qty, price: d.price, discountPercent: d.discount_percent, discountAmount: d.discount_amount ?? null,
        vatRate: vat, priceIncludesVat });
    const grossLc = round2(a.gross * rate);
    const netLc = round2(a.net * rate);
    const totalLc = priceIncludesVat && vat ? round2(a.total * rate) : round2(netLc + round2(netLc * vat / 100));
    return { grossLc, discountLc: round2(grossLc - netLc), netLc, vatLc: round2(totalLc - netLc), totalLc };
};

// คอลัมน์ราคารวม VAT / ส่วนลด / VAT ต่อบรรทัดของใบสั่งซื้อ — เรียกก่อน query นอก PO ที่อ้างถึง (GR/รายงาน)
const ensuredPo = new Set();
const ensurePoPriceColumns = async (db) => {
    const dbName = db.options?.database || db.database;
    if (dbName && ensuredPo.has(dbName)) return;
    await addSalesPriceColumns(db, 'po_transaction');
    if (dbName) ensuredPo.add(dbName);
};

// บันทึกบรรทัดใบสั่ง (SO / ใบเสนอราคา / PO): ค่าที่คำนวณจากราคาที่กรอก (รวม VAT หรือไม่) + ส่วนลด + VAT ของบรรทัด
const orderLineValues = (d, header, qty = d.qty_ordered) => {
    const vatType = d.vat_type || null;
    const vatRate = vatType && vatType !== 'NOVAT' ? (Number(d.vat_rate) || 0) : 0;
    const discountPercent = Math.min(Math.max(Number(d.discount_percent) || 0, 0), 100);
    const amt = lineAmountsLc({ qty: Number(qty) || 0, price: Number(d.unit_price_fc) || 0, discount_percent: discountPercent,
        discount_amount: d.discount_amount ?? null, vat_type: vatType, vat_rate: vatRate }, header.exchange_rate, header.price_includes_vat === true);
    return { vatType, vatRate, discountPercent, amt };
};
// ยอดรวมหัวเอกสาร (บาท) — total_value_lc = หลังส่วนลด ก่อน VAT
const sumOrderTotals = (rows) => rows.reduce((t, a) => ({
    gross: round2(t.gross + a.grossLc), discount: round2(t.discount + a.discountLc), net: round2(t.net + a.netLc),
    vat: round2(t.vat + a.vatLc), total: round2(t.total + a.totalLc),
}), { gross: 0, discount: 0, net: 0, vat: 0, total: 0 });
const saveOrderTotals = (client, table, headerId, totalQty, amts) => {
    const t = sumOrderTotals(amts);
    return client.query(`UPDATE ${table} SET total_qty=$1, total_value_lc=$2, discount_value_lc=$3, vat_amount_lc=$4, total_amount_lc=$5
        WHERE id=$6`, [totalQty, t.net, t.discount, t.vat, t.total, headerId]);
};

// ── ส่วนลดเอกสารขาย (user request 2026-11-08, ดู project_sales_discount_program) ──────────────────────────────
// ส่วนลดขั้นบันได "10+5+2" = ลดทบกัน (0.90 × 0.95 × 0.98) สูงสุด 5 ขั้น แต่ละขั้น 0–100 — คืน { steps, factor, text }
const MAX_DISCOUNT_STEPS = 5;
const parseStepDiscount = (text) => {
    const t = String(text ?? '').replace(/[\s%]/g, '');
    if (!t) return { steps: [], factor: 1, text: '' };
    const parts = t.split('+');
    const bad = parts.length > MAX_DISCOUNT_STEPS || parts.some(p => !/^\d+(\.\d+)?$/.test(p) || Number(p) > 100);
    if (bad) {
        const err = new Error(`ส่วนลด "${text}" ไม่ถูกต้อง — ใส่เป็น % คั่นด้วย + ได้ไม่เกิน ${MAX_DISCOUNT_STEPS} ขั้น เช่น 10+5+2`);
        err.status = 400;
        throw err;
    }
    const steps = parts.map(Number);
    return { steps, factor: steps.reduce((f, s) => f * (1 - s / 100), 1), text: steps.join('+') };
};

// แบ่ง amount ตามน้ำหนัก (ปัด 2 ตำแหน่ง) เศษไปบรรทัดที่น้ำหนักมากที่สุด
const distribute = (amount, weights) => {
    const total = weights.reduce((t, w) => t + (w > 0 ? w : 0), 0);
    if (!(total > 0) || !amount) return weights.map(() => 0);
    const shares = weights.map(w => (w > 0 ? round2(amount * w / total) : 0));
    const diff = round2(amount - shares.reduce((t, s) => t + s, 0));
    if (diff) {
        const iMax = weights.reduce((best, w, i) => (w > weights[best] ? i : best), 0);
        shares[iMax] = round2(shares[iMax] + diff);
    }
    return shares;
};

// ส่วนลดของเอกสารขายทั้งใบ (หน่วยเดียวกับราคาที่กรอก รวม/ไม่รวม VAT ตามหัวเอกสาร) ลำดับ:
//   1. ส่วนลดขั้นบันไดของบรรทัด (discount_text)  2. ส่วนลดเงินของบรรทัด (line_discount_amount, ต่อทั้งบรรทัด)
//   3. ส่วนลดท้ายบิล % (billDiscountPercent) ของยอดหลังส่วนลดบรรทัด  4. ส่วนลดเงินสดท้ายบิล (cashDiscountAmount)
//   ข้อ 3-4 ปันส่วนเข้าแต่ละบรรทัดตามสัดส่วนยอดหลังส่วนลดก่อนหน้า (ของแถมไม่ได้รับส่วนแบ่ง)
// ตั้งค่าในแต่ละบรรทัด: discount_text (ปรับรูปแบบ), line_discount_amount, bill_discount_amount (ส่วนที่ปันมา),
// discount_amount (รวมทั้งหมด), discount_percent (เทียบเท่า % ของยอดก่อนส่วนลด — ใช้กับ query/รายงานที่คิดเป็น %)
// lines[i] ต้องมี price/qty ผ่าน priceOf(l)/qtyOf(l) — throw เมื่อส่วนลดเกินยอด
const computeSalesDiscounts = (lines, { billDiscountPercent = 0, cashDiscountAmount = 0, priceOf, qtyOf }) => {
    const billPct = Math.min(Math.max(Number(billDiscountPercent) || 0, 0), 100);
    const cash = round2(Math.max(Number(cashDiscountAmount) || 0, 0));
    const rows = lines.map((l) => {
        const entered = round2(Math.abs(Number(qtyOf(l)) || 0) * (Number(priceOf(l)) || 0));
        if (l.is_free) return { entered: 0, own: 0, text: '', lineAmt: 0 };
        const { factor, text } = parseStepDiscount(l.discount_text);
        const lineAmt = round2(Math.max(Number(l.line_discount_amount) || 0, 0));
        const own = round2(entered * (1 - factor) + lineAmt);
        if (own > entered + 0.005) {
            const err = new Error(`${l.item_code || ''}: ส่วนลดของรายการ (${own.toFixed(2)}) มากกว่ายอดของรายการ (${entered.toFixed(2)})`.trim());
            err.status = 400;
            throw err;
        }
        return { entered, own, text, lineAmt };
    });
    const bases = rows.map(r => round2(r.entered - r.own));
    const pctShares = distribute(round2(bases.reduce((t, b) => t + b, 0) * billPct / 100), bases);
    const afterPct = bases.map((b, i) => round2(b - pctShares[i]));
    const room = round2(afterPct.reduce((t, b) => t + b, 0));
    if (cash > room + 0.005) {
        const err = new Error(`ส่วนลดเงินสดท้ายบิล (${cash.toFixed(2)}) มากกว่ายอดหลังส่วนลด (${room.toFixed(2)})`);
        err.status = 400;
        throw err;
    }
    const cashShares = distribute(cash, afterPct);
    lines.forEach((l, i) => {
        const r = rows[i];
        const bill = round2(pctShares[i] + cashShares[i]);
        const total = round2(r.own + bill);
        l.discount_text = r.text || null;
        l.line_discount_amount = r.lineAmt;
        l.bill_discount_amount = bill;
        l.discount_amount = total;
        l.discount_percent = r.entered > 0 ? Math.round(total / r.entered * 100 * 1e8) / 1e8 : 0;
    });
    return lines;
};

// ใบสั่งขาย/ใบเสนอราคา: คำนวณส่วนลดบนบรรทัดของคำขอ (แก้ค่าในบรรทัด) ก่อนบันทึก — หน้าจอเก่าที่ส่งเฉพาะ discount_percent
// ถือเป็นส่วนลดขั้นเดียว
const applyOrderSalesDiscounts = (header, details, qtyOf) => {
    for (const d of details || []) {
        if (d.discount_text === undefined && Number(d.discount_percent)) d.discount_text = String(Number(d.discount_percent));
    }
    computeSalesDiscounts(details || [], {
        billDiscountPercent: header.bill_discount_percent, cashDiscountAmount: header.cash_discount_amount,
        priceOf: d => d.unit_price_fc, qtyOf,
    });
};
const orderDiscountParams = (d) => [d.discount_text ?? null, Number(d.line_discount_amount) || 0, Number(d.bill_discount_amount) || 0,
    d.discount_amount ?? null];
const saveOrderBillDiscount = (client, table, id, header) => client.query(
    `UPDATE ${table} SET bill_discount_percent=$1, cash_discount_amount=$2 WHERE id=$3`,
    [Math.min(Math.max(Number(header.bill_discount_percent) || 0, 0), 100), Number(header.cash_discount_amount) || 0, id]);

module.exports = {
    MAX_DISCOUNT_STEPS, parseStepDiscount, computeSalesDiscounts, applyOrderSalesDiscounts, orderDiscountParams, saveOrderBillDiscount,
    addSalesDiscountColumns,
    round2, calcLineAmounts, netUnitPrice, netUnitPriceSql, ensureImPriceColumns, ensureSoPriceColumns, ensurePoPriceColumns, ensureArDiscountColumns,
    addSalesPriceColumns, lineAmountsLc, orderLineValues, saveOrderTotals,
};
