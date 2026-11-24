// controllers/sa/saDashboardController.js

// GET /api/sa/dashboard/stats
const getStats = async (req, res) => {
    try {
        const pool = req.dbPool;

        // ensure session table exists (idempotent)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sa_user_session (
                id              SERIAL PRIMARY KEY,
                user_id         INT NOT NULL REFERENCES sa_user(id) ON DELETE CASCADE,
                session_token   TEXT NOT NULL,
                started_at      TIMESTAMPTZ DEFAULT NOW(),
                last_active_at  TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(user_id)
            )
        `).catch(() => {});

        const r = await pool.query(`
            WITH non_dev AS (
                SELECT id, status FROM sa_user WHERE user_type != 'developer'
            ),
            non_dev_online AS (
                SELECT s.user_id FROM sa_user_session s
                JOIN non_dev u ON u.id = s.user_id
            )
            SELECT
                (SELECT COUNT(*)::int FROM non_dev)                          AS total,
                (SELECT COUNT(*)::int FROM non_dev WHERE status = 'active')  AS active,
                (SELECT COUNT(*)::int FROM non_dev WHERE status != 'active') AS inactive,
                (SELECT COUNT(*)::int FROM non_dev_online)                   AS online
        `);

        const row = r.rows[0];
        const online         = row.online;
        const active         = row.active;
        const active_offline = Math.max(0, active - online);

        res.json({
            total: row.total,
            active,
            inactive:       row.inactive,
            online,
            active_offline,
        });
    } catch (err) {
        console.error('Dashboard stats error:', err);
        res.status(500).json({ error: err.message });
    }
};

// GET /api/sa/dashboard/db_size
const getDbSize = async (req, res) => {
    try {
        const pool = req.dbPool;

        const [modulesR, dbSizeR] = await Promise.all([
            pool.query(`
                SELECT
                    LOWER(SUBSTRING(tablename, 1, 2))                                    AS module,
                    SUM(pg_total_relation_size(schemaname || '.' || tablename))::bigint  AS size_bytes
                FROM pg_tables
                WHERE schemaname = 'public'
                GROUP BY 1
                ORDER BY 2 DESC
            `),
            pool.query(`
                SELECT pg_database_size(current_database())::bigint AS db_size
            `),
        ]);

        const modules = modulesR.rows.map(row => ({
            module:     row.module,
            size_bytes: Number(row.size_bytes),
        }));

        const modulesTotalBytes = modules.reduce((s, m) => s + m.size_bytes, 0);
        const dbTotalBytes      = Number(dbSizeR.rows[0].db_size);

        res.json({
            modules,
            modules_total_bytes: modulesTotalBytes,
            db_total_bytes:      dbTotalBytes,
        });
    } catch (err) {
        console.error('Dashboard db_size error:', err);
        res.status(500).json({ error: err.message });
    }
};

// GET /api/sa/dashboard/home_kpi — แถวตัวเลขสรุปบนหน้าแรก (งานรออนุมัตินับฝั่ง Flutter จากรายการกระดิ่ง)
//   my_drafts: เอกสารร่างที่ผู้ใช้ (header UserId/UserName) สร้าง แยกตามโมดูล
//   so_pending: ใบสั่งขายที่ยังส่งไม่ครบ (Approved / PartiallyDelivered)
//   po_pending: ใบสั่งซื้อที่ยังรับไม่ครบ (Approved / PartiallyReceived)
//   mo_active: ใบสั่งผลิตที่กำลังผลิต (Released / InProgress)
// ตารางที่ยังไม่มีในฐานข้อมูลนั้น (โมดูลยังไม่เคยใช้) นับเป็น 0
const getHomeKpi = async (req, res) => {
    const pool = req.dbPool;
    const userId = parseInt(req.headers['userid'], 10) || 0;
    const userName = req.headers['username'] || '';
    const exists = async (t) => (await pool.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t])).rows[0].ok;
    const count = async (sql, params) => {
        try { return (await pool.query(sql, params)).rows[0]; } catch (e) { console.error('home_kpi:', e.message); return null; }
    };
    try {
        // created_by: gl_entry_header เก็บ id ผู้ใช้, ตารางอื่นเก็บชื่อผู้ใช้ (บางที่อาจเก็บ id เป็นข้อความ)
        const draftTables = [
            ['GL', 'gl_entry_header', true], ['AR', 'ar_transaction'], ['AP', 'ap_transaction'],
            ['IM', 'im_transaction'], ['CM', 'cm_transaction'], ['PO', 'pr_transaction'], ['PO', 'po_transaction'],
            ['SO', 'quote_transaction'], ['SO', 'so_transaction'], ['MO', 'mo_header'],
        ];
        const byModule = {};
        let drafts = 0;
        for (const [mod, table, byId] of draftTables) {
            if (!(await exists(table))) continue;
            const r = byId
                ? await count(`SELECT COUNT(*)::int n FROM ${table} WHERE status = 'Draft' AND created_by = $1`, [userId])
                : await count(`SELECT COUNT(*)::int n FROM ${table} WHERE status = 'Draft' AND created_by IN ($1, $2)`, [userName, String(userId)]);
            const n = r?.n || 0;
            if (n) byModule[mod] = (byModule[mod] || 0) + n;
            drafts += n;
        }

        const zero = { total: 0, partial: 0 };
        const so = (await exists('so_transaction'))
            ? (await count(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status = 'PartiallyDelivered')::int partial
                            FROM so_transaction WHERE status IN ('Approved', 'PartiallyDelivered')`)) || zero
            : zero;
        const po = (await exists('po_transaction'))
            ? (await count(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status = 'PartiallyReceived')::int partial
                            FROM po_transaction WHERE status IN ('Approved', 'PartiallyReceived')`)) || zero
            : zero;
        const mo = (await exists('mo_header'))
            ? (await count(`SELECT COUNT(*)::int total,
                                   COUNT(*) FILTER (WHERE status = 'InProgress')::int in_progress,
                                   COUNT(*) FILTER (WHERE status = 'Released')::int released
                            FROM mo_header WHERE status IN ('Released', 'InProgress')`)) || { total: 0, in_progress: 0, released: 0 }
            : { total: 0, in_progress: 0, released: 0 };

        res.json({
            my_drafts: { total: drafts, by_module: byModule },
            so_pending: so,
            po_pending: po,
            mo_active: mo,
        });
    } catch (err) {
        console.error('getHomeKpi error:', err);
        res.status(500).json({ error: err.message });
    }
};

module.exports = { getStats, getDbSize, getHomeKpi };
