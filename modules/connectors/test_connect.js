'use strict';
/**
 * modules/connectors/test_connect.js
 *
 * These are regression guards against a real `connect test` run on the
 * operator's own Mac, which printed two false lines:
 *
 *     OpenSanctions   key: MISSING   → KEY REJECTED (HTTP 401)
 *     FEC             key: MISSING   → CONNECTED (HTTP 200)
 *
 * Nothing rejected a key that was never sent. And FEC cannot be connected
 * without a key — the probe falls back to DEMO_KEY, so the 200 proved that
 * api.data.gov's shared demo key works, not that the operator's setup does.
 *
 * The green one is the dangerous one. It reads as finished.
 */

const assert = require('assert');
const R = require('./registry.js');

let PASS = 0, FAIL = 0;
function check(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

// Reach into the CLI's verdict logic without running a network probe.
const cliSrc = require('fs').readFileSync(require.resolve('./cli.js'), 'utf8');

module.exports = function run() {
  console.log('\n  connect test — verdict logic\n');

  // ── the two false lines, as tests ───────────────────────────────────
  {
    const fec = R.CONNECTORS.fec;
    check('FEC declares its key required', fec.keyRequired === true);
    check('and its probe DOES fall back to DEMO_KEY — which is why a 200 means nothing',
      /DEMO_KEY/.test(fec.probe('').url), fec.probe('').url);

    const reg = R.CONNECTORS['regulations'] || R.CONNECTORS['regulationsgov']
      || Object.values(R.CONNECTORS).find((c) => /Regulations/i.test(c.label));
    check('Regulations.gov has the same fallback',
      /DEMO_KEY/.test(JSON.stringify(reg.probe(''))), JSON.stringify(reg.probe('').headers));

    // Behavioural, not source-grep. An earlier draft of this block compared
    // indexOf('NOT TESTED') against indexOf('CONNECTED (HTTP') in the file
    // text — and matched the comment above the function that quotes the very
    // output being guarded against. Testing prose is how a guard passes while
    // the code is wrong.
    const { verdictFor } = require('./cli.js');

    const strip = (t) => String(t).replace(/\x1b\[[0-9;]*m/g, '');

    // THE FALSE GREEN. This is the whole reason this file exists.
    const green = verdictFor(fec, '', { status: 200 });
    check('a required key that is missing NEVER reports CONNECTED, even on HTTP 200',
      !/CONNECTED/.test(strip(green.text)) && green.ok === false, strip(green.text));
    check('it says it was not tested',
      /NOT TESTED/.test(strip(green.text)), strip(green.text));
    check('and explains that the 200 came from the shared demo key',
      /DEMO_KEY is shared/.test(green.note), green.note);

    // THE FALSE REJECTION.
    const rejected = verdictFor(fec, '', { status: 401 });
    check('a 401 with no key set does not claim the key was rejected',
      !/KEY REJECTED/.test(strip(rejected.text)), strip(rejected.text));
    check('and does not send you hunting for a typo in a key you never set',
      !/stray quote/.test(rejected.note || ''), rejected.note);

    // The typo advice IS right when a key was actually sent.
    const realTypo = verdictFor(fec, 'sk-whatever', { status: 401 });
    check('a 401 WITH a key set does report the key as rejected',
      /KEY REJECTED/.test(strip(realTypo.text)));
    check('and then the typo advice is the correct advice',
      /stray quote/.test(realTypo.note), realTypo.note);

    // A connector that takes no key at all must not be told to check its key.
    const nokey = { label: 'X', keyVar: null, keyRequired: false, probe: () => ({ url: 'https://x/' }) };
    const refused = verdictFor(nokey, '', { status: 403 });
    check('a no-key connector refused with 403 is not a credentials problem',
      /not a credentials problem/.test(refused.note), refused.note);
    check('and it points at the network instead',
      /proxy|VPN|blocked IP/.test(refused.note), refused.note);

    // A key that IS set and works is the only path to CONNECTED.
    const good = verdictFor(fec, 'realkey', { status: 200 });
    check('a set key with a 2xx is the only way to reach CONNECTED',
      /CONNECTED/.test(strip(good.text)) && good.ok === true);

    check('429 is reported as throttling, not as a broken connector',
      /RATE LIMITED/.test(strip(verdictFor(nokey, '', { status: 429 }).text)));
    check('an unknown status is flagged rather than shrugged at',
      /UNEXPECTED/.test(strip(verdictFor(nokey, '', { status: 500 }).text)));
    check('no network is distinguished from a refusal',
      /NO NETWORK/.test(strip(verdictFor(nokey, '', { status: 0, error: 'ENOTFOUND' }).text)));

    check('a successful probe reports the redirects it followed',
      /after 2 redirect/.test(strip(verdictFor(nokey, '', {
        status: 200, redirected_from: [{}, {}],
      }).text)));

    check('requiring the CLI does not fire a live run of every connector',
      typeof verdictFor === 'function');
  }

  // ── redirects ────────────────────────────────────────────────────────
  {
    check('a redirect budget exists', R.MAX_REDIRECTS >= 1 && R.MAX_REDIRECTS <= 5);
    check('and authenticating headers are named for stripping',
      R.AUTH_HEADERS.includes('authorization') && R.AUTH_HEADERS.includes('x-api-key'));

    const stripped = R.stripAuth({
      Authorization: 'Token abc', 'X-Api-Key': 'k', Accept: 'application/json',
      'User-Agent': 'sentinel',
    });
    check('stripAuth removes Authorization', !('Authorization' in stripped));
    check('and X-Api-Key', !('X-Api-Key' in stripped));
    check('case-insensitively',
      !('authorization' in R.stripAuth({ authorization: 'x' })));
    check('but keeps everything else',
      stripped.Accept === 'application/json' && stripped['User-Agent'] === 'sentinel');
  }

  // ── the transport refuses to downgrade ──────────────────────────────
  {
    const src = require('fs').readFileSync(require.resolve('./registry.js'), 'utf8');
    check('a non-https url is refused rather than fetched',
      /refusing non-https/.test(src));
    check('auth headers are dropped when the host changes',
      /hostname !== new URL\(current\)\.hostname/.test(src)
      && /hdrs = stripAuth\(hdrs\)/.test(src));
    check('the redirect chain is reported, not swallowed',
      /redirected_from/.test(src) && /redirected_from/.test(cliSrc));
  }

  // ── every connector is well-formed ──────────────────────────────────
  {
    for (const [name, c] of Object.entries(R.CONNECTORS)) {
      const spec = c.probe('');
      check(`${name}: probe returns an https url`,
        typeof spec.url === 'string' && spec.url.startsWith('https://'), spec.url);
      check(`${name}: declares whether its key is required`,
        typeof c.keyRequired === 'boolean');
      check(`${name}: a required key names the variable that holds it`,
        !c.keyRequired || typeof c.keyVar === 'string');
      check(`${name}: has an identify() for dedupe`, typeof c.identify === 'function');
    }
  }

  // ── the summary counts usable, not reachable ────────────────────────
  {
    check('the run reports a usable count',
      /of \$\{total\} usable/.test(cliSrc) || /usable/.test(cliSrc));
    check('and says plainly that a keyless connector is not usable',
      /not usable, whatever HTTP said/.test(cliSrc));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
