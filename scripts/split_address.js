// scripts/split_address.js
// แยก CUS_ADDR ออกเป็นฟีลด์ย่อย และ lookup รหัสไปรษณีย์จาก zipcode.xlsx
// Usage: node scripts/split_address.js

const XLSX = require('xlsx');

// ─── Load zipcode database ────────────────────────────────────────────────────
const zbWb   = XLSX.readFile('C:/Users/User/OneDrive/Desktop/zipcode.xlsx');
const zbData = XLSX.utils.sheet_to_json(zbWb.Sheets[zbWb.SheetNames[0]], { header: 1, defval: '' });
const zipcodeRows = zbData.slice(1).map(r => ({
  subDistrict: r[0].toString().trim(),
  district:    r[1].toString().trim(),
  province:    r[2].toString().trim(),
  zipcode:     r[3].toString().trim(),
}));

// Index by subDistrict name (normalized — strip leading spaces)
const zipcodeBySubDistrict = {};
for (const row of zipcodeRows) {
  const key = row.subDistrict;
  if (!zipcodeBySubDistrict[key]) zipcodeBySubDistrict[key] = [];
  zipcodeBySubDistrict[key].push(row);
}
// Index by zipcode
const zipcodeByZip = {};
for (const row of zipcodeRows) {
  const key = row.zipcode;
  if (!zipcodeByZip[key]) zipcodeByZip[key] = [];
  zipcodeByZip[key].push(row);
}
// Index by district for BKK lookup
const zipcodeByDistrict = {};
for (const row of zipcodeRows) {
  const key = `${row.province}::${row.district}`;
  if (!zipcodeByDistrict[key]) zipcodeByDistrict[key] = [];
  zipcodeByDistrict[key].push(row);
}

// ─── Helper: space-bounded keyword find ──────────────────────────────────────
/**
 * หา keyword ที่นำหน้าด้วย space หรือ start-of-string เท่านั้น
 * คืน index ของตัวแรกที่ valid (-1 ถ้าไม่พบ)
 * ถ้า findLast=true คืน index ของตัวสุดท้าย
 */
function findKeywordIndex(s, keyword, findLast = false) {
  let result = -1;
  let searchFrom = 0;
  while (true) {
    const idx = s.indexOf(keyword, searchFrom);
    if (idx === -1) break;
    const prevChar = idx === 0 ? '' : s[idx - 1];
    // valid if preceded by whitespace or start-of-string
    if (prevChar === '' || /\s/.test(prevChar)) {
      if (!findLast) return idx; // return first
      result = idx;              // record last
    }
    searchFrom = idx + 1;
  }
  return result;
}

/**
 * หา match ที่แรก (findLast=false) หรือสุดท้าย (findLast=true)
 * ของ pattern โดยต้องการให้ keyword นำหน้าด้วย space/start
 * pattern เป็น array ของ keyword strings (ลองทีละตัว)
 * คืน { keyword, keyIndex, valueStart } หรือ null
 */
function findKeyword(s, keywords, findLast = false) {
  let best = null;
  for (const kw of keywords) {
    let idx = findKeywordIndex(s, kw, findLast);
    if (idx === -1) continue;
    if (best === null) {
      best = { keyword: kw, keyIndex: idx };
    } else {
      if (findLast ? idx > best.keyIndex : idx < best.keyIndex) {
        best = { keyword: kw, keyIndex: idx };
      }
    }
  }
  return best;
}

// ─── Address parser ───────────────────────────────────────────────────────────
function parseThaiAddress(raw) {
  const empty = {
    address_no: '', address_building_village: '',
    address_alley: '', address_road: '',
    address_subdistrict: '', address_district: '',
    address_province: '', address_zip_code: '',
  };
  if (!raw || !raw.trim()) return empty;
  let s = raw.trim();
  const result = { ...empty };

  // ── 1. Zip code (5 digits at end) ──────────────────────────────────────────
  {
    const m = s.match(/(\d{5})\s*$/);
    if (m) {
      result.address_zip_code = m[1];
      s = s.substring(0, m.index).trim();
    }
  }

  // ── 2. Province ────────────────────────────────────────────────────────────
  {
    // Bangkok: check last occurrence
    const bkkRe = /กรุงเทพมหานคร|กรุงเทพฯ|กทม\.?/g;
    let bkk = null, m;
    while ((m = bkkRe.exec(s)) !== null) bkk = m;
    if (bkk) {
      result.address_province = 'กรุงเทพมหานคร';
      s = (s.substring(0, bkk.index) + s.substring(bkk.index + bkk[0].length)).trim();
    } else {
      // จ. or จังหวัด — space-bounded last occurrence
      for (const kw of ['จังหวัด', 'จ.']) {
        const idx = findKeywordIndex(s, kw, true);
        if (idx !== -1) {
          const rest = s.substring(idx + kw.length).trim();
          // take first word group as province
          const wm = rest.match(/^([\u0E00-\u0E7Fa-zA-Z]+(?:\s+[\u0E00-\u0E7Fa-zA-Z]+)*)/);
          result.address_province = wm ? wm[1].trim() : rest.trim();
          s = s.substring(0, idx).trim();
          break;
        }
      }
    }
  }

  // ── 3. District (find last valid occurrence) ───────────────────────────────
  {
    // เขต — space-bounded
    const khIdx = findKeywordIndex(s, 'เขต', true);
    if (khIdx !== -1) {
      const rest = s.substring(khIdx + 'เขต'.length).trim();
      const wm = rest.match(/^([\u0E00-\u0E7Fa-zA-Z]+(?:\s+[\u0E00-\u0E7Fa-zA-Z]+)*)/);
      result.address_district = wm ? wm[1].trim() : rest.trim();
      s = s.substring(0, khIdx).trim();
    } else {
      // อ. or อำเภอ — space-bounded
      for (const kw of ['อำเภอ', 'อ.']) {
        const idx = findKeywordIndex(s, kw, true);
        if (idx !== -1) {
          const rest = s.substring(idx + kw.length).trim();
          const wm = rest.match(/^([\u0E00-\u0E7Fa-zA-Z]+(?:\s+[\u0E00-\u0E7Fa-zA-Z]+)*)/);
          result.address_district = wm ? wm[1].trim() : rest.trim();
          s = s.substring(0, idx).trim();
          break;
        }
      }
    }
  }

  // ── 4. Sub-district ────────────────────────────────────────────────────────
  {
    // แขวง — space-bounded
    const akIdx = findKeywordIndex(s, 'แขวง', true);
    if (akIdx !== -1) {
      const rest = s.substring(akIdx + 'แขวง'.length).trim();
      const wm = rest.match(/^([\u0E00-\u0E7Fa-zA-Z]+(?:\s+[\u0E00-\u0E7Fa-zA-Z]+)*)/);
      result.address_subdistrict = wm ? wm[1].trim() : rest.trim();
      s = s.substring(0, akIdx).trim();
    } else {
      // ต. or ตำบล — space-bounded
      for (const kw of ['ตำบล', 'ต.']) {
        const idx = findKeywordIndex(s, kw, true);
        if (idx !== -1) {
          const rest = s.substring(idx + kw.length).trim();
          // For ต. take all remaining Thai text (including เขต in name)
          const wm = rest.match(/^([\u0E00-\u0E7Fa-zA-Z]+(?:[\u0E00-\u0E7Fa-zA-Z\s]*[\u0E00-\u0E7Fa-zA-Z]+)?)/);
          result.address_subdistrict = wm ? wm[1].trim() : rest.trim();
          s = s.substring(0, idx).trim();
          break;
        }
      }
    }
  }

  // ── 5. Road (space-bounded ถ./ถนน) ────────────────────────────────────────
  {
    for (const kw of ['ถนน', 'ถ.']) {
      const idx = findKeywordIndex(s, kw, false); // find first (leftmost) road
      if (idx !== -1) {
        const rest = s.substring(idx + kw.length).trim();
        // Take all remaining as road name (alley was already removed — oops, no alley yet)
        // Take until natural break: newline or too many words (Thai road names ~ 1-3 words + number)
        result.address_road = rest.trim();
        s = s.substring(0, idx).trim();
        break;
      }
    }
  }

  // ── 6. Moo / Village (process BEFORE alley to avoid greedy grab) ──────────
  {
    // หมู่ N หรือ ม.N — capture ONLY the moo number (not anything after)
    // หมู่บ้าน NAME — capture the full name until next keyword
    const mooNumRe = /(?:^|\s)(หมู่(?:ที่)?\s*\d+|ม\.\s*\d+)/;
    const mooVilRe = /(?:^|\s)(หมู่บ้าน\s*[\u0E00-\u0E7Fa-zA-Z0-9]+)/;
    const buildRe  = /(?:^|\s)((?:ตึก|อาคาร|ชั้น(?:ที่)?)\s*[\u0E00-\u0E7Fa-zA-Z0-9,.\s]+?)(?=\s+(?:ซ\.|ซอย|ถ\.|ถนน)|$)/;

    let mooMatch = null;
    // Try หมู่ N
    mooMatch = s.match(mooNumRe);
    if (mooMatch) {
      result.address_building_village = mooMatch[1].trim();
      const startIdx = s.indexOf(mooMatch[1]);
      s = (s.substring(0, startIdx) + s.substring(startIdx + mooMatch[1].length)).trim();
    } else {
      // Try หมู่บ้าน
      mooMatch = s.match(mooVilRe);
      if (mooMatch) {
        result.address_building_village = mooMatch[1].trim();
        const startIdx = s.indexOf(mooMatch[1]);
        s = (s.substring(0, startIdx) + s.substring(startIdx + mooMatch[1].length)).trim();
      } else {
        // ตึก / อาคาร / ชั้น
        const bm = s.match(buildRe);
        if (bm) {
          result.address_building_village = bm[1].trim();
          const startIdx = s.indexOf(bm[1]);
          s = (s.substring(0, startIdx) + s.substring(startIdx + bm[1].length)).trim();
        }
      }
    }
  }

  // ── 7. Alley (ซ./ซอย) ────────────────────────────────────────────────────
  {
    for (const kw of ['ซอย', 'ซ.']) {
      const idx = findKeywordIndex(s, kw, false);
      if (idx !== -1) {
        result.address_alley = s.substring(idx + kw.length).trim();
        s = s.substring(0, idx).trim();
        break;
      }
    }
  }

  // ── 8. Address No (remainder) ─────────────────────────────────────────────
  result.address_no = s.trim();

  // ── Post: recover district/subdistrict from road tail for no-prefix addresses ──
  // เช่น "ถ.จรัญสนิทวงศ์ บางกอกน้อย กรุงเทพฯ" → road = "จรัญสนิทวงศ์ บางกอกน้อย"
  // ลองตัดคำสุดท้ายออกจาก road แล้วดูว่าตรงกับ เขต/ตำบล ในฐานข้อมูลหรือไม่
  if (!result.address_district && result.address_road) {
    const roadParts = result.address_road.trim().split(/\s+/);
    if (roadParts.length >= 2) {
      // Try last word as district
      const lastWord = roadParts[roadParts.length - 1];
      const prov = result.address_province || '';
      // Check zipcode db for district match
      let distKey = prov ? `${prov}::${lastWord}` : null;
      if (distKey && zipcodeByDistrict[distKey]) {
        result.address_district = lastWord;
        result.address_road = roadParts.slice(0, -1).join(' ');
      } else if (!prov) {
        // No province either — check if last word is a known province
        const lastRow = zipcodeRows.find(r => r.province === lastWord || r.province.includes(lastWord));
        if (lastRow) {
          result.address_province = lastRow.province;
          result.address_road = roadParts.slice(0, -1).join(' ');
          // Try second-to-last as district
          if (roadParts.length >= 3) {
            const dist2 = roadParts[roadParts.length - 2];
            const dKey2 = `${lastRow.province}::${dist2}`;
            if (zipcodeByDistrict[dKey2]) {
              result.address_district = dist2;
              result.address_road = roadParts.slice(0, -2).join(' ');
            }
          }
        }
      }
    }
  }

  return result;
}

// ─── Zipcode lookup / enrichment ─────────────────────────────────────────────
function enrichFromZipcode(parsed) {
  const result = { ...parsed };
  const subRaw  = result.address_subdistrict || '';
  const distRaw = result.address_district    || '';
  const provRaw = result.address_province    || '';
  const zipRaw  = result.address_zip_code    || '';

  if (!subRaw && !zipRaw && !distRaw) return result;

  // Strategy 1: zip + subdistrict
  if (zipRaw && zipcodeByZip[zipRaw]) {
    const rows = zipcodeByZip[zipRaw];
    let best = null;
    if (rows.length === 1) {
      best = rows[0];
    } else {
      if (subRaw)  best = rows.find(r => r.subDistrict === subRaw) || null;
      if (!best && distRaw) best = rows.find(r => r.district === distRaw) || null;
      if (!best) best = rows[0];
    }
    if (best) {
      if (!result.address_subdistrict) result.address_subdistrict = best.subDistrict;
      if (!result.address_district)    result.address_district    = best.district;
      if (!result.address_province)    result.address_province    = best.province;
    }
    return result;
  }

  // Strategy 2: subdistrict name lookup
  if (subRaw && zipcodeBySubDistrict[subRaw]) {
    const rows = zipcodeBySubDistrict[subRaw];
    let best = null;
    if (rows.length === 1) {
      best = rows[0];
    } else {
      if (distRaw) best = rows.find(r => r.district === distRaw) || null;
      if (!best && provRaw) {
        best = rows.find(r =>
          r.province === provRaw ||
          r.province.includes(provRaw) ||
          provRaw.includes(r.province)
        ) || null;
      }
      if (!best) best = rows[0];
    }
    if (best) {
      if (!result.address_district)  result.address_district  = best.district;
      if (!result.address_province)  result.address_province  = best.province;
      if (!result.address_zip_code)  result.address_zip_code  = best.zipcode;
    }
    return result;
  }

  // Strategy 3: district + province → zip (e.g. ถึงแค่เขต ไม่มีแขวง)
  if (distRaw && provRaw) {
    const key = `${provRaw}::${distRaw}`;
    if (zipcodeByDistrict[key]) {
      const rows = zipcodeByDistrict[key];
      const best = rows[0];
      if (!result.address_zip_code) result.address_zip_code = best.zipcode;
    } else {
      // Try partial district match (e.g. ป้อมปราบ → ป้อมปราบศัตรูพ่าย)
      const prov4key = provRaw === 'กรุงเทพมหานคร' ? provRaw : provRaw;
      const partialDist = Object.keys(zipcodeByDistrict).find(k => {
        const [kp, kd] = k.split('::');
        return (kp === prov4key || kp === 'กรุงเทพมหานคร') &&
               (kd.startsWith(distRaw) || distRaw.startsWith(kd));
      });
      if (partialDist) {
        const best = zipcodeByDistrict[partialDist][0];
        if (!result.address_zip_code)  result.address_zip_code  = best.zipcode;
        if (!result.address_district)  result.address_district  = best.district;
        if (!result.address_province)  result.address_province  = best.province;
      }
    }
  }

  // Strategy 4: partial subdistrict match (e.g. เทพศิรินทร์ → วัดเทพศิรินทร์)
  if (subRaw && !result.address_zip_code) {
    const partialSub = Object.keys(zipcodeBySubDistrict).find(k =>
      k.includes(subRaw) || subRaw.includes(k)
    );
    if (partialSub) {
      const rows = zipcodeBySubDistrict[partialSub];
      let best = null;
      if (distRaw) best = rows.find(r => r.district.startsWith(distRaw) || distRaw.startsWith(r.district)) || null;
      if (!best && provRaw) best = rows.find(r => r.province === provRaw) || null;
      if (!best) best = rows[0];
      if (best) {
        if (!result.address_zip_code) result.address_zip_code = best.zipcode;
        if (!result.address_district) result.address_district = best.district;
      }
    }
  }

  // Strategy 4: Bangkok — try word before province as district if no explicit prefix
  if (!result.address_district && provRaw === 'กรุงเทพมหานคร' && !distRaw) {
    // This is handled above already; no-op here
  }

  return result;
}

// ─── Main processing ──────────────────────────────────────────────────────────
const custWb   = XLSX.readFile('C:/Users/User/OneDrive/Desktop/customer.xls');
const custWs   = custWb.Sheets[custWb.SheetNames[1]]; // Sheet2
const custData = XLSX.utils.sheet_to_json(custWs, { header: 1, defval: '' });

const headers  = custData[0];
const addrIdx  = headers.indexOf('CUS_ADDR');
const postIdx  = headers.indexOf('CUS_POST_CODE');
const codIdx   = headers.indexOf('customer_code');
const oldIdx   = headers.indexOf('old_customer_code');
const nameIdx  = headers.indexOf('customer_name_th');

console.log(`Total data rows: ${custData.length - 1}`);

const outHeaders = [
  'customer_code', 'old_customer_code', 'customer_name_th',
  'CUS_ADDR_original',
  'address_no', 'address_building_village', 'address_alley',
  'address_road', 'address_subdistrict', 'address_district',
  'address_province', 'address_zip_code',
  'zip_from_file', 'parse_note',
];
const outRows = [outHeaders];

let parsed = 0, emptyAddr = 0, issues = 0;

for (let i = 1; i < custData.length; i++) {
  const row     = custData[i];
  const rawAddr = (row[addrIdx] || '').toString().trim();
  const rawZip  = (row[postIdx] || '').toString().trim().replace(/\s/g, '');
  const custCode = (row[codIdx]  || '').toString().trim();
  const oldCode  = (row[oldIdx]  || '').toString().trim();
  const name     = (row[nameIdx] || '').toString().trim();

  if (!rawAddr) {
    emptyAddr++;
    outRows.push([custCode, oldCode, name, '', '', '', '', '', '', '', '', '', rawZip, 'no_address']);
    continue;
  }

  // Append zip from file if not already in address string
  let addrToParse = rawAddr;
  if (rawZip && /^\d{5}$/.test(rawZip) && !rawAddr.match(/\d{5}/)) {
    addrToParse = rawAddr + ' ' + rawZip;
  }

  let p = parseThaiAddress(addrToParse);

  // File zip overrides parsed zip (more reliable)
  if (rawZip && /^\d{5}$/.test(rawZip)) {
    p.address_zip_code = rawZip;
  }

  p = enrichFromZipcode(p);

  let note = '';
  if (!p.address_province)    note += 'no_province;';
  if (!p.address_district)    note += 'no_district;';
  if (!p.address_subdistrict) note += 'no_subdistrict;';
  if (!p.address_zip_code)    note += 'no_zip;';
  if (note) issues++;

  outRows.push([
    custCode, oldCode, name,
    rawAddr,
    p.address_no,
    p.address_building_village,
    p.address_alley,
    p.address_road,
    p.address_subdistrict,
    p.address_district,
    p.address_province,
    p.address_zip_code,
    rawZip,
    note,
  ]);
  parsed++;
}

console.log(`Processed: ${parsed}, Empty: ${emptyAddr}, Issues (partial): ${issues}`);

// ─── Write output ─────────────────────────────────────────────────────────────
const outWb = XLSX.utils.book_new();
const outWs = XLSX.utils.aoa_to_sheet(outRows);
outWs['!cols'] = [
  {wch:15},{wch:15},{wch:30},{wch:60},
  {wch:15},{wch:25},{wch:25},{wch:25},
  {wch:20},{wch:22},{wch:22},{wch:10},
  {wch:10},{wch:25},
];
XLSX.utils.book_append_sheet(outWb, outWs, 'parsed_address');
const outPath = 'C:/Users/User/OneDrive/Desktop/customer_address_parsed.xlsx';
XLSX.writeFile(outWb, outPath);
console.log(`Output: ${outPath}`);

// ─── Print issues ─────────────────────────────────────────────────────────────
console.log('\n=== Rows with parse issues ===');
for (let i = 1; i < outRows.length; i++) {
  const r = outRows[i];
  if (r[13] && r[13] !== 'no_address') {
    console.log(`\nRow ${i}: ${r[3]}`);
    console.log(`  no=${r[4]} | bld=${r[5]} | alley=${r[6]} | road=${r[7]}`);
    console.log(`  sub=${r[8]} | dist=${r[9]} | prov=${r[10]} | zip=${r[11]}`);
    console.log(`  note: ${r[13]}`);
  }
}

// ─── Print sample (first 15 with address) ────────────────────────────────────
console.log('\n=== Sample output ===');
let shown = 0;
for (let i = 1; i < outRows.length && shown < 15; i++) {
  const r = outRows[i];
  if (r[3]) {
    console.log(`\n[${i}] ${r[3]}`);
    console.log(`  no="${r[4]}" bld="${r[5]}" alley="${r[6]}" road="${r[7]}"`);
    console.log(`  sub="${r[8]}" dist="${r[9]}" prov="${r[10]}" zip="${r[11]}"`);
    if (r[13]) console.log(`  !! ${r[13]}`);
    shown++;
  }
}
