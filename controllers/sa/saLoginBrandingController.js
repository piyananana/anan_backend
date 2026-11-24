// controllers/sa/saLoginBrandingController.js
// ตั้งค่าหน้าล็อกอิน (ใช้ร่วมทุกฐานข้อมูล เพราะหน้าล็อกอินแสดงก่อนเลือกฐานข้อมูล) — user-approved 2026-11-24
//   layout: 'A' (แบ่งซ้าย-ขวา) | 'B' (การ์ดกลางจอ), ชื่อระบบ/คำโปรย ไทย-อังกฤษ, โลโก้ระบบ, รูปพื้นหลัง (แบบ B; ไม่มี = ไล่สีเขียว-ทอง)
// เก็บเป็นไฟล์บนเซิร์ฟเวอร์: ค่าตั้ง uploads/system/login_branding.json, รูป public/system/
// GET เปิดสาธารณะ (หน้าล็อกอินยังไม่มี token), PUT เฉพาะผู้พัฒนาระบบ (requireDeveloper ที่ route)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SETTINGS_DIR = path.join(ROOT, 'uploads', 'system');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'login_branding.json');
const IMAGE_DIR = path.join(ROOT, 'public', 'system');
const HISTORY_MAX = 30;

const DEFAULTS = {
    layout: 'A',
    name_th: 'ANAN System',
    name_en: 'ANAN System',
    tagline_th: 'ระบบบริหารบัญชีและการเงินครบวงจร สำหรับธุรกิจไทย',
    tagline_en: 'Integrated accounting & finance for Thai businesses',
    logo_file: null,
    background_file: null,
    updated_at: null,
    updated_by: null,
    history: [],
};

const ensureDirs = () => {
    for (const d of [SETTINGS_DIR, IMAGE_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
};

const readSettings = () => {
    try {
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    } catch (_) {
        return { ...DEFAULTS };
    }
};

const writeSettings = (s) => {
    ensureDirs();
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, SETTINGS_FILE);
};

const removeImage = (file) => {
    if (!file) return;
    const p = path.join(IMAGE_DIR, path.basename(file));
    fs.promises.unlink(p).catch(() => {});
};

// URL แบบ relative (/public/system/...) — Flutter ต่อ baseHost เอง ใช้ได้ทั้ง dev และ production
const toResponse = (s) => ({
    layout: s.layout === 'B' ? 'B' : 'A',
    name_th: s.name_th,
    name_en: s.name_en,
    tagline_th: s.tagline_th,
    tagline_en: s.tagline_en,
    logo_url: s.logo_file ? `/public/system/${s.logo_file}` : null,
    background_url: s.background_file ? `/public/system/${s.background_file}` : null,
    updated_at: s.updated_at,
    updated_by: s.updated_by,
    history: s.history || [],
});

// GET /api/sa/login_branding
const getBranding = (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(toResponse(readSettings()));
};

// PUT /api/sa/login_branding (multipart) — fields: layout, name_th, name_en, tagline_th, tagline_en,
//   remove_logo=1, remove_background=1, reset=1; files: logo, background
const saveBranding = async (req, res) => {
    const cur = readSettings();
    const b = req.body || {};
    const files = req.files || {};
    const logo = files.logo?.[0];
    const bg = files.background?.[0];
    const who = req.headers['username'] || null;
    if (logo && logo.size > 1024 * 1024) {
        removeImage(logo.filename);
        if (bg) removeImage(bg.filename);
        return res.status(400).json({ message: 'โลโก้ต้องมีขนาดไม่เกิน 1 MB' });
    }
    const changes = [];
    let next = { ...cur };

    if (b.reset === '1' || b.reset === 'true') {
        removeImage(cur.logo_file);
        removeImage(cur.background_file);
        next = { ...DEFAULTS, history: cur.history };
        changes.push('คืนค่าเริ่มต้น');
    } else {
        const text = (k, max) => {
            if (b[k] === undefined) return;
            const v = String(b[k]).trim().slice(0, max);
            if (v !== (cur[k] || '')) { next[k] = v; changes.push(k); }
        };
        if (b.layout !== undefined) {
            const l = b.layout === 'B' ? 'B' : 'A';
            if (l !== cur.layout) { next.layout = l; changes.push(`แบบ ${l}`); }
        }
        text('name_th', 80); text('name_en', 80); text('tagline_th', 200); text('tagline_en', 200);
        if (!next.name_th) next.name_th = DEFAULTS.name_th;
        if (!next.name_en) next.name_en = DEFAULTS.name_en;

        if (logo) {
            removeImage(cur.logo_file);
            next.logo_file = path.basename(logo.filename);
            changes.push(`อัปโหลดโลโก้ ${logo.originalname}`);
        } else if (b.remove_logo === '1' || b.remove_logo === 'true') {
            removeImage(cur.logo_file);
            next.logo_file = null;
            changes.push('ลบโลโก้');
        }
        if (bg) {
            removeImage(cur.background_file);
            next.background_file = path.basename(bg.filename);
            changes.push(`อัปโหลดรูปพื้นหลัง ${bg.originalname}`);
        } else if (b.remove_background === '1' || b.remove_background === 'true') {
            removeImage(cur.background_file);
            next.background_file = null;
            changes.push('ลบรูปพื้นหลัง');
        }
    }

    if (changes.length) {
        const now = new Date().toISOString();
        next.updated_at = now;
        next.updated_by = who;
        const label = changes.map((c) => ({
            name_th: 'แก้ชื่อระบบ (ไทย)', name_en: 'แก้ชื่อระบบ (อังกฤษ)',
            tagline_th: 'แก้คำโปรย (ไทย)', tagline_en: 'แก้คำโปรย (อังกฤษ)',
        }[c] || c)).join(', ');
        next.history = [{ at: now, by: who, action: label }, ...(cur.history || [])].slice(0, HISTORY_MAX);
    }
    try {
        writeSettings(next);
        res.json(toResponse(next));
    } catch (err) {
        console.error('saveBranding error:', err);
        res.status(500).json({ message: err.message });
    }
};

module.exports = { getBranding, saveBranding, IMAGE_DIR, ensureDirs };
