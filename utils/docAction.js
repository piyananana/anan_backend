// utils/docAction.js
// ตัวช่วยร่วมสำหรับการถอย / ยกเลิก / ลบเอกสาร (ดู utils/reverseLog.js สำหรับประวัติ)
// เงื่อนไขที่ทำไม่ได้ส่งให้หน้าจอเป็น { code, ref, message } (null = ทำได้) — หน้าจอแปลภาษาอังกฤษจาก code

const reasonOf = (req) => (req.body?.reason || '').trim();
const userIdOf = (req) => { const v = Number(req.headers['userid']); return Number.isFinite(v) && v > 0 ? v : null; };
const sendErr = (res, status, message, extra = {}) => res.status(status).json({ error: message, message, ...extra });
const blk = (code, message, ref = null) => ({ code, ref, message });

module.exports = { reasonOf, userIdOf, sendErr, blk };
