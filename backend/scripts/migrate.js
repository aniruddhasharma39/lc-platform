require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Create migrations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const migrationsDir = path.join(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
      const res = await client.query('SELECT id FROM migrations WHERE filename = $1', [file]);
      if (res.rows.length === 0) {
        console.log(`Applying migration: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
        console.log(`Migration ${file} applied successfully.`);
      } else {
        console.log(`Migration ${file} already applied.`);
      }
    }

    await client.query('COMMIT');
    console.log('All migrations applied successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error applying migrations:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
