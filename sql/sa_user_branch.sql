-- Phase 1: User-Branch Assignment
-- กำหนดสาขาที่ผู้ใช้มีสิทธิ์เข้าถึง

CREATE TABLE IF NOT EXISTS sa_user_branch (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES sa_user(id) ON DELETE CASCADE,
  branch_id  INT NOT NULL REFERENCES cd_branch(id) ON DELETE CASCADE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, branch_id)
);

-- Ensure only one default branch per user
CREATE UNIQUE INDEX IF NOT EXISTS uq_sa_user_branch_default
  ON sa_user_branch (user_id)
  WHERE is_default = TRUE;
