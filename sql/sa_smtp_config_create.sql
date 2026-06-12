-- sa_smtp_config: single-row SMTP email server configuration
CREATE TABLE IF NOT EXISTS sa_smtp_config (
    id          SERIAL PRIMARY KEY,
    host        VARCHAR(200) NOT NULL,
    port        INTEGER      NOT NULL DEFAULT 587,
    username    VARCHAR(200),
    password    TEXT,                                  -- stored encrypted in production
    from_email  VARCHAR(200),
    from_name   VARCHAR(200),
    use_tls     BOOLEAN      NOT NULL DEFAULT TRUE,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by  VARCHAR(100),
    updated_by  VARCHAR(100)
);
