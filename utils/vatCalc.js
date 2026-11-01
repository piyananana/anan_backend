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

module.exports = { round2, calcLineAmounts, netUnitPrice, netUnitPriceSql, ensureImPriceColumns };
