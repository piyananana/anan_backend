// routes/gl.js
const express = require('express');
const router = express.Router();
const glAccountController = require('../controllers/gl/glAccountController');
const glBeginningBalanceController = require('../controllers/gl/glBeginningBalanceController');
const glEntryController = require('../controllers/gl/glEntryController');
const glFinancialReportEngineController = require('../controllers/gl/glFinancialReportEngineController');
const glGeneralLedgerReportController = require('../controllers/gl/glGeneralLedgerReportController');
const glPeriodController = require('../controllers/gl/glPeriodController');
const glTrialBalanceReportController = require('../controllers/gl/glTrialBalanceReportController');
const glFinancialReportBuilderController = require('../controllers/gl/glFinancialReportBuilderController');

// กำหนดที่เก็บไฟล์ชั่วคราวสำหรับอัปโหลด
const multer = require('multer');
const fileUpload = multer({ dest: 'public/gl/' });

// Router สำหรับจัดการข้อมูลบัญชีแยกประเภท
router.get('/gl_account', glAccountController.fetchRows);
router.get('/gl_account/control_account', glAccountController.fetchRowsControlAccount);
router.post('/gl_account', glAccountController.addRow);
router.put('/gl_account/:id', glAccountController.updateRow);
router.delete('/gl_account/:id', glAccountController.deleteRow);
router.delete('/gl_account', glAccountController.deleteRows);
router.post('/gl_account/import', fileUpload.single('excelFile'), glAccountController.importDataExcel);
router.get('/gl_account/export', glAccountController.exportDataExcel);

// Router สำหรับจัดการข้อมูลยอดยกมา
router.get('/gl_beginning_balance/year/:year', glBeginningBalanceController.getBalancesByYearId);
router.get('/gl_beginning_balance/period/:periodId', glBeginningBalanceController.getBalancesByPeriodId);
router.post('/gl_beginning_balance/save', glBeginningBalanceController.saveBeginningBalances);

// // Router สำหรับจัดการข้อมูลรายการบัญชี
// router.get('/gl_entry', glEntryController.fetchRows);
// router.post('/gl_entry', glEntryController.addRow);
// router.put('/gl_entry/:id', glEntryController.updateRow);
// router.delete('/gl_entry/:id', glEntryController.deleteRow);
// router.delete('/gl_entry', glEntryController.deleteRows);
router.get('/gl_entry', glEntryController.getTransactions);
router.get('/gl_entry/:id', glEntryController.getTransactionById);
router.post('/gl_entry', glEntryController.createTransaction);
router.put('/gl_entry/:id', glEntryController.updateTransaction);
router.delete('/gl_entry/:id', glEntryController.deleteTransaction);
router.post('/gl_entry/reverse/:id', glEntryController.reverseTransaction);
// Router สำหรับสร้างรายงานทางการเงิน (Financial Report Engine)
router.get('/gl_financial_report_master_list', glFinancialReportEngineController.getReportMasterList);
router.post('/gl_financial_report_engine', glFinancialReportEngineController.generateFinancialReport);
// Router สำหรับจัดการข้อมูลรายงาน General Ledger (GL Report)
router.get('/gl_general_ledger', glGeneralLedgerReportController.getGeneralLedgerTransactions);
// Router สำหรับจัดการปีงบประมาณและรอบบัญชี
router.get('/gl_fiscal_year', glPeriodController.fetchHeaderRows);
router.get('/gl_fiscal_year/:id', glPeriodController.fetchHeaderRowById);
router.post('/gl_fiscal_year', glPeriodController.addHeaderRow);
router.put('/gl_fiscal_year/:id', glPeriodController.updateHeaderRow);
router.delete('/gl_fiscal_year/:id', glPeriodController.deleteHeaderRow);
router.get('/gl_fiscal_year/:fyId/gl_posting_period', glPeriodController.fetchDetailRows);
// POST สำหรับสร้างรอบบัญชีเดี่ยว (เช่น รอบที่ 13)
router.post('/gl_posting_period', glPeriodController.addDetailRow); 
// PUT สำหรับแก้ไขรายละเอียดรอบบัญชี (ชื่อ, วันที่เริ่มต้น/สิ้นสุด)
router.put('/gl_posting_period/:id', glPeriodController.updateDetailRow); 
// PUT สำหรับอัปเดตสถานะรอบบัญชี (ใช้สำหรับปิดรอบบัญชี)
router.put('/gl_posting_period/:id/status', glPeriodController.updateStatusDetailRow); 
router.delete('/gl_posting_period/:id', glPeriodController.deleteDetailRow); 
// Router สำหรับจัดการข้อมูลรายงาน Trial Balance
router.get('/gl_trial_balance', glTrialBalanceReportController.getTrialBalance);

// Router สำหรับออกแบบงบการเงิน (Financial Report Builder)
router.get('/gl_fin_report', glFinancialReportBuilderController.getReports);
router.post('/gl_fin_report', glFinancialReportBuilderController.createReport);
router.put('/gl_fin_report/:id', glFinancialReportBuilderController.updateReport);
router.delete('/gl_fin_report/:id', glFinancialReportBuilderController.deleteReport);

router.get('/gl_fin_report_row/:report_id', glFinancialReportBuilderController.getRows);
router.post('/gl_fin_report_row', glFinancialReportBuilderController.createRow);
router.put('/gl_fin_report_row/:id', glFinancialReportBuilderController.updateRow);
router.delete('/gl_fin_report_row/:id', glFinancialReportBuilderController.deleteRow);

router.post('/gl_fin_report_column', glFinancialReportBuilderController.createColumn);
router.put('/gl_fin_report_column/:id', glFinancialReportBuilderController.updateColumn);
router.delete('/gl_fin_report_column/:id', glFinancialReportBuilderController.deleteColumn);

module.exports = router;
