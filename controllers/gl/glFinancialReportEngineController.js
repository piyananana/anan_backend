// File: controllers/gl/glFinancialReportEngineController.js

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

const generateFinancialReport = async (req, res) => {
    const { report_id, base_period_id } = req.body;
    const client = await req.dbPool.connect();

    try {
        // 1. ดึงข้อมูล Master (gl_fin_report)
        const masterRes = await client.query(`SELECT * FROM gl_fin_report WHERE id = $1 AND is_active = true`, [report_id]);
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
                y.year_start_date
            FROM gl_posting_period p
            JOIN gl_fiscal_year y ON p.fiscal_year_id = y.id
            ORDER BY p.period_start_date ASC, p.period_end_date ASC
        `);
        const allPeriods = periodsRes.rows;

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

        // ====================================================================
        // STEP 4: ดึงข้อมูลยอดบัญชี (GL Data) จาก DB รวดเดียว
        // ====================================================================
        const reqPeriodArr = Array.from(requiredPeriodIds);
        let glData = [];
        
        if (reqPeriodArr.length > 0) {
            // ดึง branch_id, project_id, business_unit_id มาเผื่อต้องการกรอง
            const glDataRes = await client.query(`
                SELECT a.account_code, b.period_id, b.end_balance, b.branch_id, b.project_id, b.business_unit_id
                FROM gl_balance_accum b
                JOIN gl_account a ON b.account_id = a.id
                WHERE b.period_id = ANY($1::int[])
            `, [reqPeriodArr]);
            glData = glDataRes.rows;
        }

        // ====================================================================
        // STEP 5: ประกอบร่างข้อมูล (Pass 1 - หยอดค่า TEXT, คำนวณ MTD, YTD)
        // ====================================================================
        let reportData = rows.map(row => {
            const myCols = cols.filter(c => c.row_id === row.id);
            
            let processedColumns = myCols.map(col => {
                let cellValue = null;

                if (col.column_type === 'TEXT') {
                    cellValue = col.description_thai; 
                } 
                else if (col.column_type === 'DIVIDER') {
                    cellValue = '---';
                }
                else if (col.column_type === 'MTD' || col.column_type === 'YTD') {
                    let cellTotal = 0;
                    const targetIds = col.target_period_ids || [];

                    // คำนวณเฉพาะบรรทัดที่มีการระบุ Account (ปกติจะเป็น BODY)
                    if (targetIds.length > 0 && row.account_from && row.account_to) {
                        
                        // 1. กรองข้อมูลเอาเฉพาะ Period ที่เกี่ยวข้องกับคอลัมน์นี้
                        const targetGL = glData.filter(g => targetIds.includes(g.period_id));
                        
                        // 2. กรองข้อมูลเอาเฉพาะเงื่อนไขที่กำหนดไว้ใน Row
                        const matchedGL = targetGL.filter(g => {
                            let isMatch = true;
                            // กรองช่วงรหัสบัญชี
                            if (g.account_code < row.account_from || g.account_code > row.account_to) {
                                isMatch = false;
                            }
                            // กรองตาม Dimension ถ้ามีระบุไว้ในบรรทัดนั้น
                            if (row.branch_id && g.branch_id !== row.branch_id) isMatch = false;
                            if (row.project_id && g.project_id !== row.project_id) isMatch = false;
                            if (row.business_unit_id && g.business_unit_id !== row.business_unit_id) isMatch = false;
                            
                            return isMatch;
                        });

                        // 3. รวมยอด end_balance
                        cellTotal = matchedGL.reduce((sum, item) => sum + Number(item.end_balance || 0), 0);
                    }
                    
                    // สลับเครื่องหมายตาม normal_sign (ถ้าบัญชีปกติอยู่ฝั่ง Credit เช่น หนี้สิน/ทุน/รายได้ การแสดงผลจะคูณ -1 ให้เป็นบวก)
                    cellValue = (row.normal_sign === 'CREDIT') ? (cellTotal * -1) : cellTotal;
                }

                return {
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
                    }
                };
            });

            processedColumns.sort((a, b) => a.seq_no - b.seq_no);

            return {
                seq_no: row.row_seq_no,
                row_type: row.row_type, 
                print_control: row.print_control,
                columns: processedColumns
            };
        });

        // ====================================================================
        // STEP 6: ประมวลผลสูตรคำนวณ (Pass 2 - FORMULA)
        // ====================================================================
        // ฟังก์ชันอ่านค่าเซลล์อ้างอิง เช่น (R100, C20)
        const getCellValue = (rSeq, cSeq) => {
            const targetRow = reportData.find(r => r.seq_no === parseInt(rSeq));
            if (!targetRow) return 0;
            const targetCol = targetRow.columns.find(c => c.seq_no === parseInt(cSeq));
            return targetCol && !isNaN(targetCol.value) ? Number(targetCol.value) : 0;
        };

        // วนลูปเฉพาะคอลัมน์ที่เป็น FORMULA
        reportData.forEach(row => {
            row.columns.forEach(col => {
                if (col.type === 'FORMULA' && col.formula_text) {
                    try {
                        // Regex ค้นหารูปแบบ (R100, C20) 
                        // รองรับกรณีเว้นวรรค เช่น (R100, C20) หรือ (R100,C20)
                        let parsedFormula = col.formula_text.replace(/\(R(\d+),\s*C(\d+)\)/g, (match, rSeq, cSeq) => {
                            return getCellValue(rSeq, cSeq);
                        });
                        
                        // ประมวลผลสมการคณิตศาสตร์ที่แปลงค่าตัวเลขแล้ว
                        col.value = new Function(`return ${parsedFormula}`)();
                    } catch (err) {
                        col.value = 0;
                    }
                }
            });
        });

        let finalData = reportData.filter(r => r.print_control === 'SHOW');
        finalData.sort((a, b) => a.seq_no - b.seq_no);

        // ส่งข้อมูลกลับไปที่ Frontend (กรองเฉพาะ Print Control ที่ให้แสดงผล)
        res.status(200).json({
            report_code: master.report_code,
            report_name: master.report_name_thai,
            parenthesis_for_minus: master.parenthesis_for_minus,
            page_config: {
                orientation: master.page_orientation,
                margins: [master.margin_top, master.margin_right, master.margin_bottom, master.margin_left],
            },
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
