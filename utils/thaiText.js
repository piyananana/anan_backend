// ข้อความสำหรับพิมพ์เอกสาร: จำนวนเงินเป็นตัวอักษร (ไทย/อังกฤษ) และที่อยู่แบบไทยบรรทัดเดียว

const TH_DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const TH_UNITS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

// อ่านจำนวนเต็มบวก (สตริงตัวเลข) — ทีละกลุ่ม 6 หลักคั่นด้วย "ล้าน"
// หลักหน่วยเป็น 1 อ่าน "เอ็ด" เมื่อมีหลักที่สูงกว่าไม่เป็นศูนย์ (101 = หนึ่งร้อยเอ็ด, 1,000,001 = หนึ่งล้านเอ็ด)
const readThaiInt = (s) => {
  s = String(s).replace(/^0+/, '');
  if (!s) return '';
  const groups = [];
  for (let end = s.length; end > 0; end -= 6) groups.unshift(s.slice(Math.max(0, end - 6), end));
  let out = '';
  groups.forEach((g, gi) => {
    const len = g.length;
    for (let i = 0; i < len; i++) {
      const d = Number(g[i]);
      const pos = len - 1 - i;
      if (d === 0) continue;
      if (pos === 1) out += (d === 1 ? '' : d === 2 ? 'ยี่' : TH_DIGITS[d]) + 'สิบ';
      else if (pos === 0) out += (d === 1 && out !== '') ? 'เอ็ด' : TH_DIGITS[d];
      else out += TH_DIGITS[d] + TH_UNITS[pos];
    }
    if (gi < groups.length - 1) out += 'ล้าน';
  });
  return out;
};

// 1234.5 → "หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์", 100 → "หนึ่งร้อยบาทถ้วน"
const bahtText = (amount) => {
  const n = Number(amount) || 0;
  const cents = Math.round(Math.abs(n) * 100);
  const baht = Math.floor(cents / 100);
  const satang = cents % 100;
  if (cents === 0) return 'ศูนย์บาทถ้วน';
  let t = baht > 0 ? readThaiInt(String(baht)) + 'บาท' : '';
  t += satang > 0 ? readThaiInt(String(satang)) + 'สตางค์' : 'ถ้วน';
  return (n < 0 ? 'ลบ' : '') + t;
};

const EN_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const EN_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const EN_SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

const readEn999 = (n) => {
  const parts = [];
  if (n >= 100) { parts.push(EN_ONES[Math.floor(n / 100)] + ' Hundred'); n %= 100; }
  if (n >= 20) { parts.push(EN_TENS[Math.floor(n / 10)] + (n % 10 ? '-' + EN_ONES[n % 10] : '')); }
  else if (n > 0) parts.push(EN_ONES[n]);
  return parts.join(' ');
};

const readEnInt = (n) => {
  if (n === 0) return 'Zero';
  const parts = [];
  for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) {
    const g = n % 1000;
    if (g) parts.unshift(readEn999(g) + (EN_SCALES[i] ? ' ' + EN_SCALES[i] : ''));
  }
  return parts.join(' ');
};

// THB: "One Hundred Baht Only" / "... Baht and Fifty Satang"; สกุลอื่น: "One Hundred US Dollar and 50/100"
const englishAmountText = (amount, currencyCode = 'THB') => {
  const n = Number(amount) || 0;
  const cents = Math.round(Math.abs(n) * 100);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  const neg = n < 0 ? 'Minus ' : '';
  if (!currencyCode || currencyCode === 'THB') {
    return neg + readEnInt(whole) + ' Baht' + (frac ? ' and ' + readEnInt(frac) + ' Satang' : ' Only');
  }
  return neg + readEnInt(whole) + ' ' + currencyCode + (frac ? ` and ${String(frac).padStart(2, '0')}/100` : ' Only');
};

// เติมคำนำหน้าถ้ายังไม่มี (ข้อมูลบางแถวกรอกคำนำหน้ามาเองแล้ว)
const withPrefix = (v, prefixes) => {
  const s = (v ?? '').toString().trim();
  if (!s) return '';
  return prefixes.some(p => s.startsWith(p)) ? s : prefixes[0] + s;
};

// ซอย/ถนน ใช้คำเต็ม — ข้อมูลที่บันทึกเป็นตัวย่อ (ซ./ถ.) แปลงเป็นคำเต็ม
const fullPrefix = (v, full, abbrs) => {
  let s = (v ?? '').toString().trim();
  if (!s) return '';
  if (s.startsWith(full)) return s;
  for (const a of abbrs) if (s.startsWith(a)) s = s.slice(a.length).trim();
  return full + s;
};

// ที่อยู่ไทย → { line1, line2, full } — กรุงเทพฯ ใช้ แขวง/เขต ไม่ใส่ "จ."
// a = แถวที่มีคอลัมน์ address_no, address_building_village, address_alley|address_soi, address_road,
//     address_sub_district, address_district, address_province, address_zip_code
const thaiAddress = (a) => {
  if (!a) return { line1: '', line2: '', full: '' };
  const province = (a.address_province ?? '').toString().trim();
  const bkk = /กรุงเทพ/.test(province);
  const line1 = [
    (a.address_no ?? '').toString().trim(),
    (a.address_building_village ?? '').toString().trim(),
    fullPrefix(a.address_alley ?? a.address_soi, 'ซอย', ['ซ.']),
    fullPrefix(a.address_road, 'ถนน', ['ถ.']),
  ].filter(Boolean).join(' ');
  const line2 = [
    withPrefix(a.address_sub_district, bkk ? ['แขวง'] : ['ต.', 'ตำบล']),
    withPrefix(a.address_district, bkk ? ['เขต'] : ['อ.', 'อำเภอ']),
    bkk ? province : withPrefix(province, ['จ.', 'จังหวัด']),
    (a.address_zip_code ?? '').toString().trim(),
  ].filter(Boolean).join(' ');
  return { line1, line2, full: [line1, line2].filter(Boolean).join(' ') };
};

module.exports = { bahtText, englishAmountText, thaiAddress, readThaiInt };
