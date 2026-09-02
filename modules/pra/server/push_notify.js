'use strict';
/**
 * server/push_notify.js — the doorbell, not the delivery.
 *
 * A notification is content-minimal by design: a title, a short body, and a
 * path to open in the desk. It never carries a record's contents, an
 * agency's private-data findings, or anything that would turn "you have new
 * activity" into a leak if the phone's lock-screen preview is glanced at by
 * someone else. Same rule modules/watch/notify.js already enforces for the
 * desktop watcher; this is the phone-facing twin.
 *
 * REQUIRES (both set, or every call is a documented no-op):
 *   PRA_VAPID_PUBLIC_KEY, PRA_VAPID_PRIVATE_KEY — generate once with:
 *     npx web-push generate-vapid-keys
 *   PRA_VAPID_CONTACT — an mailto: the push services can reach you at if
 *     something's wrong with your usage. Required by the Web Push protocol.
 */

let webpush = null;
function loadWebPush() {
  if (webpush) return webpush;
  try {
    webpush = require('web-push');
  } catch {
    throw new Error('push_notify: the web-push package is not installed. Run: cd modules/pra && npm install');
  }
  return webpush;
}

function isConfigured(env = process.env) {
  return Boolean(env.PRA_VAPID_PUBLIC_KEY && env.PRA_VAPID_PRIVATE_KEY);
}

function configure(env = process.env) {
  const wp = loadWebPush();
  wp.setVapidDetails(
    env.PRA_VAPID_CONTACT || 'mailto:operator@example.invalid',
    env.PRA_VAPID_PUBLIC_KEY,
    env.PRA_VAPID_PRIVATE_KEY
  );
  return wp;
}

/**
 * Send one notification to one subscription row.
 * Returns { ok, gone, error } — never throws, so a fan-out over many
 * subscriptions can't be aborted by one dead device.
 */
async function sendOne(wp, subscription, payload) {
  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh_key, auth: subscription.auth_key },
  };
  try {
    await wp.sendNotification(pushSubscription, JSON.stringify(payload));
    return { ok: true, gone: false };
  } catch (err) {
    const gone = err.statusCode === 404 || err.statusCode === 410;
    return { ok: false, gone, error: err.message };
  }
}

/**
 * Fan out one notification to every registered device.
 *
 * @param {object} repo    a MetadataRepository (for list + outcome bookkeeping)
 * @param {object} payload { title, body, path, tag } — path is a desk route
 *                         like '/#/requests/REQ-123', never a raw record.
 */
async function notifyAll(repo, payload, env = process.env) {
  if (!isConfigured(env)) {
    return { sent: 0, failed: 0, removed: 0, skipped: true, reason: 'PRA_VAPID_PUBLIC_KEY/PRIVATE_KEY not set' };
  }
  const wp = configure(env);
  const subs = await repo.listPushSubscriptions();
  let sent = 0, failed = 0, removed = 0;
  for (const sub of subs) {
    const result = await sendOne(wp, sub, payload);
    if (result.ok) {
      sent += 1;
      await repo.recordPushOutcome(sub.endpoint, {});
    } else if (result.gone) {
      removed += 1;
      await repo.recordPushOutcome(sub.endpoint, { gone: true });
    } else {
      failed += 1;
      await repo.recordPushOutcome(sub.endpoint, { failed: true });
    }
  }
  return { sent, failed, removed, skipped: false };
}

/** Build the doorbell payload the desk's push events call for. Counts and a route, nothing else. */
function buildPayload({ title, count = null, path = '/', tag = 'sentinel' }) {
  const body = count == null ? 'Open the desk for details.' : `${count} item${count === 1 ? '' : 's'} — open the desk for details.`;
  return { title, body, path, tag };
}

module.exports = { isConfigured, configure, sendOne, notifyAll, buildPayload };
