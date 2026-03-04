// C:\\flutter_project\\aaa_backend\\controllers\\sa\\saBackupController.js
const saBackupService = require('../../services/saBackupService');
const { isBackupRunning } = saBackupService; // Import isBackupRunning

const getSchedules = async (req, res) => {
    try {
        const schedules = await req.dbPool.query(`SELECT * FROM sa_backup_schedule ORDER BY id`);
        res.json(schedules.rows);
    } catch (error) {
        console.error('Error fetching backup schedules:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const getScheduleStatus = async (req, res) => {
    const { id } = req.params;
    try {
        const scheduleStatus = await saBackupService.getScheduleStatus(req, id);
        res.json(scheduleStatus);
    } catch (error) {
        console.error('Error fetching schedule status:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const updateSchedule = async (req, res) => {
    const { id } = req.params;
    try {
        const updatedSchedule = await saBackupService.updateSchedule(req, id, req.body);
        res.json(updatedSchedule);
    } catch (error) {
        console.error('Error updating backup schedule:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const startSchedule = async (req, res) => {
    const { id } = req.params;
    try {
        const schedule = await saBackupService.startSchedule(req, id);
        res.json(schedule);
    } catch (error) {
        console.error('Error starting backup schedule:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const stopSchedule = async (req, res) => {
    const { id } = req.params;
    try {
        const schedule = await saBackupService.stopSchedule(req, id);
        res.json(schedule);
    } catch (error) {
        console.error('Error stopping backup schedule:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const getBackupFiles = async (req, res) => {
    const { scheduleType } = req.params;
    const databaseName = req.headers['x-database-name'];
    try {
        // console.log('Database Name in getBackupFiles:', req.databaseName);
        // console.log('req.headers in getBackupFiles:', req.headers);
        const files = await saBackupService.getBackupFiles(databaseName, scheduleType);
        res.json(files);
    } catch (error) {
        console.error('Error fetching backup files:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const restoreBackup = async (req, res) => {
    const { filename } = req.body;
    try {
        const result = await saBackupService.runPgRestore(req, filename);
        res.json({ message: result });
    } catch (error) {
        console.error('Error restoring backup:', error);
        res.status(500).json({ message: error.message });
    }
};

const downloadBackupFile = async (req, res) => {
    const { filename } = req.params;
    try {
        const filePath = await saBackupService.getFilePath(filename);
        res.download(filePath, filename);
    } catch (error) {
        console.error('Error downloading file:', error);
        res.status(404).json({ message: error.message });
    }
};

const deleteBackupFile = async (req, res) => {
    const { filename } = req.params;
    try {
        const result = await saBackupService.deleteBackupFile(filename);
        res.json({ message: result });
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// New Controller: Start instant backup
const startInstantBackup = async (req, res) => {
    try {
        await saBackupService.startInstantBackup(req);
        res.json({ message: 'Instant backup started' });
    } catch (error) {
        console.error('Error starting instant backup:', error);
        res.status(500).json({ message: error.message });
    }
};

// New Controller: Stop instant backup
const stopInstantBackup = async (req, res) => {
    try {
        saBackupService.stopInstantBackup();
        res.json({ message: 'Instant backup stopped' });
    } catch (error) {
        console.error('Error stopping instant backup:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// New Controller: Check instant backup status
const checkInstantBackupStatus = (req, res) => {
    const status = saBackupService.getInstantBackupStatus();
    res.json(status);
};

// New Controller: Restore from instant backup
const restoreFromInstantBackup = async (req, res) => {
    const { filename } = req.body;
    try {
        const result = await saBackupService.restoreFromInstantBackup(req, filename);
        res.json({ message: result });
    } catch (error) {
        console.error('Error restoring instant backup:', error);
        res.status(500).json({ message: error.message });
    }
};


module.exports = {
    getSchedules,
    getScheduleStatus,
    updateSchedule,
    startSchedule,
    stopSchedule,
    getBackupFiles,
    restoreBackup,
    downloadBackupFile,
    deleteBackupFile,
    startInstantBackup,
    stopInstantBackup,
    checkInstantBackupStatus,
    restoreFromInstantBackup,
};


// // C:\flutter_project\aaa_backend\controllers\sa\saBackupController.js
// const saBackupService = require('../../services/saBackupService');

// const getSchedules = async (req, res) => {
//     try {
//         // const schedules = await saBackupService.getSchedules(req);
//         const schedules = await req.dbPool.query(`SELECT * FROM sa_backup_schedule ORDER BY id`);
//         res.json(schedules.rows);
//     } catch (error) {
//         console.error('Error fetching backup schedules:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// };

// const updateSchedule = async (req, res) => {
//     const { id } = req.params;
//     try {
//         const updatedSchedule = await saBackupService.updateSchedule(req, id, req.body);
//         res.json(updatedSchedule);
//     } catch (error) {
//         console.error('Error updating backup schedule:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// };

// const startSchedule = async (req, res) => {
//     const { id } = req.params;
//     try {
//         const schedule = await saBackupService.startSchedule(req, id);
//         res.json(schedule);
//     } catch (error) {
//         console.error('Error starting backup schedule:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// };

// const stopSchedule = async (req, res) => {
//     const { id } = req.params;
//     try {
//         await saBackupService.stopSchedule(req, id);
//         res.json({ message: 'Backup schedule stopped successfully' });
//     } catch (error) {
//         console.error('Error stopping backup schedule:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// };

// const getBackupFiles = async (req, res) => {
//     const { scheduleType } = req.params;
//     try {
//         const files = await saBackupService.getBackupFiles(scheduleType);
//         res.json(files);
//     } catch (error) {
//         console.error('Error fetching backup files:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// };

// // *** Controller ใหม่: เรียกคืนข้อมูล ***
// const restoreBackup = async (req, res) => {
//     const { filename } = req.body;
//     try {
//         const result = await saBackupService.runPgRestore(req, filename);
//         res.json({ message: result });
//     } catch (error) {
//         console.error('Error restoring backup:', error);
//         res.status(500).json({ message: error.message });
//     }
// };

// // *** Controller ใหม่: ดาวน์โหลดไฟล์
// const downloadBackupFile = async (req, res) => {
//     const { filename } = req.params;
//     try {
//         const filePath = await saBackupService.getFilePath(filename);
//         res.download(filePath, filename);
//     } catch (error) {
//         console.error('Error downloading file:', error);
//         res.status(404).json({ message: error.message });
//     }
// };

// // *** Controller ใหม่: ลบไฟล์
// const deleteBackupFile = async (req, res) => {
//     const { filename } = req.params;
//     try {
//         const result = await saBackupService.deleteBackupFile(filename);
//         res.json({ message: result });
//     } catch (error) {
//         console.error('Error deleting file:', error);
//         res.status(500).json({ message: error.message });
//     }
// };

// module.exports = {
//     getSchedules,
//     updateSchedule,
//     startSchedule,
//     stopSchedule,
//     getBackupFiles,
//     restoreBackup,
//     downloadBackupFile,
//     deleteBackupFile
// };
