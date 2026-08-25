'use strict';
/**
 * server/foia_store.js — where requests live when there is no database.
 *
 * The tracker (foia_tracker.js) reads requests and decides what to do about
 * them. It does not care where they came from. This file is one answer to
 * "where from": a single JSON file on the operator's own disk, edited through
 * the terminal rather than by hand.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A FILE, AND WHY THIS FILE
 *
 * The database is the real home for this data. But a records request is filed
 * from a kitchen table at 11pm, often before Postgres is running and sometimes
 * from a laptop that does not have it at all. A request that does not get
 * recorded because recording it was inconvenient is a request whose clock
 * nobody is watching. So the low-friction path has to exist, and it has to be
 * the same shape the database path produces.
 *
 * DEFAULT LOCATION: <repo>/evidence/foia_requests.json
 *
 * That directory is gitignored, and deliberately. These records name the
 * operator, the agencies he is pressing, and what he is looking for — that is
 * working investigative material, not source code, and it must not reach a
 * remote by accident. Override with PRA_FOIA_STORE if you keep it elsewhere.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS APPEND-ONLY AND WHAT IS NOT
 *
 * Correspondence is append-only. There is no command to edit or delete a
 * logged letter, because the log is the answer to "what did you actually send
 * them, and when" — a question that gets asked adversarially. A mistaken entry
 * is corrected by appending a correction, the same way a ledger is.
 *
 * Request FIELDS do change: a request that was `submitted` becomes `denied`.
 * Every such change appends to `history` with the old value, the new value,
 * and when it happened. The current value is convenient; the history is the
 * evidence. `set()` cannot write a field without recording the change.
 */

const fs = require('fs');
const path = require('path');

class StoreError extends Error {}

const VALID_STATUS = new Set([
  'submitted', 'acknowledged', 'partial', 'fee_quoted',
  'denied', 'closed', 'published', 'withdrawn',
]);

/**
 * Fields the terminal is allowed to set. Anything not on this list has to go
 * through code, which is a deliberate speed bump: `delivery_method` decides
 * whether damages can ever accrue, and `mandamus_filed_on` decides whether the
 * question is live at all. Neither should be settable by a typo.
 */
const SETTABLE = new Set([
  'status', 'agency_name', 'description', 'submitted_on', 'delivery_method',
  'jurisdiction_scope', 'denial_basis', 'fee_quoted_usd', 'mandamus_filed_on',
  'agency_stated_due_on', 'requester', 'account_track', 'contact',
]);

function defaultPath() {
  if (process.env.PRA_FOIA_STORE) return process.env.PRA_FOIA_STORE;
  // modules/pra/server/ -> repo root
  return path.resolve(__dirname, '..', '..', '..', 'evidence', 'foia_requests.json');
}

function nowIso() { return new Date().toISOString(); }

function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

class FoiaStore {
  constructor(file) {
    this.file = file || defaultPath();
  }

  /** Read the store. A missing file is an empty store, not an error — the
   *  first `add` should work on a machine that has never run this before. */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, requests: [] };
      throw new StoreError(`cannot read ${this.file}: ${e.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Never silently reset a store we failed to parse. That file is the
      // only copy of when things were filed.
      throw new StoreError(
        `${this.file} is not valid JSON (${e.message}). It has NOT been `
        + `modified. Fix or move it before running this again.`);
    }
    // Accept the bare-array shape the superseded foia_requests.json used.
    if (Array.isArray(parsed)) return { version: 1, requests: parsed };
    if (!Array.isArray(parsed.requests)) {
      throw new StoreError(`${this.file} has no "requests" array.`);
    }
    return parsed;
  }

  /** Write via a temp file and rename. A half-written store is worse than no
   *  store, and an interrupted save is exactly how you get one. */
  save(data) {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.file;
  }

  list() { return this.load().requests; }

  find(id) {
    const r = this.load().requests.find((x) => (x.request_id || x.id) === id);
    return r || null;
  }

  /** Add a request. Refuses a duplicate id rather than merging into it —
   *  two requests to two agencies sharing an id is a filing error, and
   *  quietly overwriting one of them loses a clock. */
  add(fields) {
    const data = this.load();
    const id = fields.request_id;
    if (!id) throw new StoreError('request_id is required');
    if (data.requests.some((x) => (x.request_id || x.id) === id)) {
      throw new StoreError(`${id} already exists — pick another id, or use `
        + `\`foia set ${id} <field> <value>\` to update it.`);
    }
    if (!fields.agency_name) throw new StoreError('agency_name is required');
    if (fields.submitted_on && !isDate(fields.submitted_on)) {
      throw new StoreError('submitted_on must be YYYY-MM-DD');
    }
    if (fields.status && !VALID_STATUS.has(fields.status)) {
      throw new StoreError(`unknown status '${fields.status}' — one of: `
        + [...VALID_STATUS].join(', '));
    }

    const rec = Object.assign({
      status: 'submitted',
      jurisdiction_scope: 'OH',
      correspondence: [],
      history: [],
    }, fields, { created_at: nowIso() });

    data.requests.push(rec);
    this.save(data);
    return rec;
  }

  /**
   * Set one field, recording the change. Returns {record, change}.
   * A no-op set is reported as such rather than appending a history entry
   * that says nothing happened.
   */
  set(id, field, value) {
    if (!SETTABLE.has(field)) {
      throw new StoreError(`'${field}' is not settable from the terminal. `
        + `Settable: ${[...SETTABLE].sort().join(', ')}`);
    }
    if (field === 'status' && !VALID_STATUS.has(value)) {
      throw new StoreError(`unknown status '${value}' — one of: `
        + [...VALID_STATUS].join(', '));
    }
    if (/_on$/.test(field) && value !== null && !isDate(value)) {
      throw new StoreError(`${field} must be YYYY-MM-DD`);
    }
    if (field === 'delivery_method'
        && !['hand_delivery', 'certified_mail', 'electronic', 'web_form',
             'phone', 'in_person', 'mail'].includes(value)) {
      throw new StoreError(
        `unknown delivery_method '${value}'. Only hand_delivery, `
        + `certified_mail, and electronic satisfy the R.C. 149.43(C)(2) `
        + `transmission predicate; web_form, phone, in_person, and mail are `
        + `recordable but do not.`);
    }
    if (field === 'fee_quoted_usd') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new StoreError('fee must be a number');
      value = n;
    }

    const data = this.load();
    const rec = data.requests.find((x) => (x.request_id || x.id) === id);
    if (!rec) throw new StoreError(`no request with id ${id}`);

    const before = rec[field] === undefined ? null : rec[field];
    if (before === value) return { record: rec, change: null };

    rec[field] = value;
    rec.history = rec.history || [];
    const change = { field, from: before, to: value, at: nowIso() };
    rec.history.push(change);

    this.save(data);
    return { record: rec, change };
  }

  /**
   * Append a piece of correspondence. This is what the dedupe logic in the
   * tracker reads — an outbound letter logged here is what stops it proposing
   * the same letter again tomorrow. Logging is therefore not bookkeeping; it
   * is how you tell the system you actually sent the thing.
   */
  logCorrespondence(id, entry) {
    if (!['inbound', 'outbound'].includes(entry.direction)) {
      throw new StoreError("direction must be 'inbound' or 'outbound'");
    }
    const occurred = entry.occurred_at || new Date().toISOString().slice(0, 10);
    if (!isDate(occurred)) throw new StoreError('date must be YYYY-MM-DD');

    const data = this.load();
    const rec = data.requests.find((x) => (x.request_id || x.id) === id);
    if (!rec) throw new StoreError(`no request with id ${id}`);

    rec.correspondence = rec.correspondence || [];
    const row = {
      direction: entry.direction,
      occurred_at: occurred,
      channel: entry.channel || null,
      note: entry.note || null,
      logged_at: nowIso(),
    };
    rec.correspondence.push(row);
    this.save(data);
    return row;
  }
}

module.exports = { FoiaStore, StoreError, VALID_STATUS, SETTABLE, defaultPath };
