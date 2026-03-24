// routes/cd.js
const express = require('express');
const router = express.Router();
const cdBranchController = require('../controllers/cd/cdBranchController');
const cdBusinessTypeController = require('../controllers/cd/cdBusinessTypeController');
const cdBusinessUnitController = require('../controllers/cd/cdBusinessUnitController');
const cdCurrencyController = require('../controllers/cd/cdCurrencyController');
const cdProjectController = require('../controllers/cd/cdProjectController');
const cdZipcodeController = require('../controllers/cd/cdZipcodeController');
const cdVatRateController = require('../controllers/cd/cdVatRateController');
const cdBankController = require('../controllers/cd/cdBankController');
const cdBankBranchController = require('../controllers/cd/cdBankBranchController');
const cdSalesTerritoryController = require('../controllers/cd/cdSalesTerritoryController');
const cdSalespersonController = require('../controllers/cd/cdSalespersonController');

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

// Router สำหรับจัดการข้อมูลประเภทธุรกิจ
router.get('/cd_business_type/active', cdBusinessTypeController.fetchActiveRows);
router.get('/cd_business_type', cdBusinessTypeController.fetchRows);
router.post('/cd_business_type', cdBusinessTypeController.addRow);
router.put('/cd_business_type/:id', cdBusinessTypeController.updateRow);
router.delete('/cd_business_type/:id', cdBusinessTypeController.deleteRow);
router.delete('/cd_business_type', cdBusinessTypeController.deleteRows);

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

// Router สำหรับจัดการอัตราภาษีมูลค่าเพิ่ม
// หมายเหตุ: /effective ต้องมาก่อน /:id เพื่อป้องกัน route conflict
router.get('/cd_vat_rate/effective', cdVatRateController.fetchEffectiveRate);
router.get('/cd_vat_rate/codes', cdVatRateController.fetchVatCodes);
router.get('/cd_vat_rate', cdVatRateController.fetchRows);
router.post('/cd_vat_rate', cdVatRateController.addRow);
router.put('/cd_vat_rate/:id', cdVatRateController.updateRow);
router.delete('/cd_vat_rate/:id', cdVatRateController.deleteRow);

// Router สำหรับจัดการข้อมูลธนาคาร
router.get('/cd_bank/active', cdBankController.fetchActiveRows);
router.get('/cd_bank', cdBankController.fetchRows);
router.post('/cd_bank', cdBankController.addRow);
router.put('/cd_bank/:id', cdBankController.updateRow);
router.delete('/cd_bank/:id', cdBankController.deleteRow);

// Router สำหรับจัดการข้อมูลสาขาธนาคาร
router.get('/cd_bank_branch', cdBankBranchController.fetchRows);
router.post('/cd_bank_branch', cdBankBranchController.addRow);
router.put('/cd_bank_branch/:id', cdBankBranchController.updateRow);
router.delete('/cd_bank_branch/:id', cdBankBranchController.deleteRow);

// Router สำหรับจัดการข้อมูลเขตการขาย
router.get('/cd_sales_territory/active', cdSalesTerritoryController.fetchActiveRows);
router.get('/cd_sales_territory', cdSalesTerritoryController.fetchRows);
router.post('/cd_sales_territory', cdSalesTerritoryController.addRow);
router.put('/cd_sales_territory/:id', cdSalesTerritoryController.updateRow);
router.delete('/cd_sales_territory/:id', cdSalesTerritoryController.deleteRow);

// Router สำหรับจัดการข้อมูลพนักงานขาย
// หมายเหตุ: /by_territory ต้องมาก่อน /:id เพื่อป้องกัน route conflict
router.get('/cd_salesperson/by_territory/:territoryId', cdSalespersonController.fetchByTerritory);
router.get('/cd_salesperson', cdSalespersonController.fetchRows);
router.get('/cd_salesperson/:id', cdSalespersonController.fetchRow);
router.post('/cd_salesperson', cdSalespersonController.addRow);
router.put('/cd_salesperson/:id', cdSalespersonController.updateRow);
router.delete('/cd_salesperson/:id', cdSalespersonController.deleteRow);

module.exports = router;
