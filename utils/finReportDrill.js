// utils/finReportDrill.js
// แตกยอดของช่องในงบการเงิน (drill-down) — เรียกจาก engine เมื่อ body มี drill = { row_id, col_seq_no, account_code? }
//   ไม่มี account_code → รายบัญชีที่ประกอบเป็นยอด (บรรทัด TOTAL ไล่บรรทัดลูกทุกชั้น)
//   มี account_code     → รายการบัญชี (gl_entry_detail) ของบัญชีนั้นในบรรทัด ACCOUNTS นั้น
// ยอดเป็นบาทเต็ม ไม่หารหน่วยของงบ (amount_unit)

const DIM_KEYS = ['branch_id', 'dim1_id', 'dim2_id', 'dim3_id', 'dim4_id', 'dim5_id'];
const LINE_LIMIT = 5000;

// ctx มาจาก engine หลังโหลดยอดบัญชีแล้ว: rows (มี acctSet), cols (คอลัมน์รายบรรทัด มี target_period_ids),
// reportCols (มี target_period_ids), glData, glMatches, periodById, isEnglish, globalFilter
// คืน { status, body }
const drillDown = async (client, ctx) => {
    const { drill, rows, cols, reportCols, glData, glMatches, periodById, isEnglish, globalFilter } = ctx;
    const colSeq = Number(drill.col_seq_no);
    const target = rows.find(r => r.id === Number(drill.row_id));
    if (!target) return { status: 404, body: { error: 'Row not found', code: 'NOT_FOUND' } };
    const notDrillable = { status: 400, body: { error: 'This cell is not an account balance', code: 'NOT_DRILLABLE' } };
    const kindOf = (r) => r.row_kind || 'ACCOUNTS';
    const reportCol = reportCols.find(c => c.col_seq_no === colSeq);
    const ownCol = (row) => cols.find(c => c.row_id === row.id && c.column_seq_no === colSeq);

    // ที่มาของยอดในช่องของบรรทัด: คอลัมน์รายบรรทัด MTD/YTD หรือคอลัมน์รายงาน AMOUNT ที่ไม่ถูกแทนค่า
    // null = ช่องนี้ของบรรทัดนี้ไม่ได้มาจากยอดบัญชี (สูตร/ข้อความ)
    const cellSource = (row) => {
        const own = ownCol(row);
        if (own) {
            return (own.column_type === 'MTD' || own.column_type === 'YTD')
                ? { periodIds: own.target_period_ids || [], colFilter: null, excludeClosing: true } : null;
        }
        return reportCol && reportCol.col_kind === 'AMOUNT'
            ? { periodIds: reportCol.target_period_ids, colFilter: reportCol, excludeClosing: reportCol.exclude_closing_entries }
            : null;
    };

    const targetKind = kindOf(target);
    if (targetKind !== 'ACCOUNTS' && targetKind !== 'TOTAL') return notDrillable;
    if (ownCol(target) && !cellSource(target)) return notDrillable; // ช่องถูกแทนค่าด้วยสูตร/ข้อความ
    if (targetKind === 'ACCOUNTS' && !cellSource(target)) return notDrillable;

    const label = (r) => (isEnglish && r.label_eng) ? r.label_eng : (r.label_thai || r.label_eng || r.row_code || `R${r.row_seq_no}`);
    const sign = (r) => (r.normal_sign === 'CREDIT' ? -1 : 1);
    const periodRange = (ids) => {
        const ps = ids.map(id => periodById.get(id)).filter(Boolean).sort((a, b) => a.start_ymd.localeCompare(b.start_ymd));
        if (ps.length === 0) return null;
        return { from: ps[0].start_ymd, to: ps[ps.length - 1].end_ymd, from_name: ps[0].period_name, to_name: ps[ps.length - 1].period_name };
    };

    if (drill.account_code) return accountLines(client, { ...ctx, target, src: cellSource(target), label, sign, periodRange });

    // บรรทัดบัญชีที่ประกอบเป็นยอด + บรรทัดที่รวมอยู่แต่แตกไม่ได้ (สูตร / ช่องที่ถูกแทนค่า)
    const parts = [];
    const skipped = [];
    const visit = (row, depth) => {
        const kind = kindOf(row);
        if (kind === 'HEADING' || kind === 'BLANK' || depth > 50) return;
        const src = cellSource(row);
        if (kind === 'ACCOUNTS') {
            if (!src) skipped.push(row);
            else if (row.acctSet) parts.push({ row, src });
            return;
        }
        if (kind !== 'TOTAL' || (ownCol(row) && !src)) { skipped.push(row); return; }
        rows.filter(r => r.parent_row_code && r.parent_row_code === row.row_code).forEach(r => visit(r, depth + 1));
    };
    visit(target, 0);

    const order = new Map(rows.map((r, i) => [r.id, i]));
    const accounts = [];
    for (const { row, src } of parts) {
        const periodSet = new Set(src.periodIds);
        const byCode = new Map();
        for (const g of glData) {
            if (!glMatches(g, row, periodSet, src.colFilter, src.excludeClosing)) continue;
            byCode.set(g.account_code, (byCode.get(g.account_code) || 0) + Number(g.end_balance || 0));
        }
        for (const [code, amt] of byCode) {
            if (Math.abs(amt) < 0.005) continue;
            accounts.push({ row_id: row.id, row_code: row.row_code, row_label: label(row), account_code: code, amount: sign(row) * amt });
        }
    }
    if (accounts.length > 0) {
        const names = await client.query(
            `SELECT account_code, account_name_thai, account_name_eng FROM gl_account WHERE account_code = ANY($1::text[])`,
            [[...new Set(accounts.map(a => a.account_code))]]);
        const nameOf = new Map(names.rows.map(a => [a.account_code, (isEnglish && a.account_name_eng) ? a.account_name_eng : a.account_name_thai]));
        accounts.forEach(a => { a.account_name = nameOf.get(a.account_code) || ''; });
    }
    accounts.sort((a, b) => (order.get(a.row_id) - order.get(b.row_id)) || a.account_code.localeCompare(b.account_code));

    const firstSrc = parts[0]?.src || cellSource(target);
    return {
        status: 200,
        body: {
            row_code: target.row_code, row_label: label(target), row_kind: targetKind,
            period: firstSrc ? periodRange(firstSrc.periodIds) : null,
            accounts,
            total: accounts.reduce((s, a) => s + a.amount, 0),
            skipped_rows: skipped.map(r => ({ row_code: r.row_code, row_label: label(r) })),
        },
    };
};

// รายการบัญชีของบัญชีเดียวในบรรทัด ACCOUNTS — ตัวกรองเดียวกับยอดในงบ
const accountLines = async (client, { drill, target, src, glData, glMatches, isEnglish, globalFilter, label, sign, periodRange }) => {
    if ((target.row_kind || 'ACCOUNTS') !== 'ACCOUNTS' || !target.acctSet || !target.acctSet.has(drill.account_code)) {
        return { status: 400, body: { error: 'Account is not part of this row', code: 'NOT_DRILLABLE' } };
    }
    // สาขา/มิติ = ตัวกรองของงบ + ของบรรทัด + ของคอลัมน์ (ถ้าขัดกัน = ไม่มีรายการ)
    const filters = {};
    let conflict = false;
    for (const k of DIM_KEYS) {
        for (const v of [globalFilter[k], target[k], src.colFilter?.[k]]) {
            if (!v) continue;
            if (filters[k] && filters[k] !== v) conflict = true;
            filters[k] = v;
        }
    }
    const acc = await client.query(
        `SELECT id, account_name_thai, account_name_eng FROM gl_account WHERE account_code = $1`, [drill.account_code]);
    const account = acc.rows[0];

    let lines = [];
    if (!conflict && account && src.periodIds.length > 0) {
        const params = [src.periodIds, account.id];
        const where = Object.entries(filters).map(([k, v]) => { params.push(v); return `COALESCE(d.${k}, 0) = $${params.length}`; });
        // รายการปิดบัญชีสิ้นปี (Step 3/4) ไม่นับ ถ้าคอลัมน์ตัดออก — ให้ตรงกับยอดในงบ
        if (src.excludeClosing) {
            where.push(`h.id NOT IN (SELECT step3_entry_id FROM gl_year_end_closing WHERE step3_entry_id IS NOT NULL
                                     UNION SELECT step4_entry_id FROM gl_year_end_closing WHERE step4_entry_id IS NOT NULL)`);
        }
        params.push(LINE_LIMIT + 1);
        const res = await client.query(`
            SELECT h.id AS header_id, to_char(h.doc_date, 'YYYY-MM-DD') AS doc_date, h.doc_no, doc.doc_code, p.period_name,
                   COALESCE(NULLIF(d.description, ''), h.description) AS description,
                   COALESCE(d.debit_lc, 0)::float8 AS debit, COALESCE(d.credit_lc, 0)::float8 AS credit
              FROM gl_entry_detail d
              JOIN gl_entry_header h ON h.id = d.header_id AND h.status = 'Posted'
              JOIN gl_posting_period p ON p.id = h.period_id
              LEFT JOIN sa_module_document doc ON doc.id = h.doc_id
             WHERE h.period_id = ANY($1::int[]) AND d.account_id = $2
               ${where.map(w => `AND ${w}`).join(' ')}
             ORDER BY h.doc_date, h.doc_no, d.line_no
             LIMIT $${params.length}`, params);
        lines = res.rows;
    }
    const truncated = lines.length > LINE_LIMIT;
    if (truncated) lines = lines.slice(0, LINE_LIMIT);

    // ยอดจากยอดสะสม (gl_balance_accum) ด้วยตัวกรองเดียวกับงบ — หน้าจอเทียบกับผลรวมรายการได้
    const periodSet = new Set(src.periodIds);
    const one = { ...target, acctSet: new Set([drill.account_code]) };
    const balance = glData.filter(g => glMatches(g, one, periodSet, src.colFilter, src.excludeClosing))
        .reduce((s, g) => s + Number(g.end_balance || 0), 0);

    return {
        status: 200,
        body: {
            row_code: target.row_code, row_label: label(target), normal_sign: target.normal_sign || 'DEBIT',
            account_code: drill.account_code,
            account_name: account ? ((isEnglish && account.account_name_eng) ? account.account_name_eng : account.account_name_thai) : '',
            period: periodRange(src.periodIds),
            lines, truncated,
            total_debit: lines.reduce((s, l) => s + l.debit, 0),
            total_credit: lines.reduce((s, l) => s + l.credit, 0),
            amount: sign(target) * balance,
        },
    };
};

module.exports = { drillDown };
