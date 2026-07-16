// routes/cm.js — Cash Management
const express = require('express');
const router = express.Router();
const cmBankAccountController      = require('../controllers/cm/cmBankAccountController');
const cmPaymentMethodController    = require('../controllers/cm/cmPaymentMethodController');
const cmBankFileFormatController   = require('../controllers/cm/cmBankFileFormatController');
const cmCheckbookController        = require('../controllers/cm/cmCheckbookController');
const cmCheckPrintConfigController = require('../controllers/cm/cmCheckPrintConfigController');
const cmReceiptController                   = require('../controllers/cm/cmReceiptController');
const cmPaymentController                   = require('../controllers/cm/cmPaymentController');
const cmPettyCashVoucherController          = require('../controllers/cm/cmPettyCashVoucherController');
const cmPettyCashReplenishmentController    = require('../controllers/cm/cmPettyCashReplenishmentController');
const cmBankStatementController             = require('../controllers/cm/cmBankStatementController');
const cmBankReconcileController             = require('../controllers/cm/cmBankReconcileController');
const cmBankFxRevaluationController         = require('../controllers/cm/cmBankFxRevaluationController');
const cmReportController                    = require('../controllers/cm/cmReportController');
const cmInterBankTransferController         = require('../controllers/cm/cmInterBankTransferController');
const cmGlAccountSetupController            = require('../controllers/cm/cmGlAccountSetupController');
const cmPreCloseCheckController             = require('../controllers/cm/cmPreCloseCheckController');
const cmResetController                     = require('../controllers/cm/cmResetController');
const cmBankGlReconcileController           = require('../controllers/cm/cmBankGlReconcileController');
const cmDashboardController                 = require('../controllers/cm/cmDashboardController');
const cmYearEndController                   = require('../controllers/cm/cmYearEndController');
const cmCheckPrintController                = require('../controllers/cm/cmCheckPrintController');
const cmBankOpeningBalanceController        = require('../controllers/cm/cmBankOpeningBalanceController');
const cmFxGainLossReportController          = require('../controllers/cm/cmFxGainLossReportController');
const cmCashFlowStatementController         = require('../controllers/cm/cmCashFlowStatementController');
const cmBankFileExportController            = require('../controllers/cm/cmBankFileExportController');
const cmDocNumberController                 = require('../controllers/cm/cmDocNumberController');
const cmBankStatementImportController       = require('../controllers/cm/cmBankStatementImportController');
const cmPostDatedCheckController            = require('../controllers/cm/cmPostDatedCheckController');
const cmBankChargeController                = require('../controllers/cm/cmBankChargeController');
const cmRemittanceAdviceController          = require('../controllers/cm/cmRemittanceAdviceController');
const cmBulkPaymentController               = require('../controllers/cm/cmBulkPaymentController');

// cm_bank_account
router.get('/cm_bank_account',        cmBankAccountController.fetchRows);
router.get('/cm_bank_account/active', cmBankAccountController.fetchActiveRows);
router.get('/cm_bank_account/:id',    cmBankAccountController.fetchRow);
router.post('/cm_bank_account',       cmBankAccountController.createRow);
router.put('/cm_bank_account/:id',    cmBankAccountController.updateRow);
router.delete('/cm_bank_account/:id', cmBankAccountController.deleteRow);

// cm_payment_method
router.get('/cm_payment_method',        cmPaymentMethodController.fetchRows);
router.get('/cm_payment_method/:id',    cmPaymentMethodController.fetchRow);
router.post('/cm_payment_method',       cmPaymentMethodController.createRow);
router.put('/cm_payment_method/:id',    cmPaymentMethodController.updateRow);
router.delete('/cm_payment_method/:id', cmPaymentMethodController.deleteRow);

// cm_bank_file_format
router.get('/cm_bank_file_format',        cmBankFileFormatController.fetchRows);
router.get('/cm_bank_file_format/:id',    cmBankFileFormatController.fetchRow);
router.post('/cm_bank_file_format',       cmBankFileFormatController.addRow);
router.put('/cm_bank_file_format/:id',    cmBankFileFormatController.updateRow);
router.delete('/cm_bank_file_format/:id', cmBankFileFormatController.deleteRow);

// cm_checkbook
router.get('/cm_checkbook',        cmCheckbookController.fetchRows);
router.get('/cm_checkbook/:id',    cmCheckbookController.fetchRow);
router.post('/cm_checkbook',       cmCheckbookController.createRow);
router.put('/cm_checkbook/:id',    cmCheckbookController.updateRow);
router.delete('/cm_checkbook/:id', cmCheckbookController.deleteRow);

// cm_check_print_config
router.get('/cm_check_print_config',        cmCheckPrintConfigController.fetchRows);
router.get('/cm_check_print_config/:id',    cmCheckPrintConfigController.fetchRow);
router.post('/cm_check_print_config',       cmCheckPrintConfigController.createRow);
router.put('/cm_check_print_config/:id',    cmCheckPrintConfigController.updateRow);
router.delete('/cm_check_print_config/:id', cmCheckPrintConfigController.deleteRow);

// cm_receipt
router.get('/cm_receipt',              cmReceiptController.fetchRows);
router.get('/cm_receipt/:id',          cmReceiptController.fetchRow);
router.put('/cm_receipt/:id/clear',    cmReceiptController.clearReceipt);
router.put('/cm_receipt/:id/bounce',   cmReceiptController.bounceReceipt);
router.put('/cm_receipt/:id/void',     cmReceiptController.voidReceipt);

// cm_payment
router.get('/cm_payment',              cmPaymentController.fetchRows);
router.get('/cm_payment/:id',          cmPaymentController.fetchRow);
router.post('/cm_payment',             cmPaymentController.createPayment);
router.put('/cm_payment/:id/clear',    cmPaymentController.clearPayment);
router.put('/cm_payment/:id/void',     cmPaymentController.voidPayment);

// cm_petty_cash_voucher
router.get('/cm_petty_cash_voucher',               cmPettyCashVoucherController.fetchRows);
router.get('/cm_petty_cash_voucher/:id',            cmPettyCashVoucherController.fetchRow);
router.post('/cm_petty_cash_voucher',               cmPettyCashVoucherController.createRow);
router.put('/cm_petty_cash_voucher/:id',            cmPettyCashVoucherController.updateRow);
router.put('/cm_petty_cash_voucher/:id/approve',    cmPettyCashVoucherController.approveRow);
router.put('/cm_petty_cash_voucher/:id/void',       cmPettyCashVoucherController.voidRow);
router.delete('/cm_petty_cash_voucher/:id',         cmPettyCashVoucherController.deleteRow);

// cm_petty_cash_replenishment
router.get('/cm_petty_cash_replenishment',               cmPettyCashReplenishmentController.fetchRows);
router.get('/cm_petty_cash_replenishment/pending_vouchers', cmPettyCashReplenishmentController.fetchPendingVouchers);
router.get('/cm_petty_cash_replenishment/:id',           cmPettyCashReplenishmentController.fetchRow);
router.get('/cm_petty_cash_replenishment/:id/vouchers',  cmPettyCashReplenishmentController.fetchReplenishedVouchers);
router.post('/cm_petty_cash_replenishment',              cmPettyCashReplenishmentController.createRow);
router.put('/cm_petty_cash_replenishment/:id',           cmPettyCashReplenishmentController.updateRow);
router.put('/cm_petty_cash_replenishment/:id/post',      cmPettyCashReplenishmentController.postReplenishment);
router.put('/cm_petty_cash_replenishment/:id/void',      cmPettyCashReplenishmentController.voidRow);

// cm_bank_statement
router.get('/cm_bank_statement',                          cmBankStatementController.fetchRows);
router.get('/cm_bank_statement/:id/lines',                cmBankStatementController.fetchLines);
router.get('/cm_bank_statement/:id',                      cmBankStatementController.fetchRow);
router.post('/cm_bank_statement',                         cmBankStatementController.createRow);
router.post('/cm_bank_statement/:id/lines',               cmBankStatementController.addLine);
router.post('/cm_bank_statement/:id/lines/bulk',          cmBankStatementController.bulkInsertLines);
router.put('/cm_bank_statement/:id',                      cmBankStatementController.updateRow);
router.put('/cm_bank_statement/:id/confirm',              cmBankStatementController.confirmRow);
router.put('/cm_bank_statement/:id/void',                 cmBankStatementController.voidRow);
router.put('/cm_bank_statement_line/:lineId',             cmBankStatementController.updateLine);
router.delete('/cm_bank_statement/:id',                   cmBankStatementController.deleteRow);
router.delete('/cm_bank_statement_line/:lineId',          cmBankStatementController.deleteLine);

// cm_bank_reconcile
router.get('/cm_reconcile/items',                               cmBankReconcileController.fetchItems);
router.get('/cm_reconcile/summary',                             cmBankReconcileController.getSummary);
router.put('/cm_reconcile/statement_line/:id/reconcile',        cmBankReconcileController.reconcilePair);
router.put('/cm_reconcile/statement_line/:id/unreconcile',      cmBankReconcileController.unreconcileStatementLine);

// cm_bank_fx_revaluation — preview BEFORE /:id to avoid route conflict
router.post('/cm_bank_fx_revaluation/preview',    cmBankFxRevaluationController.previewLines);
router.get('/cm_bank_fx_revaluation',             cmBankFxRevaluationController.fetchRows);
router.get('/cm_bank_fx_revaluation/:id',         cmBankFxRevaluationController.fetchRow);
router.post('/cm_bank_fx_revaluation',            cmBankFxRevaluationController.createRow);
router.put('/cm_bank_fx_revaluation/:id',         cmBankFxRevaluationController.updateRow);
router.put('/cm_bank_fx_revaluation/:id/post',    cmBankFxRevaluationController.postRow);
router.put('/cm_bank_fx_revaluation/:id/void',    cmBankFxRevaluationController.voidRow);
router.delete('/cm_bank_fx_revaluation/:id',      cmBankFxRevaluationController.deleteRow);

// cm_report
router.get('/cm_report/cash_position',       cmReportController.getCashPosition);
router.get('/cm_report/bank_transactions',   cmReportController.getBankTransactions);
router.get('/cm_report/check_register',      cmReportController.getCheckRegister);

// cm_inter_bank_transfer
router.get('/cm_inter_bank_transfer',          cmInterBankTransferController.fetchRows);
router.get('/cm_inter_bank_transfer/:id',      cmInterBankTransferController.fetchRow);
router.post('/cm_inter_bank_transfer',         cmInterBankTransferController.createRow);
router.put('/cm_inter_bank_transfer/:id',      cmInterBankTransferController.updateRow);
router.put('/cm_inter_bank_transfer/:id/post', cmInterBankTransferController.postRow);
router.put('/cm_inter_bank_transfer/:id/void', cmInterBankTransferController.voidRow);
router.delete('/cm_inter_bank_transfer/:id',   cmInterBankTransferController.deleteRow);

// cm_gl_account_setup
router.get('/cm_gl_account_setup',    cmGlAccountSetupController.fetchRows);
router.put('/cm_gl_account_setup',    cmGlAccountSetupController.upsertRow);

// cm_pre_close_check
router.get('/cm_pre_close_check', cmPreCloseCheckController.runChecks);

// cm_reset
router.post('/cm_reset', cmResetController.resetData);

// cm_bank_gl_reconcile
router.get('/cm_bank_gl_reconcile', cmBankGlReconcileController.getReport);

// cm_dashboard
router.get('/cm_dashboard', cmDashboardController.getDashboard);

// cm_year_end
router.get('/cm_year_end',                      cmYearEndController.fetchRows);
router.get('/cm_year_end/readiness',             cmYearEndController.checkReadiness);
router.post('/cm_year_end/close',               cmYearEndController.closeYear);
router.put('/cm_year_end/:id/reopen',           cmYearEndController.reopenYear);

// cm_check_print
router.get('/cm_check_print/checks',                    cmCheckPrintController.getChecks);
router.get('/cm_check_print/config/:bank_account_id',   cmCheckPrintController.getPrintConfig);

// cm_bank_opening_balance
router.get('/cm_bank_opening_balance',                  cmBankOpeningBalanceController.fetchRows);
router.put('/cm_bank_opening_balance',                  cmBankOpeningBalanceController.upsertRow);
router.delete('/cm_bank_opening_balance/:bank_account_id', cmBankOpeningBalanceController.deleteRow);

// cm_fx_gain_loss_report
router.get('/cm_fx_gain_loss_report', cmFxGainLossReportController.getReport);

// cm_cash_flow_statement
router.get('/cm_cash_flow_statement', cmCashFlowStatementController.getStatement);

// cm_bank_file_export
router.get('/cm_bank_file_export/payments',  cmBankFileExportController.getPayments);
router.post('/cm_bank_file_export/generate', cmBankFileExportController.generateFile);

// cm_doc_number_config  — preview BEFORE /:id
router.get('/cm_doc_number_config/preview', cmDocNumberController.previewDocNo);
router.get('/cm_doc_number_config',         cmDocNumberController.fetchRows);
router.post('/cm_doc_number_config',        cmDocNumberController.createRow);
router.put('/cm_doc_number_config/:id',     cmDocNumberController.updateRow);
router.delete('/cm_doc_number_config/:id',  cmDocNumberController.deleteRow);

// cm_bank_statement_import
router.post('/cm_bank_statement_import', cmBankStatementImportController.importStatement);

// cm_post_dated_check — summary BEFORE /:id
router.get('/cm_post_dated_check/summary',         cmPostDatedCheckController.getSummary);
router.get('/cm_post_dated_check',                  cmPostDatedCheckController.fetchRows);
router.post('/cm_post_dated_check',                 cmPostDatedCheckController.createRow);
router.put('/cm_post_dated_check/:id',              cmPostDatedCheckController.updateRow);
router.put('/cm_post_dated_check/:id/present',      cmPostDatedCheckController.presentCheck);
router.put('/cm_post_dated_check/:id/clear',        cmPostDatedCheckController.clearCheck);
router.put('/cm_post_dated_check/:id/return',       cmPostDatedCheckController.returnCheck);
router.put('/cm_post_dated_check/:id/cancel',       cmPostDatedCheckController.cancelCheck);
router.delete('/cm_post_dated_check/:id',           cmPostDatedCheckController.deleteRow);

// cm_bank_charge
router.get('/cm_bank_charge',                       cmBankChargeController.fetchRows);
router.post('/cm_bank_charge',                      cmBankChargeController.createRow);
router.put('/cm_bank_charge/:id',                   cmBankChargeController.updateRow);
router.put('/cm_bank_charge/:id/post',              cmBankChargeController.postCharge);
router.put('/cm_bank_charge/:id/void',              cmBankChargeController.voidCharge);
router.delete('/cm_bank_charge/:id',                cmBankChargeController.deleteRow);

// cm_remittance_advice — batch BEFORE /:id
router.get('/cm_remittance_advice/batch',           cmRemittanceAdviceController.getBatchRemittanceData);
router.get('/cm_remittance_advice/:payment_id',     cmRemittanceAdviceController.getRemittanceData);

// cm_bulk_payment
router.get('/cm_bulk_payment/eligible',             cmBulkPaymentController.getEligibleInvoices);
router.post('/cm_bulk_payment/run',                 cmBulkPaymentController.runBulkPayment);

module.exports = router;
