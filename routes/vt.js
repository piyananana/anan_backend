// routes/vt.js
const express = require('express');
const router = express.Router();
const vatReportController = require('../controllers/vt/vatReportController');

// รายงานภาษีซื้อ / ภาษีขาย
router.get('/vat_report', vatReportController.getVatReport);

module.exports = router;
