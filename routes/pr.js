// routes/pr.js — Purchasing (Purchase Requisition)
const express = require('express');
const router = express.Router();
const prTransactionController = require('../controllers/pr/prTransactionController');

// pr_transaction (ใบขอซื้อ — Draft/Rejected->Submitted->Approved/Rejected->[PartiallyConverted/FullyConverted
// คำนวณอัตโนมัติจาก PO ที่อ้างอิง]->Closed, กิ่ง Void แยกได้ แต่บล็อกถ้ามี PO อ้างอิงแล้ว)
// convertible_lines/my_pending ต้องมาก่อน /:id ด้านล่าง
router.get('/pr_transaction/convertible_lines', prTransactionController.fetchConvertibleLines);
router.get('/pr_transaction/my_pending',        prTransactionController.fetchMyPending);
router.get('/pr_transaction',                   prTransactionController.fetchRows);
router.get('/pr_transaction/:id',               prTransactionController.fetchRow);
router.post('/pr_transaction',                  prTransactionController.createTransaction);
router.put('/pr_transaction/:id',               prTransactionController.updateTransaction);
router.put('/pr_transaction/:id/submit',        prTransactionController.submitTransaction);
router.put('/pr_transaction/:id/approve',       prTransactionController.approveTransaction);
router.put('/pr_transaction/:id/reject',        prTransactionController.rejectTransaction);
router.put('/pr_transaction/:id/close',         prTransactionController.closeTransaction);
router.put('/pr_transaction/:id/void',          prTransactionController.voidTransaction);
router.delete('/pr_transaction/:id',            prTransactionController.deleteTransaction);

module.exports = router;
