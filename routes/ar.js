// routes/ar.js
const express = require('express');
const router = express.Router();
const arCustomerController = require('../controllers/ar/arCustomerController');
const arCustomerGroupController = require('../controllers/ar/arCustomerGroupController');
const arCustomerRunningController = require('../controllers/ar/arCustomerRunningController');
const arTransactionController = require('../controllers/ar/arTransactionController');
const arCollectorController = require('../controllers/ar/arCollectorController');
const arCustomerImportController = require('../controllers/ar/arCustomerImportController');
const arGlAccountSetupController = require('../controllers/ar/arGlAccountSetupController');
const arAgingReportController        = require('../controllers/ar/arAgingReportController');
const arTransactionReportController  = require('../controllers/ar/arTransactionReportController');
const arMovementReportController     = require('../controllers/ar/arMovementReportController');
const arBillingPlanReportController   = require('../controllers/ar/arBillingPlanReportController');
const arBillingStatusReportController = require('../controllers/ar/arBillingStatusReportController');
const arBulkBillingController         = require('../controllers/ar/arBulkBillingController');
const arReceiptPaymentReportController = require('../controllers/ar/arReceiptPaymentReportController');
const arResetController          = require('../controllers/ar/arResetController');

// Router สำหรับตั้งค่ารหัสลูกหนี้อัตโนมัติ
router.get('/ar_customer_running/preview_code', arCustomerRunningController.previewCode);
router.get('/ar_customer_running', arCustomerRunningController.fetchConfig);
router.post('/ar_customer_running', arCustomerRunningController.saveConfig);

// Router สำหรับจัดการข้อมูลผู้วางบิล/รับชำระ
router.get('/ar_collector', arCollectorController.fetchRows);
router.get('/ar_collector/:id', arCollectorController.fetchRow);
router.post('/ar_collector', arCollectorController.addRow);
router.put('/ar_collector/:id', arCollectorController.updateRow);
router.delete('/ar_collector/:id', arCollectorController.deleteRow);

// Router สำหรับจัดการข้อมูลกลุ่มลูกค้า
router.get('/ar_customer_group/active', arCustomerGroupController.fetchActiveRows);
router.get('/ar_customer_group', arCustomerGroupController.fetchRows);
router.get('/ar_customer_group/:id/preview_code', arCustomerGroupController.previewGroupCode);
router.get('/ar_customer_group/:id', arCustomerGroupController.fetchRow);
router.post('/ar_customer_group', arCustomerGroupController.addRow);
router.put('/ar_customer_group/:id', arCustomerGroupController.updateRow);
router.delete('/ar_customer_group/:id', arCustomerGroupController.deleteRow);
router.delete('/ar_customer_group', arCustomerGroupController.deleteRows);

// Router สำหรับ Import ข้อมูลลูกหนี้
router.get('/ar_customer/import/template', arCustomerImportController.getTemplate);
router.get('/ar_customer/import/template/download', arCustomerImportController.downloadTemplate);
router.post('/ar_customer/import/validate', arCustomerImportController.validateFile);
router.post('/ar_customer/import/confirm', arCustomerImportController.confirmImport);

// Router สำหรับจัดการข้อมูลลูกหนี้การค้า
router.get('/ar_customer', arCustomerController.fetchRows);
router.get('/ar_customer/:id', arCustomerController.fetchRow);
router.post('/ar_customer', arCustomerController.addRow);
router.put('/ar_customer/:id', arCustomerController.updateRow);
router.delete('/ar_customer/:id', arCustomerController.deleteRow);

// Router สำหรับ AR Transaction (Invoice, DN, CN, Receipt)
router.get('/ar_transaction/open_invoices', arTransactionController.fetchOpenInvoices);
router.get('/ar_transaction/open_advances', arTransactionController.fetchOpenAdvances);
router.get('/ar_transaction/open_advances_for_refund', arTransactionController.fetchOpenAdvancesForRefund);
router.get('/ar_transaction/open_credit_notes', arTransactionController.fetchOpenCreditNotes);
router.get('/ar_transaction/invoice_billing_summary', arTransactionController.fetchInvoiceBillingSummary);
router.get('/ar_transaction/bill_collection_by_doc_no', arTransactionController.fetchBillCollectionByDocNo);
router.get('/ar_transaction', arTransactionController.fetchRows);
router.get('/ar_transaction/:id', arTransactionController.fetchRow);
router.post('/ar_transaction', arTransactionController.createTransaction);
router.put('/ar_transaction/:id', arTransactionController.updateTransaction);
router.put('/ar_transaction/:id/void', arTransactionController.voidTransaction);
router.delete('/ar_transaction/:id', arTransactionController.deleteTransaction);

// Router สำหรับรายงานลูกหนี้คงค้างตามอายุ
router.get('/ar_aging_report',             arAgingReportController.getAgingReport);
router.get('/ar_transaction_report',       arTransactionReportController.getTransactionReport);
router.get('/ar_movement_report',      arMovementReportController.getMovementReport);
router.get('/ar_billing_plan_report',   arBillingPlanReportController.getBillingPlanReport);
router.get('/ar_billing_status_report',   arBillingStatusReportController.getBillingStatusReport);
router.get('/ar_receipt_payment_report', arReceiptPaymentReportController.getReceiptPaymentReport);
router.get('/ar_bc_document_types',    arBulkBillingController.getBcDocTypes);
router.post('/ar_bulk_billing',        arBulkBillingController.createBulkBilling);

// Router สำหรับตั้งค่ารหัสบัญชี GL ต่อ doc_code ของ AR
router.get('/ar_gl_account_setup', arGlAccountSetupController.fetchRows);
router.get('/ar_gl_account_setup/:doc_code', arGlAccountSetupController.fetchRow);
router.post('/ar_gl_account_setup/:doc_code', arGlAccountSetupController.upsertRow);

// Developer-only: reset AR transaction data
router.get('/ar_reset_transactions/counts', arResetController.getCounts);
router.delete('/ar_reset_transactions', arResetController.resetTransactions);

module.exports = router;
