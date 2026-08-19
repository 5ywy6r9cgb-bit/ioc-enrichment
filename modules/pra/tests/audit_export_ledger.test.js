'use strict';
const H = require('./_harness.js');
const { FakeDb } = require('./fakes/fake_db.js');
const audit = require('../server/audit_ledger.js');
const xl = require('../server/export_ledger.js');

module.exports = async function run() {
  H.suite('ledgers — append-only, and honest about what was exported');

  const db = new FakeDb();
  await audit.record(db, { entityType:'request', entityId:'R1', action:'create', detail:{ a:1 } });
  H.eq('audit row written', db.rowCount('audit_ledger'), 1);
  await H.throwsAsync('audit requires entityType and action', () => audit.record(db, { entityId:'x' }), 'required');

  // The module must expose no way to rewrite history.
  H.check('audit_ledger exposes no update function', typeof audit.update === 'undefined');
  H.check('audit_ledger exposes no delete function', typeof audit.remove === 'undefined' && typeof audit.delete === 'undefined');

  // --- the export honesty fix ---
  const db2 = new FakeDb();
  const payload = { kind:'sentinel_pra_export', requests:[{ request_id:'A' }, { request_id:'B' }] };
  const row = await xl.recordExport(db2, payload, { scopeLabel:'test' });
  H.eq('record_count is derived from the payload, not supplied', row.params[3], 2);
  H.check('a hash of the real bytes is stored', typeof row.params[4] === 'string' && row.params[4].length === 64);

  // Same payload hashes the same; different payload does not.
  H.eq('hash is stable for equal payloads', xl.payloadHash(payload), xl.payloadHash({ kind:'sentinel_pra_export', requests:[{request_id:'A'},{request_id:'B'}] }));
  H.check('hash changes when the payload changes', xl.payloadHash(payload) !== xl.payloadHash({ ...payload, requests:[] }));

  // An export cannot be recorded without the bytes it describes.
  await H.throwsAsync('refuses to ledger an export with no payload', () => xl.recordExport(db2, null), 'payload object is required');

  // An export carrying file content is refused outright.
  await H.throwsAsync('refuses a payload containing file bytes',
    () => xl.recordExport(db2, { requests:[{ records:[{ file_bytes:'deadbeef' }] }] }), 'file content');
  await H.throwsAsync('refuses a payload containing extracted text',
    () => xl.recordExport(db2, { requests:[{ records:[{ ocr_text:'scanned words' }] }] }), 'file content');
  H.check('a metadata-only payload passes the check',
    (() => { try { xl.assertMetadataOnly({ requests:[{ records:[{ sha256:'abc', file_type:'pdf' }] }] }); return true; } catch { return false; } })());

  await H.throwsAsync('refuses an absolute recommended folder',
    () => xl.recordExport(db2, payload, { recommendedFolder:'/Users/x/Exports' }), 'relative');
};
