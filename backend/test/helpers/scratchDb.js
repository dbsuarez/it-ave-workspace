// Real-database test support: builds a throwaway PostgreSQL database from database/init.sql plus the
// startup migrations, and drops it afterwards. Tests that use it SKIP (not fail) when no server is
// reachable, so `npm test` still works on a machine without Postgres.
//
// Connection: TEST_DATABASE_ADMIN_URL (a URL with rights to create databases), otherwise the
// POSTGRES_* values from the repository's .env on 127.0.0.1:5432 (where docker-compose publishes it).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

function adminUrl() {
  if (process.env.TEST_DATABASE_ADMIN_URL) return process.env.TEST_DATABASE_ADMIN_URL;
  const envFile = path.join(__dirname, '..', '..', '..', '.env');
  if (!fs.existsSync(envFile)) return null;
  const values = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  if (!values.POSTGRES_USER || !values.POSTGRES_PASSWORD) return null;
  const host = process.env.TEST_DATABASE_HOST || '127.0.0.1';
  return `postgres://${encodeURIComponent(values.POSTGRES_USER)}:${encodeURIComponent(values.POSTGRES_PASSWORD)}@${host}:5432/postgres`;
}

async function connect(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  await client.connect();
  return client;
}

// Returns null when no database is reachable (the caller should skip).
async function createScratchDatabase() {
  const url = adminUrl();
  if (!url) return null;
  let admin;
  try {
    admin = await connect(url);
  } catch (_) {
    return null;
  }
  const name = `itavenue_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const scratchUrl = url.replace(/\/[^/]*$/, `/${name}`);

  const db = {
    name,
    url: scratchUrl,
    async open() {
      const client = await connect(scratchUrl);
      return client;
    },
    // init.sql on its own (the state a database had before the newest migrations)
    async applyInit(client) {
      await client.query(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'database', 'init.sql'), 'utf8'));
    },
    async applyMigrations(client) {
      const migrations = require('../../src/migrations');
      for (const sql of migrations) await client.query(sql);
    },
    async drop() {
      const dropper = await connect(url);
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
  return db;
}

module.exports = { createScratchDatabase };
