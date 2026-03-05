// controllers/gl/glFinancialReportBuilderController.js

// --- gl_fin_report (Master) ---

const getReports = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`SELECT * FROM gl_fin_report ORDER BY report_code`);
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const createReport = async (req, res) => {
    const { report_code, report_name_thai, is_active, parenthesis_for_minus, page_orientation, margin_top, margin_right, margin_bottom, margin_left } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `INSERT INTO gl_fin_report (report_code, report_name_thai, is_active, parenthesis_for_minus, page_orientation, margin_top, margin_right, margin_bottom, margin_left)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [report_code, report_name_thai, is_active ?? true, parenthesis_for_minus ?? true,
             page_orientation ?? 'PORTRAIT', margin_top ?? 30, margin_right ?? 30, margin_bottom ?? 30, margin_left ?? 30]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const updateReport = async (req, res) => {
    const { id } = req.params;
    const { report_code, report_name_thai, is_active, parenthesis_for_minus, page_orientation, margin_top, margin_right, margin_bottom, margin_left } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `UPDATE gl_fin_report SET report_code=$1, report_name_thai=$2, is_active=$3, parenthesis_for_minus=$4,
             page_orientation=$5, margin_top=$6, margin_right=$7, margin_bottom=$8, margin_left=$9
             WHERE id=$10 RETURNING *`,
            [report_code, report_name_thai, is_active, parenthesis_for_minus, page_orientation,
             margin_top, margin_right, margin_bottom, margin_left, id]
        );
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const deleteReport = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        // ลบ columns ก่อน แล้วลบ rows แล้วลบ master
        const rowRes = await client.query(`SELECT id FROM gl_fin_report_row WHERE report_id=$1`, [id]);
        const rowIds = rowRes.rows.map(r => r.id);
        if (rowIds.length > 0) {
            await client.query(`DELETE FROM gl_fin_report_column WHERE row_id = ANY($1::int[])`, [rowIds]);
        }
        await client.query(`DELETE FROM gl_fin_report_row WHERE report_id=$1`, [id]);
        await client.query(`DELETE FROM gl_fin_report WHERE id=$1`, [id]);
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- gl_fin_report_row ---

const getRows = async (req, res) => {
    const { report_id } = req.params;
    const client = await req.dbPool.connect();
    try {
        const rowRes = await client.query(
            `SELECT * FROM gl_fin_report_row WHERE report_id=$1 ORDER BY row_seq_no`, [report_id]
        );
        const rows = rowRes.rows;
        const rowIds = rows.map(r => r.id);
        let cols = [];
        if (rowIds.length > 0) {
            const colRes = await client.query(
                `SELECT * FROM gl_fin_report_column WHERE row_id = ANY($1::int[]) ORDER BY row_id, column_seq_no`, [rowIds]
            );
            cols = colRes.rows;
        }
        const result = rows.map(row => ({ ...row, columns: cols.filter(c => c.row_id === row.id) }));
        res.status(200).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const createRow = async (req, res) => {
    const { report_id, row_seq_no, row_type, print_control, account_from, account_to, normal_sign, branch_id, project_id, business_unit_id } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `INSERT INTO gl_fin_report_row (report_id, row_seq_no, row_type, print_control, account_from, account_to, normal_sign, branch_id, project_id, business_unit_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [report_id, row_seq_no, row_type, print_control ?? 'SHOW',
             account_from || null, account_to || null, normal_sign,
             branch_id || null, project_id || null, business_unit_id || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const updateRow = async (req, res) => {
    const { id } = req.params;
    const { row_seq_no, row_type, print_control, account_from, account_to, normal_sign, branch_id, project_id, business_unit_id } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `UPDATE gl_fin_report_row SET row_seq_no=$1, row_type=$2, print_control=$3,
             account_from=$4, account_to=$5, normal_sign=$6, branch_id=$7, project_id=$8, business_unit_id=$9
             WHERE id=$10 RETURNING *`,
            [row_seq_no, row_type, print_control,
             account_from || null, account_to || null, normal_sign,
             branch_id || null, project_id || null, business_unit_id || null, id]
        );
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const deleteRow = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query(`DELETE FROM gl_fin_report_column WHERE row_id=$1`, [id]);
        await client.query(`DELETE FROM gl_fin_report_row WHERE id=$1`, [id]);
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// --- gl_fin_report_column ---

const createColumn = async (req, res) => {
    const { row_id, column_seq_no, column_type, description_thai, data_type, column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `INSERT INTO gl_fin_report_column (row_id, column_seq_no, column_type, description_thai, data_type, column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [row_id, column_seq_no, column_type, description_thai || null, data_type || null,
             column_flex ?? 1, indent_level ?? 0, font_size ?? 10,
             font_weight ?? 'NORMAL', text_align ?? 'LEFT', period_offset ?? 0, formula_text || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const updateColumn = async (req, res) => {
    const { id } = req.params;
    const { column_seq_no, column_type, description_thai, data_type, column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text } = req.body;
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(
            `UPDATE gl_fin_report_column SET column_seq_no=$1, column_type=$2, description_thai=$3, data_type=$4,
             column_flex=$5, indent_level=$6, font_size=$7, font_weight=$8, text_align=$9, period_offset=$10, formula_text=$11
             WHERE id=$12 RETURNING *`,
            [column_seq_no, column_type, description_thai || null, data_type || null,
             column_flex, indent_level, font_size, font_weight, text_align, period_offset, formula_text || null, id]
        );
        res.status(200).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

const deleteColumn = async (req, res) => {
    const { id } = req.params;
    const client = await req.dbPool.connect();
    try {
        await client.query(`DELETE FROM gl_fin_report_column WHERE id=$1`, [id]);
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = {
    getReports, createReport, updateReport, deleteReport,
    getRows, createRow, updateRow, deleteRow,
    createColumn, updateColumn, deleteColumn,
};
