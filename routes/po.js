// routes/po.js — Purchasing (Purchase Order)
const express = require('express');
const router = express.Router();
const poTransactionController = require('../controllers/po/poTransactionController');

// po_transaction (ใบสั่งซื้อ — Draft->Approved->[PartiallyReceived/FullyReceived คำนวณอัตโนมัติจาก GRN ที่อ้างอิง]
// ->Closed, กิ่ง Void แยกได้ แต่บล็อกถ้ามี GRN อ้างอิงแล้ว) receivable_lines ต้องมาก่อน /:id ด้านล่าง
router.get('/po_transaction/receivable_lines', poTransactionController.fetchReceivableLines);
router.get('/po_transaction',                  poTransactionController.fetchRows);
router.get('/po_transaction/:id',              poTransactionController.fetchRow);
router.post('/po_transaction',                 poTransactionController.createTransaction);
router.put('/po_transaction/:id',              poTransactionController.updateTransaction);
router.put('/po_transaction/:id/approve',      poTransactionController.approveTransaction);
router.put('/po_transaction/:id/close',        poTransactionController.closeTransaction);
router.put('/po_transaction/:id/void',         poTransactionController.voidTransaction);
router.delete('/po_transaction/:id',           poTransactionController.deleteTransaction);

module.exports = router;
