'use strict';
const H = require('./_harness.js');
const { FakeDb } = require('./fakes/fake_db.js');
const { MetadataRepository } = require('../server/metadata_repository.js');

module.exports = async function run() {
  H.suite('repo_atomicity — a crash mid-sequence leaves nothing behind');

  // createRequest writes requests + request_history + audit_ledger.
  // Fail on the 2nd query (the history insert) and prove NOTHING survives.
  const db = new FakeDb();
  const repo = new MetadataRepository(db);
  db.failOnQuery = 2;

  await H.throwsAsync('an induced failure propagates',
    () => repo.createRequest({ requestId:'R1', subject:'x' }), 'induced failure');

  H.eq('no orphaned requests row',        db.rowCount('requests'), 0);
  H.eq('no orphaned request_history row', db.rowCount('request_history'), 0);
  H.eq('no orphaned audit_ledger row',    db.rowCount('audit_ledger'), 0);

  // The success path must write all three.
  const db2 = new FakeDb();
  const repo2 = new MetadataRepository(db2);
  await repo2.createRequest({ requestId:'R2', subject:'y' });
  H.eq('success writes the request',  db2.rowCount('requests'), 1);
  H.eq('success writes the history',  db2.rowCount('request_history'), 1);
  H.eq('success writes the audit row', db2.rowCount('audit_ledger'), 1);

  // Same guarantee for received records (record + history + audit).
  const db3 = new FakeDb();
  const repo3 = new MetadataRepository(db3);
  db3.failOnQuery = 3;
  await H.throwsAsync('received-record failure propagates',
    () => repo3.addReceivedRecord({ id:'RR1', requestId:'R1' }), 'induced failure');
  H.eq('no orphaned received_records row', db3.rowCount('received_records'), 0);
  H.eq('no orphaned upload_review_history row', db3.rowCount('upload_review_history'), 0);

  // Validation must reject BEFORE any write.
  const db4 = new FakeDb();
  const repo4 = new MetadataRepository(db4);
  await H.throwsAsync('absolute path is refused', () => repo4.addReceivedRecord({
    id:'RR2', requestId:'R1', recommendedFileFolder:'/Users/someone/leak',
  }), 'relative path');
  H.eq('a refused write touches nothing', db4.rowCount('received_records'), 0);

  await H.throwsAsync('an unknown status is refused',
    () => repo4.createRequest({ requestId:'R3', status:'not_a_status' }), 'unknown status');
  H.eq('a refused status touches nothing', db4.rowCount('requests'), 0);
};
