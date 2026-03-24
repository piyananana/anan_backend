// routes/ar.js
const express = require('express');
const router = express.Router();
const arCustomerController = require('../controllers/ar/arCustomerController');
const arCustomerGroupController = require('../controllers/ar/arCustomerGroupController');
const arCustomerRunningController = require('../controllers/ar/arCustomerRunningController');
const arTransactionController = require('../controllers/ar/arTransactionController');
const arCollectorController = require('../controllers/ar/arCollectorController');

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
router.post('/ar_customer_group', arCustomerGroupController.addRow);
router.put('/ar_customer_group/:id', arCustomerGroupController.updateRow);
router.delete('/ar_customer_group/:id', arCustomerGroupController.deleteRow);
router.delete('/ar_customer_group', arCustomerGroupController.deleteRows);

// Router สำหรับจัดการข้อมูลลูกหนี้การค้า
router.get('/ar_customer', arCustomerController.fetchRows);
router.get('/ar_customer/:id', arCustomerController.fetchRow);
router.post('/ar_customer', arCustomerController.addRow);
router.put('/ar_customer/:id', arCustomerController.updateRow);
router.delete('/ar_customer/:id', arCustomerController.deleteRow);

// Router สำหรับ AR Transaction (Invoice, DN, CN, Receipt)
router.get('/ar_transaction/open_invoices', arTransactionController.fetchOpenInvoices);
router.get('/ar_transaction', arTransactionController.fetchRows);
router.get('/ar_transaction/:id', arTransactionController.fetchRow);
router.post('/ar_transaction', arTransactionController.createTransaction);
router.put('/ar_transaction/:id', arTransactionController.updateTransaction);
router.put('/ar_transaction/:id/void', arTransactionController.voidTransaction);
router.delete('/ar_transaction/:id', arTransactionController.deleteTransaction);

module.exports = router;
