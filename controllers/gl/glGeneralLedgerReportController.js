// ดึงข้อมูลรายการเคลื่อนไหวสำหรับบัญชีแยกประเภท (GL Report)
const getGeneralLedgerTransactions = async (req, res) => {
    const { period_id, account_from, account_to } = req.query;
    const client = await req.dbPool.connect();

    try {
        let sql = `
            SELECT 
                d.account_id, a.account_code, a.account_name_thai, a.normal_balance,
                d.branch_id, d.business_unit_id, d.project_id,
                h.doc_date, doc.doc_code, h.doc_no, d.line_no,
                ref_doc.doc_code AS ref_doc_code, h.ref_doc_no, h.ref_doc_date,
                d.description, d.debit_lc, d.credit_lc
            FROM gl_entry_detail d
            JOIN gl_entry_header h ON d.header_id = h.id
            JOIN gl_account a ON d.account_id = a.id
            LEFT JOIN sa_module_document doc ON h.doc_id = doc.id
            LEFT JOIN sa_module_document ref_doc ON h.ref_doc_id = ref_doc.id
            WHERE h.period_id = $1 
              AND h.status = 'Posted' -- ดึงเฉพาะรายการที่ผ่านบัญชีแล้ว
        `;
        
        const params = [period_id];

        // กรองช่วงรหัสบัญชี (From - To) โดยใช้ string comparison กับ account_code
        if (account_from) {
            params.push(account_from);
            sql += ` AND a.account_code >= $${params.length}`;
        }
        if (account_to) {
            params.push(account_to);
            sql += ` AND a.account_code <= $${params.length}`;
        }

        // เรียงลำดับตาม รหัสบัญชี -> สาขา -> หน่วยงาน -> โครงการ -> วันที่ -> เลขที่เอกสาร -> ลำดับ
        sql += ` ORDER BY a.account_code ASC, d.branch_id ASC, d.business_unit_id ASC, d.project_id ASC, h.doc_date ASC, h.doc_no ASC, d.line_no ASC`;

        const result = await client.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Error in getGeneralLedgerTransactions:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = {
    getGeneralLedgerTransactions
};