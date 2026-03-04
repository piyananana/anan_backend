// services/saDatabaseService.js
const { Pool } = require('pg');
require('dotenv').config();

// สร้าง pool สำหรับฐานข้อมูลหลัก (postgres) เพื่อใช้สำหรับ query รายชื่อ db ทั้งหมด
const masterPool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: 'postgres', // ใช้ฐานข้อมูล postgres สำหรับการ query
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Dictionary สำหรับเก็บ connection pool ของแต่ละ database
const pools = {};

async function getPool(databaseName) {
    if (!databaseName) {
        throw new Error('Database name is required.');
    }
    if (!pools[databaseName]) {
        pools[databaseName] = new Pool({
            user: process.env.DB_USER,
            host: process.env.DB_HOST,
            database: databaseName,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT,
        });
        console.log(`Created connection pool for database: ${databaseName}`);
    }
    return pools[databaseName];
}

async function getDatabases() {
    const client = await masterPool.connect();
    try {
        const res = await client.query(`
            SELECT datname AS database_name
            FROM pg_database
            WHERE datistemplate = false AND datallowconn = true AND datname NOT IN ('postgres')
            ORDER BY datname;
        `);
        return res.rows.map(row => row.database_name);
    } finally {
        client.release();
    }
}

module.exports = {
    masterPool,
    getPool,
    getDatabases,
};