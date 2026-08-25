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

    // A well-SHAPED key that the host still refuses. The fixture has to be
    // 40 alphanumerics or the shape check (correctly) catches it first, and
    // this block is about the rejection path, not the shape path.
    const WELL_FORMED = 'a'.repeat(40);
    const realTypo = verdictFor(fec, WELL_FORMED, { status: 401 });
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
    const good = verdictFor(fec, WELL_FORMED, { status: 200 });
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

    // ── the shape check, from the run that motivated it ────────────────
    // FEC_API_KEY  you…0N (63 chars)  → KEY REJECTED (HTTP 403)
    // An api.data.gov key is 40 characters. The length was on screen the
    // whole time and the advice still said "check for a stray quote".
    const pasted = 'your API key is: ' + 'b'.repeat(40) + ' 01';
    const mal = verdictFor(fec, pasted, { status: 403 });
    check('a key of impossible length is caught as MALFORMED, not as rejected',
      /MALFORMED/.test(strip(mal.text)) && !/KEY REJECTED/.test(strip(mal.text)),
      strip(mal.text));
    check('and it states the expected shape and the actual length',
      /40 letters and digits/.test(mal.note) && new RegExp(String(pasted.length)).test(mal.note),
      mal.note);
    check('it spots pasted label text specifically',
      /Your API key is/i.test(mal.note), mal.note);
    check('and it never echoes the key itself',
      !mal.note.includes(pasted) && !mal.note.includes('b'.repeat(40)), mal.note);
    check('a correctly shaped key passes the shape check',
      verdictFor(fec, WELL_FORMED, { status: 200 }).ok === true);
    check('the shape check runs before the network verdict is trusted',
      /MALFORMED/.test(strip(verdictFor(fec, pasted, { status: 200 }).text)),
      'even an HTTP 200 must not override a malformed key');
    check('a connector with no declared shape is not blocked by this',
      R.checkKeyShape('LDA_API_KEY', 'anything-at-all') === null);
    check('an absent key is not reported as malformed',
      R.checkKeyShape('DATA_GOV_API_KEY', '') === null);
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

  // ══ the fan-out ══════════════════════════════════════════════════════
  {
    const cli = require('fs').readFileSync(require.resolve('./cli.js'), 'utf8');

    check('every call is announced before any call is made',
      cli.indexOf('AUTHORIZED RUN') < cli.indexOf('await R.runConnector'),
      'the announce block must precede the loop');
    check('the total number of calls is stated up front',
      /calls\s+\$\{runnable\.length\} \(exactly/.test(cli));
    check('calls are sequential, not parallel',
      !/Promise\.all/.test(cli) && /for \(const name of runnable\)/.test(cli),
      'nine parallel requests is how a free tier revokes a key');
    check('one connector failing does not abort the rest',
      /failures\.push/.test(cli) && /continue;/.test(cli));
    check('a dry run makes no call',
      cli.indexOf('DRY RUN') < cli.indexOf('await R.runConnector'));

    // A connector that cannot answer a name query must not be asked one.
    check('BLS declares it does not take free text',
      R.CONNECTORS.bls.freeText === false);
    check('and the fan-out skips it with a reason',
      /takes an identifier, not a name/.test(cli));
    for (const [name, c] of Object.entries(R.CONNECTORS)) {
      if (name === 'bls') continue;
      check(`${name} accepts a name query`, c.freeText !== false);
    }

    check('the leads boundary is restated on the fan-out too',
      /LEADS, not findings/.test(cli));
  }

  // ══ the dispatcher must reach every verb ═════════════════════════════
  // `all` was added to cli.js and not to bin/sentinel, so the module worked
  // when called directly and `sentinel connect all "X"` reported
  // "unknown connector: all". The dispatcher is the surface an operator
  // actually types; a command that works only when the module is invoked
  // directly is not yet a command.
  {
    const fs2 = require('fs');
    const path2 = require('path');
    const bin = fs2.readFileSync(
      path2.resolve(__dirname, '..', '..', 'bin', 'sentinel'), 'utf8');
    const cli = fs2.readFileSync(require.resolve('./cli.js'), 'utf8');

    // Every `action === 'verb'` branch in cli.js is a verb the dispatcher
    // must pass through rather than rewrite into a connector name.
    const verbs = [...cli.matchAll(/action === '([a-z]+)'/g)].map((m) => m[1]);
    check('cli.js declares at least test, list, and all',
      ['test', 'list', 'all'].every((v) => verbs.includes(v)), verbs.join(','));

    const passthrough = (bin.match(/^\s*(test\|list\|all[a-z|]*)\)/m) || [])[1] || '';
    for (const v of verbs) {
      if (v === 'search') continue;   // search is the implicit default
      check(`bin/sentinel passes '${v}' through instead of treating it as a connector`,
        passthrough.split('|').includes(v),
        `dispatcher passthrough list is: ${passthrough || '(none found)'}`);
    }

    check('and anything else still falls through to search',
      /node "\$ROOT\/modules\/connectors\/cli\.js" search "\$action"/.test(bin));
    check('no connector is named after a verb, which would shadow it',
      !Object.keys(R.CONNECTORS).some((n) => verbs.includes(n)),
      Object.keys(R.CONNECTORS).filter((n) => verbs.includes(n)).join(','));
  }

  // ══ a 403 that is not a bad key ══════════════════════════════════════
  // A live run reported `regulationsgov… failed: HTTP 403`. Three unrelated
  // things produce that status, and api.data.gov answers OVER_RATE_LIMIT with
  // 403 rather than 429 — so a temporary condition reads as a broken key, and
  // someone re-registers a key that was never the problem.
  {
    const B = (o) => Buffer.from(JSON.stringify(o));
    const rate = R.explainHttpError({ status: 403,
      body: B({ error: { code: 'OVER_RATE_LIMIT', message: 'You have exceeded your rate limit.' } }) });
    check('a rate limit is named as a rate limit, not a bad key',
      /rate limited, not a bad key/.test(rate), rate);

    const badkey = R.explainHttpError({ status: 403,
      body: B({ error: { code: 'API_KEY_INVALID', message: 'An invalid api_key was supplied.' } }) });
    check('an invalid key IS named as one', /the key was refused/.test(badkey), badkey);
    check('and the two do not read the same',
      !/rate limited/.test(badkey) && !/key was refused/.test(rate));

    check('a JSON:API error surfaces its detail',
      /page\[size\]/.test(R.explainHttpError({ status: 400,
        body: B({ errors: [{ title: 'Bad Request', detail: 'page[size] must be one of 5,10,25' }] }) })));
    check('an HTML error page yields words, not markup',
      R.explainHttpError({ status: 502,
        body: Buffer.from('<html>\n<head><title>502 Bad Gateway</title></head>') })
        === 'HTTP 502 — 502 Bad Gateway');
    check('no body degrades to the bare status',
      R.explainHttpError({ status: 500 }) === 'HTTP 500');
    check('a control character in a remote body cannot reach the terminal',
      !/\u001b/.test(R.explainHttpError({ status: 400,
        body: Buffer.from('{"message":"\u001b[31mfake red\u001b[0m"}') })));
  }

  // ══ ECOLOGIX is not Cologix ══════════════════════════════════════════
  {
    const f = R.looksLikeSubstringMatch;
    check('ECOLOGIX is flagged for a Cologix search',
      f('Cologix', 'ECOLOGIX ENVIRONMENTAL SYSTEMS LLC') === true);
    check('COLOGIX, INC. is NOT flagged', f('Cologix', 'COLOGIX, INC.') === false);
    check('nor a suffixed legal name', f('Cologix', 'COLOGIX MTL8, LLC') === false);
    check('Metabolic is flagged for Meta', f('Meta', 'Metabolic Research Inc') === true);
    check('Meta Platforms is not', f('Meta', 'Meta Platforms, Inc.') === false);
    check('Advantage is flagged for Vantage', f('Vantage', 'Advantage Solutions') === true);
    check('a name with no match at all is not flagged',
      f('Cologix', 'Franklin County Auditor') === false);
    // Regression from a live run: a search for "AWS" returned 25 DAWSON
    // companies, $248m of Department of Agriculture money among them, and
    // flagged none — the rule skipped queries under four characters. The
    // shorter the query, the MORE substring noise it draws.
    check('a three-letter query still flags substring noise',
      f('AWS', "DAWSON'S REALTY & MORTGAGES, INC.") === true);
    check('and so does two',
      f('GM', 'GMAC MORTGAGE CORP') === true);
    check('but a real AWS entity stays clean',
      f('AWS', 'AWS PUBLIC POLICY, AMERICAS') === false);
    check('including one where it is not the first word',
      f('AWS', 'COLUSSI AWS, INC.') === false);
    check('a single character is still skipped — it would flag everything',
      f('A', 'AMAZON') === false);
    check('regex metacharacters in a query do not throw',
      (() => { try { f('a.b*c', 'xa.b*cy'); return true; } catch { return false; } })());

    const cli2 = require('fs').readFileSync(require.resolve('./cli.js'), 'utf8');
    check('flagged hits are marked, never dropped',
      /kept, not dropped/.test(cli2) && !/filter\(.*looksLikeSubstring/.test(cli2));
    // Strip comments first. cli.js documents this very fix by quoting the
    // hardcoded string it removed, and a guard that matches the explanation
    // of a bug is the third time that has bitten in this repo.
    const cliCode = cli2.split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    check('the example named is from THIS run, not hardcoded',
      !/ECOLOGIX for Cologix/.test(cliCode) && /example\.hit\.name/.test(cliCode),
      'a "meta" search reported its hits against an ECOLOGIX example');
    check('and clean matches sort above them',
      /marked\.sort/.test(cli2));
  }

  // ══ argument parsing ═════════════════════════════════════════════════
  // A real run: `connect all "vadata" --into data center` searched for
  // "vadata center" and filed into "data". `--into` took one token and the
  // leftover was absorbed into the subject. Nothing warned; the run looked
  // normal and returned nothing, which reads as "no results" rather than
  // "you searched a string you never typed".
  {
    const { parseAllArgs: P } = require('./cli.js');

    const bad = P(['vadata', '--into', 'data', 'center']);
    check('a stray word after an option is REFUSED, not absorbed',
      !!bad.error && /stray word "center"/.test(bad.error), JSON.stringify(bad));
    check('and the fix is spelled out',
      /Quote the whole subject/.test(bad.error));
    check('naming the one-word folder rule',
      /"data-centers", not "data centers"/.test(bad.error));

    const ok = P(['New', 'Albany', 'Company', '--into', 'new-albany']);
    check('an unquoted multi-word subject before the flag still works',
      ok.subject === 'New Albany Company' && ok.opts.into === 'new-albany',
      JSON.stringify(ok));
    check('a quoted subject works', P(['Vadata', '--into', 'dc']).subject === 'Vadata');
    check('booleans do not eat the next word',
      P(['Cologix', '--dry-run', '--into', 'dc']).opts.dryRun === true
      && P(['Cologix', '--dry-run', '--into', 'dc']).opts.into === 'dc');
    check('--flag=value form works',
      P(['Cologix', '--into=dc']).opts.into === 'dc');
    check('--only splits on commas',
      P(['X', '--only', 'fec,usaspending']).opts.only.join(',') === 'fec,usaspending');

    check('a flag with no value is refused',
      /needs a value/.test(P(['x', '--into']).error || ''));
    check('a flag followed by another flag is refused',
      /needs a value/.test(P(['x', '--into', '--verbose']).error || ''));
    check('no subject at all is refused',
      /no subject/.test(P(['--into', 'dc']).error || ''));
    check('an unknown option is refused rather than ignored',
      /unknown option --bogus/.test(P(['x', '--bogus', 'y']).error || ''));

    // The investigation name becomes a directory.
    check('a path-traversing investigation name is refused',
      !!P(['x', '--into', '../../etc']).error);
    check('and a usable slug is suggested',
      /Try: /.test(P(['x', '--into', 'Data Centers!']).error || ''),
      P(['x', '--into', 'Data Centers!']).error);
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
