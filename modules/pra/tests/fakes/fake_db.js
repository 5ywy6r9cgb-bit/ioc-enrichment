'use strict';
/**
 * tests/fakes/fake_db.js — an in-memory stand-in for Db.
 *
 * It exists to prove ATOMICITY without a database: you can tell it to fail on
 * the Nth query, then assert that nothing from that transaction survived. A
 * real Postgres would also prove this, but then the suite would need a running
 * server, and a test you cannot run is a test you stop running.
 *
 * It deliberately mimics the ONE property that matters here: withTransaction
 * buffers writes and discards them on throw.
 */

class FakeDb {
  constructor() {
    this.tables = new Map();     // committed state
    this.queries = [];           // every SQL string seen
    this.failOnQuery = null;     // 1-based index that should throw
    this._depth = 0;
    this._staged = null;
  }

  _target() { return this._depth > 0 ? this._staged : this.tables; }

  _rowsFor(table, store) {
    if (!store.has(table)) store.set(table, []);
    return store.get(table);
  }

  async query(text, params = []) {
    this.queries.push(text);
    if (this.failOnQuery !== null && this.queries.length === this.failOnQuery) {
      throw new Error(`fake_db: induced failure on query #${this.failOnQuery}`);
    }
    const m = /insert\s+into\s+([a-z_]+)/i.exec(text);
    if (m) {
      const row = { _sql: text, params };
      this._rowsFor(m[1], this._target()).push(row);
      return { rows: [Object.assign({}, row, { audit_id: 1, followup_id: 1 })], rowCount: 1 };
    }

    // UPDATE must be modelled, not ignored. Repository methods branch on
    // rowCount to decide whether the target existed — a fake that always
    // reports 0 makes every update look like a missing row, which produced a
    // failure that looked like a code bug and was not.
    const u = /update\s+([a-z_]+)/i.exec(text);
    if (u) {
      const table = u[1];
      // Rows may be staged in the open transaction as well as committed.
      const committed = this._rowsFor(table, this.tables);
      const staged = this._depth > 0 ? this._rowsFor(table, this._staged) : [];
      const all = committed.concat(staged);
      if (!all.length) return { rows: [], rowCount: 0 };
      const target = all[all.length - 1];
      Object.assign(target, { _updated: (target._updated || 0) + 1, _lastUpdateSql: text });
      return { rows: [target], rowCount: 1 };
    }

    const s = /select[\s\S]*?from\s+([a-z_]+)/i.exec(text);
    if (s) {
      const committed = this._rowsFor(s[1], this.tables);
      const staged = this._depth > 0 ? this._rowsFor(s[1], this._staged) : [];
      const all = committed.concat(staged);
      return { rows: all, rowCount: all.length };
    }
    return { rows: [], rowCount: 0 };
  }

  /** Buffers into _staged; merges on success, discards on throw. */
  async withTransaction(fn) {
    this._depth += 1;
    if (this._depth === 1) this._staged = new Map();
    const client = { query: (t, p) => this.query(t, p) };
    try {
      const out = await fn(client);
      if (this._depth === 1) {
        for (const [table, rows] of this._staged) {
          this._rowsFor(table, this.tables).push(...rows);
        }
        this._staged = null;
      }
      return out;
    } catch (e) {
      if (this._depth === 1) this._staged = null;   // discard: the rollback
      throw e;
    } finally {
      this._depth -= 1;
    }
  }

  rowCount(table) { return (this.tables.get(table) || []).length; }
  async isAvailable() { return true; }
  async close() {}
}

module.exports = { FakeDb };
