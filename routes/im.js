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

module.exports = router;
