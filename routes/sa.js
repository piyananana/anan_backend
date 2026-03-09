// routes/sa.js
const express = require('express');
const router = express.Router();
const saAuthController = require('../controllers/sa/saAuthController');
const saBackupController = require('../controllers/sa/saBackupController'); 
const saCompanyController = require('../controllers/sa/saCompanyController');
const saDatabaseController = require('../controllers/sa/saDatabaseController');
const saGroupController = require('../controllers/sa/saGroupController');
const saGroupMenuController = require('../controllers/sa/saGroupMenuController');
const saGroupUserController = require('../controllers/sa/saGroupUserController');
const saMenuController = require('../controllers/sa/saMenuController');
const saModuleDocumentController = require('../controllers/sa/saModuleDocumentController');
const saPasswordPolicyController = require('../controllers/sa/saPasswordPolicyController');
const saUserController = require('../controllers/sa/saUserController');
const saUserDocumentController = require('../controllers/sa/saUserDocumentController');
const saUserMenuController = require('../controllers/sa/saUserMenuController');
// const saOrganizationController = require('../controllers/sa/saOrganizationController');

const xlsx = require('xlsx'); // Import xlsx

// กำหนดที่เก็บไฟล์ชั่วคราวสำหรับอัปโหลด
const multer = require('multer');   // ใช้ multer สำหรับจัดการการอัปโหลดไฟล์
const fileUpload = multer({ dest: 'public/sa/' }); // กำหนดโฟลเดอร์ชั่วคราวสำหรับเก็บไฟล์ที่อัปโหลด

const path = require('path');    // ใช้ path สำหรับจัดการเส้นทางของไฟล์
const fs = require('fs');        // ใช้ fs สำหรับจัดการไฟล์
const uploadsDir = path.join(__dirname, '..', 'public', 'sa');  // ชื่อเต็มของโฟลเดอร์ที่เก็บไฟล์
if (!fs.existsSync(uploadsDir)) {   // ตรวจสอบว่า ถ้ายังไม่มีโฟลเดอร์นี้
    fs.mkdirSync(uploadsDir, { recursive: true }); // สร้างโฟลเดอร์ 'public/sa'
    console.log('Created uploads directory:', uploadsDir);
}
const imageStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir); // ไฟล์จะถูกเก็บในโฟลเดอร์ 'public/sa'
    },
    filename: function (req, file, cb) {        
        const ext = path.extname(file.originalname);
        cb(null, 'company_logo_' + Date.now() + ext);   // ตั้งชื่อไฟล์ใหม่โดยไม่ให้ซ้ำกัน เช่น company_logo_timestamp.ext
    }
});
const imageUpload = multer({ 
    storage: imageStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // จำกัดขนาดไฟล์ 5MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
        if (!allowedTypes.includes(file.mimetype)) {
            cb(new Error('Invalid file type. Only JPEG, PNG, GIF are allowed.'), false);
        } else {
            cb(null, true);
        }
    }
});

// Define routes for System Administration (SA)
// These routes handle CRUD operations for system administration tasks such as managing users, roles, and permissions
//
// For saAuthController
router.post('/auth/login', saAuthController.login);
router.post('/auth/change_password/:id', saAuthController.changePassword); 
router.post('/auth/check_token', saAuthController.verifyToken); // Verify JWT token

// For saBackupController
router.get('/backup/schedules', saBackupController.getSchedules);
// router.get('/backup/schedules/status/:id', saBackupController.getScheduleStatus);
router.post('/backup/schedules/:id', saBackupController.updateSchedule);
router.post('/backup/schedules/:id/start', saBackupController.startSchedule);
router.post('/backup/schedules/:id/stop', saBackupController.stopSchedule);
router.get('/backup/files/:scheduleType', saBackupController.getBackupFiles);
router.post('/backup/restore', saBackupController.restoreBackup);
router.get('/backup/files/download/:filename', saBackupController.downloadBackupFile);
router.delete('/backup/files/:filename', saBackupController.deleteBackupFile);
router.post('/backup/instant/start', saBackupController.startInstantBackup);
router.post('/backup/instant/stop', saBackupController.stopInstantBackup);
router.get('/backup/instant/status', saBackupController.checkInstantBackupStatus);
router.post('/backup/instant/restore', saBackupController.restoreFromInstantBackup);

// For saCompanyController
router.get('/sa_company', saCompanyController.getCompanyInfo);
router.post('/sa_company', imageUpload.single('logo'), saCompanyController.createCompanyInfo);
router.put('/sa_company/:id', imageUpload.single('logo'), saCompanyController.updateCompanyInfo);

// For saDatabaseController
router.get('/databases', saDatabaseController.getDatabases);

// For saGroupController
router.get('/sa_group', saGroupController.getAllGroup); 
router.get('/sa_group/:id', saGroupController.getGroupById);
router.post('/sa_group', saGroupController.createGroup);
router.put('/sa_group/:id', saGroupController.updateGroup);
router.delete('/sa_group/:id', saGroupController.deleteGroup);

// For saGroupMenuController
router.put('/sa_group_menu/:groupId', saGroupMenuController.updateGroupMenu);
router.delete('/sa_group_menu/:groupId', saGroupMenuController.deleteGroupMenu);

// For saGroupUserController
router.get('/sa_group_user/:groupId', saGroupUserController.getGroupUsers);
router.get('/sa_group_user/only/:groupId', saGroupUserController.getGroupOnlyUsers);
router.post('/sa_group_user/:groupId/:userId', saGroupUserController.createGroupUserByUserId);
router.delete('/sa_group_user/:groupId', saGroupUserController.deleteGroupUsers); 
router.delete('/sa_group_user/:groupId/:userId', saGroupUserController.deleteGroupUserByUserId);

// For saMenuController
router.get('/sa_menu', saMenuController.getAllMenu);
router.get('/sa_menu/user/:userId', saMenuController.getMenuByUserId); 
router.get('/sa_menu/group/:groupId', saMenuController.getMenuByGroupId);
router.get('/sa_menu/content/:id', saMenuController.getMenuContentById);
router.get('/sa_menu/export', saMenuController.exportMenu);
router.post('/sa_menu', saMenuController.createMenu);
router.post('/sa_menu/import', fileUpload.single('excelFile'), saMenuController.importMenu);
router.put('/sa_menu/:id', saMenuController.updateMenu);
router.delete('/sa_menu/:id', saMenuController.deleteMenu);
router.delete('/sa_menu/all', saMenuController.deleteAllMenu);

// For saModuleDocumentController
router.get('/sa_module_document', saModuleDocumentController.fetchRows);
router.get('/sa_module_document/user/:userId', saModuleDocumentController.fetchRowsByUserId); 
router.get('/sa_module_document/module_user/:docCode/:userId', saModuleDocumentController.fetchRowsByModuleUserId); 
router.post('/sa_module_document', saModuleDocumentController.addRow);
router.put('/sa_module_document/:id', saModuleDocumentController.updateRow);
router.delete('/sa_module_document/:id', saModuleDocumentController.deleteRow);
router.delete('/sa_module_document', saModuleDocumentController.deleteRows);
router.post('/sa_module_document/import', fileUpload.single('excelFile'), saModuleDocumentController.importDataExcel);
router.get('/sa_module_document/export', saModuleDocumentController.exportDataExcel);

// For saPasswordPolicyController
router.get('/sa_policy', saPasswordPolicyController.getPolicy);
router.get('/sa_password_policy', saPasswordPolicyController.getPasswordPolicy);
router.put('/sa_password_policy/:policy', saPasswordPolicyController.updatePolicy);

// For saUserController
router.get('/sa_user', saUserController.getAllUser);
router.post('/sa_user', saUserController.createUser);
router.put('/sa_user/:id', saUserController.updateUser);
router.delete('/sa_user/:id', saUserController.deleteUser);

// For saUserDocumentController
router.put('/sa_user_document/:userId', saUserDocumentController.updateRowsByUserId);
router.delete('/sa_user_document/:userId', saUserDocumentController.deleteRowsByUserId);

// For saUserMenuController
router.put('/sa_user_menu/:userId', saUserMenuController.updateUserMenu);
router.delete('/sa_user_menu/:userId', saUserMenuController.deleteUserMenu);

// router.get('/sa_organization', saOrganizationController.getAllOrganization); // Get all organizational units
// router.get('/sa_organization/:id', saOrganizationController.getOrganizationById); // Get organizational unit by ID
// router.post('/sa_organization', saOrganizationController.createOrganization); // Create a new organizational unit
// router.put('/sa_organization/:id', saOrganizationController.updateOrganization); // Update organizational unit by ID
// router.delete('/sa_organization/:id', saOrganizationController.deleteOrganization); // Delete organizational unit by ID

module.exports = router;