// routes/im.js — Inventory Management
const express = require('express');
const router = express.Router();
const imItemCategoryController = require('../controllers/im/imItemCategoryController');
const imItemController         = require('../controllers/im/imItemController');
const imItemRunningController  = require('../controllers/im/imItemRunningController');

// im_item_category
router.get('/im_item_category',        imItemCategoryController.fetchRows);
router.get('/im_item_category/active', imItemCategoryController.fetchActiveRows);
router.get('/im_item_category/:id',    imItemCategoryController.fetchRow);
router.post('/im_item_category',       imItemCategoryController.addRow);
router.put('/im_item_category/:id',    imItemCategoryController.updateRow);
router.delete('/im_item_category/:id', imItemCategoryController.deleteRow);

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
