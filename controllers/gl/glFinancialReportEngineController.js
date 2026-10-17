// File: controllers/gl/glFinancialReportEngineController.js
const { loadAccounts, buildAccountIndex, rowSelections, resolveRowAccounts } = require('../../utils/finReportAccounts');
const { parse: parseFormula, evaluate: evaluateFormula, FormulaError } = require('../../utils/finReportFormula');
const { drillDown } = require('../../utils/finReportDrill');

const getReportMasterList = async (req, res) => {
    const client = await req.dbPool.connect();
    try {
        const result = await client.query(`
            SELECT id, report_code, report_name_thai 
            FROM gl_fin_report 
            WHERE is_active = true 
            ORDER BY id
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Fetch Report Master Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

// วันที่แบบยาวสำหรับหัวงบ: '2026-12-31' → '31 ธันวาคม 2569' / '31 December 2026'
const MONTHS_TH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (ymd, isEnglish) => {
    if (!ymd) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    return isEnglish ? `${d} ${MONTHS_EN[m - 1]} ${y}` : `${d} ${MONTHS_TH[m - 1]} ${y + 543}`;
};
const amountUnitLabel = (unit, isEnglish) => {
    if (unit === 1000) return isEnglish ? 'Thousand Baht' : 'พันบาท';
    if (unit === 1000000) return isEnglish ? 'Million Baht' : 'ล้านบาท';
    return isEnglish ? 'Baht' : 'บาท';
};

const generateFinancialReport = async (req, res) => {
    // preview =เรียกจากหน้าออกแบบ — แสดงได้แม้รายงานยังไม่เปิดใช้งาน
    // drill = { row_id, col_seq_no, account_code? } → แตกยอดของช่องนั้นเป็นรายบัญชี (หรือรายการบัญชีของ account_code)
    //         แทนการคืนทั้งงบ (ดู drillDown ด้านล่าง)
    const { report_id, base_period_id, branch_id, dim1_id, dim2_id, dim3_id, dim4_id, dim5_id, lang, preview, drill } = req.body;
    const isEnglish = lang === 'en';
    const branchId = branch_id  ? parseInt(branch_id)  : null;
    const d1 = dim1_id ? parseInt(dim1_id) : null;
    const d2 = dim2_id ? parseInt(dim2_id) : null;
    const d3 = dim3_id ? parseInt(dim3_id) : null;
    const d4 = dim4_id ? parseInt(dim4_id) : null;
    const d5 = dim5_id ? parseInt(dim5_id) : null;
    const client = await req.dbPool.connect();

    try {
        // 1. ดึงข้อมูล Master (gl_fin_report)
        const masterRes = await client.query(
            `SELECT * FROM gl_fin_report WHERE id = $1 AND (is_active = true OR $2::boolean)`, [report_id, preview === true]);
        if (masterRes.rows.length === 0) throw new Error('ไม่พบรายงานนี้ในระบบ');
        const master = masterRes.rows[0];

        // 2. ดึงข้อมูลบรรทัด (Row) ทั้งหมด
        const rowRes = await client.query(`SELECT * FROM gl_fin_report_row WHERE report_id = $1 ORDER BY row_seq_no ASC`, [report_id]);
        const rows = rowRes.rows;
        const rowIds = rows.map(r => r.id);

        // 3. ดึงข้อมูลคอลัมน์ (Column) ทั้งหมดที่ผูกกับบรรทัดเหล่านั้น
        let cols = [];
        if (rowIds.length > 0) {
            const colRes = await client.query(`SELECT * FROM gl_fin_report_column WHERE row_id = ANY($1::int[]) ORDER BY row_id, column_seq_no ASC`, [rowIds]);
            cols = colRes.rows;
        }

        // 3.1 คอลัมน์ระดับรายงาน (gl_fin_report_col) — ใช้กับทุกบรรทัด
        //     ถ้าบรรทัดมีคอลัมน์รายบรรทัดที่ seq ตรงกัน ช่องนั้นใช้คอลัมน์รายบรรทัดแทน (override)
        const reportColRes = await client.query(
            `SELECT * FROM gl_fin_report_col WHERE report_id = $1 ORDER BY col_seq_no ASC`, [report_id]);
        const reportCols = reportColRes.rows;
        const reportColByCode = new Map(reportCols.map(rc => [rc.col_code, rc]));

        // 3.2 เงื่อนไขเลือกบัญชีของบรรทัด (gl_fin_report_row_acct) → row.acctSet = Set ของรหัสบัญชี
        //     (null = บรรทัดไม่ได้เลือกบัญชี)
        let acctIndex = null;
        if (rows.some(r => (r.row_kind || 'ACCOUNTS') === 'ACCOUNTS')) {
            const selRes = await client.query(
                `SELECT * FROM gl_fin_report_row_acct WHERE row_id = ANY($1::int[]) ORDER BY row_id, seq_no, id`, [rowIds]);
            acctIndex = buildAccountIndex(await loadAccounts(client));
            rows.forEach(r => {
                r.acctSet = resolveRowAccounts(acctIndex, rowSelections(r, selRes.rows.filter(s => s.row_id === r.id)));
            });
        }

        // ====================================================================
        // STEP 2: โหลดข้อมูล Period ทั้งหมดเพื่อคำนวณ Offset อย่างรวดเร็ว
        // ====================================================================
        const periodsRes = await client.query(`
            SELECT 
                p.id AS period_id, 
                p.period_number, 
                p.fiscal_year_id, 
                p.period_start_date,
                p.period_name,
                y.fy_code,
                y.year_start_date,
                to_char(p.period_start_date, 'YYYY-MM-DD') AS start_ymd,
                to_char(p.period_end_date, 'YYYY-MM-DD') AS end_ymd,
                to_char(y.year_start_date, 'YYYY-MM-DD') AS year_start_ymd
            FROM gl_posting_period p
            JOIN gl_fiscal_year y ON p.fiscal_year_id = y.id
            ORDER BY p.period_start_date ASC, p.period_end_date ASC
        `);
        const allPeriods = periodsRes.rows;
        const periodById = new Map(allPeriods.map(p => [p.period_id, p]));

        const baseIndex = allPeriods.findIndex(p => p.period_id === base_period_id);
        if (baseIndex === -1) throw new Error('ไม่พบงวดบัญชีที่ระบุในระบบ');
        const basePeriodInfo = allPeriods[baseIndex]; 

        let requiredPeriodIds = new Set();

        // ====================================================================
        // STEP 3: หาเป้าหมาย period_ids สำหรับแต่ละคอลัมน์ (MTD, YTD)
        // ====================================================================
        cols.forEach(col => {
            const offset = col.period_offset || 0;

            if (col.column_type === 'MTD') {
                const targetIndex = baseIndex + offset;
                if (targetIndex >= 0 && targetIndex < allPeriods.length) {
                    const targetPeriod = allPeriods[targetIndex];
                    col.target_period_ids = [targetPeriod.period_id];
                    requiredPeriodIds.add(targetPeriod.period_id);
                } else {
                    col.target_period_ids = []; 
                }
            } 
            else if (col.column_type === 'YTD') {
                let targetPeriod = null;
                if (offset === 0) {
                    targetPeriod = basePeriodInfo;
                } else {
                    const targetYearValue = parseInt(basePeriodInfo.fy_code) + offset;
                    targetPeriod = allPeriods.find(p => 
                        p.period_number === basePeriodInfo.period_number && 
                        parseInt(p.fy_code) === targetYearValue
                    );
                }

                if (targetPeriod) {
                    const ytdPeriods = allPeriods.filter(p => 
                        p.fiscal_year_id === targetPeriod.fiscal_year_id &&
                        p.period_number <= targetPeriod.period_number
                    );
                    col.target_period_ids = ytdPeriods.map(p => p.period_id);
                    col.target_period_ids.forEach(id => requiredPeriodIds.add(id));
                } else {
                    col.target_period_ids = [];
                }
            }
        });

        // คอลัมน์ระดับรายงาน: เลื่อนปี (งวดเดียวกันของปีบัญชีอื่น) แล้วเลื่อนงวด จากนั้นขยายเป็นช่วง
        const periodsOfRange = (target, range) => {
            const sameYear = allPeriods.filter(p => p.fiscal_year_id === target.fiscal_year_id);
            if (range === 'MTD') return [target];
            if (range === 'FULL_YEAR') return sameYear;
            if (range === 'QTD') {
                const q = Math.ceil(target.period_number / 3);
                return sameYear.filter(p => Math.ceil(p.period_number / 3) === q && p.period_number <= target.period_number);
            }
            return sameYear.filter(p => p.period_number <= target.period_number); // YTD
        };

        reportCols.forEach(rc => {
            let idx = baseIndex;
            if (rc.offset_years) {
                const targetYearValue = parseInt(basePeriodInfo.fy_code) + rc.offset_years;
                idx = allPeriods.findIndex(p =>
                    p.period_number === basePeriodInfo.period_number && parseInt(p.fy_code) === targetYearValue);
            }
            if (idx !== -1) idx += rc.offset_periods || 0;
            rc.target_period = idx >= 0 && idx < allPeriods.length ? allPeriods[idx] : null;
            rc.range_periods = rc.target_period ? periodsOfRange(rc.target_period, rc.period_range) : [];
            rc.target_period_ids = rc.range_periods.map(p => p.period_id);
            rc.target_period_ids.forEach(id => requiredPeriodIds.add(id));
        });

        // ====================================================================
        // STEP 4: ดึงข้อมูลยอดบัญชี (GL Data) จาก DB รวดเดียว
        // ====================================================================
        const reqPeriodArr = Array.from(requiredPeriodIds);
        let glData = [];
        
        if (reqPeriodArr.length > 0) {
            // กรอง global branch + dimension filter จาก request
            const glDataRes = await client.query(`
                SELECT a.account_code, b.period_id, b.end_balance, c.branch_id, c.dim1_id, c.dim2_id, c.dim3_id, c.dim4_id, c.dim5_id
                FROM gl_balance_accum b
                JOIN gl_dim_combination c ON c.id = b.combo_id
                JOIN gl_account a ON b.account_id = a.id
                WHERE b.period_id = ANY($1::int[])
                  AND ($2::int IS NULL OR c.branch_id = $2)
                  AND ($3::int IS NULL OR c.dim1_id = $3)
                  AND ($4::int IS NULL OR c.dim2_id = $4)
                  AND ($5::int IS NULL OR c.dim3_id = $5)
                  AND ($6::int IS NULL OR c.dim4_id = $6)
                  AND ($7::int IS NULL OR c.dim5_id = $7)
            `, [reqPeriodArr, branchId, d1, d2, d3, d4, d5]);
            glData = glDataRes.rows;

            // ตัดผลของรายการปิดบัญชีสิ้นปี (Step 3 ปิดรายได้/ค่าใช้จ่าย, Step 4 โอนเข้ากำไรสะสม) ออก
            // รายการเหล่านี้ลงในงวดสุดท้ายของปี ถ้าไม่ตัดออก งบกำไรขาดทุน YTD งวดสุดท้ายจะเป็นศูนย์
            // (Step 5 ยอดยกมาในงวด 1 ของปีใหม่ ยังคงไว้ เพราะเป็นยอดตั้งต้นของงบแสดงฐานะการเงิน)
            // combo ของยอดสะสม: สาขาจากหัวรายการ + มิติ 1-5 จากบรรทัด (ตาม trigger ใน sql/gl_balance_accum_trigger.sql)
            const closingRes = await client.query(`
                SELECT a.account_code, h.period_id,
                       COALESCE(h.branch_id, 0) AS branch_id,
                       COALESCE(d.dim1_id, 0) AS dim1_id, COALESCE(d.dim2_id, 0) AS dim2_id,
                       COALESCE(d.dim3_id, 0) AS dim3_id, COALESCE(d.dim4_id, 0) AS dim4_id,
                       COALESCE(d.dim5_id, 0) AS dim5_id,
                       SUM(COALESCE(d.debit_lc, 0) - COALESCE(d.credit_lc, 0)) AS net_amount
                FROM gl_year_end_closing yc
                JOIN gl_entry_header h ON h.id IN (yc.step3_entry_id, yc.step4_entry_id) AND h.status = 'Posted'
                JOIN gl_entry_detail d ON d.header_id = h.id
                JOIN gl_account a ON a.id = d.account_id
                WHERE h.period_id = ANY($1::int[])
                  AND ($2::int IS NULL OR COALESCE(h.branch_id, 0) = $2)
                  AND ($3::int IS NULL OR COALESCE(d.dim1_id, 0) = $3)
                  AND ($4::int IS NULL OR COALESCE(d.dim2_id, 0) = $4)
                  AND ($5::int IS NULL OR COALESCE(d.dim3_id, 0) = $5)
                  AND ($6::int IS NULL OR COALESCE(d.dim4_id, 0) = $6)
                  AND ($7::int IS NULL OR COALESCE(d.dim5_id, 0) = $7)
                GROUP BY a.account_code, h.period_id, 3, 4, 5, 6, 7, 8
            `, [reqPeriodArr, branchId, d1, d2, d3, d4, d5]);
            closingRes.rows.forEach(c => glData.push({ ...c, end_balance: -Number(c.net_amount), is_closing_adj: true }));
        }

        // รวมยอดของบรรทัดตามงวด + เงื่อนไขของบรรทัด + เงื่อนไขของคอลัมน์ (ถ้ามี) แล้วกลับเครื่องหมายตาม normal_sign
        // excludeClosing=false → ไม่หักรายการปิดบัญชีออก (ได้ยอดหลังปิดบัญชี)
        const dimKeys = ['branch_id', 'dim1_id', 'dim2_id', 'dim3_id', 'dim4_id', 'dim5_id'];
        // ยอดบัญชีหารด้วยหน่วยของงบ (พันบาท/ล้านบาท) ก่อนคำนวณสูตร — สูตรอัตราส่วน/ร้อยละจึงไม่เพี้ยนตามหน่วย
        const amountUnit = Number(master.amount_unit) || 1;
        const glMatches = (g, row, periodSet, colFilter, excludeClosing) => {
            if (!periodSet.has(g.period_id)) return false;
            if (g.is_closing_adj && !excludeClosing) return false;
            if (!row.acctSet.has(g.account_code)) return false;
            // กรองตาม Dimension ที่ระบุไว้ในบรรทัด และในคอลัมน์
            if (dimKeys.some(k => row[k] && g[k] !== row[k])) return false;
            if (colFilter && dimKeys.some(k => colFilter[k] && g[k] !== colFilter[k])) return false;
            return true;
        };
        const sumRow = (row, targetIds, colFilter, excludeClosing) => {
            if (targetIds.length === 0 || !row.acctSet) return 0;
            const periodSet = new Set(targetIds);
            let total = 0;
            for (const g of glData) {
                if (glMatches(g, row, periodSet, colFilter, excludeClosing)) total += Number(g.end_balance || 0);
            }
            total /= amountUnit;
            // สลับเครื่องหมายตาม normal_sign (บัญชีปกติฝั่ง Credit เช่น หนี้สิน/ทุน/รายได้ แสดงเป็นบวก)
            return row.normal_sign === 'CREDIT' ? -total : total;
        };

        if (drill) {
            const result = await drillDown(client, {
                drill, rows, cols, reportCols, glData, glMatches, periodById, isEnglish,
                globalFilter: { branch_id: branchId, dim1_id: d1, dim2_id: d2, dim3_id: d3, dim4_id: d4, dim5_id: d5 },
            });
            return res.status(result.status).json(result.body);
        }

        // ====================================================================
        // STEP 5: ประกอบร่างข้อมูล (Pass 1 - หยอดค่า TEXT, คำนวณ MTD, YTD)
        // ====================================================================
        // ชนิดบรรทัด (row_kind): ACCOUNTS = ยอดจากช่วงบัญชี, TOTAL = รวมบรรทัดลูก (parent_row_code),
        // FORMULA = row_formula ทุกคอลัมน์ตัวเลข, HEADING/BLANK = ไม่มียอด
        const labelCol = reportCols.find(rc => rc.col_kind === 'LABEL');
        const rowLabel = (row) => (isEnglish && row.label_eng) ? row.label_eng : (row.label_thai || row.label_eng || '');
        // ช่องยอดบัญชี → ที่มาของยอด (งวด/ตัวกรองคอลัมน์) ใช้คำนวณซ้ำรายบัญชีตอนแตกบรรทัด (expand_mode)
        const cellSrc = new Map();

        let reportData = rows.map(row => {
            const myCols = cols.filter(c => c.row_id === row.id);
            const kind = row.row_kind || 'ACCOUNTS';
            // ช่องตัวเลขของบรรทัด TOTAL/FORMULA คำนวณทีหลังใน STEP 6 (calc)
            const derivedCalc = kind === 'TOTAL' ? 'TOTAL' : kind === 'FORMULA' ? 'ROWF' : null;
            const hasAccounts = kind === 'ACCOUNTS' && !!row.acctSet;
            // บรรทัดหัวงบ/ท้ายงบ: ไม่ใช้คอลัมน์ของรายงาน
            const isHeaderFooter = row.row_type === 'HEADER' || row.row_type === 'FOOTER';

            let processedColumns = myCols.map(col => {
                let cellValue = null;
                let calc;

                if (col.column_type === 'TEXT') {
                    cellValue = (isEnglish && col.description_eng) ? col.description_eng : col.description_thai;
                }
                else if (col.column_type === 'DIVIDER') {
                    cellValue = '---';
                }
                else if (col.column_type === 'MTD' || col.column_type === 'YTD') {
                    if (derivedCalc) calc = derivedCalc;
                    else cellValue = hasAccounts ? sumRow(row, col.target_period_ids || [], null, true) : 0;
                }

                const cell = {
                    seq_no: col.column_seq_no,
                    type: col.column_type,
                    data_type: col.data_type,
                    value: cellValue,
                    formula_text: col.formula_text,
                    flex: col.column_flex,
                    indent_level: col.indent_level,
                    style: {
                        fontSize: col.font_size,
                        fontWeight: col.font_weight,
                        textAlign: col.text_align
                    },
                    ...(calc ? { calc } : {}),
                    ...((col.column_type === 'MTD' || col.column_type === 'YTD') && (hasAccounts || kind === 'TOTAL') ? { drill: true } : {}),
                };
                if ((col.column_type === 'MTD' || col.column_type === 'YTD') && hasAccounts) {
                    cellSrc.set(cell, { periodIds: col.target_period_ids || [], colFilter: null, excludeClosing: true });
                }
                // แทนค่าเฉพาะช่องของคอลัมน์รายงาน: ใช้ความกว้าง/การจัดวาง/การซ่อนของคอลัมน์รายงาน เพื่อให้ตรงแนวกับบรรทัดอื่น
                const rc = isHeaderFooter ? null : reportCols.find(c => c.col_seq_no === col.column_seq_no && c.col_kind !== 'LABEL');
                if (rc) {
                    Object.assign(cell, {
                        flex: rc.column_flex,
                        style: { fontSize: rc.font_size, fontWeight: rc.font_weight, textAlign: rc.text_align },
                        report_col: true,
                        override: true,
                        hidden: rc.is_hidden,
                    });
                }
                return cell;
            });

            // เติมคอลัมน์ระดับรายงาน (ข้ามช่องที่บรรทัดนี้ override ด้วยคอลัมน์รายบรรทัด)
            const overrideSeqs = new Set(myCols.map(c => c.column_seq_no));
            const hasOverride = reportCols.some(rc => rc.col_kind !== 'LABEL' && overrideSeqs.has(rc.col_seq_no));
            const hasAmounts = hasAccounts || !!derivedCalc;
            reportCols.forEach(rc => {
                if (isHeaderFooter || overrideSeqs.has(rc.col_seq_no)) return;
                const cell = {
                    seq_no: rc.col_seq_no,
                    data_type: null,
                    flex: rc.column_flex,
                    indent_level: 0,
                    style: { fontSize: rc.font_size, fontWeight: rc.font_weight, textAlign: rc.text_align },
                    report_col: true,
                    hidden: rc.is_hidden,
                };
                if (rc.col_kind === 'LABEL') {
                    // บรรทัดว่างใส่ช่องว่าง 1 ตัวเพื่อให้บรรทัดมีความสูง
                    const text = kind === 'BLANK' ? ' ' : rowLabel(row);
                    processedColumns.push({ ...cell, type: 'TEXT', value: text, indent_level: row.indent_level || 0, label: true });
                } else if (rc.col_kind === 'AMOUNT' && hasAccounts) {
                    const src = { periodIds: rc.target_period_ids, colFilter: rc, excludeClosing: rc.exclude_closing_entries };
                    const amountCell = { ...cell, type: 'AMOUNT', value: sumRow(row, src.periodIds, src.colFilter, src.excludeClosing), drill: true };
                    cellSrc.set(amountCell, src);
                    processedColumns.push(amountCell);
                } else if (rc.col_kind === 'AMOUNT' && derivedCalc) {
                    processedColumns.push({ ...cell, type: 'AMOUNT', value: null, calc: derivedCalc, ...(kind === 'TOTAL' ? { drill: true } : {}) });
                } else if (rc.col_kind === 'CALC' && (hasAmounts || hasOverride)) {
                    processedColumns.push({ ...cell, type: 'CALC', value: null, formula_text: rc.formula_text });
                } else {
                    // บรรทัดหัวข้อ/บรรทัดว่าง: ช่องว่าง (ไม่ใช่ 0) เพื่อไม่ให้แสดง '-'
                    processedColumns.push({ ...cell, type: 'TEXT', value: '' });
                }
            });

            // ไม่มีคอลัมน์ LABEL ในรายงาน แต่บรรทัดมีชื่อ → วางไว้หน้าสุด (seq 0)
            const label = rowLabel(row);
            if (isHeaderFooter) {
                // ข้อความเต็มความกว้างบรรทัดเดียว ขนาด/ตัวหนา/การจัดวางตามบรรทัด
                // (บรรทัดหัวงบแบบเดิมที่มีคอลัมน์รายบรรทัด ใช้คอลัมน์ของบรรทัดตามเดิม)
                if (myCols.length === 0) {
                    processedColumns.push({
                        seq_no: 0, type: 'TEXT', value: label, data_type: null, flex: 1, indent_level: 0,
                        style: { fontSize: row.font_size || 10, fontWeight: row.is_bold ? 'BOLD' : 'NORMAL', textAlign: row.text_align || 'CENTER' },
                        label: true,
                    });
                }
            } else if (!labelCol && label && !overrideSeqs.has(0)) {
                processedColumns.push({
                    seq_no: 0, type: 'TEXT', value: label, data_type: null, flex: 3,
                    indent_level: row.indent_level || 0,
                    style: { fontSize: 10, fontWeight: 'NORMAL', textAlign: 'LEFT' }, label: true,
                });
            }

            if (row.is_bold) {
                processedColumns.forEach(c => { c.style = { ...c.style, fontWeight: 'BOLD' }; });
            }

            processedColumns.sort((a, b) => a.seq_no - b.seq_no);

            return {
                row_id: row.id,
                seq_no: row.row_seq_no,
                row_code: row.row_code || null,
                row_kind: kind,
                row_type: row.row_type,
                print_control: row.print_control,
                has_accounts: hasAccounts,
                parent_row_code: row.parent_row_code || null,
                parent_op: row.parent_op || 'ADD',
                row_formula: row.row_formula || null,
                hide_if_zero: !!row.hide_if_zero,
                page_break_before: row.row_type === 'BODY' && !!row.page_break_before,
                line_above: row.line_above || 'NONE',
                line_below: row.line_below || 'NONE',
                columns: processedColumns
            };
        });

        // 5.1 บรรทัดบัญชีที่ตั้งให้แตกเป็นรายบัญชี (expand_mode DETAIL/DETAIL_TOTAL):
        //     สร้างบรรทัดย่อยต่อบัญชีลงรายการ (ยอดคำนวณใหม่เฉพาะบัญชีนั้น) เก็บไว้ใน detail_rows
        //     ไม่ใส่ใน reportData — สูตร/บรรทัดยอดรวมยังอ้างยอดของบรรทัดเดิมเหมือนเดิม
        const rowById = new Map(rows.map(r => [r.id, r]));
        reportData.forEach(rd => {
            const row = rowById.get(rd.row_id);
            const mode = row.expand_mode || 'NONE';
            if (mode === 'NONE' || !rd.has_accounts) return;
            rd.expand_mode = mode;
            const codes = [...row.acctSet]
                .filter(code => acctIndex.byCode.get(code)?.is_normal_account)
                .sort();
            rd.detail_rows = codes.map(code => {
                const acct = acctIndex.byCode.get(code);
                const acctRow = { ...row, acctSet: new Set([code]) };
                const name = (isEnglish && acct.account_name_eng) ? acct.account_name_eng : (acct.account_name_thai || acct.account_name_eng || code);
                return {
                    row_id: row.id,
                    seq_no: row.row_seq_no,
                    row_code: null,
                    row_kind: 'ACCOUNT_LINE',
                    row_type: row.row_type,
                    print_control: 'SHOW',
                    account_code: code,
                    has_accounts: false,
                    columns: rd.columns.map(c => {
                        const base = {
                            seq_no: c.seq_no, data_type: c.data_type, flex: c.flex, indent_level: 0,
                            style: { ...c.style, fontWeight: 'NORMAL' },
                            ...(c.report_col ? { report_col: true } : {}),
                            ...(c.hidden ? { hidden: true } : {}),
                        };
                        if (c.label) return { ...base, type: 'TEXT', value: name, indent_level: (row.indent_level || 0) + 1, label: true };
                        const src = cellSrc.get(c);
                        if (src) return { ...base, type: c.type, value: sumRow(acctRow, src.periodIds, src.colFilter, src.excludeClosing), drill: true };
                        if (c.type === 'CALC') return { ...base, type: 'CALC', value: null, formula_text: c.formula_text };
                        return { ...base, type: 'TEXT', value: '' };
                    }),
                };
            });
        });

        // ====================================================================
        // STEP 6: ประมวลผลสูตรคำนวณ (Pass 2 - FORMULA)
        // ====================================================================
        // คำนวณแบบ recursive ตามการอ้างอิง (สูตรที่อ้างสูตรบรรทัดหลังจะได้ค่าที่ถูกต้อง)
        // สูตรผิด/อ้างอิงไม่พบ/อ้างวน → value = null + error แทนการให้ค่า 0 เงียบ ๆ
        const formulaErrors = [];
        const evalState = new Map(); // col object → 'visiting' | 'done'

        const findRow = (rSeq) => reportData.find(r => r.seq_no === rSeq);
        const rowByCode = new Map(reportData.filter(r => r.row_code).map(r => [r.row_code, r]));
        const childrenOf = (code) => reportData.filter(r => r.parent_row_code === code);
        // ช่องที่ต้องคำนวณใน STEP นี้: สูตรรายบรรทัด, CALC, ยอดรวม/สูตรของบรรทัด TOTAL/FORMULA
        const isComputed = (c) => c.type === 'FORMULA' || c.type === 'CALC' || !!c.calc;
        const cellLabel = (row, col) => `${row.row_code || 'R' + row.seq_no}, C${col.seq_no}`;

        // อ่านค่าช่องเป้าหมาย (คำนวณก่อนถ้ายังไม่ได้คำนวณ)
        const readCell = (targetRow, target, where) => {
            if (isComputed(target)) {
                computeCell(targetRow, target);
                if (target.error) {
                    throw new FormulaError('REF_ERROR', `Referenced cell (${where}) has an error`, { row: targetRow.seq_no, col: target.seq_no });
                }
            }
            // ช่องว่างของคอลัมน์ระดับรายงาน (บรรทัดที่ไม่มียอด) = ไม่มีค่า ไม่ใช่ error
            if (target.report_col && target.type === 'TEXT') return null;
            if (target.type === 'TEXT' || target.type === 'DIVIDER') {
                throw new FormulaError('NOT_NUMERIC', `Cell (${where}) is not a number`, { row: targetRow.seq_no, col: target.seq_no });
            }
            return target.value == null ? null : Number(target.value);
        };

        // คำนวณค่าของช่องตามชนิด (สูตร / TOTAL / FORMULA ของบรรทัด)
        const evaluateCell = (row, col) => {
            if (col.calc === 'TOTAL') {
                // รวมช่องเดียวกันของบรรทัดลูก (ค่าลูกกลับเครื่องหมายตาม normal_sign มาแล้ว)
                // บรรทัดลูกที่ตั้ง "หักจาก" (parent_op SUBTRACT) ลบออกแทนการบวก
                let total = 0;
                for (const child of childrenOf(row.row_code)) {
                    const target = child.columns.find(c => c.seq_no === col.seq_no);
                    if (!target) continue;
                    if (!isComputed(target) && (target.type === 'TEXT' || target.type === 'DIVIDER')) continue;
                    const v = readCell(child, target, cellLabel(child, target));
                    if (v != null) total += child.parent_op === 'SUBTRACT' ? -v : v;
                }
                return total;
            }
            const formulaText = col.calc === 'ROWF' ? row.row_formula : col.formula_text;
            const ast = parseFormula(formulaText);
            const resolveRef = (rSeq, cSeq) => {
                const targetRow = findRow(rSeq);
                const target = targetRow ? targetRow.columns.find(c => c.seq_no === cSeq) : undefined;
                if (!target) {
                    throw new FormulaError('UNKNOWN_REF', `Cell (R${rSeq}, C${cSeq}) not found`, { row: rSeq, col: cSeq });
                }
                return readCell(targetRow, target, `R${rSeq}, C${cSeq}`);
            };
            // [CODE] = คอลัมน์ระดับรายงานในบรรทัดเดียวกัน (อ่านจากบรรทัดนี้ตรงๆ — บรรทัดรายบัญชีที่แตกย่อยมี seq_no ซ้ำกับบรรทัดเดิม)
            const resolveCol = (code) => {
                const rc = reportColByCode.get(code);
                if (!rc) throw new FormulaError('UNKNOWN_REF', `Column [${code}] not found`, { code });
                const target = row.columns.find(c => c.seq_no === rc.col_seq_no);
                if (!target) {
                    throw new FormulaError('UNKNOWN_REF', `Cell (R${row.seq_no}, C${rc.col_seq_no}) not found`, { row: row.seq_no, col: rc.col_seq_no });
                }
                return readCell(row, target, `R${row.seq_no}, C${rc.col_seq_no}`);
            };
            // ROW_CODE = บรรทัดนั้นในคอลัมน์เดียวกับช่องนี้, ROW_CODE[COL] = ระบุคอลัมน์
            const resolveRow = (rowCode, colCode) => {
                const targetRow = rowByCode.get(rowCode);
                if (!targetRow) throw new FormulaError('UNKNOWN_REF', `Row ${rowCode} not found`, { row_code: rowCode });
                let seq = col.seq_no;
                if (colCode) {
                    const rc = reportColByCode.get(colCode);
                    if (!rc) throw new FormulaError('UNKNOWN_REF', `Column [${colCode}] not found`, { code: colCode });
                    seq = rc.col_seq_no;
                }
                const target = targetRow.columns.find(c => c.seq_no === seq);
                // บรรทัดเป้าหมายไม่มีช่องนี้ (เช่น หัวข้อ) = ไม่มีค่า
                if (!target) return null;
                return readCell(targetRow, target, cellLabel(targetRow, target));
            };
            return evaluateFormula(ast, resolveRef, resolveCol, resolveRow);
        };

        // throws เฉพาะ CIRCULAR (เพื่อให้ทุกช่องในวงจรถูกบันทึก error) — error อื่นเก็บไว้ที่ col.error
        function computeCell(row, col) {
            const state = evalState.get(col);
            if (state === 'done') return;
            if (state === 'visiting') {
                throw new FormulaError('CIRCULAR', `Circular reference at (${cellLabel(row, col)})`,
                    { row: row.seq_no, col: col.seq_no });
            }
            evalState.set(col, 'visiting');
            try {
                col.value = evaluateCell(row, col);
                evalState.set(col, 'done');
            } catch (err) {
                evalState.set(col, 'done');
                col.value = null;
                col.error = err.code || 'SYNTAX';
                formulaErrors.push({
                    row_seq_no: row.seq_no,
                    row_code: row.row_code,
                    column_seq_no: col.seq_no,
                    formula_text: col.calc === 'ROWF' ? row.row_formula : col.calc === 'TOTAL' ? `SUM(${row.row_code})` : col.formula_text,
                    code: col.error,
                    message: err.message,
                    detail: err.detail || {},
                });
                if (err.code === 'CIRCULAR') throw err;
            }
        }

        reportData.forEach(row => {
            row.columns.forEach(col => {
                if (!isComputed(col)) return;
                if (!col.calc && !col.formula_text) { col.value = null; return; }
                try { computeCell(row, col); } catch (_) { /* recorded in formulaErrors */ }
            });
        });

        // บรรทัดรายบัญชี: คำนวณสูตรของคอลัมน์รายงาน (CALC) ในบรรทัดนั้น
        reportData.forEach(rd => (rd.detail_rows || []).forEach(dr => dr.columns.forEach(col => {
            if (col.type !== 'CALC') return;
            if (!col.formula_text) { col.value = null; return; }
            try { computeCell(dr, col); } catch (_) { /* recorded in formulaErrors */ }
        })));

        // คอลัมน์ช่วยคำนวณ (is_hidden) คำนวณแล้วแต่ไม่ส่งออกไปแสดงผล
        reportData.forEach(row => {
            row.columns = row.columns.filter(c => !c.hidden);
            (row.detail_rows || []).forEach(dr => { dr.columns = dr.columns.filter(c => !c.hidden); });
        });

        // ซ่อนบรรทัดที่ทุกช่องตัวเลขเป็นศูนย์/ว่าง (ถ้าตั้ง hide_if_zero และไม่มี error)
        const isZeroRow = (row) => {
            const nums = row.columns.filter(c => c.type !== 'TEXT' && c.type !== 'DIVIDER');
            return nums.length > 0 && nums.every(c => !c.error && (c.value == null || Number(c.value) === 0));
        };

        const sortedData = [...reportData].sort((a, b) => a.seq_no - b.seq_no);
        let finalData = [];
        // บรรทัดที่ตั้งขึ้นหน้าใหม่แต่ถูกซ่อน → ส่งต่อการขึ้นหน้าใหม่ให้บรรทัดเนื้อหาถัดไปที่แสดง
        let pendingBreak = false;
        for (const r of sortedData) {
            const visible = r.print_control === 'SHOW' && !(r.hide_if_zero && isZeroRow(r));
            if (!visible) { if (r.page_break_before) pendingBreak = true; continue; }
            if (pendingBreak && r.row_type === 'BODY') { finalData.push({ ...r, page_break_before: true }); pendingBreak = false; }
            else finalData.push(r);
        }

        // เส้นบน/เส้นใต้ยอดเงิน → แทรกบรรทัดเส้น (DIVIDER เฉพาะช่องตัวเลข, '=' = เส้นคู่)
        const lineRow = (row, style) => ({
            seq_no: row.seq_no,
            row_type: row.row_type,
            print_control: 'SHOW',
            line_row: true,
            columns: row.columns.map(c => (c.type === 'TEXT' || c.type === 'DIVIDER')
                ? { seq_no: c.seq_no, type: 'TEXT', value: '', flex: c.flex, indent_level: 0, style: {} }
                : { seq_no: c.seq_no, type: 'DIVIDER', data_type: style === 'DOUBLE' ? '=' : '-', value: '---', flex: c.flex, indent_level: 0, style: {} }),
        });
        // บรรทัดที่แตกเป็นรายบัญชี: ชื่อบรรทัดเป็นหัวข้อ (ไม่มียอด) + รายบัญชีที่มียอด
        //   DETAIL_TOTAL ปิดท้ายด้วยบรรทัด "รวม..." (ยอดของบรรทัดเดิม) — เส้นเหนือ/ใต้ยอดเงินอยู่ที่บรรทัดรวม
        //   DETAIL       เส้นเหนือ/ใต้ยอดเงินครอบกลุ่มรายบัญชี
        const headingOf = (r) => ({
            ...r,
            columns: r.columns.map(c => (c.type === 'TEXT' || c.type === 'DIVIDER') ? c
                : { seq_no: c.seq_no, type: 'TEXT', value: '', flex: c.flex, indent_level: 0, style: c.style, ...(c.report_col ? { report_col: true } : {}) }),
        });
        const totalOf = (r) => ({
            ...r,
            columns: r.columns.map(c => c.label && c.value
                ? { ...c, value: isEnglish ? `Total ${c.value}` : `รวม${c.value}` } : c),
        });
        finalData = finalData.flatMap(r => {
            const above = r.line_above !== 'NONE' ? [lineRow(r, r.line_above)] : [];
            const below = r.line_below !== 'NONE' ? [lineRow(r, r.line_below)] : [];
            const { detail_rows: detailRows, expand_mode: expandMode, page_break_before: pageBreak, ...out } = r;
            let group;
            if (!detailRows) group = [...above, out, ...below];
            else {
                const details = detailRows.filter(d => !isZeroRow(d));
                group = expandMode === 'DETAIL_TOTAL'
                    ? [headingOf(out), ...details, ...above, totalOf(out), ...below]
                    : [headingOf(out), ...above, ...details, ...below];
            }
            // ขึ้นหน้าใหม่ก่อนแถวแรกของกลุ่ม (รวมเส้นเหนือยอดเงิน / บรรทัดรายบัญชี)
            if (pageBreak) group[0] = { ...group[0], page_break_before: true };
            return group;
        });

        // ====================================================================
        // STEP 7: หัวคอลัมน์อัตโนมัติจากคอลัมน์ระดับรายงาน (เป็น HEADER จึงพิมพ์ซ้ำทุกหน้า)
        // ====================================================================
        const visibleReportCols = reportCols.filter(rc => !rc.is_hidden);
        if (visibleReportCols.some(rc => rc.header_thai || rc.header_eng)) {
            const headerText = (rc) => {
                const text = (isEnglish && rc.header_eng) ? rc.header_eng : (rc.header_thai || rc.header_eng || '');
                const first = rc.range_periods?.[0];
                return text
                    .replaceAll('$colPeriodStartDate', first ? longDate(first.start_ymd, isEnglish) : '')
                    .replaceAll('$colPeriodEndDate', rc.target_period ? longDate(rc.target_period.end_ymd, isEnglish) : '')
                    .replaceAll('$colPeriodName', rc.target_period?.period_name ?? '')
                    .replaceAll('$colFiscalYear', rc.target_period?.fy_code ?? '');
            };
            // ช่องว่างด้านซ้ายให้ตรงกับบรรทัดเนื้อหา: ใช้ความกว้างของคอลัมน์รายบรรทัดจากบรรทัดแรกที่มียอดบัญชี
            const rcSeqs = new Set(visibleReportCols.map(rc => rc.col_seq_no));
            const templateRow = finalData.find(r => r.has_accounts);
            const spacerCells = (templateRow ? templateRow.columns : [])
                .filter(c => !c.report_col && !rcSeqs.has(c.seq_no))
                .map(c => ({ seq_no: c.seq_no, type: 'TEXT', value: '', flex: c.flex, indent_level: 0, style: {} }));
            const headerCells = visibleReportCols.map(rc => ({
                seq_no: rc.col_seq_no,
                type: 'TEXT',
                value: headerText(rc),
                flex: rc.column_flex,
                indent_level: 0,
                style: { fontSize: rc.font_size, fontWeight: 'BOLD', textAlign: rc.text_align },
            }));
            const lastHeaderIdx = finalData.map(r => r.row_type).lastIndexOf('HEADER');
            finalData.splice(lastHeaderIdx + 1, 0, {
                seq_no: lastHeaderIdx >= 0 ? finalData[lastHeaderIdx].seq_no : 0,
                row_type: 'HEADER',
                print_control: 'SHOW',
                auto_column_header: true,
                columns: [...spacerCells, ...headerCells].sort((a, b) => a.seq_no - b.seq_no),
            });
        }

        // ตัวแปรในข้อความ ($ชื่อ) ที่ engine รู้ค่า — หน้าจอแทนค่าในบรรทัดหัวงบ/ชื่อบรรทัด
        let branchName = isEnglish ? 'All branches' : 'ทุกสาขา';
        if (branchId) {
            const br = await client.query(`SELECT branch_name_thai, branch_name_eng FROM cd_branch WHERE id = $1`, [branchId]);
            const b = br.rows[0];
            if (b) branchName = (isEnglish && b.branch_name_eng) ? b.branch_name_eng : (b.branch_name_thai || '');
        }
        const co = await client.query(`SELECT thai_name, english_name FROM sa_company WHERE is_active = TRUE LIMIT 1`);
        const company = co.rows[0] || {};
        let userName = req.headers?.username || '';
        try { userName = decodeURIComponent(userName); } catch (_) { /* ใช้ค่าเดิม */ }
        const variables = {
            companyName: (isEnglish && company.english_name) ? company.english_name : (company.thai_name || ''),
            userName,
            periodName: basePeriodInfo.period_name ?? '',
            fiscalYear: basePeriodInfo.fy_code ?? '',
            periodStartDate: longDate(basePeriodInfo.start_ymd, isEnglish),
            periodEndDate: longDate(basePeriodInfo.end_ymd, isEnglish),
            yearStartDate: longDate(basePeriodInfo.year_start_ymd, isEnglish),
            amountUnit: amountUnitLabel(amountUnit, isEnglish),
            branchName,
        };

        // ส่งข้อมูลกลับไปที่ Frontend (กรองเฉพาะ Print Control ที่ให้แสดงผล)
        res.status(200).json({
            report_code: master.report_code,
            report_name: (isEnglish && master.report_name_eng) ? master.report_name_eng : master.report_name_thai,
            parenthesis_for_minus: master.parenthesis_for_minus,
            amount_unit: amountUnit,
            decimal_places: master.decimal_places ?? 2,
            variables,
            page_config: {
                orientation: master.page_orientation,
                margins: [master.margin_top, master.margin_right, master.margin_bottom, master.margin_left],
            },
            formula_errors: formulaErrors,
            data: finalData
        });

    } catch (err) {
        console.error("Report Engine Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

module.exports = { 
    generateFinancialReport,
    getReportMasterList
};

// // File: controllers/gl/glFinancialReportEngineController.js

// const getReportMasterList = async (req, res) => {
//     const client = await req.dbPool.connect();
//     try {
//         // const result = await client.query(`
//         //     SELECT id, report_code, report_name_thai 
//         //     FROM gl_report_master 
//         //     WHERE is_active = true 
//         //     ORDER BY id
//         // `);
//         const result = await client.query(`
//             SELECT id, report_code, report_name_thai 
//             FROM gl_fin_report 
//             WHERE is_active = true 
//             ORDER BY id
//         `);
//         res.status(200).json(result.rows);
//     } catch (err) {
//         console.error("Fetch Report Master Error:", err);
//         res.status(500).json({ error: err.message });
//     } finally {
//         client.release();
//     }
// };

// const generateFinancialReport = async (req, res) => {
//     const { report_id, base_period_id } = req.body;
//     const client = await req.dbPool.connect();

//     try {
//         // 1. ดึงข้อมูล Master (gl_fin_report)
//         const masterRes = await client.query(`SELECT * FROM gl_fin_report WHERE id = $1 AND is_active = true`, [report_id]);
//         if (masterRes.rows.length === 0) throw new Error('ไม่พบรายงานนี้ในระบบ');
//         const master = masterRes.rows[0];

//         // 2. ดึงข้อมูลบรรทัด (Row) ทั้งหมด
//         const rowRes = await client.query(`SELECT * FROM gl_fin_report_row WHERE report_id = $1 ORDER BY row_seq_no ASC`, [report_id]);
//         const rows = rowRes.rows;
//         const rowIds = rows.map(r => r.id);

//         // 3. ดึงข้อมูลคอลัมน์ (Column) ทั้งหมดที่ผูกกับบรรทัดเหล่านั้น
//         let cols = [];
//         if (rowIds.length > 0) {
//             const colRes = await client.query(`SELECT * FROM gl_fin_report_column WHERE row_id = ANY($1::int[]) ORDER BY row_id, column_seq_no ASC`, [rowIds]);
//             cols = colRes.rows;
//         }

//         // ====================================================================
//         // STEP 2: โหลดข้อมูล Period ทั้งหมดเพื่อคำนวณ Offset อย่างรวดเร็ว
//         // ====================================================================
//         // ดึงเรียงตาม period_start_date เพื่อให้เป็น Chronological Order
//         const periodsRes = await client.query(`
//             SELECT 
//                 p.id AS period_id, 
//                 p.period_number, 
//                 p.fiscal_year_id, 
//                 p.period_start_date,
//                 p.period_name,
//                 y.fy_code,
//                 y.year_start_date
//             FROM gl_posting_period p
//             JOIN gl_fiscal_year y ON p.fiscal_year_id = y.id
//             ORDER BY p.period_start_date ASC, p.period_end_date ASC
//         `);
//         const allPeriods = periodsRes.rows;

//         // หา Base Period (งวดเดือนปัจจุบันที่ผู้ใช้เลือกมา)
//         const baseIndex = allPeriods.findIndex(p => p.period_id === base_period_id);
//         if (baseIndex === -1) throw new Error('ไม่พบงวดบัญชีที่ระบุในระบบ');
//         const basePeriodInfo = allPeriods[baseIndex]; 

//         // ตัวแปร Set เพื่อใช้เก็บ period_id ที่ต้องกวาดข้อมูลจาก DB (ไม่ให้มี ID ซ้ำ)
//         let requiredPeriodIds = new Set();

//         // ====================================================================
//         // STEP 3: หาเป้าหมาย period_ids สำหรับแต่ละคอลัมน์ (MTD, YTD)
//         // ====================================================================
//         cols.forEach(col => {
//             const offset = col.period_offset || 0;

//             if (col.column_type === 'MTD') {
//                 // MTD ถอยหลังตามจำนวนงวด (เช่น -1 คือเดือนก่อนหน้า)
//                 const targetIndex = baseIndex + offset;
                
//                 if (targetIndex >= 0 && targetIndex < allPeriods.length) {
//                     const targetPeriod = allPeriods[targetIndex];
//                     col.target_period_ids = [targetPeriod.period_id];
//                     requiredPeriodIds.add(targetPeriod.period_id);
//                 } else {
//                     col.target_period_ids = []; // ถอยหลังเกินข้อมูลที่มี
//                 }
//             } 
//             else if (col.column_type === 'YTD') {
//                 // YTD ถอยหลังตามจำนวนปี (เช่น -1 คือปีก่อนหน้า แต่งวดเดือนเดียวกัน)
//                 // 1. หางวดเป้าหมายก่อน (สมมติว่า 1 ปีมี 12 งวด ให้เอา offset * 12) 
//                 // หรือ หา period ที่มี period_number เดียวกัน แต่ข้ามปีบัญชี
                
//                 let targetPeriod = null;
                
//                 if (offset === 0) {
//                     targetPeriod = basePeriodInfo;
//                 } else {
//                     // หากระโดดข้ามปีโดยหาช่วงที่ period_number เดิม แต่ fy_code เปลี่ยน
//                     const targetYearValue = parseInt(basePeriodInfo.fy_code) + offset;
//                     targetPeriod = allPeriods.find(p => 
//                         p.period_number === basePeriodInfo.period_number && 
//                         parseInt(p.fy_code) === targetYearValue
//                     );
//                 }

//                 if (targetPeriod) {
//                     // YTD ต้องการรวมยอด "ตั้งแต่ช่วงต้นปีบัญชีนั้น" จนถึง "งวดเป้าหมาย"
//                     const ytdPeriods = allPeriods.filter(p => 
//                         p.fiscal_year_id === targetPeriod.fiscal_year_id &&
//                         p.period_number <= targetPeriod.period_number
//                     );
                    
//                     col.target_period_ids = ytdPeriods.map(p => p.period_id);
//                     col.target_period_ids.forEach(id => requiredPeriodIds.add(id));
//                 } else {
//                     col.target_period_ids = [];
//                 }
//             }
//         });

//         // ====================================================================
//         // STEP 4: ดึงข้อมูลยอดบัญชี (GL Data) จาก DB รวดเดียว
//         // ====================================================================
//         const reqPeriodArr = Array.from(requiredPeriodIds);
//         let glData = [];
        
//         if (reqPeriodArr.length > 0) {
//             const glDataRes = await client.query(`
//                 SELECT a.account_code, b.period_id, b.end_balance
//                 FROM gl_balance_accum b
//                 JOIN gl_account a ON b.account_id = a.id
//                 WHERE b.period_id = ANY($1::int[])
//             `, [reqPeriodArr]);
//             glData = glDataRes.rows;
//         }
// //console.log("GL Data fetched for periods:", reqPeriodArr, "Data:", glData);

//         // // ====================================================================
//         // // STEP: เตรียมข้อมูล GL ตาม base_period_id และ offsets (จำลอง Logic)
//         // // ในระบบจริง คุณต้อง Join กับตาราง Period เพื่อหา period_id ย้อนหลังตาม period_offset
//         // // ====================================================================
//         // const glDataRes = await client.query(`
//         //     SELECT a.account_code, b.period_id, b.end_balance
//         //     FROM gl_balance_accum b
//         //     JOIN gl_account a ON b.account_id = a.id
//         //     -- WHERE b.period_id IN (ดึงช่วง period ที่ครอบคลุม offset ทั้งหมด)
//         // `);
//         // const glData = glDataRes.rows;

//         // ====================================================================
//         // STEP: ประกอบร่างข้อมูล (Pass 1 - หยอดค่า TEXT, MTD, YTD)
//         // ====================================================================
//         let reportData = rows.map(row => {
//             const myCols = cols.filter(c => c.row_id === row.id);
            
//             let processedColumns = myCols.map(col => {
//                 let cellValue = null;

//                 if (col.column_type === 'TEXT') {
//                     cellValue = col.description_thai; // ตัวแปร $ ต่างๆ จะถูกส่งไปให้ Flutter แทนค่า
//                 } 
//                 else if (col.column_type === 'DIVIDER') {
//                     cellValue = '---';
//                 }
//                 else if (col.column_type === 'MTD' || col.column_type === 'YTD') {
//                     // Logic ค้นหายอด GL: นำ offset ไปหา period_id ที่ถูกต้อง
//                     // นำ account_from, account_to ของ row ไป filter กรองยอด
//                     let cellTotal = 5000; // จำลองผลลัพธ์การบวกเลข
                    
//                     // สลับเครื่องหมายตาม normal_sign
//                     cellValue = row.normal_sign === 'CREDIT' ? cellTotal * -1 : cellTotal;
//                 }

//                 return {
//                     seq_no: col.column_seq_no,
//                     type: col.column_type,
//                     value: cellValue,
//                     formula_text: col.formula_text,
//                     flex: col.column_flex,
//                     style: {
//                         fontSize: col.font_size,
//                         fontWeight: col.font_weight,
//                         textAlign: col.text_align
//                     }
//                 };
//             });

//             return {
//                 seq_no: row.row_seq_no,
//                 row_type: row.row_type, // HEADER, BODY, FOOTER
//                 print_control: row.print_control,
//                 columns: processedColumns
//             };
//         });

//         // ====================================================================
//         // STEP: ประมวลผลสูตรคำนวณ (Pass 2 - FORMULA)
//         // ====================================================================
//         // ฟังก์ชันอ่านค่าเซลล์อ้างอิง เช่น (R100, C20)
//         const getCellValue = (rSeq, cSeq) => {
//             const targetRow = reportData.find(r => r.seq_no === parseInt(rSeq));
//             if (!targetRow) return 0;
//             const targetCol = targetRow.columns.find(c => c.seq_no === parseInt(cSeq));
//             return targetCol && !isNaN(targetCol.value) ? Number(targetCol.value) : 0;
//         };

//         // วนลูปเฉพาะคอลัมน์ที่เป็น FORMULA
//         reportData.forEach(row => {
//             row.columns.forEach(col => {
//                 if (col.type === 'FORMULA' && col.formula_text) {
//                     try {
//                         // Regex ค้นหารูปแบบ (R100, C20)
//                         let parsedFormula = col.formula_text.replace(/\(R(\d+),\s*C(\d+)\)/g, (match, rSeq, cSeq) => {
//                             return getCellValue(rSeq, cSeq);
//                         });
//                         // ประมวลผลสมการคณิตศาสตร์
//                         col.value = new Function(`return ${parsedFormula}`)();
//                     } catch (err) {
//                         col.value = 0;
//                     }
//                 }
//             });
//         });

//         // ส่งข้อมูลกลับไปที่ Frontend
//         res.status(200).json({
//             report_code: master.report_code,
//             report_name: master.report_name_thai,
//             page_config: {
//                 orientation: master.page_orientation,
//                 margins: [master.margin_top, master.margin_right, master.margin_bottom, master.margin_left],
//             },
//             data: reportData.filter(r => r.print_control === 'SHOW') // กรองเฉพาะบรรทัดที่ SHOW
//         });
// //console.log("Final Report Data:", reportData);

//     } catch (err) {
//         console.error("Report Engine Error:", err);
//         res.status(500).json({ error: err.message });
//     } finally {
//         client.release();
//     }
// };

// module.exports = { 
//     generateFinancialReport,
//     getReportMasterList
// };
