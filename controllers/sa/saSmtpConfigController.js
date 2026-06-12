// controllers/sa/saSmtpConfigController.js

// GET config (returns first row or empty object)
const getConfig = async (req, res) => {
    try {
        const result = await req.dbPool.query(
            `SELECT id, host, port, username, from_email, from_name,
                    use_tls, is_active, updated_at
             FROM sa_smtp_config
             ORDER BY id LIMIT 1`
        );
        // Return config without exposing stored password
        res.status(200).json(result.rows[0] || null);
    } catch (error) {
        console.error('Error fetching sa_smtp_config:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// PUT upsert (create or update single config row)
const upsertConfig = async (req, res) => {
    const {
        host, port, username, password,
        from_email, from_name, use_tls, is_active
    } = req.body;
    const userName = req.headers.username;
    try {
        // Check if row exists
        const existing = await req.dbPool.query(
            'SELECT id FROM sa_smtp_config ORDER BY id LIMIT 1'
        );

        let result;
        if (existing.rows.length > 0) {
            const id = existing.rows[0].id;
            // Only update password if explicitly provided
            if (password && password.trim() !== '') {
                result = await req.dbPool.query(
                    `UPDATE sa_smtp_config SET
                       host = $1, port = $2, username = $3, password = $4,
                       from_email = $5, from_name = $6, use_tls = $7,
                       is_active = $8, updated_by = $9, updated_at = NOW()
                     WHERE id = $10 RETURNING id, host, port, username, from_email, from_name, use_tls, is_active`,
                    [host, port || 587, username || null, password,
                     from_email || null, from_name || null,
                     use_tls ?? true, is_active ?? true, userName, id]
                );
            } else {
                result = await req.dbPool.query(
                    `UPDATE sa_smtp_config SET
                       host = $1, port = $2, username = $3,
                       from_email = $4, from_name = $5, use_tls = $6,
                       is_active = $7, updated_by = $8, updated_at = NOW()
                     WHERE id = $9 RETURNING id, host, port, username, from_email, from_name, use_tls, is_active`,
                    [host, port || 587, username || null,
                     from_email || null, from_name || null,
                     use_tls ?? true, is_active ?? true, userName, id]
                );
            }
        } else {
            result = await req.dbPool.query(
                `INSERT INTO sa_smtp_config
                   (host, port, username, password, from_email, from_name,
                    use_tls, is_active, created_by, updated_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
                 RETURNING id, host, port, username, from_email, from_name, use_tls, is_active`,
                [host, port || 587, username || null, password || null,
                 from_email || null, from_name || null,
                 use_tls ?? true, is_active ?? true, userName]
            );
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error upserting sa_smtp_config:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = { getConfig, upsertConfig };
