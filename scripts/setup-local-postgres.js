require('dotenv').config();

const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');

const root = path.join(__dirname, '..');
const dataDirectory = path.join(root, 'database', 'local-pgdata');
const adminPasswordFile = path.join(root, 'database', '.local-pg-admin-password');
const databaseName = 'alphaverse';
const appUsername = 'alphaverse_app';
const port = Number(process.env.LOCAL_PG_PORT || 5433);

function postgresBinary(name) {
  const binDirectory = process.env.PG_BIN ||
    (process.platform === 'win32'
      ? 'C:\\Program Files\\PostgreSQL\\18\\bin'
      : '/usr/bin');
  const executable = path.join(binDirectory, process.platform === 'win32' ? `${name}.exe` : name);
  if (!fs.existsSync(executable)) {
    throw new Error(`PostgreSQL tool not found at ${executable}. Set PG_BIN to your PostgreSQL bin directory.`);
  }
  return executable;
}

function run(executable, args) {
  execFileSync(executable, args, { stdio: 'inherit', windowsHide: true });
}

function quoteIdentifier(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This local cluster helper currently supports Windows. For Render/Vercel, set DATABASE_URL and run npm run db:setup.');
  }
  if (!process.env.ADMIN_EMAIL?.trim()) {
    throw new Error('Set ADMIN_EMAIL to the first administrator email before running npm run db:local.');
  }
  if (fs.existsSync(path.join(root, '.env'))) {
    throw new Error('.env already exists. Refusing to overwrite local configuration.');
  }
  if (fs.existsSync(dataDirectory)) {
    throw new Error(`The local data directory already exists at ${dataDirectory}. Refusing to overwrite it.`);
  }
  if (fs.existsSync(adminPasswordFile)) {
    throw new Error(`A local PostgreSQL password file already exists at ${adminPasswordFile}. Refusing to overwrite it.`);
  }

  const initdb = postgresBinary('initdb');
  const pgCtl = postgresBinary('pg_ctl');
  await fsp.mkdir(path.dirname(dataDirectory), { recursive: true });

  const clusterPassword = randomBytes(36).toString('base64url');
  const appPassword = randomBytes(36).toString('base64url');
  const sessionSecret = randomBytes(48).toString('base64url');
  const initialAdminPassword = randomBytes(24).toString('base64url');
  const passwordFile = path.join(os.tmpdir(), `alphaverse-pg-${randomBytes(12).toString('hex')}.txt`);
  await fsp.writeFile(passwordFile, `${clusterPassword}\n`, { flag: 'wx' });

  try {
    run(initdb, [
      '-D', dataDirectory,
      '-U', 'postgres',
      '--pwfile', passwordFile,
      '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256',
      '--encoding=UTF8'
    ]);
  } finally {
    await fsp.rm(passwordFile, { force: true });
  }

  await fsp.writeFile(adminPasswordFile, `${clusterPassword}\n`, { flag: 'wx' });
  run(pgCtl, [
    '-D', dataDirectory,
    '-l', path.join(root, 'database', 'local-postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port}`,
    '-w', 'start'
  ]);

  const adminClient = new Client({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: clusterPassword,
    database: 'postgres',
    connectionTimeoutMillis: 10000
  });

  try {
    await adminClient.connect();
    await adminClient.query(
      `CREATE ROLE ${quoteIdentifier(appUsername)} LOGIN PASSWORD ${quoteLiteral(appPassword)}`
    );
    await adminClient.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(appUsername)}`
    );
  } finally {
    await adminClient.end().catch(() => {});
  }

  const appClient = new Client({
    host: '127.0.0.1',
    port,
    user: appUsername,
    password: appPassword,
    database: databaseName,
    connectionTimeoutMillis: 10000
  });

  try {
    await appClient.connect();
    const schema = await fsp.readFile(path.join(root, 'database', 'schema.sql'), 'utf8');
    await appClient.query(schema);
  } finally {
    await appClient.end().catch(() => {});
  }

  const connectionString = `postgresql://${appUsername}:${encodeURIComponent(appPassword)}@127.0.0.1:${port}/${databaseName}`;
  const environment = [
    `DATABASE_URL=${connectionString}`,
    'DATABASE_SSL=false',
    `SESSION_SECRET=${sessionSecret}`,
    'RESEND_API_KEY=',
    'EMAIL_FROM=AlphaVerse Construction <noreply@example.com>',
    `INQUIRY_NOTIFICATION_EMAIL=${process.env.ADMIN_EMAIL.trim().toLowerCase()}`,
    `ADMIN_EMAIL=${process.env.ADMIN_EMAIL.trim().toLowerCase()}`,
    `ADMIN_PASSWORD=${initialAdminPassword}`,
    'ALLOWED_ORIGIN=http://localhost:3000',
    'PORT=3000',
    ''
  ].join('\n');
  await fsp.writeFile(path.join(root, '.env'), environment, { flag: 'wx' });
  await fsp.chmod(path.join(root, '.env'), 0o600).catch(() => {});

  console.log(`Local PostgreSQL database "${databaseName}" is ready on 127.0.0.1:${port}.`);
  console.log('The schema has been applied and local credentials are in the ignored .env file.');
  console.log('A first admin account will be seeded by npm start. Read ADMIN_PASSWORD from .env to sign in, then rotate it.');
  console.log('Email delivery is disabled until RESEND_API_KEY and a verified EMAIL_FROM address are configured.');
}

main().catch((error) => {
  console.error('Local PostgreSQL setup failed:', error.message);
  process.exitCode = 1;
});
