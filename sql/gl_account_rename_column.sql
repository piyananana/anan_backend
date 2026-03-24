-- Rename column: is_control_account → is_normal_account in gl_account
ALTER TABLE gl_account RENAME COLUMN is_control_account TO is_normal_account;
