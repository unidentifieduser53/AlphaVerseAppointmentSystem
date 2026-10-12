const { Pool } = require('pg');

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('The DATABASE_URL environment variable is not configured.');
  }

  if (!pool) {
    const useSsl = process.env.DATABASE_SSL === 'true' ||
      process.env.DATABASE_URL.includes('sslmode=require');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });
    pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error));
  }

  return pool;
}

async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { getPool, withTransaction };
