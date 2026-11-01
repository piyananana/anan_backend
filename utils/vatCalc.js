// ยอดของบรรทัดเอกสารซื้อ/ขาย ตามตัวเลือก "ราคารวม VAT" — มิเรอร์ lib/utils/vat_calc.dart ฝั่ง Flutter
// (user-approved 2026-10-31, ดู project_vat_discount_deposit) ค่าที่คืนเป็นยอดก่อน VAT เสมอ (ยกเว้น total)
//   ราคาไม่รวม VAT: gross = จำนวน × ราคา, ส่วนลด = gross × %, net = gross − ส่วนลด, vat = net × อัตรา
//   ราคารวม VAT:   total = จำนวน × ราคา × (1 − %), vat = total × อัตรา / (100 + อัตรา), net = total − vat
// ปัดทศนิยม 2 ตำแหน่งต่อบรรทัด — ส่วนลดคือส่วนต่าง gross − net เพื่อให้ gross − ส่วนลด = net พอดี
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const calcLineAmounts = ({ qty, price, discountPercent = 0, vatRate = 0, noVat = false, priceIncludesVat = false }) => {
    const rate = noVat ? 0 : (Number(vatRate) || 0);
    const entered = (Number(qty) || 0) * (Number(price) || 0);
    const afterDisc = entered * (1 - (Number(discountPercent) || 0) / 100);
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
    if (dbName) ensuredIm.add(dbName);
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
const ensuredSo = new Set();
const ensureSoPriceColumns = async (db) => {
    const dbName = db.options?.database || db.database;
    if (dbName && ensuredSo.has(dbName)) return;
    await addSalesPriceColumns(db, 'so_transaction');
    await addSalesPriceColumns(db, 'quote_transaction');
    if (dbName) ensuredSo.add(dbName);
};

// ยอดบรรทัดเป็นบาทของเอกสารสกุลเงินต่างประเทศ — มิเรอร์ imDocAmount: ราคารวม VAT ใช้ยอดรวมแปลงเป็นบาท,
// ไม่รวม VAT คิด VAT จากยอดบาท  d = { qty, price, discount_percent, vat_type, vat_rate }
const lineAmountsLc = (d, exchangeRate = 1, priceIncludesVat = false) => {
    const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 1;
    const vat = !d.vat_type || d.vat_type === 'NOVAT' ? 0 : (Number(d.vat_rate) || 0);
    const a = calcLineAmounts({ qty: d.qty, price: d.price, discountPercent: d.discount_percent, vatRate: vat, priceIncludesVat });
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
        vat_type: vatType, vat_rate: vatRate }, header.exchange_rate, header.price_includes_vat === true);
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

module.exports = {
    round2, calcLineAmounts, netUnitPrice, netUnitPriceSql, ensureImPriceColumns, ensureSoPriceColumns, ensurePoPriceColumns,
    addSalesPriceColumns, lineAmountsLc, orderLineValues, saveOrderTotals,
};
