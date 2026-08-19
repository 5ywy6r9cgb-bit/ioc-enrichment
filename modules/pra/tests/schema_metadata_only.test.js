'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');

const MIG = path.join(__dirname, '..', 'migrations');
const sql = ['0001_v0_6_1_metadata_schema.sql', '0002_v0_7_master_schema.sql']
  .map((f) => fs.readFileSync(path.join(MIG, f), 'utf8')).join('\n');

module.exports = function run() {
  H.suite('schema — metadata only, and the constraints that enforce it');

  // received_records must have no content-bearing column.
  const rr = /CREATE TABLE received_records\s*\(([\s\S]*?)\n\);/i.exec(sql);
  H.check('received_records table is defined', !!rr);
  if (rr) {
    // Match COLUMN DECLARATIONS, not substrings. An earlier version of this
    // test looked for the bare word "content" and matched the default text
    // 'Content scan not performed.' — a false positive that would have taught
    // us to distrust the suite.
    const columns = rr[1].split('\n')
      .map((l) => l.trim().toLowerCase())
      .map((l) => (/^([a-z_]+)\s+(text|bigint|integer|boolean|timestamptz|bytea|jsonb|numeric)/.exec(l) || [])[1])
      .filter(Boolean);
    for (const forbidden of ['file_bytes', 'content', 'base64', 'ocr_text', 'extracted_text', 'preview', 'thumbnail', 'body'])
      H.check(`received_records has no "${forbidden}" column`, !columns.includes(forbidden));
    H.check('the only content_* columns are scan status/note, which hold no content',
      columns.filter((c) => c.startsWith('content')).every((c) => c === 'content_scan_status' || c === 'content_scan_note'));
    const body = rr[1].toLowerCase();
    H.check('content_scan_status is pinned to not_performed', body.includes("content_scan_status = 'not_performed'"));
    H.check('manual_review_required cannot be turned off', body.includes('manual_review_required = true'));
  }

  // The privacy constraints must exist by name.
  for (const c of [
    'entities_no_private_home_address',
    'portals_no_credentials',
    'sources_relative_path_only',
  ]) H.check(`constraint ${c} exists`, sql.includes(c));

  // The gated text index.
  H.check('document_text_index requires operator_consent = true', /operator_consent\s+boolean[\s\S]*?CHECK \(operator_consent = true\)/i.test(sql));
  H.check('document_text_index requires redaction_confirmed = true', /redaction_confirmed\s+boolean[\s\S]*?CHECK \(redaction_confirmed = true\)/i.test(sql));
  H.check('a trigger re-checks approval on every write', sql.includes('gate_document_text_index'));
  H.check('the gate requires prior human approval', sql.includes("approved_internal','approved_public"));

  // Append-only enforcement.
  H.check('prevent_ledger_mutation exists', sql.includes('prevent_ledger_mutation'));
  for (const t of ['audit_ledger_append_only', 'export_ledger_append_only', 'followups_append_only'])
    H.check(`${t} trigger is created`, sql.includes(t));

  // Exports are pinned to metadata.
  H.check('export_ledger pins exported_metadata_only = true', sql.includes('exported_metadata_only = true'));

  // Transactions.
  H.eq('every migration is wrapped in a transaction',
    (sql.match(/\bBEGIN;/g) || []).length, (sql.match(/\bCOMMIT;/g) || []).length);
};
