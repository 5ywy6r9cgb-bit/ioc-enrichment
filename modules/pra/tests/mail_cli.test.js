'use strict';
/**
 * tests/mail_cli.test.js — the commands a person actually types.
 *
 * The outbox suites prove the states are right. This one proves the operator
 * can SEE them and ACT on them from the terminal: that an unresolved send is
 * shown as unresolved rather than dimmed into "skipped", and that the only
 * way out of it — reconcile — is a command that exists.
 *
 * Runs scripts/mail.js as a child process against a throwaway outbox. No
 * network, no mail library, no database.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./_harness.js');
const { Outbox } = require('../server/outbox.js');

const CLI = path.resolve(__dirname, '..', 'scripts', 'mail.js');
const LETTER = 'To whom it may concern,\n\nThis is a request for records under '
  + 'R.C. 149.43. Please acknowledge receipt at your earliest convenience.\n\nThank you,';

// Strip colour so assertions read the words, not the escape codes.
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcli-'));
  return new Outbox(path.join(dir, 'outbox.json'));
}

function run(ob, args, extraEnv = {}) {
  const env = Object.assign({}, process.env, {
    PRA_OUTBOX: ob.file,
    // Never let a real .env on the machine running the tests configure a
    // real mailbox for a test.
    PRA_MAIL_ADDRESS: '', PRA_MAIL_PASSWORD: '', PRA_SMTP_HOST: '', PRA_IMAP_HOST: '',
  }, extraEnv);
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: plain(r.stdout) + plain(r.stderr) };
}

function approved(ob, over = {}) {
  const m = ob.queue(Object.assign({ request_id: 'OH-2026-0001', to: 'records@agency.oh.gov',
    subject: 'Public records request', body: LETTER }, over));
  ob.approve(m.message_id, 'Mark');
  return ob.get(m.message_id);
}

module.exports = function run_() {
  H.suite('mail CLI — what the operator sees, and the command that resolves it');

  // ══ nothing open ═══════════════════════════════════════════════════════
  {
    const ob = fresh();
    const r = run(ob, ['unresolved']);
    H.eq('with nothing open, `unresolved` exits 0', r.code, 0);
    H.check('and says so', /Nothing unresolved/.test(r.out), r.out);
  }

  // ══ an unknown outcome is shown, loudly, first ═════════════════════════
  {
    const ob = fresh();
    const m = approved(ob);
    ob.claim(m.message_id);
    ob.markUnknown(m.message_id, 'the connection reset after DATA');

    const u = run(ob, ['unresolved']);
    H.eq('`unresolved` exits non-zero so a morning check can notice', u.code, 1);
    H.check('it names the message', u.out.includes(m.message_id));
    H.check('and why the outcome is unknown', /connection reset after DATA/.test(u.out));
    H.check('and gives the exact reconcile command',
      u.out.includes(`mail reconcile ${m.message_id} sent`), u.out);

    const rv = run(ob, ['review']);
    H.check('`review` shows it even with nothing else waiting', rv.out.includes(m.message_id), rv.out);
    H.check('under OUTCOME UNKNOWN', /OUTCOME UNKNOWN/.test(rv.out));

    const lg = run(ob, ['log']);
    H.check('`log` shows the state as UNKNOWN', /UNKNOWN\s+MSG-/.test(lg.out), lg.out);
    H.check('with the reason beneath it', /connection reset after DATA/.test(lg.out));
  }

  // ══ send, with nothing approved, still surfaces the open one ═══════════
  {
    const ob = fresh();
    const m = approved(ob);
    ob.claim(m.message_id);
    ob.markUnknown(m.message_id, 'timed out');
    const s = run(ob, ['send', '--dry-run']);
    H.check('`send` with nothing approved still shows the unresolved message',
      s.out.includes(m.message_id) && /OUTCOME UNKNOWN/.test(s.out), s.out);
  }

  // ══ a stranded claim is resolved even when nothing else is approved ════
  {
    const ob = fresh();
    const m = approved(ob);
    ob.claim(m.message_id);           // a run died here
    // Configured, but nodemailer is not installed in the test environment —
    // which is exactly the case where the sweep used to be skipped.
    run(ob, ['send'], {
      PRA_MAIL_ADDRESS: 'records@example.org', PRA_MAIL_PASSWORD: 'x',
      PRA_SMTP_HOST: '127.0.0.1', PRA_IMAP_HOST: '127.0.0.1',
    });
    H.eq('a stranded in_flight message becomes unknown on the next send, '
      + 'even with no mail library installed', ob.get(m.message_id).state, 'unknown');
  }

  // ══ reconcile — the only way out ═══════════════════════════════════════
  {
    const ob = fresh();
    const m = approved(ob);
    ob.claim(m.message_id);
    ob.markUnknown(m.message_id, 'timed out');

    const bad = run(ob, ['reconcile', m.message_id, 'sent']);
    H.eq('reconcile without a basis is refused', bad.code, 2);
    H.check('with the usage line', /usage: mail reconcile/.test(bad.out), bad.out);
    H.eq('and nothing changed', ob.get(m.message_id).state, 'unknown');

    const wrong = run(ob, ['reconcile', m.message_id, 'probably', 'I think it went']);
    H.eq('an outcome other than sent|failed is refused', wrong.code, 2);

    const tokenBasis = run(ob, ['reconcile', m.message_id, 'sent', 'ok']);
    H.eq('a token basis is refused by the outbox itself', tokenBasis.code, 2);
    H.check('and the refusal explains what a basis is', /requires a basis/.test(tokenBasis.out),
      tokenBasis.out);

    const good = run(ob, ['reconcile', m.message_id, 'sent',
      'sent folder of records@ shows it at 14:02, no bounce']);
    H.eq('with a real basis it succeeds', good.code, 0);
    H.eq('the message is now sent', ob.get(m.message_id).state, 'sent');
    H.check('the basis is on the record', /14:02, no bounce/.test(ob.get(m.message_id).reconciled_basis));
    H.check('and the command says how to log it against the request',
      good.out.includes(`foia sent ${m.request_id}`), good.out);

    const after = run(ob, ['unresolved']);
    H.eq('afterwards nothing is unresolved', after.code, 0);
  }

  {
    const ob = fresh();
    const m = approved(ob);
    ob.claim(m.message_id);
    ob.markUnknown(m.message_id, 'timed out');
    const f = run(ob, ['reconcile', m.message_id, 'failed',
      'not in the sent folder; clerk confirmed by phone nothing arrived']);
    H.eq('reconciling to failed works too', ob.get(m.message_id).state, 'failed');
    H.check('and says a new letter may now be queued', /may now be queued/.test(f.out), f.out);
  }

  {
    const ob = fresh();
    const r = run(ob, ['frobnicate']);
    H.check('the unknown-command message lists reconcile and unresolved',
      /unresolved reconcile/.test(r.out), r.out);
  }
};
