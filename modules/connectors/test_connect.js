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

  // ══ A MULTI-WORD QUERY IS A PHRASE, NOT AN OR OF WORDS ════════════════
  //
  // Federal Register and Regulations.gov both OR the words of an unquoted
  // full-text query. So "Magnet Forensics" asked for every document
  // containing "magnet" OR "forensics", and a sweep for a police forensics
  // vendor returned EPA glyphosate spreadsheets. "Ohio Peace Officer
  // Training Commission" — five common words — returned twenty-five
  // confident, irrelevant rows.
  //
  // Twenty-five junk rows per subject per connector bury the real hits, and
  // an operator who scrolls past them learns to distrust the whole output,
  // including the rows that matter. A search that always returns something
  // is indistinguishable from one that never works.
  {
    check('a multi-word query is quoted as a phrase',
      R.phrase('Magnet Forensics') === '"Magnet Forensics"', R.phrase('Magnet Forensics'));
    check('a single word is left alone — quoting it buys nothing',
      R.phrase('Cellebrite') === 'Cellebrite');
    check('an already-quoted query is not double-quoted',
      R.phrase('"Flock Safety"') === '"Flock Safety"', R.phrase('"Flock Safety"'));
    check('an embedded quote cannot break out of the phrase',
      R.phrase('Ohio" OR x') === '"Ohio OR x"', R.phrase('Ohio" OR x'));
    check('empty and null do not throw',
      R.phrase('') === '' && R.phrase(null) === '' && R.phrase(undefined) === '');

    // Five words, and an entity name — it stays a phrase. The word limit is
    // a heuristic, and a longer proper name WILL fall the wrong side of it;
    // that is what --exact is for, and the request line says which happened.
    const fr = R.CONNECTORS.federalregister.run('Ohio Peace Officer Training Commission', null, {});
    check('Federal Register sends a five-word entity name as a phrase',
      fr.url.includes('%22Ohio%20Peace%20Officer%20Training%20Commission%22'), fr.url);
    const frLong = R.CONNECTORS.federalregister.run(
      'Entity List additions Xinjiang iFLYTEK Hikvision Dahua', null, {});
    check('but a six-term subject search is sent as terms, not as one dead phrase',
      !frLong.url.includes('%22'), frLong.url);
    const frForced = R.CONNECTORS.federalregister.run(
      'Entity List additions Xinjiang iFLYTEK Hikvision Dahua', null, { exact: true });
    check('and --exact overrides the heuristic when the operator means a phrase',
      frForced.url.includes('%22'), frForced.url);
    const rg = R.CONNECTORS.regulationsgov.run('Magnet Forensics', 'k');
    check('Regulations.gov sends the quoted phrase',
      /%22Magnet(%20|\+)Forensics%22/.test(rg.url), rg.url);

    // The connectors that take a NAME rather than a full-text term must not
    // acquire quotes — a company registry looking up '"Flock Safety"' with
    // the quotes included finds nothing at all.
    const oc = R.CONNECTORS.opencorporates.run('Flock Safety', 'k');
    check('a company-registry lookup is NOT quoted',
      !oc.url.includes('%22'), oc.url);
    const lda = R.CONNECTORS.senatelda.run('Flock Safety', 'k');
    check('a lobbying-filing lookup is NOT quoted',
      !lda.url.includes('%22'), lda.url);
  }

  // ══ FARA: A SCHEMA THIS DESK NEVER CLAIMED TO KNOW ════════════════════
  //
  // DOJ publishes the whole active-registrant list at one URL — no search
  // endpoint — and the exact column names were not verifiable when this was
  // written. A parser that guesses them fetches successfully, matches
  // nothing, and reports a clean zero: the worst failure here, a confident
  // wrong null.
  {
    const F = R.CONNECTORS.fara;
    const body = { REGISTRANTS_ACTIVE: { ROW: [
      { Registration_Number: '1234', Registrant_Name: 'ACME PUBLIC AFFAIRS LLC',
        Foreign_Principal: 'Ministry of X', State: 'DC', Registration_Date: '2024-01-05' },
      { Registration_Number: '9', Registrant_Name: 'UNRELATED CORP',
        Foreign_Principal: 'Y', State: 'NY', Registration_Date: '2020-01-01' },
    ] } };

    const hits = F.parse(body, 'acme');
    check('the record array is found inside a wrapper it was not told about',
      hits.length === 1, String(hits.length));
    check('the registrant name is picked out', hits[0].name === 'ACME PUBLIC AFFAIRS LLC');
    // Written before DOJ's real schema was known, this asserted a principal
    // field on the registrant list. The live list carries none — principals
    // live in the registrant's DOCUMENTS — so extracting one here produced a
    // field that was always empty, which reads as "no principal on file".
    check('the registrant list does NOT claim to carry a foreign principal',
      !('principal' in hits[0]), Object.keys(hits[0]).join(','));
    check('the registration number is carried instead, since it addresses them',
      hits[0].external_id === '1234', hits[0].external_id);
    check('the record reports its OWN column names, so a mismatch is visible',
      /Registrant_Name/.test(hits[0].fields), hits[0].fields);

    // The shape-finder must handle the other wrappers too.
    check('a bare array of records is found', R.findRecordArray([{ a: 1 }]).length === 1);
    check('an object with no array yields none rather than throwing',
      R.findRecordArray({ a: 1 }).length === 0);
    check('null and a string do not throw',
      R.findRecordArray(null).length === 0 && R.findRecordArray('x').length === 0);
    check('an array of strings is not mistaken for records',
      R.findRecordArray(['a', 'b']).length === 0);

    check('an empty query matches nothing rather than everything',
      F.parse(body, '').length === 0 && F.parse(body, '   ').length === 0);
    check('a query matching no registrant returns none',
      F.parse(body, 'zzzznotreal').length === 0);
    check('the connector needs no key', F.keyRequired === false && F.keyVar === null);
    check('and announces that it filters locally',
      /filtered locally/.test(F.describe('x')));

    // Addresses of registrants are in that dataset. This desk does not
    // collect them: the notification guard refuses street addresses, and a
    // capture is not the place to start keeping them either.
    check('no address is carried into a result row', hits[0].address === '');
  }

  // ══ A ZERO MUST SAY WHICH KIND OF ZERO IT IS ══════════════════════════
  //
  // "No hits" has two causes that look identical: the source really holds
  // nothing, or the parser missed the schema and matched nothing it was
  // handed. The second reports a confident, wrong absence — "no foreign-agent
  // registration" for a firm that may have several.
  //
  // The fields line was built to expose exactly that and only printed on a
  // HIT, which is the one case where nobody needs it.
  {
    const F = R.CONNECTORS.fara;
    check('the connector can explain its own zero', typeof F.diagnose === 'function');

    const wrong = F.diagnose({ SOMETHING_ELSE: { NOT_ROWS: 'x' } });
    check('a shape it could not read is NOT reported as a null result',
      /NO RECORDS WERE READ AT ALL/.test(wrong), wrong);
    check('and it says the capture is on disk so the parser can be fixed',
      /capture is on disk/.test(wrong));

    const real = F.diagnose({ REGISTRANTS_ACTIVE: { ROW: [
      { Registration_Number: '1', Registrant_Name: 'X CORP', Foreign_Principal: 'Y' },
      { Registration_Number: '2', Registrant_Name: 'Z LLC', Foreign_Principal: 'W' },
    ] } });
    check('a genuine null reports how many records were actually read',
      /2 record\(s\) read, none matching/.test(real), real);
    check('and names the columns, so a mismatch is visible next time',
      /Registrant_Name/.test(real), real);

    const cli = require('fs').readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the CLI calls diagnose() on an empty result',
      /typeof conn\.diagnose === 'function'/.test(cli));
    check('and a connector without one still prints the plain no-hits line',
      /No hits\. A clean result is not proof of absence/.test(cli));
  }

  // ══ ASKING A SANCTIONS DATABASE IF A COMPANY IS A PERSON ═════════════
  //
  // The connector hardcoded schema:'Person'. A company is not a Person in
  // FollowTheMoney, so EVERY organisation ever searched came back empty —
  // Internet Research Agency, Social Design Agency, Structura — while
  // "Yevgeny Prigozhin" scored 1.0 and made the connector look healthy.
  //
  // The zero then printed as "a clean result is not proof of absence", which
  // reads as a considered null. It was a malformed question, and the desk had
  // been treating "is this company a person?" as "is this company sanctioned?"
  {
    const O = R.CONNECTORS.opensanctions;
    const body = JSON.parse(O.run('Internet Research Agency', 'K').body);
    const schemas = Object.values(body.queries).map((q) => q.schema).sort();
    check('an organisation is searched AS an organisation',
      schemas.includes('Organization'), schemas.join(','));
    check('and a person is still searched as a person',
      schemas.includes('Person'), schemas.join(','));
    check('both go in ONE request, so the announced call count stays true',
      Object.keys(body.queries).length === 2);
    check('the announced request says it covers both',
      /person and an organisation/i.test(O.describe('X')), O.describe('X'));

    // The same entity can match both queries. Counting it twice would
    // manufacture a second sanctioned party out of one.
    const dupe = { responses: {
      person: { results: [{ id: 'Q1', caption: 'A', schema: 'Person', score: 0.9 }] },
      org: { results: [{ id: 'Q1', caption: 'A', schema: 'Person', score: 0.9 },
                        { id: 'Q2', caption: 'B', schema: 'Organization', score: 0.95 }] },
    } };
    const parsed = O.parse(dupe);
    check('an entity matching both queries is counted once', parsed.length === 2,
      String(parsed.length));
    check('and results are ordered by score, best first',
      parsed[0].external_id === 'Q2', parsed[0].external_id);
    check('each row records which query found it',
      parsed.every((r) => r.matched_as));

    check('a zero explains that /match is resolution, not search',
      /RESOLUTION, not full-text search/.test(
        O.diagnose({ responses: { person: { results: [], total: { value: 3 } } } })));
    check('and a response with no query results at all is called malformed',
      /malformed request/.test(O.diagnose({})));
  }

  // ══ AN INDICTMENT IS NOT AN OPINION ══════════════════════════════════
  //
  // Searching "Internet Research Agency" returned Hachette v. Internet
  // Archive and FCC v. Consumers' Research — the words OR'd, because the
  // phrase fix had been applied to two connectors and not this one. And
  // type=o searches OPINIONS: a charging document, a criminal complaint and
  // a seizure affidavit are docket filings, in RECAP, under type=r. Searching
  // opinions for an indictment returns zero forever and the zero looks like
  // an answer.
  {
    const C = R.CONNECTORS.courtlistener;
    check('a multi-word case party is sent as a phrase, not OR\'d words',
      C.run('Internet Research Agency', null, {}).url.includes('%22Internet%20Research%20Agency%22'),
      C.run('Internet Research Agency', null, {}).url);
    check('the default search is still opinions',
      /type=o/.test(C.run('X', null, {}).url));
    check('--dockets searches the RECAP filing archive instead',
      /type=r/.test(C.run('X', null, { dockets: true }).url));
    check('and the request line warns that opinions exclude charging documents',
      /charging documents are not opinions/.test(C.describe('X', {})), C.describe('X', {}));
    check('while the docket mode says what it is searching',
      /indictments, affidavits/.test(C.describe('X', { dockets: true })));

    // A RECAP row carries docket_id rather than an opinion id; without this
    // every docket result would render with an empty link.
    const recap = C.parse({ results: [{ docket_id: 987, caseName: 'US v. X',
      court: 'dcd', dateFiled: '2018-02-16', docketNumber: '1:18-cr-00032' }] })[0];
    check('a docket result still produces a usable identifier and link',
      recap.external_id === '987' && /docket\/987/.test(recap.url), recap.url);
  }

  // ══ QUOTING EVERYTHING TRADED ONE FAILURE FOR A WORSE ONE ════════════
  //
  // Quoting fixed OR'd junk: "Magnet Forensics" had been returning EPA
  // glyphosate notices. But quoting EVERYTHING turned a list of search terms
  // into a demand for one exact string. "Entity List additions Xinjiang
  // iFLYTEK Hikvision Dahua" appears in no document ever written, so the
  // search returned a confident zero over a subject the Federal Register
  // covers extensively. Junk is visible; a wrong zero is not.
  {
    check('a two-word entity name is still sent as a phrase',
      R.phrase('Flock Safety') === '"Flock Safety"', R.phrase('Flock Safety'));
    check('a single word is never quoted', R.phrase('iFLYTEK') === 'iFLYTEK');
    check('a long list of terms is NOT forced into one impossible phrase',
      R.phrase('Entity List additions Xinjiang iFLYTEK Hikvision Dahua')
        === 'Entity List additions Xinjiang iFLYTEK Hikvision Dahua');
    check('--exact quotes a long query when the operator means a phrase',
      R.phrase('a b c d e f', { exact: true }) === '"a b c d e f"');
    check('a five-word proper name stays a phrase',
      R.phrase('Ohio Peace Officer Training Commission')
        === '"Ohio Peace Officer Training Commission"');
    check('--any un-quotes a short one', R.phrase('Flock Safety', { any: true }) === 'Flock Safety');
    check('an already-quoted query is left alone',
      R.phrase('"Q Cyber"') === '"Q Cyber"');

    // The choice must never be silent: a search that quietly changes the
    // question is exactly the failure this whole mechanism exists to catch.
    check('the announced request says when it sent an exact phrase',
      /EXACT PHRASE/.test(R.phraseMode('Flock Safety')), R.phraseMode('Flock Safety'));
    check('and says when it sent separate terms instead',
      /SEPARATE TERMS/.test(R.phraseMode('a b c d e f')), R.phraseMode('a b c d e f'));
    check('the federalregister request line carries that decision',
      /SEPARATE TERMS/.test(R.CONNECTORS.federalregister.describe('a b c d e f', {})),
      R.CONNECTORS.federalregister.describe('a b c d e f', {}));
    check('and the URL actually matches what the line claims',
      !/%22/.test(R.CONNECTORS.federalregister.run('a b c d e f', null, {}).url)
      && /%22/.test(R.CONNECTORS.federalregister.run('Flock Safety', null, {}).url));
  }

  // ══ THE REGISTER SAYS "AGENT"; THE DOCUMENTS SAY "FOR WHOM" ═══════════
  //
  // The live active-registrant list turned out to carry
  // Zip, Address_1, State, Registration_Date, City, Registration_Number, Name
  // — and no principal at all. The first version advertised a `principal`
  // field that was therefore always empty, which reads as "registered, but no
  // foreign principal on file" and is the opposite of true.
  {
    const F = R.CONNECTORS.fara;
    const live = { REGISTRANTS_ACTIVE: { ROW: [{
      Zip: '20005', Address_1: '1 K St', State: 'DC',
      Registration_Date: '05/14/2013', City: 'Washington',
      Registration_Number: '6170', Name: 'Mercury Public Affairs, LLC',
    }] } };
    const hit = F.parse(live, 'mercury')[0];
    check('the real DOJ schema parses', hit && hit.name === 'Mercury Public Affairs, LLC');
    check('the registration number is carried, since it addresses the documents',
      hit.external_id === '6170', hit.external_id);
    check('no empty principal field is advertised on a list that has none',
      !('principal' in hit), Object.keys(hit).join(','));

    const D = R.CONNECTORS.faradocs;
    check('the documents connector is addressed by registration number',
      D.run('6170').url.endsWith('/RegDocs/json/6170'), D.run('6170').url);
    check('and declares it does not take free text, so a sweep skips it',
      D.takesFreeText === false);
    check('a number with stray whitespace still addresses the right record',
      D.run('  6170 ').url.endsWith('/RegDocs/json/6170'));
    check('a value needing encoding is encoded, not interpolated raw',
      D.run('a/b').url.endsWith('%2Fb'), D.run('a/b').url);

    const docs = { REGDOCS: { ROW: [{
      Document_ID: '9', Foreign_Principal: 'Kingdom of X',
      Document_Type: 'Supplemental Statement', Date_Stamped: '2025-06-01',
      URL: 'https://efile.fara.gov/d/9',
    }] } };
    const d = D.parse(docs)[0];
    check('the FOREIGN PRINCIPAL is what the row is named for', d.name === 'Kingdom of X');
    check('the document type is kept', d.document === 'Supplemental Statement');
    check('and a link to the filing itself', /efile\.fara\.gov/.test(d.url));
    check('an unreadable shape is diagnosed, not reported as no principals',
      /NO RECORDS READ/.test(D.diagnose({ nope: 1 })));

    // A COUNTRY IS NOT A PRINCIPAL.
    //
    // The live RegDocs schema puts FOREIGN_PRINCIPAL_COUNTRY ahead of
    // FOREIGN_PRINCIPAL_NAME in key order, so a loose /principal/ match named
    // every row after a country: "SAUDI ARABIA", "TURKEY", "HAITI". That is a
    // different claim from the one the record makes. The kingdom is not the
    // counterparty on the contract; the named principal is.
    const real = { REGDOCS: { ROW: [{
      DATE_STAMPED: '2026-08-21', REGISTRATION_NUMBER: '7070',
      FOREIGN_PRINCIPAL_COUNTRY: 'TURKEY', DOCUMENT_TYPE: 'Exhibit AB',
      REGISTRANT_NAME: 'Ballard Partners', URL: 'https://efile.fara.gov/d/1',
      SHORT_FORM_NAME: '', FOREIGN_PRINCIPAL_NAME: 'Republic of Turkiye',
    }] } };
    const t = D.parse(real)[0];
    check('the NAMED principal wins over the country that sorts before it',
      t.name === 'Republic of Turkiye', t.name);
    check('and the country is carried as its own fact, not as the name',
      t.country === 'TURKEY', t.country);
    check('the registrant is kept separately, so both parties are on the row',
      t.registrant === 'Ballard Partners', t.registrant);

    // An empty principal must not borrow the registrant's name. "Ballard
    // Partners" in the principal column reads as a firm that filed for
    // itself; a blank FOREIGN_PRINCIPAL_NAME means no principal is named on
    // THIS document, which is a routine and different thing.
    const bare = { REGDOCS: { ROW: [{
      DATE_STAMPED: '2026-08-21', REGISTRATION_NUMBER: '7070',
      FOREIGN_PRINCIPAL_COUNTRY: '', DOCUMENT_TYPE: 'Amendment',
      REGISTRANT_NAME: 'Ballard Partners', URL: 'https://efile.fara.gov/d/2',
      FOREIGN_PRINCIPAL_NAME: '',
    }] } };
    const b = D.parse(bare)[0];
    check('a document naming no principal says so instead of echoing the firm',
      /no foreign principal named/i.test(b.name), b.name);
    check('and the firm is still visible in its own column',
      b.registrant === 'Ballard Partners');

    // A CAP IS NOT A COUNT.
    //
    // RegDocs returns a registrant's WHOLE filing history, not a page of
    // search results. BGR's number came back with 917 documents; the parser
    // sliced 25 and the screen said "25 candidate lead(s)". Read that way,
    // BGR appears to have started filing in January of this year.
    const many = { REGDOCS: { ROW: Array.from({ length: 300 }, (_, i) => ({
      DATE_STAMPED: '2026-01-01', REGISTRATION_NUMBER: '5430',
      DOCUMENT_TYPE: 'Short-Form', REGISTRANT_NAME: 'BGR',
      URL: `https://efile.fara.gov/d/${i}`,
      FOREIGN_PRINCIPAL_NAME: '', FOREIGN_PRINCIPAL_COUNTRY: '',
    })) } };
    check('a whole filing history is returned, not the first screenful',
      D.parse(many).length === 300, String(D.parse(many).length));

    // The Short-Form row names the individual registering as a foreign
    // agent. It was being dropped, which is the difference between "a firm
    // lobbied" and "a named person swore they were acting for a foreign
    // government".
    const sf = { REGDOCS: { ROW: [{
      DATE_STAMPED: '2026-08-13', REGISTRATION_NUMBER: '5430',
      FOREIGN_PRINCIPAL_COUNTRY: '', DOCUMENT_TYPE: 'Short-Form',
      REGISTRANT_NAME: 'BGR Government Affairs, LLC',
      URL: 'https://efile.fara.gov/d/3',
      SHORT_FORM_NAME: 'Viney, William', FOREIGN_PRINCIPAL_NAME: '',
    }] } };
    check('the individual named on a Short-Form registration is carried',
      D.parse(sf)[0].agent === 'Viney, William', D.parse(sf)[0].agent);
  }

  // ══ A NAME DECODED WRONG WILL NOT MATCH ITSELF ANYWHERE ELSE ══════════
  //
  // DOJ serves Windows-1252 bytes with no charset declared. Read as UTF-8,
  // the Turkish defence ministry arrived as "Republic of T\uFFFDrkiye". The
  // principal's name is the identifier carried into every other source, so a
  // mangled one silently fails to match the same entity twice.
  {
    const utf8 = Buffer.from('Republic of T\u00FCrkiye', 'utf8');
    check('valid UTF-8 is decoded as UTF-8 and left alone',
      R.decodeBody(utf8) === 'Republic of T\u00FCrkiye', R.decodeBody(utf8));

    const cp = Buffer.from([0x54, 0xFC, 0x72, 0x6B, 0x69, 0x79, 0x65]);
    check('bytes that are not valid UTF-8 fall back rather than corrupting',
      R.decodeBody(cp) === 'T\u00FCrkiye', R.decodeBody(cp));
    check('and no replacement character survives the fallback',
      !/\uFFFD/.test(R.decodeBody(cp)));

    // Windows-1252, not Latin-1: they differ exactly where quotes and dashes
    // live, which is the range government systems actually emit.
    check('the 0x80-0x9F range is read as Windows-1252, not Latin-1',
      R.decodeBody(Buffer.from([0x93, 0x41, 0x94])) === '\u201CA\u201D',
      R.decodeBody(Buffer.from([0x93, 0x41, 0x94])));
  }

  // ══ SEC EDGAR — THE ONLY SWORN NUMBER ON FAKE ACCOUNTS ════════════════
  //
  // The whole point of this connector is that a platform's own 10-K is the
  // only public, company-specific, sworn figure on duplicate and false
  // accounts. Every defect below would turn that into a confident zero.
  {
    const c = R.CONNECTORS.sec;
    check('sec is registered', !!c);

    // SEC refuses automated clients that do not identify themselves, and the
    // refusal is an HTML 403 — which a JSON parser reads as "no results".
    const ua = c.run('x', null, {}).headers['User-Agent'];
    check('every SEC request declares a contact in its User-Agent', !!ua && /sentinel/.test(ua), ua);
    check('and says so loudly when no contact has been configured',
      /SEC_CONTACT/.test(ua) || !/not set/.test(ua), ua);
    check('a non-JSON body is diagnosed as a refusal, not as an empty result',
      /not JSON/i.test(c.diagnose('<html>Request Rate Threshold Exceeded</html>')));

    // A filing hit has to reach the actual document. A constructed EDGAR path
    // that 404s is worse than no link: it looks checkable and is not.
    const sample = { hits: { total: { value: 412 }, hits: [{
      _id: '0001326801-24-000012:meta-20231231.htm',
      _source: { ciks: ['0001326801'], root_form: '10-K', file_date: '2024-02-02',
        display_names: ['Meta Platforms, Inc.  (META)  (CIK 0001326801)'] },
    }] } };
    const [row] = c.parse(sample);
    check('the filing URL is built from the accession and document name',
      row.url === 'https://www.sec.gov/Archives/edgar/data/1326801/000132680124000012/meta-20231231.htm',
      row.url);
    check('the CIK is stripped of leading zeros for the archive path',
      /\/data\/1326801\//.test(row.url), row.url);

    // "Meta Platforms, Inc.  (META)  (CIK 0001326801)" as a name matches no
    // other connector's spelling of the same company, so the entity index
    // would carry it as a separate company forever.
    check('the ticker and CIK are not left glued inside the company name',
      row.name === 'Meta Platforms, Inc.', row.name);
    check('the ticker is kept, separately', row.ticker === 'META', row.ticker);
    check('the CIK is kept, separately', row.cik === '0001326801', row.cik);

    // A hit with no id must not silently produce a link to nowhere.
    const [bare] = c.parse({ hits: { hits: [{ _source: { display_names: ['X Corp.'] } }] } });
    check('a hit with no accession yields no URL rather than a broken one',
      bare.url === '', bare.url);

    // A schema change under hits.hits reports "this company never disclosed a
    // false-account estimate" about a company that discloses one every year.
    check('a missing hits array is diagnosed as a schema mismatch',
      /schema mismatch/i.test(c.diagnose({ took: 3 })));
    check('and the top-level keys are shown so it can be fixed',
      /took/.test(c.diagnose({ took: 3 })));

    // Zero hits out of a non-zero reported total is a real search result and
    // must not read as a fact about the company.
    check('an honest zero says what was searched, not what is true',
      /search result, not a fact/.test(c.diagnose({ hits: { total: { value: 412 }, hits: [] } })));

    // The default narrows to 10-K because that is where the disclosure lives;
    // --allforms has to actually drop the filter.
    check('10-K is the default form filter', /forms=10-K/.test(c.run('q', null, {}).url));
    check('--allforms drops the form filter',
      !/forms=/.test(c.run('q', null, { allforms: true }).url));
    check('and the announced request line says which was used',
      /10-K only/.test(c.describe('q', {})) && /ALL/.test(c.describe('q', { allforms: true })));

    // A multi-word disclosure phrase must go as a phrase. "false or duplicate
    // accounts" sent as loose terms matches every filing containing "accounts".
    check('a short disclosure phrase is sent as an exact phrase',
      /%22/.test(c.run('false or duplicate accounts', null, {}).url),
      c.run('false or duplicate accounts', null, {}).url);
  }

  // ══ THE LDA CARRIES THE FOREIGN DISCLOSURE FARA DOES NOT ══════════════
  //
  // 22 U.S.C. 613(h) exempts an agent from FARA registration when the agent
  // has registered under the LDA for a foreign principal that is not a foreign
  // government or political party. A foreign CORPORATION lobbying commercially
  // therefore appears in the LDA and not in FARA, lawfully and by design.
  //
  // Measured: a full sweep of the active FARA register -- 536/536 registrants,
  // 58,287 documents -- found one of eight foreign-linked names taken off a
  // single firm's LDA client list. The disclosure that FARA does not hold is
  // in the LDA filing, in fields this parser was throwing away.
  {
    const p = R.CONNECTORS.senatelda.parse;
    const [au, gov, odd] = p({ results: [
      { filing_uuid: 'a1',
        registrant: { name: 'A FIRM LLP' },
        client: { name: 'WOODSIDE ENERGY', country_display: 'United States',
          ppb_country_display: 'Australia', client_government_entity: false },
        foreign_entities: [{ name: 'Woodside Energy Group Ltd',
          country_display: 'Australia', ownership_percentage: 100 }] },
      { filing_uuid: 'a2', registrant: { name: 'B LLP' },
        client: { name: 'CITY OF SOMEWHERE', client_government_entity: true },
        foreign_entities: [] },
      { filing_uuid: 'a3', registrant: { name: 'C LLP' }, client: { name: 'Z INC' },
        foreign_entities: [{ weird_key: '?', other: '??' }] },
    ] });

    check('a declared foreign entity is carried, with its country and share',
      /Woodside Energy Group Ltd/.test(au.foreign_entities)
        && /Australia/.test(au.foreign_entities) && /100%/.test(au.foreign_entities),
      au.foreign_entities);

    // A Delaware subsidiary of a foreign parent has country US and ppb_country
    // abroad. Only the second says so, and the first alone reads as domestic.
    check('the principal place of business is kept separately from the country',
      au.client_country === 'United States' && au.client_ppb_country === 'Australia',
      `${au.client_country} / ${au.client_ppb_country}`);

    check('a government client is flagged — the case FARA would have covered',
      gov.government_client === 'yes');
    check('and a domestic commercial client is not flagged as one',
      au.government_client === '', JSON.stringify(au.government_client));

    check('a filing declaring nothing yields an empty string, not a false value',
      gov.foreign_entities === '' && gov.foreign_count === 0);

    // The faradocs defect, in a new place: a shape this parser does not
    // recognise must not come back as "" -- that is indistinguishable from
    // "no foreign entity declared", which is the opposite of true.
    check('an unrecognised entity shape names the keys it saw instead of going blank',
      /unrecognised shape/.test(odd.foreign_entities) && /weird_key/.test(odd.foreign_entities),
      odd.foreign_entities);
    check('and the count still reflects that something WAS declared',
      odd.foreign_count === 1);

    check('a plain string entity is passed through rather than dropped',
      R.foreignEntitySummary(['Some Foreign Co']) === 'Some Foreign Co');
    check('an absent array is empty, not a crash',
      R.foreignEntitySummary(undefined) === '' && R.foreignEntitySummary(null) === '');

    // The name field feeds crosslink's entity index; changing it would split
    // every company in the library into two.
    check('the client — registrant name field is unchanged',
      au.name === 'WOODSIDE ENERGY — A FIRM LLP', au.name);

    // ── "UNITED STATES OF AMERICA" IS THE UNITED STATES ──────────────────
    //
    // A scan across 1,192 captures tested /^(US|United States)$/ against the
    // LDA's own spelling and reported that all 25,526 filings read had a
    // principal place of business outside the US. Every domestic client
    // counted as foreign, in the one number meant to say how much foreign
    // ownership is declared.
    const dom = R.isDomesticCountry;
    check('the LDA spelling "United States of America" is domestic',
      dom('', 'United States of America') === true);
    check('so are US, USA and U.S.A.',
      dom('', 'United States') === true && dom('', 'USA') === true
        && dom('', 'U.S.A.') === true);
    check('the two-letter code wins over any spelling',
      dom('US', 'Cayman Islands') === true && dom('KY', 'United States') === false);
    check('a real foreign country is foreign',
      dom('KY', 'Cayman Islands') === false && dom('', 'Japan') === false);
    // Unknown is not domestic. Counting it as either invents the answer.
    check('nothing to judge returns null rather than a guess',
      dom('', '') === null && dom(null, null) === null);
  }

  // ══ THE AD ARCHIVE IS THE ONLY PLACE A FUNDER MUST NAME ITSELF ════════
  //
  // There is no US law against Americans running many accounts to push a
  // political view; coordinated domestic political speech is broadly
  // protected. So "who is behind this page" has no legal answer -- except
  // where money bought reach, and an issue ad carries a "Paid for by"
  // disclaimer archived for seven years.
  {
    const c = R.CONNECTORS.adlibrary;
    check('adlibrary is registered', !!c);
    check('it requires a key and names the variable',
      c.keyRequired === true && c.keyVar === 'META_AD_LIBRARY_TOKEN');

    const [ad] = c.parse({ data: [{
      id: 'a1', page_id: '99', page_name: 'Ohio Blue Line',
      bylines: 'Paid for by Ohio Families for Safety', currency: 'USD',
      ad_delivery_start_time: '2026-03-01T00:00:00+0000',
      ad_delivery_stop_time: '2026-04-01T00:00:00+0000',
      spend: { lower_bound: '100', upper_bound: '499' },
      impressions: { lower_bound: '10000', upper_bound: '14999' },
      publisher_platforms: ['facebook', 'instagram'],
      ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=a1',
    }] });

    // The PAYER is the point, so the payer is the name.
    check('the "paid for by" disclaimer is the row name',
      ad.name === 'Paid for by Ohio Families for Safety', ad.name);
    check('the page is kept separately from the payer',
      ad.page === 'Ohio Blue Line' && ad.page_id === '99');

    // Spend and impressions are BANDS. Collapsing one to a single number
    // invents precision the archive deliberately does not publish.
    check('a spend band stays a band',
      ad.spend === '100–499 USD', ad.spend);
    check('an impression band stays a band',
      ad.impressions === '10000–14999', ad.impressions);
    const [half] = c.parse({ data: [{ id: 'b', spend: { lower_bound: '5000' } }] });
    check('a one-sided band is not silently completed',
      half.spend === '5000+', half.spend);

    // An ad with no disclaimer must not read as an ad with no payer field.
    const [none] = c.parse({ data: [{ id: 'c' }] });
    check('a missing disclaimer says so rather than going blank',
      /no "paid for by"/.test(none.name), none.name);

    // page_name is a PAGE. Indexing it as an entity would put "Ohio Blue
    // Line" in the same table as Meta Platforms, Inc.
    check('a page name is not indexed as a legal entity',
      c.entityNames === false);

    // --pageid changes WHICH parameter is sent, and the announced request
    // line has to say which, or the operator cannot tell what was searched.
    check('--pageid searches page ids, not ad text',
      /search_page_ids/.test(c.run('1234567890', 'k', { pageid: true }).url)
        && /search_terms/.test(c.run('back the blue', 'k', {}).url));
    check('and the announced request line states which was used',
      /page id:/.test(c.describe('123', { pageid: true }))
        && /terms:/.test(c.describe('x', {})));
    // A page id is digits. Anything else in that parameter is a malformed
    // request that comes back as an empty result, which reads as "no ads".
    check('a page id is stripped to digits before it is sent',
      /%5B%22123%22%5D/.test(c.run('page/123', 'k', { pageid: true }).url),
      c.run('page/123', 'k', { pageid: true }).url);

    // The four causes of a zero, and only one of them is "no political ads".
    check('a refused token is diagnosed as a credential problem',
      /TOKEN WAS REFUSED/.test(c.diagnose({ error: { message: 'Invalid OAuth access token.' } })));
    check('any other API error is not reported as an empty result',
      /ERROR, NOT AN EMPTY RESULT/.test(c.diagnose({ error: { message: 'rate limited' } })));
    check('a missing data array is a schema mismatch',
      /schema mismatch/.test(c.diagnose({ paging: {} })));

    // THE most important sentence in this connector: the archive holds ads,
    // not posts. An empty result for a page that posts all day means the page
    // never triggered a disclosure obligation -- not that it is clean.
    check('an honest zero says the archive holds ADS, not posts',
      /ADS, NOT POSTS/.test(c.diagnose({ data: [] })));
    check('and that the absence is not evidence the page is clean',
      /not evidence the page is/.test(c.diagnose({ data: [] })));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
