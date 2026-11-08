// C:\\flutter_project\\aaa_backend\\services\\saBackupService.js
const pool = require('../config/db');
const schedule = require('node-schedule');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const dbService = require('./saDatabaseService');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

// หาโปรแกรม pg_dump / pg_restore / psql: PG_BIN_PATH ใน .env > C:\Program Files\PostgreSQL\<เวอร์ชันสูงสุด>\bin
// (Windows) > PATH — เครื่องที่ติดตั้ง PostgreSQL ใหม่มักไม่ได้เพิ่มโฟลเดอร์ bin ลง PATH
const pgTool = (name) => {
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    const dirs = [];
    if (process.env.PG_BIN_PATH) dirs.push(process.env.PG_BIN_PATH);
    if (process.platform === 'win32') {
        for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
            const pgRoot = root && path.join(root, 'PostgreSQL');
            if (!pgRoot || !fs.existsSync(pgRoot)) continue;
            const versions = fs.readdirSync(pgRoot)
                .filter(v => /^\d+(\.\d+)?$/.test(v))
                .sort((a, b) => parseFloat(b) - parseFloat(a));
            for (const v of versions) dirs.push(path.join(pgRoot, v, 'bin'));
        }
    }
    for (const dir of dirs) {
        const full = path.join(dir, exe);
        if (fs.existsSync(full)) return full;
    }
    return name;
};

// รันโปรแกรมแบบส่ง argument เป็น array (ไม่ผ่าน shell — path ที่มีช่องว่างไม่ต้อง quote) คืน { error, stdout, stderr }
const runTool = (name, args, password) => new Promise((resolve) => {
    const bin = pgTool(name);
    execFile(bin, args, { env: { ...process.env, PGPASSWORD: password }, maxBuffer: 50 * 1024 * 1024 },
        (error, stdout, stderr) => {
            if (error && error.code === 'ENOENT') {
                error.message = `ไม่พบโปรแกรม ${name} (${bin}) — ติดตั้ง PostgreSQL หรือตั้ง PG_BIN_PATH ใน .env ให้ชี้ไปที่โฟลเดอร์ bin ของ PostgreSQL`;
            }
            resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '').trim() });
        });
});

const connArgs = (o) => ['-U', o.user, '-h', o.host, '-p', String(o.port), '-d', o.database];

// ข้อความ error ที่อ่านได้: เอาบรรทัด error ของ PostgreSQL (ตัดความยาว) ถ้าไม่มีใช้ข้อความของ process
const toolError = (res, fallback) => {
    const lines = res.stderr.split(/\r?\n/).filter(Boolean);
    const msg = lines.length ? lines.slice(0, 10).join('\n') : (res.error && res.error.message) || '';
    return new Error(msg ? `${fallback}\n${msg}` : fallback);
};

const timestampForFile = () => {
    const now = new Date();
    return now.getFullYear().toString() +
        '-' + (now.getMonth() + 1).toString().padStart(2, '0') +
        '-' + now.getDate().toString().padStart(2, '0') +
        'T' + now.getHours().toString().padStart(2, '0') +
        '-' + now.getMinutes().toString().padStart(2, '0') +
        '-' + now.getSeconds().toString().padStart(2, '0');
};

// format 'custom' = ไฟล์ .backup (pg_restore ต้องเป็นเวอร์ชันเดียวกันหรือใหม่กว่า pg_dump)
// format 'plain' = ไฟล์ .sql คำสั่ง SQL ล้วน ใช้ย้ายข้ามเครื่องที่ PostgreSQL ต่างเวอร์ชันได้ (psql / pgAdmin เวอร์ชันใดก็รันได้)
// plain ไม่ใส่ owner/สิทธิ์ เพื่อให้รันบนเครื่องที่ไม่มี role เดียวกันได้ (custom ตัดตอน restore ด้วย --no-owner --no-privileges อยู่แล้ว)
const dumpArgs = (o, filePath, format = 'custom') => format === 'plain'
    ? ['-Fp', '--clean', '--if-exists', '--no-owner', '--no-privileges', ...connArgs(o), '-f', filePath]
    : ['-Fc', '--clean', '--if-exists', ...connArgs(o), '-f', filePath];

const backupExt = (format) => (format === 'plain' ? '.sql' : '.backup');
const isBackupFileName = (file) => file.endsWith('.backup') || file.endsWith('.sql');

// ไฟล์ SQL ที่ได้จาก pg_dump แบบ plain (pg_dump หรือ pgAdmin ใส่หัวไฟล์ "-- PostgreSQL database dump")
const isPlainDump = (filePath) => {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, 4096, 0);
        return buf.toString('utf8', 0, n).includes('PostgreSQL database dump');
    } finally {
        fs.closeSync(fd);
    }
};

// ไฟล์ในโฟลเดอร์ backups เท่านั้น (กันชื่อไฟล์แบบ ../)
const backupFilePath = (filename) => {
    const filePath = path.join(BACKUP_DIR, filename || '');
    if (!filePath.startsWith(BACKUP_DIR + path.sep) || !fs.existsSync(filePath)) {
        throw new Error('ไม่พบไฟล์สำรองข้อมูล');
    }
    return filePath;
};

// เวอร์ชัน archive ในหัวไฟล์ (byte 5-6 หลัง 'PGDMP') -> เวอร์ชัน PostgreSQL ขั้นต่ำของ pg_restore ที่อ่านไฟล์ได้
const ARCHIVE_MIN_PG = { '1.15': 16, '1.16': 17 };

const archiveVersion = (filePath) => {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(8);
        fs.readSync(fd, buf, 0, 8, 0);
        if (buf.toString('latin1', 0, 5) !== 'PGDMP') return null;
        return `${buf[5]}.${buf[6]}`;
    } finally {
        fs.closeSync(fd);
    }
};

// pg_restore ที่เก่ากว่า pg_dump ที่สร้างไฟล์จะอ่านไฟล์ไม่ได้ ("unsupported version (1.16) in file header")
// ตรวจก่อนล้าง schema เพื่อไม่ให้ฐานข้อมูลปลายทางถูกล้างทิ้งทั้งที่ restore ไม่ได้
const checkRestoreToolVersion = async (filePath, password) => {
    const ver = archiveVersion(filePath);
    const need = ARCHIVE_MIN_PG[ver];
    if (!need) return;
    const res = await runTool('pg_restore', ['--version'], password);
    if (res.error) throw toolError(res, 'เรียกโปรแกรม pg_restore ไม่สำเร็จ');
    const m = res.stdout.match(/\)\s*(\d+)/);
    const have = m ? parseInt(m[1], 10) : 0;
    if (have && have < need) {
        throw new Error(
            `ไฟล์สำรองข้อมูลนี้สร้างด้วย PostgreSQL ${need} (archive ${ver}) ` +
            `แต่เครื่องนี้ใช้ pg_restore เวอร์ชัน ${have} (${pgTool('pg_restore')}) ซึ่งอ่านไฟล์ไม่ได้\n` +
            `แก้ไข: ติดตั้ง PostgreSQL ${need} ขึ้นไป หรือตั้ง PG_BIN_PATH ใน .env ให้ชี้ไปที่โฟลเดอร์ bin ของ PostgreSQL ${need} ขึ้นไป`);
    }
};

// รันไฟล์ .sql ด้วย psql แบบทำต่อเมื่อเจอ error (เหมือน pgAdmin) — error ที่เจอส่งกลับเป็นคำเตือน
// เช่น ไฟล์จาก PostgreSQL 17 ลงเครื่อง 16 จะมี error "transaction_timeout" ซึ่งไม่กระทบข้อมูล
// psql จบด้วย exit code ไม่เป็น 0 เฉพาะกรณีร้ายแรง (เชื่อมต่อไม่ได้ / หลุดกลางทาง) จึงถือว่าล้มเหลว
const restorePlain = async (o, filePath) => {
    const res = await runTool('psql', ['-q', '-X', ...connArgs(o), '-f', filePath], o.password);
    if (res.stderr) console.error(`psql restore stderr (${o.database}):\n${res.stderr}`);
    if (res.error) throw toolError(res, `Restore ไปยังฐานข้อมูล ${o.database} ไม่สำเร็จ`);
    const lines = res.stderr.split(/\r?\n/);
    const errors = lines.filter(l => /ERROR:|error:/.test(l));
    if (!errors.length) return { message: 'Restore สำเร็จ', warnings: [] };
    const warnings = lines
        .filter(l => /ERROR:|error:|DETAIL:|HINT:/.test(l))
        .map(l => l.replace(/^psql:.*?:(\d+):\s*/, 'บรรทัด $1: '))
        .slice(0, 50);
    return { message: `Restore สำเร็จ แต่มีข้อผิดพลาด ${errors.length} รายการ`, warnings };
};

// ล้าง schema public แล้ว pg_restore ไฟล์ลงฐานข้อมูล — คืน { message, warnings }
// pg_restore จบด้วย exit code 1 แม้มี error เล็กน้อยแล้วทำต่อจนจบ ("errors ignored on restore: N")
// กรณีนั้นถือว่าสำเร็จพร้อมคำเตือน (ส่งรายการ error กลับไปแสดง) — ล้มเหลวจริงเฉพาะเมื่อ pg_restore หยุดกลางทาง
const restoreArchive = async (dbConfig, filePath) => {
    const o = dbConfig.options;
    const plain = archiveVersion(filePath) === null;
    if (plain && !isPlainDump(filePath)) {
        throw new Error('ไฟล์ที่เลือกไม่ใช่ไฟล์สำรองข้อมูลของ PostgreSQL (.backup หรือ .sql จาก pg_dump) หรือไฟล์เสียระหว่างคัดลอก');
    }
    if (!plain) await checkRestoreToolVersion(filePath, o.password);
    const drop = await runTool('psql', [...connArgs(o), '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'], o.password);
    if (drop.error) {
        console.error(`drop schema error (${o.database}):`, drop.stderr || drop.error.message);
        throw toolError(drop, `ล้าง schema public ของฐานข้อมูล ${o.database} ไม่สำเร็จ (ผู้ใช้ ${o.user} ต้องเป็นเจ้าของ schema หรือ superuser)`);
    }

    if (plain) return restorePlain(o, filePath);

    const res = await runTool('pg_restore', ['--no-owner', '--no-privileges', ...connArgs(o), filePath], o.password);
    if (res.stderr) console.error(`pg_restore stderr (${o.database}):\n${res.stderr}`);
    if (!res.error) return { message: 'Restore สำเร็จ', warnings: [] };

    const ignored = res.stderr.match(/errors ignored on restore:\s*(\d+)/);
    if (ignored) {
        const warnings = res.stderr.split(/\r?\n/)
            .filter(l => /error:|ERROR:|DETAIL:|HINT:|Command was:/.test(l) && !/errors ignored on restore/.test(l))
            .slice(0, 50);
        return { message: `Restore สำเร็จ แต่มีข้อผิดพลาด ${ignored[1]} รายการ`, warnings };
    }
    throw toolError(res, `Restore ไปยังฐานข้อมูล ${o.database} ไม่สำเร็จ`);
};

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
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
        const filePath = path.join(BACKUP_DIR, `${databaseName}_Backup_${scheduleType}_${timestampForFile()}.backup`);

        const dbConfig = await dbService.getPool(databaseName);
        const res = await runTool('pg_dump', dumpArgs(dbConfig.options, filePath), dbConfig.options.password);
        if (res.error) {
            console.error('pg_dump error:', res.stderr || res.error.message);
            throw toolError(res, 'สำรองข้อมูลไม่สำเร็จ');
        }
        console.log(`Backup completed successfully: ${filePath}`);
        return filePath;
    }

    // ฟังก์ชันสำหรับสั่ง pg_restore
    static async runPgRestore(req, filename) {
        console.log(`Running pg_restore for file: ${filename}`);
        const filePath = backupFilePath(filename);
        const dbConfig = await dbService.getPool(req.header('X-Database-Name'));
        return restoreArchive(dbConfig, filePath);
    }

    // เพิ่มฟังก์ชันสำหรับ Instant Backup
    static async startInstantBackup(req) {
        if (this.instantBackupProcess) {
            throw new Error('Instant backup is already running.');
        }

        const databaseName = req.headers['x-database-name'];
        const format = req.body && req.body.format === 'plain' ? 'plain' : 'custom';
        this.instantBackupStatus.isRunning = true;
        this.instantBackupStatus.status = 'กำลังทำงาน';
        this.instantBackupStatus.lastBackup = 'กำลังดำเนินการ...';

        console.log('Starting instant backup...');

        try {
            if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
            const filePath = path.join(BACKUP_DIR, `${databaseName}_instant_backup_${timestampForFile()}${backupExt(format)}`);
            const dbConfig = await dbService.getPool(databaseName);

            const bin = pgTool('pg_dump');
            this.instantBackupProcess = execFile(bin, dumpArgs(dbConfig.options, filePath, format),
                { env: { ...process.env, PGPASSWORD: dbConfig.options.password }, maxBuffer: 50 * 1024 * 1024 },
                (error, stdout, stderr) => {
                this.instantBackupProcess = null;
                this.instantBackupStatus.isRunning = false;
                if (error) {
                    // ห้าม throw ใน callback — จะทำให้ server ล่ม
                    console.error(`Instant backup failed (${bin}):`, String(stderr || '').trim() || error.message);
                    if (this.instantBackupStatus.status !== 'ถูกยกเลิก') this.instantBackupStatus.status = 'ล้มเหลว';
                    return;
                }
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
        const filePath = backupFilePath(filename);
        const dbConfig = await dbService.getPool(req.header('X-Database-Name'));
        return restoreArchive(dbConfig, filePath);
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
                    return file.startsWith(str) && isBackupFileName(file);
                } else {
                    var str = `${databaseName}_Backup_${scheduleType}_`;
                    return file.startsWith(str) && isBackupFileName(file);
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

    // Restore จากไฟล์ที่ upload มาจาก client ไปยัง targetDatabase ที่ระบุ
    static async runPgRestoreFromUpload(uploadedFilePath, targetDatabaseName) {
        console.log(`Restoring uploaded file to database: ${targetDatabaseName}`);
        try {
            // restoreArchive ตรวจชนิดไฟล์ (.backup / .sql) ก่อนล้าง schema
            const dbConfig = await dbService.getPool(targetDatabaseName);
            const result = await restoreArchive(dbConfig, uploadedFilePath);
            console.log(`Restore from upload completed to: ${targetDatabaseName}`);
            return result;
        } finally {
            fs.unlink(uploadedFilePath, () => {}); // ลบ temp file เสมอ
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