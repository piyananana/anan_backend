// index.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const dbMiddleware = require('./middlewares/dbMiddleware'); 
const history = require('connect-history-api-fallback');

const app = express();
const port = process.env.PORT || 8888;
const host = '0.0.0.0'; // ฟังทุก interface

app.use(cors()); 
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 

// *** เพิ่มการจัดการ Static Files สำหรับ Flutter Web ***
const flutterWebPath = path.join(__dirname, 'build', 'web');    // กำหนด path ไปยังโฟลเดอร์ build/web ของโปรเจกต์ Flutter ของคุณ
app.use(express.static(flutterWebPath));

app.use(dbMiddleware);

// *** เพิ่ม Middleware 'history' ก่อนการให้บริการไฟล์ static ***
// โดยให้แน่ใจว่าไฟล์ที่ถูกเรียกใช้ไม่ใช่เส้นทาง API
app.use(history({
    rewrites: [
        {
            from: /^\/api\/.*$/,
            to: function(context) {
                return context.parsedUrl.path;
            }
        }
    ]
}));

// *** ให้บริการไฟล์ Static ของ Flutter Web ***
app.get('/', (req, res) => {
    res.sendFile(path.join(flutterWebPath, 'index.html'));
});

// ROUTES
// cd = Common Data
const cdRoutes = require('./routes/cd');
app.use('/api/cd', cdRoutes);
// ----------------

// gl = General Ledger
const glRoutes = require('./routes/gl');
app.use('/api/gl', glRoutes);
// ----------------

// ar = Accounts Receivable
const arRoutes = require('./routes/ar');
app.use('/api/ar', arRoutes);
// ----------------

// sa = System Administration
const saRoutes = require('./routes/sa');
const saPasswordPolicyController = require('./controllers/sa/saPasswordPolicyController');
const saBackupService = require('./services/saBackupService');
const saDatabaseService = require('./services/saDatabaseService');
app.use('/api/sa', saRoutes);
// ----------------

app.use('/public', express.static(path.join(__dirname, 'public')));

// Error handling middleware (optional but recommended)
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

const startServer = async (databaseName) => {
    try {
        await saPasswordPolicyController.ensureDefaultPolicyExists(databaseName);
        await saBackupService.stopAllJobs();        // ยกเลิก job ที่กำลังรันอยู่ทั้งหมดก่อน
        // await saBackupService.setupAllJobs(databaseName);
        var allDatabases = await saDatabaseService.getDatabases();
        console.log('All databases:', allDatabases);
        allDatabases.forEach(async dbName => {
            console.log(`- ${dbName}`);
            await saBackupService.setupAllJobs(dbName);
        })
        app.listen(port, host, () => {
            console.log(`Server for ANAN is running on http://${host}:${port}`);
            console.log('Time Zone:', process.env.TZ || 'Not set');
            console.log(`Connected to database: ${databaseName}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

const databaseFromCommandLine = process.argv[2];
const defaultDatabaseName = databaseFromCommandLine || process.env.DB_NAME;

if (!defaultDatabaseName) {
    console.error('Error: No database name provided. Please run with a database name, e.g., node index.js yourdbname');
    process.exit(1);
}

startServer(defaultDatabaseName);
