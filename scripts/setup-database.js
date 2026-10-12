require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required. Configure it before setting up PostgreSQL.');
  }

  const useSsl = process.env.DATABASE_SSL === 'true';
  const pool = new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined
  });

  try {
    const schema = await fs.readFile(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('PostgreSQL schema is ready.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Database setup failed:', error.message);
  process.exitCode = 1;
});
