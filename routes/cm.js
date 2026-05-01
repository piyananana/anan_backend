// routes/cm.js — Cash Management
const express = require('express');
const router = express.Router();
const cmBankController          = require('../controllers/cm/cmBankController');
const cmBankAccountController   = require('../controllers/cm/cmBankAccountController');
const cmPaymentMethodController = require('../controllers/cm/cmPaymentMethodController');

// cm_bank
router.get('/cm_bank',          cmBankController.fetchRows);
router.get('/cm_bank/:id',      cmBankController.fetchRow);
router.post('/cm_bank',         cmBankController.createRow);
router.put('/cm_bank/:id',      cmBankController.updateRow);
router.delete('/cm_bank/:id',   cmBankController.deleteRow);

// cm_bank_account
router.get('/cm_bank_account',        cmBankAccountController.fetchRows);
router.get('/cm_bank_account/:id',    cmBankAccountController.fetchRow);
router.post('/cm_bank_account',       cmBankAccountController.createRow);
router.put('/cm_bank_account/:id',    cmBankAccountController.updateRow);
router.delete('/cm_bank_account/:id', cmBankAccountController.deleteRow);

// cm_payment_method
router.get('/cm_payment_method',        cmPaymentMethodController.fetchRows);
router.get('/cm_payment_method/:id',    cmPaymentMethodController.fetchRow);
router.post('/cm_payment_method',       cmPaymentMethodController.createRow);
router.put('/cm_payment_method/:id',    cmPaymentMethodController.updateRow);
router.delete('/cm_payment_method/:id', cmPaymentMethodController.deleteRow);

module.exports = router;
