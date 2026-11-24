// controllers/sa/saFavoriteMenuController.js
// เมนูโปรดของผู้ใช้ (หน้าหลัก: แถบเมนูซ้าย + การ์ดเมนูโปรด) — เก็บต่อผู้ใช้ เรียงตาม sort_order
// ผู้ใช้ระบุจาก header UserId (ทุกคนแก้ได้เฉพาะของตัวเอง)

const ensureTable = (pool) => pool.query(`
    CREATE TABLE IF NOT EXISTS sa_user_favorite_menu (
        user_id     INT NOT NULL REFERENCES sa_user(id) ON DELETE CASCADE,
        menu_id     INT NOT NULL REFERENCES sa_menu(id) ON DELETE CASCADE,
        sort_order  INT NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, menu_id)
    )
`);

const currentUserId = (req) => {
    const id = parseInt(req.headers['userid'], 10);
    return Number.isFinite(id) && id > 0 ? id : null;
};

// GET /api/sa/sa_favorite_menu → [menu_id, ...] ตามลำดับ
const getFavorites = async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(400).json({ message: 'Missing UserId header' });
    try {
        await ensureTable(req.dbPool);
        const r = await req.dbPool.query(
            `SELECT menu_id FROM sa_user_favorite_menu WHERE user_id = $1 ORDER BY sort_order, created_at`,
            [userId]);
        res.json(r.rows.map((x) => x.menu_id));
    } catch (err) {
        console.error('getFavorites error:', err);
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/sa/sa_favorite_menu  { menu_ids: [..] } → แทนที่ทั้งรายการ (ลำดับตามที่ส่งมา)
const saveFavorites = async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(400).json({ message: 'Missing UserId header' });
    const ids = Array.isArray(req.body?.menu_ids)
        ? [...new Set(req.body.menu_ids.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0))]
        : null;
    if (!ids) return res.status(400).json({ message: 'menu_ids must be an array' });
    const client = await req.dbPool.connect();
    try {
        await ensureTable(client);
        await client.query('BEGIN');
        await client.query(`DELETE FROM sa_user_favorite_menu WHERE user_id = $1`, [userId]);
        if (ids.length) {
            // เฉพาะเมนูที่มีอยู่จริง
            await client.query(`
                INSERT INTO sa_user_favorite_menu (user_id, menu_id, sort_order)
                SELECT $1, m.id, x.ord
                FROM unnest($2::int[]) WITH ORDINALITY AS x(menu_id, ord)
                JOIN sa_menu m ON m.id = x.menu_id
            `, [userId, ids]);
        }
        await client.query('COMMIT');
        res.json(ids);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('saveFavorites error:', err);
        res.status(500).json({ message: err.message });
    } finally {
        client.release();
    }
};

module.exports = { getFavorites, saveFavorites };
