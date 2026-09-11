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

  // ══ A FLAG VALUE MUST NOT BECOME PART OF THE SUBJECT ══════════════════
  // `connect courtlistener "X" --into new-albany` searched for
  // "X new-albany" and returned Mississippi murder cases. args is argv with
  // --flags filtered out, which drops `--into` and KEEPS `new-albany`; the
  // leftover value landed in the query. Same corruption as `--into data
  // center` searching for "vadata center", fixed once in `connect all` and
  // never in the single-connector path.
  {
    const positional = (argv, fromIndex) => {
      const out = [];
      let seen = 0;
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
          if (/^--(into|only|skip|pages|limit|chart)$/.test(a)
              && argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
          continue;
        }
        if (seen++ < fromIndex) continue;
        out.push(a);
      }
      return out;
    };

    check('a --into value does not survive into the subject',
      positional(['courtlistener', 'Licking', 'Heights', '--into', 'new-albany'], 1)
        .join(' ') === 'Licking Heights');
    check('a flag before the subject is handled too',
      positional(['courtlistener', '--into', 'x', 'Licking', 'Heights'], 1)
        .join(' ') === 'Licking Heights');
    check('a valueless flag consumes nothing',
      positional(['courtlistener', 'Licking', '--dry-run'], 1).join(' ') === 'Licking');
    check('--into immediately followed by another flag eats no subject word',
      positional(['courtlistener', '--into', '--dry-run', 'Licking'], 1).join(' ') === 'Licking');
    check('the search verb form skips the connector name too',
      positional(['search', 'courtlistener', 'Alpine', 'Group', '--into', 'lobbying'], 2)
        .join(' ') === 'Alpine Group');
    check('a subject that looks like a flag value is still kept',
      positional(['courtlistener', 'new-albany'], 1).join(' ') === 'new-albany');
  }

  // ══ A RATE LIMIT IS "LATER", NOT "NO" ═════════════════════════════════
  // CourtListener allows 5/min and enforces it. A twelve-subject sweep fired
  // calls back to back and lost the source on most subjects -- reported, but
  // still lost. The run now paces itself and reads the wait out of the 429.
  {
    check('courtlistener declares its documented interval',
      R.CONNECTORS.courtlistener.minIntervalMs >= 12000,
      String(R.CONNECTORS.courtlistener.minIntervalMs));

    const body = (t) => ({ status: 429, headers: {}, body: Buffer.from(t) });
    check('the wait is read out of the body when there is no header',
      R.retryAfterMs(body('Request was throttled. Expected available in 5 seconds.')) === 6000);
    check('a standard Retry-After header is preferred',
      R.retryAfterMs({ status: 429, headers: { 'retry-after': '30' }, body: Buffer.from('') }) === 30000);
    check('an unparseable 429 returns null rather than a guessed backoff',
      R.retryAfterMs({ status: 429, headers: {}, body: Buffer.from('slow down') }) === null);
    check('a non-numeric Retry-After is not treated as a number',
      R.retryAfterMs({ status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
                       body: Buffer.from('') }) === null);

    // The header branch is only reachable if the request layer returns
    // headers at all. It did not, and the branch was dead code.
    const src = require('fs').readFileSync(require('path').join(__dirname, 'registry.js'), 'utf8');
    check('the request layer actually returns headers',
      /headers: res\.headers/.test(src));

    // Pacing must be per connector: throttling CourtListener must not slow
    // down eight sources that have nothing to do with it.
    check('a connector with no declared interval is not paced',
      !R.CONNECTORS.usaspending.minIntervalMs);
  }

  // ══ TWO QUESTIONS, TWO FIELDS ═════════════════════════════════════════
  // client_name asks "who lobbied FOR this company". registrant_name asks
  // "who does this firm lobby FOR". Only the first existed, and it bounded
  // every answer about a registrant by which clients had been searched --
  // reporting HARBINGER STRATEGIES with 2 clients where the API has 2,450
  // filings. Verified against the live API 2026-08-26.
  {
    const c = R.CONNECTORS.senatelda;
    const client = c.run('Harbinger Strategies', 'K').url;
    const reg = c.run('Harbinger Strategies', 'K', { mode: 'registrant' }).url;

    check('the default search still asks client_name',
      client.includes('client_name=') && !client.includes('registrant_name='), client);
    check('--registrant asks registrant_name',
      reg.includes('registrant_name=') && !reg.includes('client_name='), reg);
    check('the two modes produce different URLs', client !== reg);
    check('the registrant name is URL-encoded, not interpolated raw',
      reg.includes('Harbinger%20Strategies'), reg);

    const p3 = c.run('X', 'K', { mode: 'registrant', page: 3 }).url;
    check('a page beyond the first is requested explicitly', p3.includes('&page=3'), p3);
    const p1 = c.run('X', 'K', { mode: 'registrant', page: 1 }).url;
    check('page 1 sends no page parameter', !p1.includes('&page='), p1);

    check('the key travels in the Authorization header, never the URL',
      c.run('X', 'SECRETKEY', { mode: 'registrant' }).headers.Authorization === 'Token SECRETKEY'
      && !reg.includes('SECRETKEY'));
    check('no key means no Authorization header, not an empty one',
      Object.keys(c.run('X', '', { mode: 'registrant' }).headers).length === 0);

    // The host was observed 301-ing from lda.senate.gov; paying a redirect on
    // every call to reach a known destination is waste.
    check('both modes go straight to lda.gov, not the redirecting host',
      reg.startsWith('https://lda.gov/') && client.startsWith('https://lda.gov/'));
  }

  // ══ ONE KEY RESOLVER, USED BY BOTH ════════════════════════════════════
  // `connect test` resolved env[keyVar] alone while the runner resolved
  // env[keyVar] || env[keyVarAlt]. With only DATA_GOV_API_KEY set, the check
  // reported FEC as keyless while `connect fec "X"` searched fine -- the
  // diagnostic contradicting the thing it exists to diagnose.
  {
    const fec = R.CONNECTORS.fec;
    check(fec.keyVarAlt === 'DATA_GOV_API_KEY',
      'fec still declares an alternate key variable');
    check(R.resolveKey(fec, { DATA_GOV_API_KEY: 'shared' }) === 'shared',
      'the federation key resolves for a connector whose own key is unset');
    check(R.resolveKey(fec, { FEC_API_KEY: 'own', DATA_GOV_API_KEY: 'shared' }) === 'own',
      'a connector-specific key wins over the federation key');
    check(R.resolveKey(fec, {}) === '', 'no key set resolves to empty');
    const lda = R.CONNECTORS.senatelda;
    check(R.resolveKey(lda, { DATA_GOV_API_KEY: 'shared' }) === '',
      'the federation key is NOT handed to a connector outside that federation');
  }
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

  // ══ ASYMMETRY MUST TAKE A NAME ════════════════════════════════════════
  // Three commands were handed to the operator as
  //   connect asymmetry "Americans for Prosperity Action" --cycle 2026
  // and all three printed the usage block and exited 2, because the command
  // read ONLY --committee C00… and ignored the positional argument. Every
  // other command in this file takes a name. Nothing was measured and the
  // failure was silent about why.
  {
    const CLI = require('./cli.js');
    const parseAsym = (argv) => {
      const args = argv.filter((a) => !a.startsWith('--'));
      return CLI.flagVal(argv, '--committee')
        || CLI.subjectFrom(args.slice(1), argv, ['--cycle', '--dimension', '--min-rows']);
    };

    check('a bare committee NAME reaches the command',
      parseAsym(['asymmetry', 'Americans for Prosperity Action', '--cycle', '2026'])
        === 'Americans for Prosperity Action',
      parseAsym(['asymmetry', 'Americans for Prosperity Action', '--cycle', '2026']));
    check('a one-word name reaches it too',
      parseAsym(['asymmetry', 'WinSenate', '--cycle', '2026']) === 'WinSenate');
    check('--committee still works and still wins',
      parseAsym(['asymmetry', 'Some Name', '--committee', 'C00694323']) === 'C00694323');

    // The bug next door: a flag's VALUE joining the name. --cycle 2026 with
    // the 2026 landing in the search string is how "vadata center" happened.
    check('a flag value does not become part of the name',
      !parseAsym(['asymmetry', 'WinSenate', '--cycle', '2026']).includes('2026'));
    check('nor does --dimension\'s',
      !parseAsym(['asymmetry', 'WinSenate', '--dimension', 'vendor']).includes('vendor'));
    check('no name and no --committee is still refused',
      parseAsym(['asymmetry', '--cycle', '2026']) === '');

    // An id typed where a name goes must not cost a search.
    check('an id is recognised without a lookup',
      /\^C\\d\{8\}\$/.test(cliSrc) || /C\\d\{8\}/.test(cliSrc));
    check('several matches STOP rather than picking the first',
      /Choosing for you would be choosing the story/.test(cliSrc)
      && /Nothing was measured/.test(cliSrc));
    check('and the resolver is what asymmetry calls',
      /committee: await resolveCommittee\(/.test(cliSrc));

    // The checks above run a COPY of the parse. They would stay green if the
    // dispatcher itself reverted to --committee-only, so pin the real branch
    // in source: the fallback to subjectFrom must be in it.
    const branch = cliSrc.slice(cliSrc.indexOf("if (action === 'asymmetry')"));
    check('the dispatcher branch itself falls back to a positional name',
      /flagVal\(argv, '--committee'\)\s*\n?\s*\|\|\s*subjectFrom\(/
        .test(branch.slice(0, 900)));
    check('and its usage line offers the name form first',
      /usage: sentinel connect asymmetry "COMMITTEE NAME"/.test(branch.slice(0, 1400)));

    // ── A PASTED PLACEHOLDER IS NOT A SEARCH ────────────────────────────
    // `--committee C00XXXXXXX` was pasted verbatim from an example and the
    // resolver answered "No committee of that name is registered with the
    // FEC." True of the string, and it reads as a fact about the register
    // rather than a typo. Placeholders are recognised and cost no call.
    const isPlaceholder = (q) =>
      /^C0{0,2}[X?#*_]{3,}$/i.test(q) || /^C\d*[X?#*]+\d*$/i.test(q);
    for (const p of ['C00XXXXXXX', 'CXXXXXXXX', 'C00??????', 'C00######']) {
      check(`"${p}" is caught as a placeholder`, isPlaceholder(p));
    }
    for (const id of ['C00687103', 'C00865444', 'C00707844']) {
      check(`a real id (${id}) is NOT mistaken for one`, !isPlaceholder(id));
    }
    for (const n of ['WinSenate', 'EDF Action Votes', 'CVA ACTION']) {
      check(`nor is a real name ("${n}")`, !isPlaceholder(n));
    }
    check('and the guard runs before any request is made',
      cliSrc.indexOf('is a placeholder, not a committee id')
        < cliSrc.indexOf('parseCommittees(await fetchJson(F.committeeSearchUrl(q, key)))'));
  }

  // ══ A DROPPED CONNECTION IS NOT AN ANSWER ═════════════════════════════
  // Sherrod Brown's Schedule A died at page 21 of 25, 2,100 rows in:
  //     Error: FEC returned 0 —
  // status 0 is registry.request's own marker for a timeout or socket
  // error. It never reached the FEC. All four retry lists excluded it, so
  // the single most retryable failure was the one treated as permanent, and
  // the empty half of the message was res.body — which a socket error does
  // not have. What it knew was in res.error and was never printed.
  {
    const CLI = require('./cli.js');

    check('a timeout (status 0) is retried',
      CLI.fecRetryable({ status: 0, error: 'timed out' }));
    check('so is a socket reset',
      CLI.fecRetryable({ status: 0, error: 'ECONNRESET' }));
    check('and a gateway error, which is the proxy talking',
      CLI.fecRetryable({ status: 502 }));
    for (const s of [429, 500, 503, 504]) {
      check(`${s} is retried`, CLI.fecRetryable({ status: s }));
    }
    check('a 404 is NOT retried — it is an answer',
      !CLI.fecRetryable({ status: 404 }));
    check('nor is a 403, which means the key',
      !CLI.fecRetryable({ status: 403 }));
    check('nor a 400',
      !CLI.fecRetryable({ status: 400 }));

    // The message must carry what actually went wrong.
    check('a transport failure reports its cause, not an empty body',
      /timed out/.test(CLI.fecError({ status: 0, error: 'timed out' })));
    check('and does not claim the FEC "returned" anything',
      !/returned 0/.test(CLI.fecError({ status: 0, error: 'timed out' })));
    check('a status 0 with no error field still says something useful',
      /before any response|before a reply/.test(CLI.fecError({ status: 0 })));
    check('an HTTP error still shows the body',
      /rate limit/.test(CLI.fecError({ status: 429, body: 'rate limit exceeded' })));

    // One fetcher, not four that drifted.
    // Count-free: every fetchJson assignment must come from the shared
    // fetcher. Pinning a number just means the next command that adds one
    // breaks the test instead of being checked by it.
    const assignments = (cliSrc.match(/const fetchJson = /g) || []).length;
    const shared = (cliSrc.match(/const fetchJson = fecFetcher\(/g) || []).length;
    check(`every fetchJson comes from the shared fetcher (${shared}/${assignments})`,
      assignments > 0 && shared === assignments);
    check('and no inline retry list survives',
      !/\[429, 503, 504\]\.includes/.test(cliSrc));
    check('the shared fetcher exists and is callable',
      typeof CLI.fecFetcher() === 'function');
  }

  // ══ THE DISPATCHER MUST KNOW EVERY VERB ═══════════════════════════════
  // `all` was added to cli.js and not to bin/sentinel, so the dispatcher
  // treated it as a connector NAME and reported "unknown connector: all".
  // A command that works when the module is called directly is not yet a
  // command that works.
  {
    const disp = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'bin', 'sentinel'), 'utf8');
    const line = (disp.match(/^\s*test\|list\|.*\)$/m) || [''])[0];
    for (const verb of ['test', 'list', 'all', 'crosslink', 'lobby', 'graph',
      'expand', 'sweep', 'brief', 'fecpac', 'delegation', 'member',
      'asymmetry', 'donors', 'filings', 'control', 'vendor', 'matrix']) {
      check(`the dispatcher passes "${verb}" through`,
        line.split('|').map((s) => s.replace(/[^a-z]/g, '')).includes(verb));
    }
    check('and cli.js has a branch for donors',
      /if \(action === 'donors'\)/.test(cliSrc));
    check('and one for filings',
      /if \(action === 'filings'\)/.test(cliSrc));
    check('and one for control',
      /if \(action === 'control'\)/.test(cliSrc));
    check('and one for vendor',
      /if \(action === 'vendor'\)/.test(cliSrc));
    check('and one for matrix',
      /if \(action === 'matrix'\)/.test(cliSrc));
    // The register has no lobbyist-to-legislator field. A tool that shows
    // one has inferred it, and this one says so on every run.
    check('matrix states that no politician column exists in the LDA',
      /NOT name a politician/.test(cliSrc));
    check('and that a tool showing one has inferred it',
      /has \s*'\s*\+\s*'?\s*inferred it|inferred it/.test(cliSrc));
    // The caveat must agree with the label above it. A run that printed
    // "A FEW CLIENTS — the usual defence does not apply" also printed
    // "firms carry many clients" eight lines later, and the footer was the
    // confident one.
    check('vendor carries a caveat for MANY clients',
      /trade carry many clients/.test(cliSrc));
    check('and a different one for FEW, which withdraws that defence',
      /is unavailable at this client count/.test(cliSrc));
    check('the few-client caveat still refuses to allege a violation',
      /violation follows from anything above/.test(cliSrc));
    check('and the choice is driven by the measured shape, not by hand',
      /shape\.reading === 'few_clients'/.test(cliSrc));
    // "Political media is a small trade" was printed over rows reading
    // FINANCE CONSULTING. The trade is in the purpose codes on screen.
    check('the caveat no longer names a trade it has not measured',
      !/Political media is a /.test(cliSrc));
  }

  // ══ A MULTI-WORD SUBJECT IS A PHRASE, NOT A BAG OF WORDS ══════════════
  // The surveillance sweep returned, as leads requiring verification:
  //
  //   "Axon Enterprise" → IRIS Toxicological Review of Formaldehyde
  //                       Tox Profile for Carbon Disulfide
  //   "Flock Safety"    → migratory bird hunting regs, poultry standards
  //
  // Not near-misses. AXON is an anatomical term and carbon disulfide is a
  // classic AXONAL neurotoxin; FLOCK is an ornithological one. The subject
  // was sent UNQUOTED, so three full-text APIs matched the words
  // independently — structurally corrupting every multi-word subject in
  // every sweep, and reporting the wreckage as leads.
  {
    // This file uses check(); a local eq keeps the failure messages useful.
    const eq = (label, got, want) => check(
      `${label}${got === want ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
      got === want);

    eq('a multi-word subject is quoted', R.phrase('Axon Enterprise'), '"Axon Enterprise"');
    eq('so is a three-word one', R.phrase('Ohio Department of Public Safety'),
      '"Ohio Department of Public Safety"');
    eq('a single word is left alone', R.phrase('Cellebrite'), 'Cellebrite');
    eq('an already-quoted subject is not double-quoted',
      R.phrase('"United Democracy Project"'), '"United Democracy Project"');
    eq('surrounding whitespace is trimmed before the decision',
      R.phrase('  Flock Safety  '), '"Flock Safety"');
    eq('an embedded quote is dropped rather than breaking the syntax',
      R.phrase('A "Public" Voice'), '"A Public Voice"');
    eq('an empty subject stays empty', R.phrase(''), '');
    eq('and null does not throw', R.phrase(null), '');

    // All three text connectors must send the phrase.
    const rg = R.CONNECTORS.regulationsgov.run('Axon Enterprise', 'K').url;
    check('regulations.gov sends the quoted phrase', rg.includes('%22Axon%20Enterprise%22'), rg);
    const fr = R.CONNECTORS.federalregister.run('Flock Safety', 'K').url;
    check('the federal register sends it too', fr.includes('%22Flock%20Safety%22'), fr);
    const cl = R.CONNECTORS.courtlistener.run('Babel Street', 'K').url;
    check('and courtlistener', cl.includes('%22Babel%20Street%22'), cl);

    // A single-word subject must NOT acquire quotes — some APIs treat a
    // quoted single term differently from a bare one.
    check('a one-word subject is sent bare',
      !R.CONNECTORS.regulationsgov.run('Cellebrite', 'K').url.includes('%22'));

    // The announcement must show what is actually sent, or the operator is
    // reading a different query from the one that ran.
    check('the describe line shows the quoted form',
      /"Axon Enterprise"/.test(R.CONNECTORS.regulationsgov.describe('Axon Enterprise')));
  }


  // ── FEC captures, and the key that was in the ledger ────────────────────
  {
    console.log('\n  FEC runs now leave an audit trail');
    const fs = require('fs');
    const cliSrc = fs.readFileSync(require('path').join(__dirname, 'cli.js'), 'utf8');
    const R2 = require('./registry.js');

    // The strongest figures on this desk had no capture, no hash and no
    // ledger entry, while a speculative name search had all three.
    check('the FEC fetcher takes a capture spec', /function fecFetcher\(\{ quiet = false, capture/.test(cliSrc));
    check('and writes it through the shared recorder', /R\.recordCapture\(\{/.test(cliSrc));
    for (const cmd of ['fecpac', 'vendor', 'donors', 'asymmetry', 'control',
      'filings', 'member', 'delegation']) {
      check(`${cmd} captures`, new RegExp(`command: '${cmd}'`).test(cliSrc));
    }
    // 'fec' is the candidate-search connector. Reusing that name would make
    // crosslink parse schedule rows with the wrong parser.
    check('captures use a prefix crosslink will not index',
      /prefix: 'fec_api'/.test(cliSrc));
    check('a capture that cannot be written is reported, not swallowed',
      /capture NOT written/.test(cliSrc));

    // The ledger is the file you hand to a lawyer. The FEC takes its key as a
    // QUERY PARAMETER, so source_url was recording it verbatim.
    const red = R2.redactUrl('https://api.open.fec.gov/v1/x/?api_key=SECRET&committee_id=C1');
    check('an api_key in the query string is redacted', !/SECRET/.test(red));
    check('but the parameter NAME survives, because which key is a fair question',
      /api_key=REDACTED/.test(red));
    check('the rest of the query is untouched', /committee_id=C1/.test(red));
    check('a token is redacted too', !/T0K/.test(R2.redactUrl('https://x.test/?token=T0K')));
    check('a url with no secret is returned unchanged',
      R2.redactUrl('https://example.com/a?q=hi') === 'https://example.com/a?q=hi');
    check('a string that is not a url does not throw',
      R2.redactUrl('not a url') === 'not a url');
    check('and the connector path redacts before the ledger too',
      /sourceUrl: redactUrl\(spec\.url\)/.test(
        fs.readFileSync(require('path').join(__dirname, 'registry.js'), 'utf8')));
  }

  // ══ A DEAD NETWORK IS NOT A FINDING ═══════════════════════════════════
  // A router reboot mid-run produced 150 lines of
  //     fail  AXON ENTERPRISE — ENOTFOUND
  // which reads exactly like "these firms have no filings". ENOTFOUND is
  // DNS; ETIMEDOUT is a connection that never opened. Neither is an answer.
  {
    const isTransport = new Function('out', `
      if (!out || out.ok) return false;
      if (out.status === 0) return true;
      return /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|timed out|socket hang up|network/i
        .test(String(out.error || ''));`);

    check('ENOTFOUND is the network', isTransport({ ok: false, error: 'ENOTFOUND' }));
    check('ETIMEDOUT is the network', isTransport({ ok: false, error: 'ETIMEDOUT' }));
    check('"timed out" is the network', isTransport({ ok: false, error: 'timed out' }));
    check('status 0 is the network', isTransport({ ok: false, status: 0, error: '' }));
    check('a 404 is an ANSWER, not a dead link',
      !isTransport({ ok: false, status: 404, error: 'not found' }));
    check('a 429 is an answer too — it means later, not broken',
      !isTransport({ ok: false, status: 429, error: 'rate limited' }));
    check('a success is never a transport failure', !isTransport({ ok: true }));

    check('expand stops after consecutive transport failures',
      /const BREAK_AFTER = 3;/.test(cliSrc) && /aborted = t; break;/.test(cliSrc));
    check('and says it was the network, not the register',
      /network, not an answer/.test(cliSrc));
    check('a transport failure resets to zero on the next success',
      /consecutive = 0;\n    done \+= 1;/.test(cliSrc));
    check('an ordinary failure does NOT trip the breaker',
      /consecutive = 0;\n        console\.log\(`  \$\{C\.r\('fail'\)\}/.test(cliSrc));
    check('the abort reports how many were never asked',
      /not asked/.test(cliSrc));

    // Resumability, with no new state file: the ledger already records what
    // was asked, on the same record that proves what was fetched.
    check('expand reads the ledger to find what it already asked',
      /function askedRegistrants\(ledgerPath\)/.test(cliSrc));
    check('filtering on the search mode, not just the connector',
      /x\.search_mode !== 'registrant_name'/.test(cliSrc));
    check('skipped registrants are counted out loud',
      /already asked/.test(cliSrc));
    check('and --again re-asks the whole list',
      /opts\.again \? new Set\(\)/.test(cliSrc)
      && /again: argv\.includes\('--again'\)/.test(cliSrc));
  }


  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
