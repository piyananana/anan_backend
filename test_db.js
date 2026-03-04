// test_db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function testDbConnection() {
    try {
        const client = await pool.connect();
        console.log('Successfully connected to PostgreSQL!');
        const res = await client.query('SELECT NOW()');
        console.log('Current database time:', res.rows[0].now);
        client.release(); // Release the client back to the pool
    } catch (err) {
        console.error('Database connection error:', err);
    } finally {
        pool.end(); // Close the pool after testing
    }
}

testDbConnection();