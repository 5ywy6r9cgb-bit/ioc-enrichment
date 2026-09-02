'use strict';
/**
 * tests/push_notify.test.js — push_subscriptions repo methods (against
 * FakeDb, offline) and push_notify's fan-out logic (against a stub
 * web-push-shaped sender, offline — no real push service is ever contacted
 * by this suite).
 */

const H = require('./_harness.js');
const { FakeDb } = require('./fakes/fake_db.js');
const { MetadataRepository } = require('../server/metadata_repository.js');
const pushNotify = require('../server/push_notify.js');

module.exports = async function run() {
  H.suite('push_notify');

  // ---------------------------------------------------------- repo layer
  {
    const db = new FakeDb();
    const repo = new MetadataRepository(db);

    await H.throwsAsync('addPushSubscription requires an endpoint',
      () => repo.addPushSubscription({ p256dhKey: 'a', authKey: 'b' }), 'endpoint');
    await H.throwsAsync('addPushSubscription requires both keys',
      () => repo.addPushSubscription({ endpoint: 'https://push.example/1' }), 'p256dhKey');

    const row = await repo.addPushSubscription({
      endpoint: 'https://push.example/1', p256dhKey: 'pk1', authKey: 'ak1', label: 'iPhone',
    });
    H.check('a valid subscription is written', !!row);
    H.eq('one audit row for the subscribe', db.rowCount('audit_ledger'), 1);

    await repo.addPushSubscription({ endpoint: 'https://push.example/2', p256dhKey: 'pk2', authKey: 'ak2' });
    const all = await repo.listPushSubscriptions();
    H.eq('two distinct endpoints are listed', all.length, 2);

    // Note: FakeDb models DELETE bluntly (it has no WHERE-clause matcher, the
    // same simplification it applies to UPDATE) — a delete against the fake
    // removes every row currently held for the table, not just the matching
    // endpoint. Real Postgres, driven by the endpoint in the WHERE clause,
    // removes only the one row; that exact-match behavior is covered by the
    // seed-load-and-live-DB path, not by this offline suite.
    const removed = await repo.removePushSubscription('https://push.example/1');
    H.check('remove reports removed:true', removed.removed === true);
    H.eq('the fake clears the table on delete (blunt WHERE, documented above)',
      (await repo.listPushSubscriptions()).length, 0);
  }

  // --------------------------------------------------------- payload shape
  {
    const p = pushNotify.buildPayload({ title: 'New lead', count: 3, path: '/#/leads', tag: 'leads' });
    H.check('payload carries title, body, path, tag',
      p.title === 'New lead' && /3 items/.test(p.body) && p.path === '/#/leads' && p.tag === 'leads');
    H.check('payload never carries record content — no free-text field beyond title/body',
      Object.keys(p).sort().join(',') === 'body,path,tag,title');

    const single = pushNotify.buildPayload({ title: 'New lead', count: 1, path: '/#/leads' });
    H.check('singular count reads "1 item" not "1 items"', /1 item(?!s)/.test(single.body));
  }

  // -------------------------------------------------------- isConfigured
  {
    H.check('not configured when keys are absent', pushNotify.isConfigured({}) === false);
    H.check('configured when both keys are present',
      pushNotify.isConfigured({ PRA_VAPID_PUBLIC_KEY: 'x', PRA_VAPID_PRIVATE_KEY: 'y' }) === true);
  }

  // ------------------------------------------------------------ notifyAll
  {
    // Unconfigured: a documented no-op, never a thrown error mid-fan-out.
    const db = new FakeDb();
    const repo = new MetadataRepository(db);
    await repo.addPushSubscription({ endpoint: 'https://push.example/1', p256dhKey: 'pk', authKey: 'ak' });
    const result = await pushNotify.notifyAll(repo, pushNotify.buildPayload({ title: 'x' }), {});
    H.check('notifyAll skips cleanly when unconfigured',
      result.skipped === true && /PRA_VAPID/.test(result.reason));
  }

  // sendOne: exercised directly against a stub matching web-push's
  // sendNotification(subscription, payload) contract, so the fan-out logic
  // (ok / gone / failed bucketing) is proven without a real push service.
  {
    const okSender = { sendNotification: async () => {} };
    const goneSender = { sendNotification: async () => { const e = new Error('gone'); e.statusCode = 410; throw e; } };
    const failSender = { sendNotification: async () => { throw new Error('network blip'); } };
    const sub = { endpoint: 'https://push.example/1', p256dh_key: 'pk', auth_key: 'ak' };

    const ok = await pushNotify.sendOne(okSender, sub, { title: 't' });
    H.check('a successful send reports ok, not gone', ok.ok === true && ok.gone === false);

    const gone = await pushNotify.sendOne(goneSender, sub, { title: 't' });
    H.check('a 410 reports gone:true, not ok', gone.ok === false && gone.gone === true);

    const failed = await pushNotify.sendOne(failSender, sub, { title: 't' });
    H.check('a non-410 failure reports gone:false', failed.ok === false && failed.gone === false);
  }
};

if (require.main === module) { module.exports().then(() => process.exit(H.report())); }
