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

module.exports = { getStats, getDbSize };
