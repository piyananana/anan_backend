// routes/cd.js
const express = require('express');
const router = express.Router();
const cdBranchController = require('../controllers/cd/cdBranchController');
const cdBusinessUnitController = require('../controllers/cd/cdBusinessUnitController');
const cdCurrencyController = require('../controllers/cd/cdCurrencyController');
const cdProjectController = require('../controllers/cd/cdProjectController');
const cdZipcodeController = require('../controllers/cd/cdZipcodeController');

// กำหนดที่เก็บไฟล์ชั่วคราวสำหรับอัปโหลด
const multer = require('multer');
const fileUpload = multer({ dest: 'public/cd/' });

// Router สำหรับจัดการข้อมูลสาขา
router.get('/cd_branch', cdBranchController.fetchRows);
router.post('/cd_branch', cdBranchController.addRow);
router.put('/cd_branch/:id', cdBranchController.updateRow);
router.delete('/cd_branch/:id', cdBranchController.deleteRow);
router.delete('/cd_branch', cdBranchController.deleteRows);
router.get('/cd_branch/export', cdBranchController.exportDataExcel);

// Router สำหรับจัดการข้อมูลหน่วยงาน
router.get('/cd_business_unit', cdBusinessUnitController.fetchRows);
router.post('/cd_business_unit', cdBusinessUnitController.addRow);
router.put('/cd_business_unit/:id', cdBusinessUnitController.updateRow);
router.delete('/cd_business_unit/:id', cdBusinessUnitController.deleteRow);
router.delete('/cd_business_unit', cdBusinessUnitController.deleteRows);
router.post('/cd_business_unit/import', fileUpload.single('excelFile'), cdBusinessUnitController.importDataExcel);
router.get('/cd_business_unit/export', cdBusinessUnitController.exportDataExcel);

// Router สำหรับจัดการข้อมูลสกุลเงิน
router.get('/cd_currency', cdCurrencyController.fetchRows);
router.get('/cd_currency/active', cdCurrencyController.fetchActiveRows);
// router.get('/cd_currency/:id', cdCurrencyController.fetchRowById);
router.post('/cd_currency', cdCurrencyController.addRow);
router.put('/cd_currency/:id', cdCurrencyController.updateRow);
router.delete('/cd_currency/:id', cdCurrencyController.deleteRow);
router.delete('/cd_currency', cdCurrencyController.deleteRows);
router.post('/cd_currency/import', fileUpload.single('excelFile'), cdCurrencyController.importDataExcel);
router.get('/cd_currency/export', cdCurrencyController.exportDataExcel);

// Router สำหรับจัดการข้อมูลโครงการ
router.get('/cd_project', cdProjectController.fetchRows);
router.post('/cd_project', cdProjectController.addRow);
router.put('/cd_project/:id', cdProjectController.updateRow);
router.delete('/cd_project/:id', cdProjectController.deleteRow);
router.delete('/cd_project', cdProjectController.deleteRows);
router.get('/cd_project/export', cdProjectController.exportDataExcel);

// Router สำหรับจัดการข้อมูลรหัสไปรษณีย์
router.get('/cd_zipcode', cdZipcodeController.fetchRows);
router.post('/cd_zipcode', cdZipcodeController.addRow);
router.put('/cd_zipcode/:id', cdZipcodeController.updateRow);
router.delete('/cd_zipcode/:id', cdZipcodeController.deleteRow);
router.delete('/cd_zipcode', cdZipcodeController.deleteRows);
router.post('/cd_zipcode/import', fileUpload.single('excelFile'), cdZipcodeController.importDataExcel);
router.get('/cd_zipcode/export', cdZipcodeController.exportDataExcel);

module.exports = router;
