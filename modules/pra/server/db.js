'use strict';
/**
 * server/db.js — the connection layer.
 *
 * Two things this file exists to get right:
 *
 * 1. THE HOST IS CHECKED BEFORE A SOCKET OPENS. db_policy runs first, every
 *    time. There is no path to a remote database through this module.
 *
 * 2. withTransaction() CHECKS OUT ONE CONNECTION for the whole BEGIN/COMMIT.
 *    Issuing BEGIN and COMMIT through a pool does NOT guarantee they land on
 *    the same connection — the second statement can be handed a different one,
 *    and then your "transaction" is two autocommitted statements wearing a
 *    costume. That bug was live in an earlier build of this system: a crash
 *    between two writes could leave a received_records row with no matching
 *    history row. Every multi-row write in metadata_repository goes through
 *    withTransaction for that reason.
 */

const fs = require('fs');
const path = require('path');
const policy = require('./db_policy.js');

const ROOT = path.resolve(__dirname, '..');

let Pg = null;
function pg() {
  if (Pg) return Pg;
  try {
    Pg = require('pg');
  } catch {
    throw new Error('the pg driver is not installed. Run: cd modules/pra && npm install');
  }
  return Pg;
}

/** Read .env without a dependency. Never logs a value. */
function loadEnv(envPath) {
  const env = Object.assign({}, process.env);
  const candidates = envPath ? [envPath] : [
    path.join(ROOT, '.env'),
    path.join(ROOT, '..', '..', '.env'),
  ];
  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

function configFromEnv(env) {
  const e = env || loadEnv();
  const cfg = {
    host: e.PGHOST || '127.0.0.1',
    port: Number(e.PGPORT || 5432),
    database: e.PGDATABASE || 'sentinel_pra',
    user: e.PGUSER || 'sentinel_app',
    password: e.PGPASSWORD || undefined,
    // Small pool: this is a single-operator desk, not a web tier.
    max: Number(e.PGPOOL_MAX || 4),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: 'sentinel_pra',
  };
  return policy.assertLocal(cfg);
}

class Db {
  constructor(config) {
    this.config = policy.assertLocal(config || configFromEnv());
    this.pool = new (pg().Pool)(this.config);
    this._available = null;
    // A pool error with no listener crashes the process. A desk that dies
    // because Postgres restarted is worse than one that reports it is down.
    this.pool.on('error', (err) => {
      this._available = false;
      this._lastError = err.message;
    });
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  /**
   * Run `fn` inside a real transaction on a SINGLE checked-out connection.
   * Commits on success, rolls back on any throw, always releases.
   *
   *   await db.withTransaction(async (client) => {
   *     await client.query('INSERT ...');
   *     await client.query('INSERT ...');   // both, or neither
   *   });
   */
  async withTransaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Cheap liveness check. Never throws — the caller wants a boolean. */
  async isAvailable() {
    try {
      await this.pool.query('SELECT 1');
      this._available = true;
      return true;
    } catch (err) {
      this._available = false;
      this._lastError = err.message;
      return false;
    }
  }

  lastError() { return this._lastError || null; }

  async close() {
    try { await this.pool.end(); } catch { /* already closed */ }
  }
}

/** Process-wide singleton, created lazily so importing this file is free. */
let singleton = null;
function getDb() {
  if (!singleton) singleton = new Db();
  return singleton;
}
async function closeDb() {
  if (singleton) { await singleton.close(); singleton = null; }
}

module.exports = { Db, getDb, closeDb, configFromEnv, loadEnv };
