'use strict';
/**
 * provenance.js — the JavaScript half of the Sentinel OS provenance spine.
 *
 * This is a deliberate twin of provenance.py, not a loose reimplementation.
 * The Node modules (PRA persistence, connectors, ingest) and the Python modules
 * (OpenMontage, atlas-vuln, analysis) both write into the same evidence store,
 * so a record built on either side must hash to the same value. If these two
 * files ever disagree, the two halves of the system can no longer verify each
 * other's chain of custody — so test_provenance.py builds the same record in
 * both languages and compares the hashes.
 *
 * Same rules as the Python side: standard library only, relative paths only,
 * append-only ledger, no network.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 'provenance/1';
const ABS_PATH = /^([A-Za-z]:[\\/]|\/|\\\\)/;

// ---------------------------------------------------------------------------
// Canonical JSON
//
// Must byte-match Python's json.dumps(obj, sort_keys=True, separators=(',',':')).
// Two details that JSON.stringify gets wrong for our purposes:
//   1. it does not sort keys, and Python sorts them at every nesting level
//   2. Python defaults to ensure_ascii=True, escaping every non-ASCII character
// Both are reproduced here.
// ---------------------------------------------------------------------------

function escapeString(s) {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else if (code < 0x7f) out += ch;
    else if (code <= 0xffff) out += '\\u' + code.toString(16).padStart(4, '0');
    else {
      // Python emits a surrogate pair for astral characters.
      const v = code - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += '\\u' + hi.toString(16).padStart(4, '0') +
             '\\u' + lo.toString(16).padStart(4, '0');
    }
  }
  return out + '"';
}

function canonicalJson(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number is not canonical JSON');
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (t === 'string') return escapeString(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => escapeString(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  throw new TypeError('cannot canonicalize ' + t);
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Text(text) {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

function sha256Json(obj) {
  return sha256Text(canonicalJson(obj));
}

/** SHA-256 of a file, streamed so large videos don't blow up memory. */
function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isAbsolute(p) {
  return ABS_PATH.test(p || '');
}

/**
 * Express `p` relative to the evidence root. Refuses to emit an absolute path —
 * an artifact record must be portable and must not leak machine layout.
 */
function relativize(p, evidenceRoot) {
  if (!p) return p;
  if (evidenceRoot) {
    const rel = path.relative(path.resolve(evidenceRoot), path.resolve(p));
    if (rel && !rel.startsWith('..')) return rel;
  }
  if (isAbsolute(p)) return path.basename(p);
  return p;
}

// ---------------------------------------------------------------------------
// Sourcing tiers — must stay identical to provenance.py TIERS
// ---------------------------------------------------------------------------

const TIERS = {
  GREEN: 'primary document/artifact in custody (we hold the file and its hash)',
  ATTRIBUTED: "another party's material, credited to its source",
  SOURCE_NEEDED: 'not verified yet — must not be published or asserted',
  GENERATED: 'produced by this system (a render, a report), traceable to its inputs',
  NA: 'no factual claim attached',
};

function validTier(tier) {
  return Object.prototype.hasOwnProperty.call(TIERS, tier);
}

// ---------------------------------------------------------------------------
// The provenance record
// ---------------------------------------------------------------------------

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build one provenance record. Mirrors make_record() in provenance.py field for
 * field; the camelCase argument names are the only intentional difference.
 *
 * Throws on an invalid tier — a wrong tier is worse than no tier.
 */
function makeRecord(opts) {
  const {
    kind, artifactId, label = '', tool = '', toolVersion = '',
    tier = 'GENERATED', sha256 = null, localPath = null, evidenceRoot = null,
    sourceUrl = null, sourceRef = null, inputs = null, extra = null,
  } = opts || {};

  if (!kind || !artifactId) throw new Error('provenance record requires kind and artifactId');
  if (!validTier(tier)) {
    throw new Error(`unknown sourcing tier ${JSON.stringify(tier)}; valid: ${Object.keys(TIERS).sort().join(', ')}`);
  }

  const rec = {
    schema: SCHEMA_VERSION,
    kind,
    artifact_id: artifactId,
    label: label || '',
    tier,
    recorded_at: utcNow(),
    tool: tool || '',
    tool_version: toolVersion || '',
  };
  if (sha256) rec.sha256 = sha256;
  if (localPath !== null && localPath !== undefined) {
    const rel = relativize(localPath, evidenceRoot);
    if (isAbsolute(rel)) throw new Error(`refusing to record an absolute path: ${localPath}`);
    rec.local_path = rel;
  }
  if (sourceUrl) rec.source_url = sourceUrl;
  if (sourceRef) rec.source_ref = sourceRef;

  const normInputs = [];
  for (const i of inputs || []) {
    const item = {};
    for (const [k, v] of Object.entries(i)) {
      if (v !== null && v !== undefined) item[k] = v;
    }
    if ('path' in item) item.path = relativize(item.path, evidenceRoot);
    normInputs.push(item);
  }
  if (normInputs.length) rec.inputs = normInputs;

  if (extra) rec.extra = extra;

  rec.record_sha256 = sha256Json({ ...rec });
  return rec;
}

// ---------------------------------------------------------------------------
// The append-only ledger
// ---------------------------------------------------------------------------

class Ledger {
  constructor(ledgerPath) {
    this.path = ledgerPath;
    fs.mkdirSync(path.dirname(path.resolve(ledgerPath)), { recursive: true });
  }

  append(record) {
    if (!record || !record.record_sha256) throw new Error('record must be built with makeRecord()');
    fs.appendFileSync(this.path, canonicalJson(record) + '\n', 'utf8');
    return record;
  }

  readAll() {
    if (!fs.existsSync(this.path)) return [];
    return fs.readFileSync(this.path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  /** Recompute every line's record_sha256 and report lines edited after writing. */
  verify() {
    const rows = this.readAll();
    const tampered = [];
    rows.forEach((row, idx) => {
      const claimed = row.record_sha256;
      const body = { ...row };
      delete body.record_sha256;
      if (claimed !== sha256Json(body)) {
        tampered.push({ line: idx + 1, artifact_id: row.artifact_id });
      }
    });
    return { total: rows.length, tampered, ok: tampered.length === 0 };
  }
}

module.exports = {
  SCHEMA_VERSION, TIERS,
  canonicalJson, sha256Bytes, sha256Text, sha256Json, sha256File,
  isAbsolute, relativize, validTier, utcNow, makeRecord, Ledger,
};
