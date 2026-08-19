'use strict';
const H = require('./_harness.js');
const { FakeDb } = require('./fakes/fake_db.js');
const { MetadataRepository, REVIEW_STATUSES } = require('../server/metadata_repository.js');

module.exports = async function run() {
  H.suite('upload review — every status change leaves a trail');

  const db = new FakeDb();
  const repo = new MetadataRepository(db);

  await repo.addReceivedRecord({ id:'RR1', requestId:'R1', originalFilename:'scan.pdf', fileSizeBytes: 2048 });
  H.eq('registering writes one history row', db.rowCount('upload_review_history'), 1);
  H.eq('registering writes one audit row', db.rowCount('audit_ledger'), 1);

  await H.throwsAsync('an unknown review status is refused',
    () => repo.setReviewStatus('RR1', 'totally_approved'), 'unknown review status');

  H.check('the approved statuses the text-index gate requires both exist',
    REVIEW_STATUSES.includes('approved_internal') && REVIEW_STATUSES.includes('approved_public'));
  H.check('rejected_private_data is an available terminal state',
    REVIEW_STATUSES.includes('rejected_private_data'));

  // Size display is derived, never trusted from input.
  const db2 = new FakeDb();
  const repo2 = new MetadataRepository(db2);
  await repo2.addReceivedRecord({ id:'RR2', requestId:'R1', fileSizeBytes: 5 * 1048576 });
  const params = db2.tables.get('received_records')[0].params;
  H.check('file_size_display is computed from bytes', params.includes('5.0 MB'));

  // The original filename is evidence-chain metadata; rename touches only the display name.
  const db3 = new FakeDb();
  const repo3 = new MetadataRepository(db3);
  await repo3.addReceivedRecord({ id:'RR1', requestId:'R1', originalFilename:'original.pdf' });
  await repo3.renameDisplayName('RR1', 'Clean name');
  const sql = db3.queries.find((q) => /UPDATE received_records/i.test(q));
  H.check('rename updates safe_display_name only', /safe_display_name/.test(sql) && !/original_filename/.test(sql));
  H.check('rename writes no __RECOMPUTE__ placeholder', !db3.queries.some((q) => q.includes('__RECOMPUTE__')));
};
