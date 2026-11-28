// controllers/im/imItemRunningController.js
'use strict';

const ensureImItemRunningTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS im_item_running (
            id                    SERIAL PRIMARY KEY,
            is_auto_numbering     BOOLEAN     NOT NULL DEFAULT false,
            format_prefix         VARCHAR(20) NOT NULL DEFAULT 'ITEM',
            format_separator      VARCHAR(5)  NOT NULL DEFAULT '-',
            format_suffix_date    VARCHAR(10) NOT NULL DEFAULT '',
            running_length        SMALLINT    NOT NULL DEFAULT 4,
            next_running_number   INTEGER     NOT NULL DEFAULT 1,
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by            VARCHAR(100),
            updated_by            VARCHAR(100)
        )
    `);
};

// number = เลขรันที่จะใช้ (ไม่ระบุ = next_running_number)
const formatItemCode = (config, number) => {
    let code = config.format_prefix || '';
    if (config.format_suffix_date) {
        const now = new Date();
        const year  = now.getFullYear().toString();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day   = now.getDate().toString().padStart(2, '0');
        switch (config.format_suffix_date) {
            case 'YY':     code += year.substring(2); break;
            case 'YYYY':   code += year; break;
            case 'YYMM':   code += year.substring(2) + month; break;
            case 'YYYYMM': code += year + month; break;
            case 'YYMMDD': code += year.substring(2) + month + day; break;
        }
    }
    if (config.format_separator) code += config.format_separator;
    code += String(number ?? config.next_running_number).padStart(config.running_length, '0');
    return code;
};

// GET /im_item_running
const fetchConfig = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImItemRunningTable(client);
        const result = await client.query(`SELECT * FROM im_item_running ORDER BY id LIMIT 1`);
        if (result.rows.length === 0) return res.status(404).json({ message: 'No config found' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching im_item_running:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// GET /im_item_running/preview_code
const previewCode = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImItemRunningTable(client);
        const result = await client.query(`SELECT * FROM im_item_running ORDER BY id LIMIT 1`);
        if (result.rows.length === 0) return res.status(404).json({ message: 'No config found' });
        const config = result.rows[0];
        if (!config.is_auto_numbering) return res.status(400).json({ message: 'Auto-numbering is not enabled' });
        res.status(200).json({ item_code: formatItemCode(config) });
    } catch (error) {
        console.error('Error previewing item code:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// POST /im_item_running (upsert)
const saveConfig = async (req, res) => {
    const {
        is_auto_numbering, format_prefix, format_separator,
        format_suffix_date, running_length, next_running_number,
    } = req.body;
    const userName = req.headers['username'] || 'system';
    const client = await req.dbPool.connect();
    try {
        await ensureImItemRunningTable(client);
        const existing = await client.query(`SELECT id FROM im_item_running LIMIT 1`);
        let result;
        if (existing.rows.length === 0) {
            result = await client.query(
                `INSERT INTO im_item_running
                    (is_auto_numbering, format_prefix, format_separator,
                     format_suffix_date, running_length, next_running_number,
                     created_by, updated_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
                 RETURNING *`,
                [is_auto_numbering, format_prefix, format_separator,
                 format_suffix_date, running_length, next_running_number, userName]
            );
        } else {
            result = await client.query(
                `UPDATE im_item_running SET
                    is_auto_numbering   = $1,  format_prefix       = $2,
                    format_separator    = $3,  format_suffix_date  = $4,
                    running_length      = $5,  next_running_number = $6,
                    updated_by = $7, updated_at = NOW()
                 WHERE id = $8
                 RETURNING *`,
                [is_auto_numbering, format_prefix, format_separator,
                 format_suffix_date, running_length, next_running_number,
                 userName, existing.rows[0].id]
            );
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error saving im_item_running:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// สำหรับใช้ภายใน imItemController (atomic increment ภายใน transaction)
const generateNextCode = async (client) => {
    await ensureImItemRunningTable(client);
    const result = await client.query(
        `SELECT * FROM im_item_running ORDER BY id LIMIT 1 FOR UPDATE`
    );
    if (result.rows.length === 0 || !result.rows[0].is_auto_numbering) return null;
    const config = result.rows[0];
    // ข้ามเลขที่ชนรหัสสินค้าที่มีอยู่แล้ว (เช่น ผู้ใช้ป้อนรหัสเองที่ตรงรูปแบบ) — ไม่งั้นบันทึกสินค้าใหม่ล้มด้วยรหัสซ้ำ
    const num = await findFreeNumber(client, config, Number(config.next_running_number));
    const code = formatItemCode(config, num);
    await client.query(
        `UPDATE im_item_running SET next_running_number = $2 WHERE id = $1`,
        [config.id, num + 1]
    );
    return code;
};

const MAX_SCAN = 10000;
const codeExists = async (client, code) =>
    (await client.query(`SELECT 1 FROM im_item WHERE UPPER(item_code) = UPPER($1) LIMIT 1`, [code])).rows.length > 0;

// เลขรันแรกตั้งแต่ start ที่รหัสยังไม่มีในระบบ (สแกนสูงสุด MAX_SCAN เลข แล้วคืน start ถ้าหาไม่เจอ)
const findFreeNumber = async (client, config, start) => {
    const s = Math.max(1, Number(start) || 1);
    const BATCH = 500;
    for (let offset = 0; offset < MAX_SCAN; offset += BATCH) {
        const batch = Array.from({ length: BATCH }, (_, i) => formatItemCode(config, s + offset + i).toUpperCase());
        const used = new Set((await client.query(
            `SELECT UPPER(item_code) AS c FROM im_item WHERE UPPER(item_code) = ANY($1::text[])`, [batch])).rows.map(r => r.c));
        const i = batch.findIndex(c => !used.has(c));
        if (i >= 0) return s + offset + i;
    }
    return s;
};

const escapeRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DATE_LEN = { YY: 2, YYYY: 4, YYMM: 4, YYYYMM: 6, YYMMDD: 6 };

// GET /im_item_running/summary?prefix=&separator=&suffix_date=&length=&next= — ข้อมูลประกอบหน้าตั้งค่า (redesign 2026-11-26)
// ค่าที่ส่งมาแทนค่าที่บันทึกไว้ (ดูผลของรูปแบบที่กำลังแก้ได้ก่อนบันทึก)
//   next_codes: 4 รหัสที่จะออกจริงถัดไป (ข้ามรหัสที่มีอยู่แล้ว), collision: รหัสของเลขรันถัดไปมีอยู่แล้ว + เลขว่างถัดไป
//   last_issued: สินค้าล่าสุดที่ออกรหัสอัตโนมัติตามรูปแบบนี้, categories: หมวดที่ออกรหัสเอง (ใช้แทนรูปแบบหน้านี้)
const getSummary = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureImItemRunningTable(client);
        const saved = (await client.query(`SELECT * FROM im_item_running ORDER BY id LIMIT 1`)).rows[0] || {};
        const q = req.query;
        const config = {
            format_prefix: q.prefix !== undefined ? String(q.prefix).toUpperCase() : (saved.format_prefix ?? 'ITEM'),
            format_separator: q.separator !== undefined ? String(q.separator) : (saved.format_separator ?? '-'),
            format_suffix_date: q.suffix_date !== undefined ? String(q.suffix_date) : (saved.format_suffix_date ?? ''),
            running_length: Math.min(10, Math.max(1, Number(q.length ?? saved.running_length ?? 4) || 4)),
            next_running_number: Math.max(1, Number(q.next ?? saved.next_running_number ?? 1) || 1),
        };
        const next = config.next_running_number;
        const nextCode = formatItemCode(config, next);

        let collision = null;
        if (await codeExists(client, nextCode)) {
            const it = (await client.query(
                `SELECT item_code, item_name_th, item_name_en FROM im_item WHERE UPPER(item_code) = UPPER($1) LIMIT 1`, [nextCode])).rows[0];
            collision = { code: nextCode, item_code: it.item_code, item_name_th: it.item_name_th, item_name_en: it.item_name_en,
                next_free: await findFreeNumber(client, config, next) };
        }

        const nextCodes = [];
        let n = collision ? collision.next_free : next;
        while (nextCodes.length < 4) {
            n = await findFreeNumber(client, config, n);
            nextCodes.push(formatItemCode(config, n));
            n += 1;
        }

        // รหัสล่าสุดที่ตรงรูปแบบ: คำนำหน้า + วันที่ (ตัวเลขตามความยาวของรูปแบบวันที่) + ตัวคั่น + เลขรัน
        const dl = DATE_LEN[config.format_suffix_date] || 0;
        const re = `^${escapeRe(config.format_prefix)}${dl ? `[0-9]{${dl}}` : ''}${escapeRe(config.format_separator)}[0-9]{${config.running_length},}$`;
        const last = (await client.query(`
            SELECT item_code, item_name_th, item_name_en, created_at FROM im_item
             WHERE is_code_auto_generated = true AND UPPER(item_code) ~ $1
             ORDER BY created_at DESC, id DESC LIMIT 1`, [re.toUpperCase()]).catch(() => ({ rows: [] }))).rows[0] || null;

        const categories = (await client.query(`
            SELECT c.id, c.category_code, c.category_name_th, c.category_name_en,
                   c.running_prefix, c.running_separator, c.running_suffix_date, c.running_length, c.running_next_number,
                   (SELECT COUNT(*)::int FROM im_item i WHERE i.category_id = c.id) AS item_count
              FROM im_item_category c
             WHERE c.is_auto_number = true
             ORDER BY c.category_code`).catch(() => ({ rows: [] }))).rows.map(c => ({
            ...c,
            sample_code: formatItemCode({ format_prefix: c.running_prefix, format_separator: c.running_separator,
                format_suffix_date: c.running_suffix_date, running_length: c.running_length, next_running_number: c.running_next_number }),
        }));

        res.status(200).json({ next_codes: nextCodes, collision, last_issued: last, categories });
    } catch (error) {
        console.error('Error fetching im_item_running summary:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

module.exports = { ensureImItemRunningTable, fetchConfig, saveConfig, previewCode, generateNextCode, getSummary };
