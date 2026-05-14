// controllers/sa/saDocNumberBranchController.js
// จัดการเลขที่เอกสารอัตโนมัติแยกตามสาขา

// GET /api/sa/sa_doc_number_branch?branch_id=X
// ดึงประเภทเอกสารทั้งหมด (is_auto_numbering=true) พร้อม config ของสาขานั้น (ถ้ามี)
const fetchByBranch = async (req, res) => {
  const { branch_id } = req.query;
  try {
    const result = await req.dbPool.query(`
      SELECT
        m.id              AS doc_id,
        m.doc_code,
        m.doc_name_thai,
        m.sys_module,
        m.format_prefix   AS global_prefix,
        m.format_separator AS global_separator,
        m.format_suffix_date AS global_suffix_date,
        m.running_length  AS global_running_length,
        m.next_running_number AS global_next_running,
        b.id,
        b.format_prefix,
        b.format_separator,
        b.format_suffix_date,
        b.running_length,
        b.next_running_number
      FROM sa_module_document m
      LEFT JOIN sa_doc_number_branch b
        ON b.doc_id = m.id AND b.branch_id = $1
      WHERE m.is_doc_type = TRUE
        AND m.is_active   = TRUE
        AND m.is_auto_numbering = TRUE
      ORDER BY m.sys_module, m.doc_code
    `, [branch_id || 0]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching doc number branch config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// PUT /api/sa/sa_doc_number_branch/:branchId
// บันทึก config ของสาขา: configs = รายการที่ enable, ส่วนที่ไม่อยู่ใน list จะถูกลบ
const upsertByBranch = async (req, res) => {
  const { branchId } = req.params;
  const { configs } = req.body; // [{doc_id, format_prefix, format_separator, format_suffix_date, running_length}]
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');

    const enabledDocIds = (configs || []).map(c => c.doc_id);

    // Delete rows that are no longer enabled
    if (enabledDocIds.length > 0) {
      const placeholders = enabledDocIds.map((_, i) => `$${i + 2}`).join(',');
      await client.query(
        `DELETE FROM sa_doc_number_branch WHERE branch_id = $1 AND doc_id NOT IN (${placeholders})`,
        [branchId, ...enabledDocIds]
      );
    } else {
      await client.query('DELETE FROM sa_doc_number_branch WHERE branch_id = $1', [branchId]);
    }

    // Upsert enabled configs (preserve existing counter)
    for (const c of (configs || [])) {
      await client.query(`
        INSERT INTO sa_doc_number_branch
          (doc_id, branch_id, format_prefix, format_separator, format_suffix_date, running_length, next_running_number)
        VALUES ($1, $2, $3, $4, $5, $6, 1)
        ON CONFLICT (doc_id, branch_id) DO UPDATE SET
          format_prefix      = EXCLUDED.format_prefix,
          format_separator   = EXCLUDED.format_separator,
          format_suffix_date = EXCLUDED.format_suffix_date,
          running_length     = EXCLUDED.running_length
      `, [
        c.doc_id, branchId,
        c.format_prefix      || null,
        c.format_separator   || null,
        c.format_suffix_date || null,
        c.running_length     || null,
      ]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error upserting doc number branch config:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

// POST /api/sa/sa_doc_number_branch/reset
// Reset running counter — ถ้า branch_id=null → reset global sa_module_document counter
const resetCounter = async (req, res) => {
  const { branch_id, doc_id, new_value } = req.body;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    if (branch_id) {
      const result = await client.query(
        `UPDATE sa_doc_number_branch SET next_running_number = $1
         WHERE branch_id = $2 AND doc_id = $3`,
        [new_value, branch_id, doc_id]
      );
      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'ไม่พบการตั้งค่าสาขา กรุณาตั้งค่าก่อน reset' });
      }
    } else {
      await client.query(
        `UPDATE sa_module_document SET next_running_number = $1 WHERE id = $2`,
        [new_value, doc_id]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error resetting counter:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

// PUT /api/sa/sa_doc_number_branch/:branchId/:docId — upsert single config
const upsertSingle = async (req, res) => {
  const { branchId, docId } = req.params;
  const { format_prefix, format_separator, format_suffix_date, running_length, next_running_number } = req.body;
  const client = await req.dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO sa_doc_number_branch
        (doc_id, branch_id, format_prefix, format_separator, format_suffix_date, running_length, next_running_number)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (doc_id, branch_id) DO UPDATE SET
        format_prefix      = EXCLUDED.format_prefix,
        format_separator   = EXCLUDED.format_separator,
        format_suffix_date = EXCLUDED.format_suffix_date,
        running_length     = EXCLUDED.running_length,
        next_running_number = EXCLUDED.next_running_number
    `, [
      docId, branchId,
      format_prefix      || null,
      format_separator   || null,
      format_suffix_date || null,
      running_length     || null,
      next_running_number != null ? Number(next_running_number) : 1,
    ]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error upserting single config:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
};

// DELETE /api/sa/sa_doc_number_branch/:branchId/:docId — delete single config
const deleteSingle = async (req, res) => {
  const { branchId, docId } = req.params;
  try {
    await req.dbPool.query(
      'DELETE FROM sa_doc_number_branch WHERE branch_id = $1 AND doc_id = $2',
      [branchId, docId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting single config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { fetchByBranch, upsertByBranch, upsertSingle, deleteSingle, resetCounter };
