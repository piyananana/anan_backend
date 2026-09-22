// controllers/sa/saAttachmentController.js — ไฟล์แนบท้ายรายการแบบ generic ใช้ร่วมกันได้ทุกโมดูล (module_code +
// entity_id คือ id ของแถวที่แนบ เช่น pr_transaction_detail.id/po_transaction_detail.id) — เก็บไฟล์จริงบน disk ใต้
// public/attachments/<database>/<module_code>/<entity_id>/ แยกตามชื่อฐานข้อมูล เพราะ backend เดียวใช้ร่วมกันหลาย
// tenant (anandev/anansqa) แต่ระบบไฟล์ไม่ได้แยก pool ตาม DB เหมือนข้อมูลใน DB เอง จึงต้องกันชนกันเองตรงนี้
'use strict';
const fs = require('fs');
const path = require('path');

const PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');

const ensureAttachmentTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS sa_attachment (
            id                    SERIAL PRIMARY KEY,
            module_code           VARCHAR(50)  NOT NULL,
            entity_id             INTEGER      NOT NULL,
            file_name             VARCHAR(255) NOT NULL,
            file_path             VARCHAR(500) NOT NULL,
            file_size             INTEGER,
            mime_type             VARCHAR(100),
            source_attachment_id  INTEGER REFERENCES sa_attachment(id),
            uploaded_by           VARCHAR(100),
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sa_attachment_entity ON sa_attachment(module_code, entity_id)`);
};

// กันชื่อไฟล์ต้นฉบับที่ผู้ใช้อัปโหลดมาถูกใช้เป็นส่วนหนึ่งของ path บน disk โดยตรง (path traversal)
const sanitizeFileName = (name) => (name || 'file').replace(/[\\/]/g, '_').replace(/\.\./g, '_');

const toFullUrl = (req, filePath) => `http://${req.headers.host}/public/${filePath.replace(/\\/g, '/')}`;

const uploadAttachment = async (req, res) => {
    const { module_code, entity_id } = req.body;
    const userName = req.headers['username'] || null;
    if (!module_code || !entity_id) return res.status(400).json({ message: 'ต้องระบุ module_code และ entity_id' });
    if (!req.file) return res.status(400).json({ message: 'ไม่พบไฟล์ที่อัปโหลด' });
    const dbName = req.header('X-Database-Name');
    if (!dbName) return res.status(400).json({ message: 'ต้องระบุฐานข้อมูล (X-Database-Name)' });

    const client = await req.dbPool.connect();
    try {
        await ensureAttachmentTable(client);

        const relDir = path.join('attachments', dbName, module_code, String(entity_id));
        fs.mkdirSync(path.join(PUBLIC_ROOT, relDir), { recursive: true });

        const safeName = sanitizeFileName(req.file.originalname);
        const storedName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
        const relPath = path.join(relDir, storedName).replace(/\\/g, '/');
        fs.writeFileSync(path.join(PUBLIC_ROOT, relPath), req.file.buffer);

        const result = await client.query(`
            INSERT INTO sa_attachment (module_code, entity_id, file_name, file_path, file_size, mime_type, uploaded_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING *
        `, [module_code, Number(entity_id), req.file.originalname, relPath, req.file.size, req.file.mimetype, userName]);

        const row = result.rows[0];
        row.full_url = toFullUrl(req, row.file_path);
        res.status(201).json(row);
    } catch (error) {
        console.error('Error uploading attachment:', error);
        res.status(500).json({ message: error.message || 'Internal server error' });
    } finally { client.release(); }
};

const fetchByEntity = async (req, res) => {
    const { module_code, entity_id } = req.query;
    if (!module_code || !entity_id) return res.status(400).json({ message: 'ต้องระบุ module_code และ entity_id' });
    const client = await req.dbPool.connect();
    try {
        await ensureAttachmentTable(client);
        const result = await client.query(
            `SELECT * FROM sa_attachment WHERE module_code=$1 AND entity_id=$2 ORDER BY created_at`,
            [module_code, Number(entity_id)]
        );
        res.status(200).json(result.rows.map(r => ({ ...r, full_url: toFullUrl(req, r.file_path) })));
    } catch (error) {
        console.error('Error fetching attachments:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const fetchByEntities = async (req, res) => {
    const { module_code, entity_ids } = req.query;
    if (!module_code || !entity_ids) return res.status(400).json({ message: 'ต้องระบุ module_code และ entity_ids' });
    const ids = entity_ids.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
    const client = await req.dbPool.connect();
    try {
        await ensureAttachmentTable(client);
        const result = await client.query(
            `SELECT * FROM sa_attachment WHERE module_code=$1 AND entity_id = ANY($2::int[]) ORDER BY created_at`,
            [module_code, ids]
        );
        res.status(200).json(result.rows.map(r => ({ ...r, full_url: toFullUrl(req, r.file_path) })));
    } catch (error) {
        console.error('Error fetching attachments (batch):', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

const deleteAttachment = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await ensureAttachmentTable(client);
        const existing = await client.query(`SELECT * FROM sa_attachment WHERE id=$1`, [id]);
        if (existing.rows.length === 0) return res.status(404).json({ message: 'Not found' });
        const absPath = path.join(PUBLIC_ROOT, existing.rows[0].file_path);
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
        await client.query(`DELETE FROM sa_attachment WHERE id=$1`, [id]);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting attachment:', error);
        res.status(500).json({ message: 'Internal server error' });
    } finally { client.release(); }
};

// ใช้ตอนแปลง PR line -> PO line: คัดลอกไฟล์แนบเป็นไฟล์จริงชุดใหม่ (ไม่ share file_path เดียวกัน) เพื่อให้วงจรชีวิต
// ของไฟล์แนบฝั่ง PR และ PO เป็นอิสระต่อกันอย่างสมบูรณ์ — ลบฝั่งใดฝั่งหนึ่งภายหลังไม่กระทบอีกฝั่ง
const copyAttachmentsToEntity = async (client, { dbName, sourceModule, sourceEntityId, targetModule, targetEntityId, uploadedBy }) => {
    await ensureAttachmentTable(client);
    const sourceRows = await client.query(
        `SELECT * FROM sa_attachment WHERE module_code=$1 AND entity_id=$2`,
        [sourceModule, sourceEntityId]
    );
    if (sourceRows.rows.length === 0) return;

    const relDir = path.join('attachments', dbName, targetModule, String(targetEntityId));
    fs.mkdirSync(path.join(PUBLIC_ROOT, relDir), { recursive: true });

    for (const src of sourceRows.rows) {
        const srcAbsPath = path.join(PUBLIC_ROOT, src.file_path);
        if (!fs.existsSync(srcAbsPath)) continue; // ไฟล์ต้นทางหายไปจาก disk แล้ว — ข้าม ไม่ทำให้การสร้าง PO ทั้งใบล้มเหลว
        const storedName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${path.basename(src.file_path)}`;
        const relPath = path.join(relDir, storedName).replace(/\\/g, '/');
        fs.copyFileSync(srcAbsPath, path.join(PUBLIC_ROOT, relPath));
        await client.query(`
            INSERT INTO sa_attachment (module_code, entity_id, file_name, file_path, file_size, mime_type, source_attachment_id, uploaded_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [targetModule, targetEntityId, src.file_name, relPath, src.file_size, src.mime_type, src.id, uploadedBy || null]);
    }
};

// ใช้ตอนลบบรรทัดที่อาจมีไฟล์แนบ (เรียกก่อน DELETE แถว detail เสมอ) — ลบทั้งไฟล์จริงบน disk และแถวใน sa_attachment
const deleteAttachmentsForEntities = async (client, moduleCode, entityIds) => {
    if (!entityIds || entityIds.length === 0) return;
    await ensureAttachmentTable(client);
    const rows = await client.query(
        `SELECT * FROM sa_attachment WHERE module_code=$1 AND entity_id = ANY($2::int[])`,
        [moduleCode, entityIds]
    );
    for (const row of rows.rows) {
        const absPath = path.join(PUBLIC_ROOT, row.file_path);
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    }
    await client.query(`DELETE FROM sa_attachment WHERE module_code=$1 AND entity_id = ANY($2::int[])`, [moduleCode, entityIds]);
};

module.exports = {
    ensureAttachmentTable, uploadAttachment, fetchByEntity, fetchByEntities, deleteAttachment,
    copyAttachmentsToEntity, deleteAttachmentsForEntities,
};
