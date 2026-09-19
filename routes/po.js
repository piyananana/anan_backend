// routes/po.js — Purchasing (Purchase Order)
const express = require('express');
const router = express.Router();
const poTransactionController = require('../controllers/po/poTransactionController');
const poReplenishmentController = require('../controllers/po/poReplenishmentController');
const poPrTransactionController = require('../controllers/po/poPrTransactionController');

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

// po_replenishment (ใบแนะนำสั่งซื้อเพื่อเติมสต็อก — อ่านอย่างเดียว)
router.get('/po_replenishment/suggestions', poReplenishmentController.fetchSuggestions);

// pr_transaction (ใบขอซื้อ — ย้ายมารวมกับ po.js เพราะ PR เป็นส่วนหนึ่งของ workflow จัดซื้อเดียวกับ PO, เดิมอยู่
// routes/pr.js แยกต่างหาก — Draft/Rejected->Submitted->Approved/Rejected->[PartiallyConverted/FullyConverted
// คำนวณอัตโนมัติจาก PO ที่อ้างอิง]->Closed, กิ่ง Void แยกได้ แต่บล็อกถ้ามี PO อ้างอิงแล้ว)
// convertible_lines/my_pending ต้องมาก่อน /:id ด้านล่าง
router.get('/pr_transaction/convertible_lines', poPrTransactionController.fetchConvertibleLines);
router.get('/pr_transaction/my_pending',        poPrTransactionController.fetchMyPending);
router.get('/pr_transaction',                   poPrTransactionController.fetchRows);
router.get('/pr_transaction/:id',               poPrTransactionController.fetchRow);
router.post('/pr_transaction',                  poPrTransactionController.createTransaction);
router.put('/pr_transaction/:id',               poPrTransactionController.updateTransaction);
router.put('/pr_transaction/:id/submit',        poPrTransactionController.submitTransaction);
router.put('/pr_transaction/:id/approve',       poPrTransactionController.approveTransaction);
router.put('/pr_transaction/:id/reject',        poPrTransactionController.rejectTransaction);
router.put('/pr_transaction/:id/close',         poPrTransactionController.closeTransaction);
router.put('/pr_transaction/:id/void',          poPrTransactionController.voidTransaction);
router.delete('/pr_transaction/:id',            poPrTransactionController.deleteTransaction);

module.exports = router;
