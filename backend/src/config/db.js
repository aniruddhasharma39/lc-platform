require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
});

const testConnection = async () => {
  try {
    const client = await pool.connect();
    console.log('Successfully connected to the database.');
    client.release();
    return true;
  } catch (error) {
    console.error('Database connection failed:', error.message);
    console.error('Verify DATABASE_URL and ensure PostgreSQL is running.');
    return false;
  }
};

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool: pool,
  testConnection
};
