-- ลบ legacy boolean flags ที่ถูกแทนด้วย gl_account_dim_rule framework
-- branch_required ยังคงไว้เพราะยังไม่มี equivalent ใน dimension framework
ALTER TABLE gl_account DROP COLUMN IF EXISTS cost_center_required;
ALTER TABLE gl_account DROP COLUMN IF EXISTS project_required;
