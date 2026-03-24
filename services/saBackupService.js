// C:\\flutter_project\\aaa_backend\\services\\saBackupService.js
const pool = require('../config/db');
const schedule = require('node-schedule');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const dbService = require('./saDatabaseService');

class BackupService {
    static runningJobs = {};
    static instantBackupProcess = null;
    static instantBackupStatus = {
        isRunning: false,
        status: 'รอเริ่ม',
        lastBackup: null,
    };

    // ฟังก์ชันสำหรับสั่ง pg_dump
    static async runPgDump(databaseName, scheduleType) {
        console.log(`Running pg_dump for ${scheduleType} database: ${databaseName}`);
        
        try {
            const now = new Date();
            const timestamp = now.getFullYear().toString() +
                              '-' + (now.getMonth() + 1).toString().padStart(2, '0') +
                              '-' + now.getDate().toString().padStart(2, '0') +
                              'T' + now.getHours().toString().padStart(2, '0') +
                              '-' + now.getMinutes().toString().padStart(2, '0') +
                              '-' + now.getSeconds().toString().padStart(2, '0');

            const backupDir = path.join(__dirname, '..', 'backups');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir);
            }
            const filename = `${databaseName}_Backup_${scheduleType}_${timestamp}.backup`;
            const filePath = path.join(backupDir, filename);

            const dbConfig = await dbService.getPool(databaseName);
            const pgDumpCmd = `pg_dump -Fc --clean --if-exists -U ${dbConfig.options.user} -d ${dbConfig.options.database} -h ${dbConfig.options.host} -p ${dbConfig.options.port} -f "${filePath}"`;

            return new Promise((resolve, reject) => {
                const child = exec(pgDumpCmd, { env: { ...process.env, PGPASSWORD: dbConfig.options.password } }, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`exec error: ${error}`);
                        return reject(new Error('Backup command failed.'));
                    }
                    if (stderr) {
                        console.error(`stderr: ${stderr}`);
                    }
                    console.log(`stdout: ${stdout}`);
                    console.log(`Backup completed successfully: ${filePath}`);
                    resolve(filePath);
                });
                return child;
            });
        } catch (error) {
            console.error('Error in runPgDump:', error);
            throw new Error('Failed to run pg_dump due to internal error.');
        }
    }

    // ฟังก์ชันสำหรับสั่ง pg_restore
    static async runPgRestore(req, filename) {
        console.log(`Running pg_restore for file: ${filename}`);

        const databaseName = req.header('X-Database-Name');
        const dbConfig = await dbService.getPool(databaseName);
        const backupDir = path.join(__dirname, '..', 'backups');
        const filePath = path.join(backupDir, filename);
        
        if (!fs.existsSync(filePath)) {
            throw new Error('Backup file not found.');
        }

        const dropSchemaCmd = `psql -U ${dbConfig.options.user} -d ${dbConfig.options.database} -h ${dbConfig.options.host} -p ${dbConfig.options.port} -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`;
        const restoreCmd = `pg_restore -Fc --no-owner --no-privileges -U ${dbConfig.options.user} -d ${dbConfig.options.database} -h ${dbConfig.options.host} -p ${dbConfig.options.port} "${filePath}"`;
        const env = { ...process.env, PGPASSWORD: dbConfig.options.password };

        return new Promise((resolve, reject) => {
            exec(dropSchemaCmd, { env }, (dropError, dropStdout, dropStderr) => {
                if (dropError) {
                    console.error(`drop schema error: ${dropError}`);
                    return reject(new Error('Failed to drop schema before restore.'));
                }
                console.log(`Schema dropped and recreated for: ${dbConfig.options.database}`);
                exec(restoreCmd, { env }, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`exec error: ${error}`);
                        return reject(new Error('Restore command failed.'));
                    }
                    if (stderr) {
                        console.error(`stderr: ${stderr}`);
                    }
                    console.log(`stdout: ${stdout}`);
                    console.log(`Restore completed successfully from: ${filePath}`);
                    resolve('Restore completed successfully.');
                });
            });
        });
    }

    // เพิ่มฟังก์ชันสำหรับ Instant Backup
    static async startInstantBackup(req) {
        if (this.instantBackupProcess) {
            throw new Error('Instant backup is already running.');
        }

        const databaseName = req.headers['x-database-name'];
        this.instantBackupStatus.isRunning = true;
        this.instantBackupStatus.status = 'กำลังทำงาน';
        this.instantBackupStatus.lastBackup = 'กำลังดำเนินการ...';
        
        console.log('Starting instant backup...');

        try {
            // const now = new Date();
            // const timestamp = now.toISOString().replace(/[:.]/g, '-');
            var now = new Date();
            let timestamp = now.getFullYear().toString() +
                              '-' + (now.getMonth() + 1).toString().padStart(2, '0') +
                              '-' + now.getDate().toString().padStart(2, '0') +
                              'T' + now.getHours().toString().padStart(2, '0') +
                              '-' + now.getMinutes().toString().padStart(2, '0') +
                              '-' + now.getSeconds().toString().padStart(2, '0');
            const backupDir = path.join(__dirname, '..', 'backups');
            const filename = `${databaseName}_instant_backup_${timestamp}.backup`;
            const filePath = path.join(backupDir, filename);

            const dbConfig = await dbService.getPool(databaseName);
            const pgDumpCmd = `pg_dump -Fc --clean --if-exists -U ${dbConfig.options.user} -d ${dbConfig.options.database} -h ${dbConfig.options.host} -p ${dbConfig.options.port} -f "${filePath}"`;
            // สร้าง environment object เพื่อส่งรหัสผ่าน
            const options = {
                env: { ...process.env, PGPASSWORD: dbConfig.options.password },
            };

            this.instantBackupProcess = exec(pgDumpCmd, options, (error, stdout, stderr) => {
                this.instantBackupProcess = null;
                if (error) {
                    console.error(`Instant backup failed: ${error}`);
                    this.instantBackupStatus.isRunning = false;
                    this.instantBackupStatus.status = 'ล้มเหลว';
                    throw new Error('Instant backup failed.');
                }
                this.instantBackupStatus.isRunning = false;
                this.instantBackupStatus.status = 'สำเร็จ';
                var now = new Date();
                let timestamp = now.getFullYear().toString() +
                              '/' + (now.getMonth() + 1).toString().padStart(2, '0') +
                              '/' + now.getDate().toString().padStart(2, '0') +
                              ' ' + now.getHours().toString().padStart(2, '0') +
                              ':' + now.getMinutes().toString().padStart(2, '0') +
                              ':' + now.getSeconds().toString().padStart(2, '0');
                // instantBackupStatus.lastBackup = now.toISOString();
                this.instantBackupStatus.lastBackup = timestamp;
                console.log(`Instant backup completed successfully: ${filePath}`);
            });
        } catch (error) {
            console.error('Error starting instant backup process:', error);
            this.instantBackupStatus.isRunning = false;
            this.instantBackupStatus.status = 'ล้มเหลว';
            throw new Error('Failed to start instant backup process.');
        }
    }

    static stopInstantBackup() {
        if (this.instantBackupProcess) {
            this.instantBackupProcess.kill();
            this.instantBackupProcess = null;
            this.instantBackupStatus.isRunning = false;
            this.instantBackupStatus.status = 'ถูกยกเลิก';
            console.log('Instant backup process stopped by user.');
        }
    }

    static getInstantBackupStatus() {
        return this.instantBackupStatus;
    }

    static async restoreFromInstantBackup(req, filename) {
        console.log(`Running instant restore for file: ${filename}`);
        const databaseName = req.header('X-Database-Name');
        const dbConfig = await dbService.getPool(databaseName);
        const backupDir = path.join(__dirname, '..', 'backups');
        const filePath = path.join(backupDir, filename);

        if (!fs.existsSync(filePath)) {
            throw new Error('Instant backup file not found.');
        }

        const dropSchemaCmd = `psql -U ${dbConfig.options.user} -d ${dbConfig.options.database} -h ${dbConfig.options.host} -p ${dbConfig.options.port} -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`;
        const restoreCmd = `pg_restore -Fc --no-owner --no-privileges -U ${dbConfig.options.user} -d ${dbConfig.options.database} -h ${dbConfig.options.host} -p ${dbConfig.options.port} "${filePath}"`;
        const env = { ...process.env, PGPASSWORD: dbConfig.options.password };

        return new Promise((resolve, reject) => {
            exec(dropSchemaCmd, { env }, (dropError, dropStdout, dropStderr) => {
                if (dropError) {
                    console.error(`drop schema error: ${dropError}`);
                    return reject(new Error('Failed to drop schema before restore.'));
                }
                console.log(`Schema dropped and recreated for: ${dbConfig.options.database}`);
                exec(restoreCmd, { env }, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`exec error: ${error}`);
                        return reject(new Error('Restore command failed.'));
                    }
                    if (stderr) {
                        console.error(`stderr: ${stderr}`);
                    }
                    console.log(`stdout: ${stdout}`);
                    console.log(`Restore completed successfully from: ${filePath}`);
                    resolve('Instant restore completed successfully.');
                });
            });
        });
    }

    // ฟังก์ชันสำหรับตั้งค่า job ทั้งหมดเมื่อ Server เริ่มต้น
    static async setupAllJobs(databaseName) {
        try {
            console.log(`Setting up backup jobs for database: ${databaseName}`);
            // ใช้ getPool เพื่อเชื่อมต่อฐานข้อมูลที่ต้องการ
            const pool = await dbService.getPool(databaseName);
            // // ยกเลิก job ที่กำลังรันอยู่ทั้งหมดก่อน
            // await this.stopAllJobs();
            // const result = await pool.query('SELECT * FROM sa_backup_schedule WHERE is_running = TRUE');
                    
            // ขั้นตอนที่ 1: ตรวจสอบว่าตาราง 'sa_backup_schedule' มีอยู่หรือไม่
            const tableCheckResult = await pool.query(
                "SELECT to_regclass('sa_backup_schedule') AS table_exists;"
            );
            // ขั้นตอนที่ 2: ตรวจสอบผลลัพธ์จาก query แรก
            if (tableCheckResult.rows[0].table_exists !== null) {
                // ถ้าตารางมีอยู่จริง ให้รันคำสั่ง SELECT เพื่อดึงข้อมูล
                const result = await pool.query(
                    "SELECT * FROM sa_backup_schedule WHERE is_running = TRUE;"
                );
                const schedules = result.rows;
                console.log(`Found ${schedules.length} active schedules.`);
                
                for (const scheduleData of schedules) {
                    await this.setupJob(databaseName, scheduleData);
                }
            }

        } catch (error) {
            console.error('Failed to setup backup jobs:', error);
            // Handle error, e.g., send notification
        }
    }

    // ตั้งค่าและเริ่ม job สำหรับ schedule ที่กำหนด
    static async setupJob(databaseName, scheduleData) {
        const { id, schedule_type, daily_days_of_week, daily_time, monthly_months, monthly_day_of_month, monthly_time, yearly_date, yearly_time } = scheduleData;
        
        let jobSchedule = null;

        if (schedule_type === 'daily' && daily_days_of_week && daily_time) {
            const timeParts = daily_time.split(':');
            const rule = new schedule.RecurrenceRule();
            rule.dayOfWeek = daily_days_of_week.split(',').map(Number);
            rule.hour = parseInt(timeParts[0]);
            rule.minute = parseInt(timeParts[1]);
            // rule.tz = process.env.TZ || 'UTC'; // ตั้งค่า Time Zone
            jobSchedule = rule;
            console.log(`Setting up daily backup job for days ${daily_days_of_week} at ${daily_time}`);
        } else if (schedule_type === 'monthly' && monthly_months && monthly_day_of_month && monthly_time) {
            const timeParts = monthly_time.split(':');
            const rule = new schedule.RecurrenceRule();
            rule.month = monthly_months.split(',').map(m => m - 1); // 0-indexed month
            rule.date = monthly_day_of_month;
            rule.hour = parseInt(timeParts[0]);
            rule.minute = parseInt(timeParts[1]);
            // rule.tz = process.env.TZ || 'UTC'; // ตั้งค่า Time Zone
            jobSchedule = rule;
            console.log(`Setting up monthly backup job for months ${monthly_months} on day ${monthly_day_of_month} at ${monthly_time}`);
        } else if (schedule_type === 'yearly' && yearly_date && yearly_time) {
            const dateParts = yearly_date ? yearly_date.split('-') : null;
            const timeParts = yearly_time ? yearly_time.split(':') : null;
            const rule = new schedule.RecurrenceRule();
            rule.year = parseInt(dateParts[0]);
            rule.month = parseInt(dateParts[1]) - 1; // 0-indexed month
            rule.date = parseInt(dateParts[2]);
            rule.hour = parseInt(timeParts[0]);
            rule.minute = parseInt(timeParts[1]);
            // rule.tz = process.env.TZ || 'UTC'; // ตั้งค่า Time Zone
            jobSchedule = rule;
            console.log(`Setting up yearly backup job for ${yearly_date} at ${yearly_time}`);
        }

        if (jobSchedule) {
            this.runningJobs[id] = schedule.scheduleJob(jobSchedule, () => {
                // this.runPgDump(databaseName, id);
                this.runPgDump(databaseName, schedule_type);
            });
        }
    }

    // เมธอดสำหรับยกเลิก job ที่กำลังรันอยู่ทั้งหมด
    static async stopAllJobs() {
        console.log('Stopping all existing backup jobs...');
        // วนลูปผ่าน object runningJobs
        for (const jobId in this.runningJobs) {
            if (Object.prototype.hasOwnProperty.call(this.runningJobs, jobId)) {
                // ยกเลิก job แต่ละตัว
                this.runningJobs[jobId].cancel();
                console.log(`Job with ID ${jobId} has been stopped.`);
            }
        }
        // ล้าง object runningJobs
        this.runningJobs = {};
        console.log('All backup jobs have been stopped.');
    }

    // เริ่มการทำงานของ schedule
    static async startSchedule(req, id) {
        try {
            await this.stopSchedule(req, id); // เพื่อให้แน่ใจว่า job เดิมถูกหยุดก่อน
            const res = await req.dbPool.query('UPDATE sa_backup_schedule SET is_running = TRUE, progress_percent = 0, message = NULL WHERE id = $1 RETURNING *', [id]);
            const scheduleData = res.rows[0];
            if (scheduleData) {
                await this.setupJob(req.databaseName, scheduleData); // สร้าง job ใหม่
            }
            return scheduleData;
        } catch (e) {
            console.error('Error start schedule:', e);
        }
    }

    // หยุดการทำงานของ schedule
    static async stopSchedule(req, id) {
        try {
            await req.dbPool.query('UPDATE sa_backup_schedule SET is_running = FALSE WHERE id = $1', [id]);
            if (this.runningJobs[id]) {
                this.runningJobs[id].cancel();
                delete this.runningJobs[id];
                console.log(`Job for schedule ID ${id} stopped.`);
            }
        } catch (e) {
            console.error('Error stop schedule:', e);
        }
    }

    static async getSchedules(req) {
        const res = await req.dbPool.query(`SELECT * FROM sa_backup_schedule ORDER BY id`);
        return res.rows;
    }
    
    static async getScheduleStatus(req, id) {
        // ... (โค้ดเดิม)
    }
    
    static async updateSchedule(req, id, scheduleData) {
        const { daily_days_of_week, daily_time, monthly_months, monthly_day_of_month, monthly_time, yearly_date, yearly_time } = scheduleData;
        try {
            const res = await req.dbPool.query(
                `UPDATE sa_backup_schedule SET
                daily_days_of_week = $1, daily_time = $2,
                monthly_months = $3, monthly_day_of_month = $4, monthly_time = $5,
                yearly_date = $6, yearly_time = $7,
                updated_at = CURRENT_TIMESTAMP
                WHERE id = $8 RETURNING *`,
                [
                    daily_days_of_week, daily_time,
                    monthly_months, monthly_day_of_month, monthly_time,
                    yearly_date, yearly_time,
                    id
                ]
            );
            return res.rows[0];
        } catch (e) {
            console.error('Error update schedule:', e);
        }
    }

    static async getBackupFiles(databaseName, scheduleType) {
        // ... (โค้ดเดิม)
        try {
            const backupDir = path.join(__dirname, '..', 'backups');
            if (!fs.existsSync(backupDir)) {
                return [];
            }
            const files = fs.readdirSync(backupDir).filter(file => {
                if (scheduleType === 'instant') {
                    var str = `${databaseName}_instant_backup_`;
                    return file.startsWith(str) && file.endsWith('.backup');
                } else {
                    var str = `${databaseName}_Backup_${scheduleType}_`;
                    return file.startsWith(str) && file.endsWith('.backup');
                }
            }).sort().reverse();
            return files;
        } catch (error) {
            console.error('Error fetching backup files:', error);
            throw new Error('Failed to fetch backup files.');
        }
    }

    static async deleteBackupFile(filename) {
        const backupDir = path.join(__dirname, '..', 'backups');
        const filePath = path.join(backupDir, filename);

        if (!fs.existsSync(filePath) || !filePath.startsWith(backupDir)) {
            throw new Error('File not found or invalid path');
        }

        try {
            await fs.promises.unlink(filePath);
            return 'File deleted successfully.';
        } catch (error) {
            console.error('Error deleting file:', error);
            throw new Error('Failed to delete file.');
        }
    }

    static async getFilePath(filename) {
        const backupDir = path.join(__dirname, '..', 'backups');
        const filePath = path.join(backupDir, filename);
        
        if (!fs.existsSync(filePath) || !filePath.startsWith(backupDir)) {
            throw new Error('File not found or invalid path');
        }
        return filePath;
    }

    static isBackupRunning() {
        return !!instantBackupProcess;
    }
}

module.exports = BackupService;


// // C:\flutter_project\aaa_backend\services\saBackupService.js
// const pool = require('../config/db');
// const schedule = require('node-schedule');
// const { exec } = require('child_process');
// const path = require('path');
// const fs = require('fs');
// const dbService = require('./saDatabaseService');

// class BackupService {
//     static runningJobs = {};

//     // ฟังก์ชันสำหรับสั่ง pg_dump
//     static async runPgDump(databaseName, scheduleId) {
//         console.log(`Running pg_dump for schedule ID: ${scheduleId} of database: ${databaseName}`);

//         const now = new Date();
//         const timestamp = now.getFullYear().toString() +
//                           '-' + (now.getMonth() + 1).toString().padStart(2, '0') +
//                           '-' + now.getDate().toString().padStart(2, '0') +
//                           'T' + now.getHours().toString().padStart(2, '0') +
//                           '-' + now.getMinutes().toString().padStart(2, '0') +
//                           '-' + now.getSeconds().toString().padStart(2, '0');

//         const backupDir = path.join(__dirname, '..', 'backups');
//         if (!fs.existsSync(backupDir)) {
//             fs.mkdirSync(backupDir);
//         }
//         const filename = `${databaseName}Backup_${scheduleId}_${timestamp}.sql`;
//         const filePath = path.join(backupDir, filename);

//         console.log(`Backup file will be saved to: ${filePath}`);

//         const dbConfig = {
//             user: process.env.DB_USER,
//             host: process.env.DB_HOST,
//             database: databaseName, // ใช้ databaseName จาก parameter
//             password: process.env.DB_PASSWORD,
//             port: process.env.DB_PORT,
//         };
//         // ปรับปรุงคำสั่ง pg_dump โดยลบ PGPASSWORD= ออก
//         const pgDumpCommand = `pg_dump -U ${dbConfig.user} -h ${dbConfig.host} -p ${dbConfig.port} -d ${dbConfig.database} > "${filePath}"`;
//         // สร้าง environment object เพื่อส่งรหัสผ่าน
//         const options = {
//             env: { ...process.env, PGPASSWORD: dbConfig.password },
//         };

//         console.log(`Starting backup for schedule ID ${scheduleId}  of database: ${databaseName} ...`);
//         await this.updateBackupStatus(databaseName, scheduleId, true, 0, 'Starting backup...');

//         exec(pgDumpCommand, options, async (error, stdout, stderr) => {
//             if (error) {
//                 console.error(`exec error: ${error}`);
//                 await this.updateBackupStatus(databaseName, scheduleId, false, 0, `Backup failed: ${stderr}`);
//                 return;
//             }
//             console.log(`Backup completed for schedule ID ${scheduleId}.`);
//             await this.updateBackupStatus(databaseName, scheduleId, true, 100, `Backup completed successfully to ${filename}`);
//         });
//     }

//     // อัปเดตสถานะการทำงานในฐานข้อมูลสำหรับ schedule นั้นๆ
//     static async updateBackupStatus(databaseName, scheduleId, isRunning, progress, message) {
//         const dbPool = await dbService.getPool(databaseName);
//         try {
//             await dbPool.query(
//                 `UPDATE sa_backup_schedule SET
//                  is_running = $1,
//                  progress_percent = $2,
//                  message = $3,
//                  last_backup_time = CASE WHEN $1 = TRUE THEN CURRENT_TIMESTAMP ELSE last_backup_time END
//                  WHERE id = $4`,
//                 [isRunning, progress, message, scheduleId]
//             );
//         } catch (error) {
//             console.error('Error updating backup status:', error);
//         }
//     }

//     // // ดึงสถานะการทำงานปัจจุบัน
//     // static async getBackupStatus(id) {
//     //     // const client = await pool.connect();
//     //     // const res = await client.query('SELECT * FROM sa_backup_status WHERE id = $1', [id]);
//     //     // return res.rows[0];
//     //     const client = await pool.connect();
//     //     try {
//     //         const result = await client.query('SELECT * FROM sa_backup_status WHERE id = $1', [id]);
//     //         // if (result.rows.length > 0) {
//     //         return result.rows[0];
//     //         // } else {
//     //         //     result.status(404).json({ message: 'Group not found' });
//     //         // }
//     //     } catch (error) {
//     //         console.error('Error fetching Backup status by ID:', error);
//     //         result.status(500).json({ message: 'Failed to fetch backup status', error: error.message });
//     //     } finally {
//     //         client.release();
//     //     }
//     // }

//     // ดึง schedule ทั้งหมดพร้อมสถานะการทำงาน
//     // static async getSchedules(req) {
//     //     const res = await req.dbPool.query(`SELECT * FROM sa_backup_schedule ORDER BY id`);
//     //     return res.rows;
//     // }

//     // บันทึก schedule
//     static async updateSchedule(req, id, scheduleData) {
//         const { daily_days_of_week, daily_time, monthly_months, monthly_day_of_month, monthly_time, yearly_date, yearly_time } = scheduleData;
//         try {
//             const res = await req.dbPool.query(
//                 `UPDATE sa_backup_schedule SET
//                 daily_days_of_week = $1, daily_time = $2,
//                 monthly_months = $3, monthly_day_of_month = $4, monthly_time = $5,
//                 yearly_date = $6, yearly_time = $7,
//                 updated_at = CURRENT_TIMESTAMP
//                 WHERE id = $8 RETURNING *`,
//                 [
//                     daily_days_of_week, daily_time,
//                     monthly_months, monthly_day_of_month, monthly_time,
//                     yearly_date, yearly_time,
//                     id
//                 ]
//             );
//             return res.rows[0];
//         } catch (e) {
//             console.error('Error update schedule:', e);
//         }
//     }

//     // เริ่มการทำงานของ schedule
//     static async startSchedule(req, id) {
//         try {
//             await this.stopSchedule(req, id); // เพื่อให้แน่ใจว่า job เดิมถูกหยุดก่อน
//             const res = await req.dbPool.query('UPDATE sa_backup_schedule SET is_running = TRUE, progress_percent = 0, message = NULL WHERE id = $1 RETURNING *', [id]);
//             const scheduleData = res.rows[0];
//             if (scheduleData) {
//                 this.setupJob(req.databaseName, scheduleData); // สร้าง job ใหม่
//             }
//             return scheduleData;
//         } catch (e) {
//             console.error('Error start schedule:', e);
//         }
//     }

//     // หยุดการทำงานของ schedule
//     static async stopSchedule(req, id) {
//         try {
//             await req.dbPool.query('UPDATE sa_backup_schedule SET is_running = FALSE WHERE id = $1', [id]);
//             if (this.runningJobs[id]) {
//                 this.runningJobs[id].cancel();
//                 delete this.runningJobs[id];
//                 console.log(`Job for schedule ID ${id} stopped.`);
//             }
//         } catch (e) {
//             console.error('Error stop schedule:', e);
//         }
//     }

//     // ตั้งค่าและเริ่ม job สำหรับ schedule ที่กำหนด
//     static setupJob(databaseName, scheduleData) {
//         const { id, schedule_type, daily_days_of_week, daily_time, monthly_months, monthly_day_of_month, monthly_time, yearly_date, yearly_time } = scheduleData;
        
//         let jobSchedule = null;

//         if (schedule_type === 'daily' && daily_days_of_week && daily_time) {
//             const timeParts = daily_time.split(':');
//             const rule = new schedule.RecurrenceRule();
//             rule.dayOfWeek = daily_days_of_week.split(',').map(Number);
//             rule.hour = parseInt(timeParts[0]);
//             rule.minute = parseInt(timeParts[1]);
//             // rule.tz = process.env.TZ || 'UTC'; // ตั้งค่า Time Zone
//             jobSchedule = rule;
//             console.log(`Setting up daily backup job for days ${daily_days_of_week} at ${daily_time}`);
//         } else if (schedule_type === 'monthly' && monthly_months && monthly_day_of_month && monthly_time) {
//             const timeParts = monthly_time.split(':');
//             const rule = new schedule.RecurrenceRule();
//             rule.month = monthly_months.split(',').map(m => m - 1); // 0-indexed month
//             rule.date = monthly_day_of_month;
//             rule.hour = parseInt(timeParts[0]);
//             rule.minute = parseInt(timeParts[1]);
//             // rule.tz = process.env.TZ || 'UTC'; // ตั้งค่า Time Zone
//             jobSchedule = rule;
//             console.log(`Setting up monthly backup job for months ${monthly_months} on day ${monthly_day_of_month} at ${monthly_time}`);
//         } else if (schedule_type === 'yearly' && yearly_date && yearly_time) {
//             const dateParts = yearly_date ? yearly_date.split('-') : null;
//             const timeParts = yearly_time ? yearly_time.split(':') : null;
//             const rule = new schedule.RecurrenceRule();
//             rule.year = parseInt(dateParts[0]);
//             rule.month = parseInt(dateParts[1]) - 1; // 0-indexed month
//             rule.date = parseInt(dateParts[2]);
//             rule.hour = parseInt(timeParts[0]);
//             rule.minute = parseInt(timeParts[1]);
//             // rule.tz = process.env.TZ || 'UTC'; // ตั้งค่า Time Zone
//             jobSchedule = rule;
//             console.log(`Setting up yearly backup job for ${yearly_date} at ${yearly_time}`);
//         }

//         if (jobSchedule) {
//             this.runningJobs[id] = schedule.scheduleJob(jobSchedule, () => {
//                 this.runPgDump(databaseName, id);
//             });
//         }
//     }

//     // เมธอดสำหรับยกเลิก job ที่กำลังรันอยู่ทั้งหมด
//     static stopAllJobs() {
//         console.log('Stopping all existing backup jobs...');
//         // วนลูปผ่าน object runningJobs
//         for (const jobId in this.runningJobs) {
//             if (Object.prototype.hasOwnProperty.call(this.runningJobs, jobId)) {
//                 // ยกเลิก job แต่ละตัว
//                 this.runningJobs[jobId].cancel();
//                 console.log(`Job with ID ${jobId} has been stopped.`);
//             }
//         }
//         // ล้าง object runningJobs
//         this.runningJobs = {};
//         console.log('All backup jobs have been stopped.');
//     }

//     static async setupAllJobs(databaseName) { // ฟังก์ชันนี้จะถูกเรียกตอนเริ่มต้น server (node index.js <database_name>)
//         try {
//             console.log(`Setting up backup jobs for database: ${databaseName}`);
//             // ใช้ getPool เพื่อเชื่อมต่อฐานข้อมูลที่ต้องการ
//             const pool = await dbService.getPool(databaseName);
            
//             // ยกเลิก job ที่กำลังรันอยู่ทั้งหมดก่อน
//             this.stopAllJobs();

//             const result = await pool.query('SELECT * FROM sa_backup_schedule WHERE is_running = TRUE');
//             const schedules = result.rows;
//             console.log(`Found ${schedules.length} active schedules.`);
            
//             for (const scheduleData of schedules) {
//                 this.setupJob(databaseName, scheduleData);
//             }
//         } catch (error) {
//             console.error('Failed to setup backup jobs:', error);
//             // Handle error, e.g., send notification
//         }
//     }

//     // *** ฟังก์ชันใหม่: ดึงรายชื่อไฟล์สำรองข้อมูลตามประเภท ***
//     static async getBackupFiles(scheduleType) {
//         const backupDir = path.join(__dirname, '..', 'backups');
//         if (!fs.existsSync(backupDir)) {
//             return [];
//         }

//         const files = await fs.promises.readdir(backupDir);
        
//         const filteredFiles = files
//             .filter(file => file.startsWith(`backup_`) && file.endsWith('.sql'))
//             .filter(file => {
//                 const parts = file.split('_');
//                 if (parts.length < 3) return false;
//                 const scheduleId = parts[1];
//                 if (scheduleType === 'daily' && scheduleId === '1') return true;
//                 if (scheduleType === 'monthly' && scheduleId === '2') return true;
//                 if (scheduleType === 'yearly' && scheduleId === '3') return true;
//                 return false;
//             })
//             .sort((a, b) => b.localeCompare(a)) // เรียงจากล่าสุดไปเก่าสุด
//             .slice(0, 50); // จำกัดจำนวนไฟล์ที่แสดงผล

//         return filteredFiles;
//     }

//     // *** ฟังก์ชันใหม่: เรียกคืนข้อมูลจากไฟล์ที่เลือก ***
//     static async runPgRestore(req, filename) {
//         const backupDir = path.join(__dirname, '..', 'backups');
//         const filePath = path.join(backupDir, filename);

//         // ตรวจสอบว่าไฟล์มีอยู่จริงและป้องกัน Directory Traversal
//         if (!fs.existsSync(filePath) || !filePath.startsWith(backupDir)) {
//             throw new Error('File not found or invalid path');
//         }

//         console.log(`Starting pg_restore from file: ${filePath}`);

//         const dbConfig = {
//             user: process.env.DB_USER,
//             host: process.env.DB_HOST,
//             database: req.databaseName, // ใช้ databaseName จาก req
//             password: process.env.DB_PASSWORD,
//             port: process.env.DB_PORT,
//         };

//         // คำสั่ง pg_restore
//         const pgRestoreCommand = `psql -U ${dbConfig.user} -h ${dbConfig.host} -p ${dbConfig.port} -d ${dbConfig.database} < "${filePath}"`;

//         const options = {
//             env: { ...process.env, PGPASSWORD: dbConfig.password },
//         };

//         return new Promise((resolve, reject) => {
//             exec(pgRestoreCommand, options, (error, stdout, stderr) => {
//                 if (error) {
//                     console.error(`exec error: ${error}`);
//                     reject(new Error(`Restore failed: ${stderr || error.message}`));
//                 } else {
//                     console.log(`pg_restore completed successfully.`);
//                     resolve('Restore completed successfully.');
//                 }
//             });
//         });
//     }

//     // *** ฟังก์ชันใหม่: ดึง Path ของไฟล์เพื่อใช้ในการดาวน์โหลด
//     static async getFilePath(filename) {
//         const backupDir = path.join(__dirname, '..', 'backups');
//         const filePath = path.join(backupDir, filename);
        
//         if (!fs.existsSync(filePath) || !filePath.startsWith(backupDir)) {
//             throw new Error('File not found or invalid path');
//         }
//         return filePath;
//     }

//     // *** ฟังก์ชันใหม่: ลบไฟล์สำรองข้อมูล
//     static async deleteBackupFile(filename) {
//         const backupDir = path.join(__dirname, '..', 'backups');
//         const filePath = path.join(backupDir, filename);

//         if (!fs.existsSync(filePath) || !filePath.startsWith(backupDir)) {
//             throw new Error('File not found or invalid path');
//         }

//         try {
//             await fs.promises.unlink(filePath);
//             return 'File deleted successfully.';
//         } catch (error) {
//             console.error('Error deleting file:', error);
//             throw new Error('Failed to delete file.');
//         }
//     }

// }

// module.exports = BackupService;

// // // C:\flutter_project\aaa_backend\services\backupService.js

// // // const db = require('../db');
// // const pool = require('../config/db');
// // const schedule = require('node-schedule');
// // const { exec } = require('child_process');
// // const path = require('path');
// // const fs = require('fs');

// // class BackupService {
// //     static runningJobs = {};

// //     // ฟังก์ชันสำหรับสั่ง pg_dump
// //     static async runPgDump(scheduleType) {
// //         const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
// //         const backupDir = path.join(__dirname, '..', 'backups');
// //         if (!fs.existsSync(backupDir)) {
// //             fs.mkdirSync(backupDir);
// //         }
// //         const filename = `backup_${scheduleType}_${timestamp}.sql`;
// //         const filePath = path.join(backupDir, filename);

// //         const dbConfig = {
// //             user: process.env.DB_USER,
// //             host: process.env.DB_HOST,
// //             database: process.env.DB_NAME,
// //             password: process.env.DB_PASSWORD,
// //             port: process.env.DB_PORT,
// //         };
// //         const pgDumpCommand = `PGPASSWORD=${dbConfig.password} pg_dump -U ${dbConfig.user} -h ${dbConfig.host} -p ${dbConfig.port} -d ${dbConfig.database} > "${filePath}"`;

// //         console.log(`Running pg_dump with command: ${pgDumpCommand}`);
// //         console.log(`Starting ${scheduleType} backup...`);
// //         await this.updateBackupStatus(true, scheduleType, 0, 'Starting backup...');

// //         exec(pgDumpCommand, async (error, stdout, stderr) => {
// //             if (error) {
// //                 console.error(`exec error: ${error}`);
// //                 await this.updateBackupStatus(false, scheduleType, 0, `Backup failed: ${stderr}`);
// //                 return;
// //             }
// //             console.log(`Backup completed for ${scheduleType}.`);
// //             await this.updateBackupStatus(false, scheduleType, 100, `Backup completed successfully to ${filename}`);
// //         });
// //     }

// //     // อัปเดตสถานะการทำงานในฐานข้อมูล
// //     static async updateBackupStatus(isRunning, scheduleType, progress, message) {
// //         try {
// //             await pool.query(
// //                 `UPDATE sa_backup_status SET
// //                  is_running = $1,
// //                  schedule_type = $2,
// //                  progress_percent = $3,
// //                  message = $4,
// //                  last_backup_time = CASE WHEN $1 = FALSE THEN CURRENT_TIMESTAMP ELSE last_backup_time END
// //                  WHERE id = 1`,
// //                 [isRunning, scheduleType, progress, message]
// //             );
// //         } catch (error) {
// //             console.error('Error updating backup status:', error);
// //         }
// //     }

// //     // ดึงสถานะการทำงานปัจจุบัน
// //     static async getBackupStatus(id) {
// //         // const client = await pool.connect();
// //         // const res = await client.query('SELECT * FROM sa_backup_status WHERE id = $1', [id]);
// //         // return res.rows[0];
// //         const client = await pool.connect();
// //         try {
// //             const result = await client.query('SELECT * FROM sa_backup_status WHERE id = $1', [id]);
// //             // if (result.rows.length > 0) {
// //             return result.rows[0];
// //             // } else {
// //             //     result.status(404).json({ message: 'Group not found' });
// //             // }
// //         } catch (error) {
// //             console.error('Error fetching Backup status by ID:', error);
// //             result.status(500).json({ message: 'Failed to fetch backup status', error: error.message });
// //         } finally {
// //             client.release();
// //         }
// //     }

// //     // ดึง schedule ทั้งหมด
// //     static async getSchedules() {
// //         const client = await pool.connect();
// //         const res = await client.query('SELECT * FROM sa_backup_schedule ORDER BY id');
// //         return res.rows;
// //     }

// //     // บันทึก schedule
// //     static async updateSchedule(id, scheduleData) {
// //         const { schedule_type, daily_days_of_week, daily_time, monthly_months, monthly_day_of_month, monthly_time, yearly_date, yearly_time } = scheduleData;
// //         const res = await pool.query(
// //             `UPDATE sa_backup_schedule SET
// //              is_active = FALSE,
// //              daily_days_of_week = $1, daily_time = $2,
// //              monthly_months = $3, monthly_day_of_month = $4, monthly_time = $5,
// //              yearly_date = $6, yearly_time = $7,
// //              updated_at = CURRENT_TIMESTAMP
// //              WHERE id = $8 RETURNING *`,
// //             [
// //                 daily_days_of_week, daily_time,
// //                 monthly_months, monthly_day_of_month, monthly_time,
// //                 yearly_date, yearly_time,
// //                 id
// //             ]
// //         );
// //         return res.rows[0];
// //     }

// //     // เริ่มการทำงานของ schedule
// //     static async startSchedule(id) {
// //         const res = await pool.query('UPDATE sa_backup_schedule SET is_active = TRUE WHERE id = $1 RETURNING *', [id]);
// //         const scheduleData = res.rows[0];
// //         if (scheduleData) {
// //             this.stopSchedule(id); // หยุด job เดิมถ้ามี
// //             this.setupJob(scheduleData); // สร้าง job ใหม่
// //         }
// //         return scheduleData;
// //     }

// //     // หยุดการทำงานของ schedule
// //     static async stopSchedule(id) {
// //         await pool.query('UPDATE sa_backup_schedule SET is_active = FALSE WHERE id = $1', [id]);
// //         if (this.runningJobs[id]) {
// //             this.runningJobs[id].cancel();
// //             delete this.runningJobs[id];
// //             console.log(`Job for schedule ID ${id} stopped.`);
// //         }
// //     }

// //     // ตั้งค่าและเริ่ม job สำหรับ schedule ที่กำหนด
// //     static setupJob(scheduleData) {
// //         const { id, schedule_type, daily_days_of_week, daily_time, monthly_months, monthly_day_of_month, monthly_time, yearly_date, yearly_time } = scheduleData;
        
// //         let jobSchedule = null;

// //         if (schedule_type === 'daily' && daily_days_of_week && daily_time) {
// //             const timeParts = daily_time.split(':');
// //             const rule = new schedule.RecurrenceRule();
// //             rule.dayOfWeek = daily_days_of_week.split(',').map(Number);
// //             rule.hour = parseInt(timeParts[0]);
// //             rule.minute = parseInt(timeParts[1]);
// //             jobSchedule = rule;
// //             console.log(`Setting up daily backup job for days ${daily_days_of_week} at ${daily_time}`);
// //         } else if (schedule_type === 'monthly' && monthly_months && monthly_day_of_month && monthly_time) {
// //             const timeParts = monthly_time.split(':');
// //             const rule = new schedule.RecurrenceRule();
// //             rule.month = monthly_months.split(',').map(m => m - 1); // 0-indexed month
// //             rule.date = monthly_day_of_month;
// //             rule.hour = parseInt(timeParts[0]);
// //             rule.minute = parseInt(timeParts[1]);
// //             jobSchedule = rule;
// //             console.log(`Setting up monthly backup job for months ${monthly_months} on day ${monthly_day_of_month} at ${monthly_time}`);
// //         } else if (schedule_type === 'yearly' && yearly_date && yearly_time) {
// //             const dateParts = yearly_date.split('-');
// //             const timeParts = yearly_time.split(':');
// //             const rule = new schedule.RecurrenceRule();
// //             rule.year = parseInt(dateParts[0]);
// //             rule.month = parseInt(dateParts[1]) - 1; // 0-indexed month
// //             rule.date = parseInt(dateParts[2]);
// //             rule.hour = parseInt(timeParts[0]);
// //             rule.minute = parseInt(timeParts[1]);
// //             jobSchedule = rule;
// //             console.log(`Setting up yearly backup job for ${yearly_date} at ${yearly_time}`);
// //         }

// //         if (jobSchedule) {
// //             console.log(`Scheduling job for ID ${id} with schedule type ${schedule_type}:`, jobSchedule);
// //             this.runningJobs[id] = schedule.scheduleJob(jobSchedule, () => {
// //                 this.runPgDump(schedule_type);
// //             });
// //         }
// //     }

// //     // ฟังก์ชันสำหรับตั้งค่า job ทั้งหมดเมื่อ Server เริ่มต้น
// //     static async setupAllJobs() {
// //         const schedules = await pool.query('SELECT * FROM sa_backup_schedule WHERE is_active = TRUE');
// //         for (const schedule of schedules.rows) {
// //             this.setupJob(schedule);
// //         }
// //     }
// // }

// // module.exports = BackupService;