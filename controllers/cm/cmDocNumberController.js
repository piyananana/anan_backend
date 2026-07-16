// controllers/cm/cmDocNumberController.js
'use strict';

const ensureTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS cm_doc_number_config (
            id                  SERIAL PRIMARY KEY,
            cm_doc_type         VARCHAR(30) NOT NULL,
            branch_id           INTEGER REFERENCES cd_branch(id),
            prefix              VARCHAR(20) NOT NULL DEFAULT '',
            separator           VARCHAR(5)  NOT NULL DEFAULT '-',
            date_suffix         VARCHAR(20) NOT NULL DEFAULT 'YYYYMM',
            running_length      INTEGER     NOT NULL DEFAULT 4,
            next_running_number INTEGER     NOT NULL DEFAULT 1,
            reset_period        VARCHAR(20) NOT NULL DEFAULT 'YEARLY',
            last_reset_date     DATE,
            is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
            created_by          VARCHAR(100),
            created_at          TIMESTAMPTZ DEFAULT NOW(),
            updated_at          TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (cm_doc_type, branch_id)
        )
    `);
};

// Build the doc number string for a given config + date (does NOT increment)
const buildDocNo = (config, date) => {
    const d = new Date(date);
    const year   = d.getFullYear().toString();
    const month  = (d.getMonth() + 1).toString().padStart(2, '0');
    const day    = d.getDate().toString().padStart(2, '0');

    let suffix = '';
    switch (config.date_suffix) {
        case 'YY':       suffix = year.substring(2); break;
        case 'YYYY':     suffix = year; break;
        case 'YYMM':     suffix = year.substring(2) + month; break;
        case 'YYYYMM':   suffix = year + month; break;
        case 'YYYYMMDD': suffix = year + month + day; break;
        default:         suffix = ''; break;
    }

    const sep = config.separator || '';
    const num = config.next_running_number.toString().padStart(config.running_length || 4, '0');
    return `${config.prefix}${suffix}${sep}${num}`;
};

const fetchRows = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            SELECT c.*,
                   b.branch_code      AS branch_code,
                   b.branch_name_thai AS branch_name_thai
            FROM cm_doc_number_config c
            LEFT JOIN cd_branch b ON b.id = c.branch_id
            ORDER BY c.cm_doc_type, b.branch_code NULLS FIRST`);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

const createRow = async (req, res) => {
    const { cm_doc_type, branch_id, prefix, separator, date_suffix,
            running_length, next_running_number, reset_period, is_active } = req.body;
    if (!cm_doc_type) return res.status(400).json({ error: 'ต้องระบุ cm_doc_type' });
    const createdBy = req.headers.username || 'system';
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            INSERT INTO cm_doc_number_config
                (cm_doc_type, branch_id, prefix, separator, date_suffix,
                 running_length, next_running_number, reset_period, is_active, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING *`,
            [cm_doc_type, branch_id || null, prefix || '', separator ?? '-',
             date_suffix || 'YYYYMM', running_length || 4,
             next_running_number || 1, reset_period || 'YEARLY',
             is_active ?? true, createdBy]);
        res.status(201).json(r.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'ประเภทเอกสาร + สาขา นี้มีอยู่แล้ว' });
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const { prefix, separator, date_suffix, running_length,
            next_running_number, reset_period, is_active, branch_id } = req.body;
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(`
            UPDATE cm_doc_number_config SET
                branch_id           = $1,
                prefix              = $2,
                separator           = $3,
                date_suffix         = $4,
                running_length      = $5,
                next_running_number = $6,
                reset_period        = $7,
                is_active           = $8,
                updated_at          = NOW()
            WHERE id = $9 RETURNING *`,
            [branch_id || null, prefix || '', separator ?? '-',
             date_suffix || 'YYYYMM', running_length || 4,
             next_running_number || 1, reset_period || 'YEARLY',
             is_active ?? true, id]);
        if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
        res.json(r.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'ประเภทเอกสาร + สาขา นี้มีอยู่แล้ว' });
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
};

const deleteRow = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        const r = await client.query(
            `DELETE FROM cm_doc_number_config WHERE id=$1 RETURNING id`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

// Preview: return what the next doc number would look like for a type+branch+date (no increment)
const previewDocNo = async (req, res) => {
    const { cm_doc_type, branch_id, date } = req.query;
    if (!cm_doc_type || !date) return res.status(400).json({ error: 'ต้องระบุ cm_doc_type และ date' });

    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        // Priority: branch-specific first, then global (NULL branch_id)
        let r = null;
        if (branch_id) {
            r = await client.query(
                `SELECT * FROM cm_doc_number_config WHERE cm_doc_type=$1 AND branch_id=$2 AND is_active=TRUE LIMIT 1`,
                [cm_doc_type, branch_id]);
        }
        if (!r || !r.rows.length) {
            r = await client.query(
                `SELECT * FROM cm_doc_number_config WHERE cm_doc_type=$1 AND branch_id IS NULL AND is_active=TRUE LIMIT 1`,
                [cm_doc_type]);
        }
        if (!r || !r.rows.length) {
            return res.json({ doc_no: null, message: 'ไม่พบ config สำหรับประเภทนี้' });
        }
        const docNo = buildDocNo(r.rows[0], date);
        res.json({ doc_no: docNo, config_id: r.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { client.release(); }
};

module.exports = { fetchRows, createRow, updateRow, deleteRow, previewDocNo };
