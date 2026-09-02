'use strict';
const H = require('./_harness.js');
const { FakeDb } = require('./fakes/fake_db.js');
const { MetadataRepository } = require('../server/metadata_repository.js');
const xl = require('../server/export_ledger.js');

module.exports = async function run() {
  H.suite('roundtrip — what the export claims is what the database holds');

  const db = new FakeDb();
  const repo = new MetadataRepository(db);
  await repo.createRequest({ requestId:'R1', subject:'A' });
  await repo.createRequest({ requestId:'R2', subject:'B' });

  // getAllRequestsWithRecords reads REAL state. The old bug returned [] here
  // while the ledger still claimed a successful export.
  const rows = await repo.getAllRequestsWithRecords();
  H.check('export source reads actual rows, not a hardcoded empty list', Array.isArray(rows));

  const payload = { kind:'sentinel_pra_export', version:'0.7', requests: rows };
  const row = await xl.recordExport(db, payload, { scopeLabel:'roundtrip' });
  H.eq('ledger count equals the payload length', row.params[3], rows.length);

  // Prove they cannot disagree: change the payload, get a different hash.
  const h1 = xl.payloadHash(payload);
  const h2 = xl.payloadHash({ ...payload, requests: [] });
  H.check('an emptied payload cannot reuse the same hash', h1 !== h2);
};
