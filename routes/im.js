// routes/im.js — Inventory Management
const express = require('express');
const router = express.Router();
const imItemCategoryController = require('../controllers/im/imItemCategoryController');
const imItemController         = require('../controllers/im/imItemController');
const imItemRunningController  = require('../controllers/im/imItemRunningController');
const imUomController          = require('../controllers/im/imUomController');
const imWarehouseController    = require('../controllers/im/imWarehouseController');
const imBomController          = require('../controllers/im/imBomController');
const imPriceListController    = require('../controllers/im/imPriceListController');
const imGlAccountSetupController = require('../controllers/im/imGlAccountSetupController');
const imItemImportController   = require('../controllers/im/imItemImportController');
const imLocationController     = require('../controllers/im/imLocationController');
const imLocationImportController = require('../controllers/im/imLocationImportController');
const imStockBalanceController = require('../controllers/im/imStockBalanceController');
const imStockLayerController   = require('../controllers/im/imStockLayerController');
const imTransactionController  = require('../controllers/im/imTransactionController');
const imStockCountController   = require('../controllers/im/imStockCountController');
const imStockCountRunningController = require('../controllers/im/imStockCountRunningController');
const imOpeningBalanceImportController = require('../controllers/im/imOpeningBalanceImportController');
const imAccountingSettingController = require('../controllers/im/imAccountingSettingController');
const imPeriodClosingController = require('../controllers/im/imPeriodClosingController');
const imGrBillingReportController = require('../controllers/im/imGrBillingReportController');
const imDlnBillingReportController = require('../controllers/im/imDlnBillingReportController');
const imResetController        = require('../controllers/im/imResetController');
const imTransactionReportController = require('../controllers/im/imTransactionReportController');
const imItemTransactionReportController = require('../controllers/im/imItemTransactionReportController');

// im_gl_account_setup (per doc-type GL fallback, for the future im_transaction module)
router.get('/im_gl_account_setup',           imGlAccountSetupController.fetchRows);
router.get('/im_gl_account_setup/:doc_code', imGlAccountSetupController.fetchRow);
router.post('/im_gl_account_setup/:doc_code', imGlAccountSetupController.upsertRow);

// im_price_list (im_price_list + im_price_list_detail)
router.get('/im_price_list',                     imPriceListController.fetchRows);
router.get('/im_price_list/:id',                 imPriceListController.fetchRow);
router.get('/im_price_list_detail/by_item/:itemId', imPriceListController.fetchByItem);
router.post('/im_price_list',                    imPriceListController.addRow);
router.put('/im_price_list/:id',                 imPriceListController.updateRow);
router.delete('/im_price_list/:id',               imPriceListController.deleteRow);

// im_bom (im_bom_header + im_bom_detail)
router.get('/im_bom',        imBomController.fetchRows);
router.get('/im_bom/:id',    imBomController.fetchRow);
router.post('/im_bom',       imBomController.addRow);
router.put('/im_bom/:id',    imBomController.updateRow);
router.delete('/im_bom/:id', imBomController.deleteRow);

// im_warehouse
router.get('/im_warehouse',        imWarehouseController.fetchRows);
router.get('/im_warehouse/active', imWarehouseController.fetchActiveRows);
router.get('/im_warehouse/:id',    imWarehouseController.fetchRow);
router.post('/im_warehouse',       imWarehouseController.addRow);
router.put('/im_warehouse/:id',    imWarehouseController.updateRow);
router.delete('/im_warehouse/:id', imWarehouseController.deleteRow);

// im_location (ผังตำแหน่งจัดเก็บ — โซน/แถว/ช่องเก็บ ต่อคลังสินค้า)
router.get('/im_location',        imLocationController.fetchRows);
router.get('/im_location/active', imLocationController.fetchActiveRows);
router.get('/im_location/:id',    imLocationController.fetchRow);
router.post('/im_location',       imLocationController.addRow);
router.put('/im_location/:id',    imLocationController.updateRow);
router.delete('/im_location/:id', imLocationController.deleteRow);

// im_location import
router.get('/im_location/import/template',          imLocationImportController.getTemplate);
router.get('/im_location/import/template/download', imLocationImportController.downloadTemplate);
router.post('/im_location/import/validate',         imLocationImportController.validateFile);
router.post('/im_location/import/confirm',          imLocationImportController.confirmImport);

// im_stock_balance / im_stock_layer (sub-ledger — อ่านอย่างเดียว เขียนโดยการ Post ใบนับสต็อกเท่านั้น)
router.get('/im_stock_balance', imStockBalanceController.fetchRows);
router.get('/im_stock_layer',   imStockLayerController.fetchRows);

// im_transaction (v1: doc_code='AJS' — ตั้งยอดสินค้าด้วยการนับสต็อค; ISS/TRF/GRN/DLN family เพิ่มทีหลังในหน้าจอเดียวกัน)
router.get('/im_transaction/system_qty', imTransactionController.fetchSystemQty);
router.get('/im_transaction/returnable_docs', imTransactionController.fetchReturnableDocs);
router.get('/im_transaction/gr_billing_report', imGrBillingReportController.getGrBillingReport);
router.get('/im_transaction/dln_billing_report', imDlnBillingReportController.getDlnBillingReport);
router.get('/im_transaction_report', imTransactionReportController.getTransactionReport);
router.get('/im_item_transaction_report', imItemTransactionReportController.getItemTransactionReport);
router.get('/im_transaction',            imTransactionController.fetchRows);
router.get('/im_transaction/:id',        imTransactionController.fetchRow);
router.get('/im_transaction/:id/returnable_lines', imTransactionController.fetchReturnableLines);
router.post('/im_transaction',           imTransactionController.createTransaction);
router.put('/im_transaction/:id',        imTransactionController.updateTransaction);
router.put('/im_transaction/:id/post',   imTransactionController.postTransaction);
router.put('/im_transaction/:id/post_billing', imTransactionController.postBillingForGrn);
router.put('/im_transaction/:id/post_billing_ar', imTransactionController.postBillingForDln);
router.put('/im_transaction/:id/void',   imTransactionController.voidTransaction);
router.delete('/im_transaction/:id',     imTransactionController.deleteTransaction);

// im_accounting_setting (โหมดบัญชีสินค้า PERPETUAL/PERIODIC ระดับบริษัท)
router.get('/im_accounting_setting',  imAccountingSettingController.getSetting);
router.put('/im_accounting_setting',  imAccountingSettingController.upsertSetting);

// im_period_closing (ปิดงวดสต็อกสินค้าสำหรับโหมด PERIODIC — คำนวณ+โพสต์ COGS ครั้งเดียวต่องวด)
router.get('/im_period_closing/:periodId/preview', imPeriodClosingController.calculatePreview);
router.post('/im_period_closing/:periodId/confirm', imPeriodClosingController.confirmClose);

// im_opening_balance (ตั้งยอดคงเหลือ+มูลค่าสินค้าเริ่มต้น — ไม่ผ่าน GL, ไม่ผ่าน im_transaction)
router.get('/im_opening_balance/import/template',          imOpeningBalanceImportController.getTemplate);
router.get('/im_opening_balance/import/template/download', imOpeningBalanceImportController.downloadTemplate);
router.post('/im_opening_balance/import/validate',         imOpeningBalanceImportController.validateFile);
router.post('/im_opening_balance/import/confirm',          imOpeningBalanceImportController.confirmImport);

// im_stock_count_running (เลขที่ใบตรวจนับอัตโนมัติ)
router.get('/im_stock_count_running/preview_code', imStockCountRunningController.previewCode);
router.get('/im_stock_count_running',              imStockCountRunningController.fetchConfig);
router.post('/im_stock_count_running',             imStockCountRunningController.saveConfig);

// im_stock_count (ใบตรวจนับสต็อก — Draft->Posted->Approved->Closed, กิ่ง Void แยกจาก Draft/Posted)
// Closed = บันทึกปรับยอดแล้ว สร้าง+โพสต์ im_transaction AJS ให้อัตโนมัติ
router.get('/im_stock_count/variance_report',   imStockCountController.fetchVarianceReport);
router.get('/im_stock_count',                   imStockCountController.fetchRows);
router.get('/im_stock_count/:id',               imStockCountController.fetchRow);
router.get('/im_stock_count/:id/lines',         imStockCountController.fetchLinesForRecording);
router.get('/im_stock_count/:id/check',         imStockCountController.checkResults);
router.post('/im_stock_count',                  imStockCountController.addRow);
router.put('/im_stock_count/:id',               imStockCountController.updateHeader);
router.put('/im_stock_count/:id/resync',        imStockCountController.resyncLines);
router.put('/im_stock_count/:id/post',          imStockCountController.postCount);
router.put('/im_stock_count/:id/void',          imStockCountController.voidCount);
router.put('/im_stock_count/:id/print_count',   imStockCountController.incrementPrintCount);
router.put('/im_stock_count/:id/counts',        imStockCountController.updateCounts);
router.put('/im_stock_count/:id/approve',       imStockCountController.approveCount);
router.put('/im_stock_count/:id/close',         imStockCountController.closeCount);
router.get('/im_stock_count/:id/export',        imStockCountController.exportExcel);
router.post('/im_stock_count/:id/import/validate', imStockCountController.importValidate);
router.post('/im_stock_count/:id/import/confirm',  imStockCountController.importConfirm);

// im_uom
router.get('/im_uom',        imUomController.fetchRows);
router.get('/im_uom/active', imUomController.fetchActiveRows);
router.get('/im_uom/:id',    imUomController.fetchRow);
router.post('/im_uom',       imUomController.addRow);
router.put('/im_uom/:id',    imUomController.updateRow);
router.delete('/im_uom/:id', imUomController.deleteRow);

// im_item_category
router.get('/im_item_category',        imItemCategoryController.fetchRows);
router.get('/im_item_category/active', imItemCategoryController.fetchActiveRows);
router.get('/im_item_category/:id',    imItemCategoryController.fetchRow);
router.post('/im_item_category',       imItemCategoryController.addRow);
router.put('/im_item_category/:id',    imItemCategoryController.updateRow);
router.delete('/im_item_category/:id', imItemCategoryController.deleteRow);

// im_item import
router.get('/im_item/import/template',          imItemImportController.getTemplate);
router.get('/im_item/import/template/download', imItemImportController.downloadTemplate);
router.post('/im_item/import/validate',         imItemImportController.validateFile);
router.post('/im_item/import/confirm',          imItemImportController.confirmImport);

// im_item
router.get('/im_item',        imItemController.fetchRows);
router.get('/im_item/:id',    imItemController.fetchRow);
router.post('/im_item',       imItemController.addRow);
router.put('/im_item/:id',    imItemController.updateRow);
router.delete('/im_item/:id', imItemController.deleteRow);

// im_item_running (auto-numbering settings)
router.get('/im_item_running/preview_code', imItemRunningController.previewCode);
router.get('/im_item_running',              imItemRunningController.fetchConfig);
router.post('/im_item_running',             imItemRunningController.saveConfig);

// im_reset_transactions (เครื่องมือผู้พัฒนาระบบ — ล้างข้อมูลธุรกรรม/ข้อมูลหลักของ IM)
router.get('/im_reset_transactions/counts', imResetController.getCounts);
router.delete('/im_reset_transactions',     imResetController.resetTransactions);

module.exports = router;
