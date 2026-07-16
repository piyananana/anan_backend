// controllers/sa/saUserAuditLogController.js

// Role-visibility hierarchy: key = caller's type, value = types they can see
const TYPE_HIERARCHY = {
    developer:     ['developer', 'administrator', 'user', 'guest'],
    administrator: ['administrator', 'user', 'guest'],
    user:          ['user', 'guest'],
    guest:         ['guest'],
};

async function _ensureAuditTable(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sa_user_audit_log (
            id               BIGSERIAL PRIMARY KEY,
            user_id          INT         NOT NULL,
            user_type        VARCHAR(20),
            username         VARCHAR(100),
            full_name        VARCHAR(200),
            db_name          VARCHAR(100),
            ip_address       VARCHAR(45),
            hostname         VARCHAR(255),
            user_agent       TEXT,
            session_token    TEXT,
            login_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            logout_at        TIMESTAMPTZ,
            logout_type      VARCHAR(20),
            duration_seconds INT
        )
    `);
    // Migration: add user_type if table existed before this column was introduced
    await pool.query(`ALTER TABLE sa_user_audit_log ADD COLUMN IF NOT EXISTS user_type VARCHAR(20)`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_aul_user    ON sa_user_audit_log(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_aul_login   ON sa_user_audit_log(login_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_aul_session ON sa_user_audit_log(session_token)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_aul_utype   ON sa_user_audit_log(user_type)`);
}

// Resolve caller's user_type from DB (req.authUserId is set by injectUserRole middleware)
async function _getCallerType(pool, req) {
    const userId = req.authUserId;
    if (!userId) return 'guest';
    try {
        const r = await pool.query('SELECT user_type FROM sa_user WHERE id = $1', [userId]);
        return r.rows[0]?.user_type ?? 'guest';
    } catch (_) {
        return 'guest';
    }
}

// INSERT audit record on login — returns new row id
async function logLogin(pool, { userId, userType, username, fullName, dbName, ipAddress, hostname, userAgent, sessionToken }) {
    try {
        await _ensureAuditTable(pool);
        const r = await pool.query(`
            INSERT INTO sa_user_audit_log
                (user_id, user_type, username, full_name, db_name, ip_address, hostname, user_agent, session_token, login_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            RETURNING id
        `, [userId, userType ?? null, username ?? null, fullName ?? null, dbName ?? null,
            ipAddress ?? null, hostname ?? null, userAgent ?? null, sessionToken ?? null]);
        return r.rows[0]?.id ?? null;
    } catch (err) {
        console.error('auditLog.logLogin error:', err.message);
        return null;
    }
}

// Mark open audit record as 'forced' (kicked out by new login on same account)
async function markForced(pool, userId) {
    try {
        await _ensureAuditTable(pool);
        await pool.query(`
            UPDATE sa_user_audit_log
            SET logout_at        = NOW(),
                logout_type      = 'forced',
                duration_seconds = EXTRACT(EPOCH FROM NOW() - login_at)::int
            WHERE user_id = $1 AND logout_at IS NULL
        `, [userId]);
    } catch (err) {
        console.error('auditLog.markForced error:', err.message);
    }
}

// UPDATE audit record on logout
async function logLogout(pool, { sessionToken, logoutType = 'normal' }) {
    try {
        await _ensureAuditTable(pool);
        await pool.query(`
            UPDATE sa_user_audit_log
            SET logout_at        = NOW(),
                logout_type      = $2,
                duration_seconds = EXTRACT(EPOCH FROM NOW() - login_at)::int
            WHERE session_token = $1 AND logout_at IS NULL
        `, [sessionToken, logoutType]);
    } catch (err) {
        console.error('auditLog.logLogout error:', err.message);
    }
}

// GET /api/sa/user_audit_log
const getList = async (req, res) => {
    const pool = req.dbPool;
    try {
        await _ensureAuditTable(pool);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    const callerType   = await _getCallerType(pool, req);
    const allowedTypes = TYPE_HIERARCHY[callerType] ?? ['guest'];

    const {
        user_id,
        date_from,
        date_to,
        logout_type,
        sort_by = 'login_desc',
        page    = '1',
        limit   = '50',
    } = req.query;

    const params = [];
    const wheres = [];

    // Role-based visibility (always applied first)
    // NULL user_type = records from before this column existed; only developer sees them
    params.push(allowedTypes);
    wheres.push(`COALESCE(user_type, 'developer') = ANY($${params.length}::text[])`);

    if (user_id && user_id !== 'all') {
        params.push(parseInt(user_id, 10));
        wheres.push(`user_id = $${params.length}`);
    }
    if (date_from) {
        params.push(date_from);
        wheres.push(`login_at >= $${params.length}::date`);
    }
    if (date_to) {
        params.push(date_to);
        wheres.push(`login_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (logout_type === 'active') {
        wheres.push(`logout_at IS NULL`);
    } else if (logout_type && logout_type !== 'all') {
        params.push(logout_type);
        wheres.push(`logout_type = $${params.length}`);
    }

    const where   = 'WHERE ' + wheres.join(' AND ');
    const sortMap = {
        login_desc:    'login_at DESC',
        login_asc:     'login_at ASC',
        duration_desc: 'COALESCE(duration_seconds, EXTRACT(EPOCH FROM NOW() - login_at)::int) DESC NULLS LAST',
        duration_asc:  'COALESCE(duration_seconds, EXTRACT(EPOCH FROM NOW() - login_at)::int) ASC NULLS LAST',
    };
    const orderBy  = sortMap[sort_by] ?? sortMap.login_desc;
    const pageNum  = Math.max(1, parseInt(page,  10));
    const limitNum = Math.min(10000, Math.max(1, parseInt(limit, 10)));
    const offset   = (pageNum - 1) * limitNum;

    try {
        const [dataR, countR] = await Promise.all([
            pool.query(`
                SELECT
                    id, user_id, user_type, username, full_name, db_name,
                    ip_address, hostname,
                    TO_CHAR(login_at  AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI:SS') AS login_at_str,
                    TO_CHAR(logout_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI:SS') AS logout_at_str,
                    logout_type,
                    CASE
                        WHEN logout_at IS NOT NULL THEN duration_seconds
                        ELSE EXTRACT(EPOCH FROM NOW() - login_at)::int
                    END AS duration_seconds_display,
                    (logout_at IS NULL) AS is_active
                FROM sa_user_audit_log
                ${where}
                ORDER BY ${orderBy}
                LIMIT $${params.length + 1} OFFSET $${params.length + 2}
            `, [...params, limitNum, offset]),
            pool.query(
                `SELECT COUNT(*)::int AS total FROM sa_user_audit_log ${where}`,
                params
            ),
        ]);

        res.json({
            rows:  dataR.rows,
            total: countR.rows[0].total,
            page:  pageNum,
            limit: limitNum,
        });
    } catch (err) {
        console.error('auditLog.getList error:', err);
        res.status(500).json({ error: err.message });
    }
};

// GET /api/sa/user_audit_log/users — dropdown list filtered by caller's role
const getUsers = async (req, res) => {
    const pool = req.dbPool;
    try {
        const callerType   = await _getCallerType(pool, req);
        const allowedTypes = TYPE_HIERARCHY[callerType] ?? ['guest'];
        const r = await pool.query(`
            SELECT id, user_name,
                   TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS full_name
            FROM sa_user
            WHERE user_type = ANY($1::text[])
            ORDER BY user_name
        `, [allowedTypes]);
        res.json(r.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// GET /api/sa/user_audit_log/counts?date_from=&date_to=
const getCounts = async (req, res) => {
    const pool = req.dbPool;
    try {
        await _ensureAuditTable(pool);
        const { date_from, date_to } = req.query;

        const params = [];
        const wheres = [];
        if (date_from) { params.push(date_from); wheres.push(`login_at >= $${params.length}::date`); }
        if (date_to)   { params.push(date_to);   wheres.push(`login_at < ($${params.length}::date + INTERVAL '1 day')`); }

        const where       = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const whereActive = wheres.length
            ? 'WHERE ' + [...wheres, 'logout_at IS NULL'].join(' AND ')
            : 'WHERE logout_at IS NULL';

        const [totalR, activeR] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS cnt FROM sa_user_audit_log ${where}`, params),
            pool.query(`SELECT COUNT(*)::int AS cnt FROM sa_user_audit_log ${whereActive}`, params),
        ]);

        res.json({ total: totalR.rows[0].cnt, active: activeR.rows[0].cnt });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// DELETE /api/sa/user_audit_log/reset
const deleteLog = async (req, res) => {
    const pool = req.dbPool;
    try {
        await _ensureAuditTable(pool);
        const { date_from, date_to } = req.body ?? {};

        const params = [];
        const wheres = [];
        if (date_from) { params.push(date_from); wheres.push(`login_at >= $${params.length}::date`); }
        if (date_to)   { params.push(date_to);   wheres.push(`login_at < ($${params.length}::date + INTERVAL '1 day')`); }

        const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const r     = await pool.query(`DELETE FROM sa_user_audit_log ${where}`, params);

        res.json({ deleted: r.rowCount, message: `ลบข้อมูล ${r.rowCount} รายการเรียบร้อย` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

module.exports = { logLogin, markForced, logLogout, getList, getUsers, getCounts, deleteLog };
