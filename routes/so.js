// routes/so.js — Sales (Sale Order) — มิเรอร์ routes/po.js (po_transaction section) ทุกประการ
const express = require('express');
const router = express.Router();
const soTransactionController = require('../controllers/so/soTransactionController');
const soQuoteTransactionController = require('../controllers/so/soQuoteTransactionController');

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

// quote_transaction (ใบเสนอราคา — ส่วนหนึ่งของ workflow สั่งขายเดียวกับ SO — Draft/Rejected->Submitted->
// Approved/Rejected->[PartiallyConverted/FullyConverted คำนวณอัตโนมัติจาก SO ที่อ้างอิง]->Closed, กิ่ง Void แยกได้
// แต่บล็อกถ้ามี SO อ้างอิงแล้ว) convertible_lines/my_pending ต้องมาก่อน /:id ด้านล่าง
router.get('/quote_transaction/convertible_lines', soQuoteTransactionController.fetchConvertibleLines);
router.get('/quote_transaction/my_pending',        soQuoteTransactionController.fetchMyPending);
router.get('/quote_transaction',                   soQuoteTransactionController.fetchRows);
router.get('/quote_transaction/:id',               soQuoteTransactionController.fetchRow);
router.post('/quote_transaction',                  soQuoteTransactionController.createTransaction);
router.put('/quote_transaction/:id',               soQuoteTransactionController.updateTransaction);
router.put('/quote_transaction/:id/submit',        soQuoteTransactionController.submitTransaction);
router.put('/quote_transaction/:id/approve',       soQuoteTransactionController.approveTransaction);
router.put('/quote_transaction/:id/reject',        soQuoteTransactionController.rejectTransaction);
router.put('/quote_transaction/:id/close',         soQuoteTransactionController.closeTransaction);
router.put('/quote_transaction/:id/void',          soQuoteTransactionController.voidTransaction);
router.delete('/quote_transaction/:id',            soQuoteTransactionController.deleteTransaction);

module.exports = router;
