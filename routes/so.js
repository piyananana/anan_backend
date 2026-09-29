// routes/so.js — Sales (Sale Order) — มิเรอร์ routes/po.js (po_transaction section) ทุกประการ
const express = require('express');
const router = express.Router();
const soTransactionController = require('../controllers/so/soTransactionController');

// so_transaction (ใบสั่งขาย — Draft->Approved->[PartiallyDelivered/FullyDelivered คำนวณอัตโนมัติจาก DLN ที่อ้างอิง]
// ->Closed, กิ่ง Void แยกได้ แต่บล็อกถ้ามี DLN อ้างอิงแล้ว) deliverable_lines ต้องมาก่อน /:id ด้านล่าง
router.get('/so_transaction/deliverable_lines', soTransactionController.fetchDeliverableLines);
router.get('/so_transaction',                   soTransactionController.fetchRows);
router.get('/so_transaction/:id',               soTransactionController.fetchRow);
router.post('/so_transaction',                  soTransactionController.createTransaction);
router.put('/so_transaction/:id',               soTransactionController.updateTransaction);
router.put('/so_transaction/:id/approve',       soTransactionController.approveTransaction);
router.put('/so_transaction/:id/close',         soTransactionController.closeTransaction);
router.put('/so_transaction/:id/void',          soTransactionController.voidTransaction);
router.delete('/so_transaction/:id',            soTransactionController.deleteTransaction);

module.exports = router;
