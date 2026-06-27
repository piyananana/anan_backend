// routes/ap.js
const express = require('express');
const router  = express.Router();

const apVendorRunningController  = require('../controllers/ap/apVendorRunningController');
const apVendorGroupController    = require('../controllers/ap/apVendorGroupController');
const apVendorController         = require('../controllers/ap/apVendorController');
const apVendorReportController   = require('../controllers/ap/apVendorReportController');
const apWhtReportController      = require('../controllers/ap/apWhtReportController');
const apGlAccountSetupController = require('../controllers/ap/apGlAccountSetupController');
const apTransactionController    = require('../controllers/ap/apTransactionController');
const apPaymentRunController     = require('../controllers/ap/apPaymentRunController');
const apVendorImportController   = require('../controllers/ap/apVendorImportController');

// ── Vendor Running (auto-code) ─────────────────────────────────────────────
router.get('/ap_vendor_running/preview_code', apVendorRunningController.previewCode);
router.get('/ap_vendor_running',              apVendorRunningController.fetchConfig);
router.post('/ap_vendor_running',             apVendorRunningController.saveConfig);

// ── Vendor Group ───────────────────────────────────────────────────────────
router.get('/ap_vendor_group/active', apVendorGroupController.fetchActiveRows);
router.get('/ap_vendor_group',        apVendorGroupController.fetchRows);
router.get('/ap_vendor_group/:id',    apVendorGroupController.fetchRow);
router.post('/ap_vendor_group',       apVendorGroupController.addRow);
router.put('/ap_vendor_group/:id',    apVendorGroupController.updateRow);
router.delete('/ap_vendor_group/:id', apVendorGroupController.deleteRow);

// ── Vendor Import ──────────────────────────────────────────────────────────
router.get('/ap_vendor/import/template',          apVendorImportController.getTemplate);
router.get('/ap_vendor/import/template/download', apVendorImportController.downloadTemplate);
router.post('/ap_vendor/import/validate',         apVendorImportController.validateFile);
router.post('/ap_vendor/import/confirm',          apVendorImportController.confirmImport);

// ── WHT Report ────────────────────────────────────────────────────────────
router.get('/ap_wht_report', apWhtReportController.fetchWhtReport);

// ── Vendor master ──────────────────────────────────────────────────────────
router.get('/ap_vendor/active',  apVendorController.fetchActiveRows);
router.get('/ap_vendor/report',  apVendorReportController.fetchReport);
router.get('/ap_vendor',         apVendorController.fetchRows);
router.get('/ap_vendor/:id',    apVendorController.fetchRow);
router.post('/ap_vendor',       apVendorController.addRow);
router.put('/ap_vendor/:id',    apVendorController.updateRow);
router.delete('/ap_vendor/:id', apVendorController.deleteRow);

// ── GL Account Setup ───────────────────────────────────────────────────────
router.get('/ap_gl_account_setup',            apGlAccountSetupController.fetchRows);
router.get('/ap_gl_account_setup/:doc_code',  apGlAccountSetupController.fetchRow);
router.post('/ap_gl_account_setup/:doc_code', apGlAccountSetupController.upsertRow);

// ── AP Payment Run ─────────────────────────────────────────────────────────
router.get('/ap_payment_run/my_pending',        apPaymentRunController.fetchMyPending);
router.get('/ap_payment_run/open_invoices',    apPaymentRunController.fetchOpenInvoicesForRun);
router.get('/ap_payment_run',                  apPaymentRunController.fetchRows);
router.get('/ap_payment_run/:id',              apPaymentRunController.fetchRow);
router.post('/ap_payment_run',                 apPaymentRunController.createRun);
router.put('/ap_payment_run/:id/submit',       apPaymentRunController.submitRun);
router.put('/ap_payment_run/:id/approve',      apPaymentRunController.approveRun);
router.put('/ap_payment_run/:id/reject',       apPaymentRunController.rejectRun);
router.put('/ap_payment_run/:id/void',         apPaymentRunController.voidRun);
router.put('/ap_payment_run/:id/post_gl',      apPaymentRunController.postRun);
router.put('/ap_payment_run/:id',              apPaymentRunController.updateRun);

// ── AP Transaction ─────────────────────────────────────────────────────────
router.get('/ap_transaction/open_invoices',          apTransactionController.fetchOpenInvoices);
router.get('/ap_transaction/open_advances',          apTransactionController.fetchOpenAdvances);
router.get('/ap_transaction/open_remittance_advices', apTransactionController.fetchOpenRemittanceAdvices);
router.get('/ap_transaction/ra_invoices',            apTransactionController.fetchRaInvoices);
router.get('/ap_transaction',                        apTransactionController.fetchRows);
router.get('/ap_transaction/:id',                    apTransactionController.fetchRow);
router.post('/ap_transaction',                       apTransactionController.createTransaction);
router.put('/ap_transaction/:id',                    apTransactionController.updateTransaction);
router.put('/ap_transaction/:id/void',               apTransactionController.voidTransaction);
router.delete('/ap_transaction/:id',                 apTransactionController.deleteTransaction);


module.exports = router;
