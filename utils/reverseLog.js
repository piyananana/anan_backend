// utils/reverseLog.js
// ประวัติการถอยเอกสารกลับเป็นร่าง การลบเอกสาร (to_status = 'Deleted') และการยกเลิก (to_status = 'Void')
// ตาราง sa_document_reverse_log, sql/sa_document_reverse_log.sql
// ใช้ร่วมทุกโมดูล: บันทึกทุกครั้งที่ถอยเอกสาร และดึงไปแสดงที่หน้าจอเอกสาร

const logReverse = async (client, { sysModule, tableName, recordId, docNo, fromStatus, toStatus = 'Draft', reason, userId }) => {
    await client.query(`
        INSERT INTO sa_document_reverse_log
            (sys_module, table_name, record_id, doc_no, from_status, to_status, reason, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [sysModule, tableName, recordId, docNo || null, fromStatus || null, toStatus, reason, userId || null]);
};

const getReverseHistory = async (db, tableName, recordId) => {
    const r = await db.query(`
        SELECT l.id, l.doc_no, l.from_status, l.to_status, l.reason, l.created_at,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.user_name) AS created_by_name
          FROM sa_document_reverse_log l
          LEFT JOIN sa_user u ON u.id = l.created_by
         WHERE l.table_name = $1 AND l.record_id = $2
         ORDER BY l.created_at DESC, l.id DESC
    `, [tableName, recordId]);
    return r.rows;
};

module.exports = { logReverse, getReverseHistory };
