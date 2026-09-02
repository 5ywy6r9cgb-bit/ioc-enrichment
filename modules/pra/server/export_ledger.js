'use strict';
/**
 * server/export_ledger.js — append-only record of every export.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * A ledger row must describe an export that actually happened. An earlier build
 * of this system had an /export endpoint that always returned `{requests: []}`
 * regardless of what was in the database — while still writing a ledger row
 * claiming a successful export. A ledger that records an export that did not
 * occur is worse than no ledger at all, because it is evidence of a thing that
 * never happened.
 *
 * So `recordExport` takes the payload it is describing, derives the count and
 * the hash FROM that payload, and refuses to accept a caller-supplied count.
 * The row cannot disagree with the bytes.
 */

const crypto = require('crypto');

const ABSOLUTE_PATH = /^([A-Za-z]:[\\/]|\/|\\\\)/;

/** Stable hash of the exported payload — sorted keys, no incidental whitespace. */
function payloadHash(payload) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Walk an export payload and prove it carries no file bytes or extracted text.
 * The schema forbids storing them; this forbids exporting them.
 */
function assertMetadataOnly(payload) {
  const FORBIDDEN = ['file_bytes', 'base64', 'content', 'data', 'ocr_text', 'extracted_text', 'body_text', 'preview'];
  const found = [];

  (function walk(node, path) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN.includes(k.toLowerCase()) && v !== null && v !== '') {
        found.push(`${path}.${k}`);
      }
      walk(v, `${path}.${k}`);
    }
  }(payload, '$'));

  if (found.length) {
    throw new Error(
      'export_ledger: refusing to record an export containing file content: '
      + found.join(', ')
      + '\n  Exports are METADATA ONLY. Raw files stay in Received_Records/.'
    );
  }
}

/**
 * Record an export.
 *
 * @param {object} exec     Db or pg client
 * @param {object} payload  the exact object being exported
 * @param {object} opts     { scopeLabel, suggestedFilename, recommendedFolder, note, actor }
 */
async function recordExport(exec, payload, opts = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('export_ledger: a payload object is required — the ledger describes real bytes');
  }
  assertMetadataOnly(payload);

  const {
    scopeLabel = null, suggestedFilename = null, recommendedFolder = null,
    note = null, actor = 'local_operator',
  } = opts;

  if (recommendedFolder && ABSOLUTE_PATH.test(recommendedFolder)) {
    throw new Error(`export_ledger: recommendedFolder must be relative, got: ${recommendedFolder}`);
  }

  // Count is DERIVED, never supplied. This is the whole fix.
  const recordCount = Array.isArray(payload.requests) ? payload.requests.length
    : Array.isArray(payload.records) ? payload.records.length
      : Object.keys(payload).length;

  const hash = payloadHash(payload);

  const res = await exec.query(
    `INSERT INTO export_ledger
       (scope_label, suggested_filename, recommended_folder, record_count,
        export_sha256, exported_metadata_only, actor, note)
     VALUES ($1,$2,$3,$4,$5,true,$6,$7)
     RETURNING export_id, exported_at, record_count, export_sha256`,
    [scopeLabel, suggestedFilename, recommendedFolder, recordCount, hash, actor, note]
  );
  return res.rows[0];
}

async function recent(exec, limit = 25) {
  const res = await exec.query(
    'SELECT * FROM export_ledger ORDER BY export_id DESC LIMIT $1', [limit]
  );
  return res.rows;
}

module.exports = { recordExport, recent, payloadHash, assertMetadataOnly };
