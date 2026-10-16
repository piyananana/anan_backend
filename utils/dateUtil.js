// Date-only helpers ('YYYY-MM-DD').
// Never use toISOString() for a date-only value: it converts to UTC, and in Asia/Bangkok (UTC+7)
// local midnight becomes 17:00 of the PREVIOUS day — the "saved one day earlier" bug.

const pad = (n) => String(n).padStart(2, '0');

// Date (pg DATE column, local Date) or 'YYYY-MM-DD...' string -> 'YYYY-MM-DD' (local calendar day)
const ymd = (d) => {
  if (d == null || d === '') return null;
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s); // ISO with time/zone, e.g. '2026-09-30T17:00:00.000Z'
  return isNaN(parsed.getTime()) ? null : ymd(parsed);
};

// today in server local time (process TZ)
const today = () => ymd(new Date());

// 'YYYY-MM-DD' + n days -> 'YYYY-MM-DD'
const addDays = (dateStr, n) => {
  const [y, m, d] = ymd(dateStr).split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
};

// Excel cell value -> 'YYYY-MM-DD'
// - Date: SheetJS (cellDates) builds dates a few seconds off local midnight
//   (e.g. 2026-10-01 is read as 2026-09-30 23:59:56), so shift by one hour before taking the day.
// - number: Excel serial date
// - text: YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, DD-MM-YYYY
const excelDate = (val) => {
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    return ymd(new Date(val.getTime() + 3600 * 1000));
  }
  if (typeof val === 'number' && isFinite(val)) {
    if (val < 1) return null;
    const utc = new Date(Math.round((val - 25569) * 86400) * 1000); // 25569 = 1970-01-01
    return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
  }
  const s = String(val ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
};

module.exports = { ymd, today, addDays, excelDate };
