// routes/mo.js — Manufacturing Order (sys_module='61')
const express = require('express');
const router = express.Router();
const moBomController = require('../controllers/mo/moBomController');
const moWorkCenterController = require('../controllers/mo/moWorkCenterController');
const moHeaderController = require('../controllers/mo/moHeaderController');

// mo_bom (mo_bom_header + mo_bom_detail) — ย้ายมาจาก /api/im/im_bom
router.get('/mo_bom',        moBomController.fetchRows);
router.get('/mo_bom/report/cost_rollup', moBomController.fetchCostRollupReport); // ต้องมาก่อน /mo_bom/:id ด้านล่าง
router.get('/mo_bom/report/where_used',  moBomController.fetchWhereUsedReport);  // ต้องมาก่อน /mo_bom/:id ด้านล่าง
router.get('/mo_bom/:id',    moBomController.fetchRow);
router.post('/mo_bom',       moBomController.addRow);
router.put('/mo_bom/:id',    moBomController.updateRow);
router.delete('/mo_bom/:id', moBomController.deleteRow);

// mo_work_center (ศูนย์งาน — อัตราค่าแรง/ค่าเครื่องจักร/overhead ต่อชั่วโมง สำหรับ Routing)
router.get('/mo_work_center',        moWorkCenterController.fetchRows);
router.get('/mo_work_center/active', moWorkCenterController.fetchActiveRows); // ต้องมาก่อน /:id ด้านล่าง
router.get('/mo_work_center/report/efficiency', moWorkCenterController.fetchEfficiencyReport); // ต้องมาก่อน /:id ด้านล่าง
router.get('/mo_work_center/:id',    moWorkCenterController.fetchRow);
router.post('/mo_work_center',       moWorkCenterController.addRow);
router.put('/mo_work_center/:id',    moWorkCenterController.updateRow);
router.delete('/mo_work_center/:id', moWorkCenterController.deleteRow);

// mo_header (ใบสั่งผลิต) + mo_component_detail/mo_output_detail/mo_operation_detail
router.get('/mo_header',             moHeaderController.fetchRows);
router.get('/mo_header/my_pending',  moHeaderController.fetchMyPending);
router.get('/mo_header/report/status', moHeaderController.fetchStatusReport);
router.get('/mo_header/report/cost_variance', moHeaderController.fetchCostVarianceReport);
router.get('/mo_header/report/wip_valuation', moHeaderController.fetchWipValuationReport);
router.get('/mo_header/:id',         moHeaderController.fetchRow);
router.post('/mo_header',            moHeaderController.createTransaction);
router.put('/mo_header/:id',         moHeaderController.updateTransaction);
router.put('/mo_header/:id/release', moHeaderController.releaseTransaction); // = approve (ต้องส่งขออนุมัติก่อน)
router.put('/mo_header/:id/submit',  moHeaderController.submitTransaction);
router.put('/mo_header/:id/approve', moHeaderController.approveTransaction);
router.put('/mo_header/:id/reject',  moHeaderController.rejectTransaction);
router.put('/mo_header/:id/cancel',  moHeaderController.cancelTransaction);
router.put('/mo_header/:id/close',   moHeaderController.closeTransaction);
router.put('/mo_header/:id/reverse', moHeaderController.reverseTransaction);
router.get('/mo_header/:id/availability', moHeaderController.checkMaterialAvailability);
router.get('/mo_header/:id/explosion_candidates', moHeaderController.fetchExplosionCandidates);
router.post('/mo_header/:id/explode', moHeaderController.explodeSubAssembly);
router.delete('/mo_header/:id',      moHeaderController.deleteTransaction);
// บันทึกเวลาปฏิบัติงาน (เฉพาะ MO costing_mode='ROUTING') — ไม่ใช่ im_transaction ไม่มีผล GL/สต็อก
router.put('/mo_header/:moId/operations/:opId/log_time', moHeaderController.logOperationTime);

module.exports = router;
