// This file sets up a connection pool to a PostgreSQL database using the 'pg' library.
const { Pool } = require('pg');
require('dotenv').config();

// Create a new pool instance with the database connection details
// Use environment variables for configuration
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
});

pool.on('connect', () => {
    // console.log('Connected to the PostgreSQL database!');
});

pool.on('error', (err) => {
    console.error('Error connecting to PostgreSQL:', err.message);
});

module.exports = pool;

// const { Pool } = require('pg');
// require('dotenv').config();

// const pool = new Pool({
//     user: process.env.DB_USER,
//     host: process.env.DB_HOST,
//     database: process.env.DB_NAME,
//     password: process.env.DB_PASSWORD,
//     port: process.env.DB_PORT,
// });

// pool.on('connect', () => {
//     console.log('Connected to PostgreSQL database');
// });

// pool.on('error', (err) => {
//     console.error('Unexpected error on idle client', err);
//     process.exit(-1);
// });

// module.exports = {
//     query: (text, params) => pool.query(text, params),
// };