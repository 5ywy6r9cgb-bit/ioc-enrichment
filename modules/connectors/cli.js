#!/usr/bin/env node
'use strict';
/**
 * modules/connectors/cli.js — interactive connector runs.
 *
 *   sentinel connect test
 *   sentinel connect list
 *   sentinel connect opensanctions "Larry Householder"
 *   sentinel connect courtlistener "Reynoldsburg water" --dry-run
 *
 * The run procedure itself lives in registry.js, shared with the watch runner.
 * This file is presentation: announce, then report what happened.
 */

const fs = require('fs');
const path = require('path');
const R = require('./registry.js');

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

/**
 * Decide what a probe actually proved.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FUNCTION AND NOT FOUR LINES INLINE
 *
 * The first version computed the HTTP verdict and the key state completely
 * independently and printed them side by side. On a real desk that produced:
 *
 *     OpenSanctions   key: MISSING   → KEY REJECTED (HTTP 401)
 *     FEC             key: MISSING   → CONNECTED (HTTP 200)
 *
 * Both lines are false. Nothing rejected a key that was never sent — the
 * advice to "check for a typo" pointed at a key that does not exist. And FEC
 * cannot be CONNECTED without a key: the probe quietly falls back to
 * DEMO_KEY, so the 200 proves that api.data.gov's shared demo key works, not
 * that anything of the operator's does.
 *
 * The second line is the dangerous one. It is green. It reads as done. The
 * first real query then fails, or worse, succeeds a handful of times against
 * a shared rate limit and starts failing at some later point for no visible
 * reason.
 *
 * So the key state now GATES the verdict. If a required key is absent, the
 * answer is "cannot test" — no HTTP result is evidence about a setup that
 * does not exist yet.
 */
function verdictFor(c, key, res) {
  const usesDemoFallback = /DEMO_KEY/.test(c.probe('').url || '')
    || /DEMO_KEY/.test(JSON.stringify(c.probe('').headers || {}));

  // Shape first. A key that cannot possibly be valid should not need a
  // network round trip and a 403 to discover, and "check for a stray quote"
  // is the wrong advice for a value that is twenty characters too long.
  const shape = c.keyVar ? R.checkKeyShape(c.keyVar, key) : null;
  if (shape) {
    return {
      text: C.r(`KEY MALFORMED — ${shape.length} chars`),
      note: `${c.keyVar} should be ${shape.expected}, and yours is `
        + `${shape.length} characters.`
        + (shape.hints.length ? ` Looks like ${shape.hints.join('; and ')}.` : '')
        + ` Re-copy just the key itself from ${shape.where}`,
      ok: false,
    };
  }

  if (c.keyVar && c.keyRequired && !key) {
    return {
      text: C.y('NOT TESTED — no key set'),
      note: usesDemoFallback
        ? `The probe fell back to DEMO_KEY, so HTTP ${res.status} says nothing `
          + `about your setup. DEMO_KEY is shared and rate-limited to roughly a `
          + `handful of calls an hour. Get a free key and set ${c.keyVar}.`
        : `Set ${c.keyVar} in modules/pra/.env, then run this again.`,
      ok: false,
    };
  }

  if (res.status === 0) {
    return { text: C.r(`NO NETWORK — ${res.error}`), ok: false,
             note: 'The host could not be reached at all.' };
  }
  if (res.status === 401 || res.status === 403) {
    // Three different situations wear the same status code, and telling a
    // no-key connector to "check your key" sends you looking for a setting
    // that does not exist.
    if (key) {
      return {
        text: C.r(`KEY REJECTED (HTTP ${res.status})`),
        note: `The key in ${c.keyVar} was sent and refused. Check for a stray `
          + `quote, a trailing space, or a key that has been revoked.`,
        ok: false,
      };
    }
    if (c.keyVar) {
      return {
        text: C.r(`REFUSED (HTTP ${res.status}) — needs a key`),
        note: `This connector is marked optional-key, but the host refused an `
          + `anonymous request. Set ${c.keyVar} in modules/pra/.env.`,
        ok: false,
      };
    }
    return {
      text: C.r(`REFUSED (HTTP ${res.status})`),
      note: `This connector uses no key at all, so this is not a credentials `
        + `problem. Something between you and the host refused the request — a `
        + `corporate proxy, a VPN, or a blocked IP range.`,
      ok: false,
    };
  }
  if (res.status >= 200 && res.status < 300) {
    const via = res.redirected_from && res.redirected_from.length
      ? ` after ${res.redirected_from.length} redirect(s)` : '';
    return { text: C.g(`CONNECTED (HTTP ${res.status})${via}`), ok: true,
             note: key ? null : 'Anonymous access worked; a key would raise the rate limit.' };
  }
  if (res.status === 429) {
    return { text: C.y('RATE LIMITED (HTTP 429)'), ok: false,
             note: 'The host is throttling. Wait, or set a key to raise the limit.' };
  }
  return {
    text: C.r(`UNEXPECTED (HTTP ${res.status})`),
    note: `Not an error this connector knows how to interpret. The endpoint may `
      + `have moved or changed shape.`,
    ok: false,
  };
}

async function cmdTest() {
  const env = R.loadEnv();
  console.log('\n' + C.b('Connector key check'));
  console.log(C.dim('  Keys are read from .env and never printed. Presence and length only.\n'));

  let ready = 0;
  const total = Object.keys(R.CONNECTORS).length;

  for (const [, c] of Object.entries(R.CONNECTORS)) {
    // Same resolver the runner uses. Checking only keyVar here reported
    // connectors as keyless that would have searched fine.
    const key = R.resolveKey(c, env);
    const spec = c.probe(key);
    const res = await R.request(spec.method, spec.url, spec.headers);
    const v = verdictFor(c, key, res);
    if (v.ok) ready++;

    let keyState;
    if (!c.keyVar) keyState = C.dim('none needed');
    else if (key) keyState = C.g('set');
    else keyState = c.keyRequired ? C.r('MISSING') : C.y('not set (optional)');

    console.log(`  ${C.b(c.label.padEnd(28))} key: ${keyState}   → ${v.text}`);
    if (key) console.log(C.dim(`  ${' '.repeat(30)}${R.mask(key)}  [${c.keyVar}]`));
    if (v.note) {
      for (const line of wrap(v.note, 74)) console.log(C.dim(`  ${' '.repeat(30)}${line}`));
    }
    if (res.redirected_from) {
      for (const hop of res.redirected_from) {
        console.log(C.dim(`  ${' '.repeat(30)}${hop.status} → ${hop.to}`));
      }
    }
    console.log('');
  }

  console.log(C.dim('  ' + '─'.repeat(74)));
  console.log(`  ${ready === total ? C.g(`${ready} of ${total} usable`) : C.y(`${ready} of ${total} usable`)}`);
  if (ready < total) {
    console.log(C.dim('  A connector without its key is not usable, whatever HTTP said —'));
    console.log(C.dim('  the probe may have fallen back to a shared demo key.'));
    console.log(C.dim('  Keys go in modules/pra/.env — see docs/API_KEYS.md'));
  }
  console.log('');
}

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const w of String(text).split(/\s+/)) {
    if ((line + ' ' + w).trim().length > width) { out.push(line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

function cmdList() {
  console.log('\n' + C.b('Connectors') + '\n');
  for (const [n, c] of Object.entries(R.CONNECTORS)) {
    const k = c.keyVar ? `${c.keyVar}${c.keyRequired ? '' : ' (optional)'}` : 'no key needed';
    console.log(`  ${n.padEnd(18)} ${c.label.padEnd(28)} ${k}`);
  }
  console.log('');
}

/**
 * Parse `connect all` arguments by walking them in order.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY NOT THE OBVIOUS THING
 *
 * The first version built the subject by taking every positional argument and
 * SUBTRACTING the known flag values. On a real run:
 *
 *     bin/sentinel connect all "vadata" --into data center
 *     subject     vadata center
 *     filing to   evidence/investigations/data/
 *
 * `--into` consumed only `data`; `center` was not a known flag value, so it
 * survived into the subject and the desk searched for something the operator
 * never typed. Nothing warned. The run looked completely normal and returned
 * nothing, which reads as "no results" rather than "you searched the wrong
 * string". The same silent corruption hit three other searches in that session.
 *
 * Walking in order removes the guesswork: a flag takes exactly the next token,
 * and everything before the first flag is the subject. A bare token appearing
 * AFTER a flag is refused rather than absorbed, because at that point there is
 * no way to know whether the operator meant it as part of the flag value or
 * part of the subject — and guessing is what caused this.
 */
function parseAllArgs(args) {
  const KNOWN = { into: 1, only: 1, skip: 1 };
  const BOOLEAN = new Set(['dry-run', 'verbose']);
  const subject = [];
  const opts = { dryRun: false, verbose: false, into: null, only: null, skip: null };
  let seenFlag = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a.startsWith('--')) {
      seenFlag = true;
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let value = eq > 0 ? a.slice(eq + 1) : null;

      if (BOOLEAN.has(name)) {
        if (name === 'dry-run') opts.dryRun = true;
        if (name === 'verbose') opts.verbose = true;
        continue;
      }
      if (!(name in KNOWN)) {
        return { error: `unknown option --${name}. Known: --into, --only, --skip, --dry-run, --verbose` };
      }
      if (value === null) {
        value = args[++i];
        if (value === undefined || value.startsWith('--')) {
          return { error: `--${name} needs a value` };
        }
      }
      if (name === 'into') opts.into = value;
      if (name === 'only') opts.only = value.split(',').map((x) => x.trim()).filter(Boolean);
      if (name === 'skip') opts.skip = value.split(',').map((x) => x.trim()).filter(Boolean);
      continue;
    }

    // A bare word after a flag is ambiguous. Refuse instead of absorbing it.
    if (seenFlag) {
      return {
        error: `stray word "${a}" after an option.\n`
          + `  Quote the whole subject and put options last:\n`
          + `    sentinel connect all "${[...subject, a].join(' ')}" --into <one-word-name>\n`
          + `  An investigation name becomes a folder, so it takes one word: `
          + `"data-centers", not "data centers".`,
      };
    }
    subject.push(a);
  }

  if (!subject.length) return { error: 'no subject. usage: connect all "SUBJECT" [--into NAME]' };

  // The folder name has to survive being a path component.
  if (opts.into && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.into)) {
    return {
      error: `--into "${opts.into}" is not usable as a folder name.\n`
        + `  Letters, digits, dot, dash, underscore. Try: `
        + `${opts.into.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-investigation'}`,
    };
  }

  return { subject: subject.join(' '), opts };
}

/**
 * Search EVERY usable connector for one subject.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Building a library on a subject means asking the same question of every
 * source: is there a company registration, a federal contract, a lobbying
 * filing, a lawsuit, a rulemaking comment. Nine connectors done one at a time
 * is nine commands per subject, and for a dozen subjects nobody does it twice.
 *
 * WHAT IT KEEPS FROM THE SINGLE-CONNECTOR RUN
 *
 * The announce step, in full. Every call is declared before any call is made,
 * including the total — a fan-out is the one place where "it made how many
 * requests?" is a real question, and the answer should be on screen before
 * the operator commits rather than after.
 *
 * Calls run one at a time, deliberately. Nine parallel requests is how a free
 * API tier revokes a key, and the wall-clock saving is seconds.
 *
 * A connector that fails does not stop the rest. A partial library is worth
 * having; the failures are listed at the end rather than buried.
 */
async function cmdAll(query, opts) {
  if (!query) {
    console.error('\n  usage: sentinel connect all "SUBJECT" [--into INVESTIGATION]\n');
    process.exit(2);
  }

  const env = R.loadEnv();
  const names = Object.keys(R.CONNECTORS);

  // Sort into what will run and what cannot, before anything runs.
  const runnable = [];
  const skipped = [];
  for (const name of names) {
    const c = R.CONNECTORS[name];
    if (opts.only && !opts.only.includes(name)) continue;
    if (opts.skip && opts.skip.includes(name)) { skipped.push([name, 'skipped by --skip']); continue; }
    // Some connectors do not take a name. BLS wants a series id; asking it
    // about a company spends a call to learn nothing.
    if (c.freeText === false) {
      skipped.push([name, 'takes an identifier, not a name — query it directly']);
      continue;
    }
    const key = c.keyVar ? (env[c.keyVar] || (c.keyVarAlt ? env[c.keyVarAlt] : '') || '') : '';
    if (c.keyRequired && !key) { skipped.push([name, `${c.keyVar} not set`]); continue; }
    runnable.push(name);
  }

  console.log('\n' + C.b(`AUTHORIZED RUN — ${runnable.length} connector(s)`));
  console.log(`  subject     ${C.b(query)}`);
  console.log(`  calls       ${runnable.length} (exactly, one per connector, sequential)`);
  // Captures all live in ONE directory, because crosslink, lobby, brief and
  // graph read one directory -- filing them into per-investigation folders
  // would hide them from every tool that reads them back. `--into` therefore
  // TAGS a capture rather than moving it. This line used to announce a folder
  // nothing was ever written to, which is the desk lying about its own work.
  if (opts.into) console.log(`  tagging     investigation: ${opts.into}  ${C.dim('(captures stay in evidence/captures/)')}`);
  console.log('  boundary    every hit lands as a LEAD requiring a primary source');
  for (const name of runnable) {
    console.log(C.dim(`    ${name.padEnd(18)} ${R.CONNECTORS[name].describe(query)}`));
  }
  for (const [name, why] of skipped) {
    console.log(C.y(`    ${name.padEnd(18)} SKIPPED — ${why}`));
  }

  if (opts.dryRun) {
    console.log('\n  ' + C.y('DRY RUN — no network call made, nothing written.') + '\n');
    return;
  }

  console.log('');
  const rows = [];
  const failures = [];
  for (const name of runnable) {
    process.stdout.write(C.dim(`  ${name}… `));
    const out = await R.runConnector(name, query, { env, investigation: opts.into });
    if (!out.ok) {
      failures.push([name, out.error]);
      console.log(C.r(`failed: ${out.error}`));
      continue;
    }
    if (out.parseError) {
      failures.push([name, `captured but unparsed: ${out.parseError}`]);
      console.log(C.y(`captured, unparsed`));
      continue;
    }
    rows.push({ name, label: R.CONNECTORS[name].label, results: out.results,
      capturePath: out.capturePath, captureHash: out.captureHash });
    console.log(out.results.length
      ? C.g(`${out.results.length} lead(s)`) : C.dim('nothing'));
  }

  // ---- the library view -------------------------------------------------
  const total = rows.reduce((n, r) => n + r.results.length, 0);
  console.log('\n' + C.dim('  ' + '─'.repeat(74)));
  console.log(`  ${C.b(`${total} candidate lead(s)`)} across ${rows.filter((r) => r.results.length).length} source(s)\n`);

  for (const r of rows) {
    if (!r.results.length) continue;
    console.log(`  ${C.b(r.label)}  ${C.dim(`${r.results.length}`)}`);
    // Clean matches first. A substring hit is real output and is never
    // dropped — you cannot audit what you never saw — but it should not sit
    // above the thing you were actually looking for.
    const marked = r.results.map((hit) => ({
      hit, sub: R.looksLikeSubstringMatch(query, hit.name || hit.title || ''),
    }));
    marked.sort((a, b) => (a.sub === b.sub ? 0 : a.sub ? 1 : -1));
    const nSub = marked.filter((m) => m.sub).length;

    for (const { hit, sub } of marked.slice(0, opts.verbose ? 999 : 5)) {
      const line = hit.name || hit.title || hit.external_id || '(unnamed)';
      const extra = [hit.jurisdiction, hit.amount, hit.agency, hit.incorporated, hit.date]
        .filter(Boolean).join(' · ');
      const text = String(line).slice(0, 62);
      console.log(sub ? C.dim(`    ${text}   ← substring, probably not it`)
                      : `    ${text}`);
      if (extra) console.log(C.dim(`      ${extra.slice(0, 68)}`));
    }
    if (!opts.verbose && marked.length > 5) {
      console.log(C.dim(`    …and ${marked.length - 5} more (all in the capture)`));
    }
    if (nSub) {
      // Name the actual example from THIS run. The first version hardcoded
      // "(ECOLOGIX for Cologix)", so a search for "meta" reported its own
      // flagged hits against an example from a different subject entirely —
      // which reads as a bug in the tool rather than a note about the results.
      const example = marked.find((m) => m.sub);
      const exName = example && (example.hit.name || example.hit.title || '');
      console.log(C.dim(`    ${nSub} of ${marked.length} match only inside a longer word`
        + (exName ? ` (${String(exName).slice(0, 34)} for "${query}")` : '')
        + ` — kept, not dropped`));
    }
    console.log(C.dim(`    capture  ${path.relative(R.EVIDENCE, r.capturePath)}`));
    console.log('');
  }

  if (failures.length) {
    console.log(`  ${C.y('Did not complete:')}`);
    for (const [name, why] of failures) console.log(C.dim(`    ${name.padEnd(18)} ${why}`));
    console.log(C.dim('  A partial library is still a library. Re-run to retry these.\n'));
  }

  console.log(C.y('  These are LEADS, not findings.'));
  console.log(C.dim('  A name match is not an identification. Confirm same-entity and pull'));
  console.log(C.dim('  the underlying document before any of it is used.'));
  console.log(C.dim('\n  Watch it instead of re-running by hand:  see watchlist.json\n'));
}

/**
 * Cross-reference everything already captured. No network call.
 */
function cmdCrosslink(opts) {
  const X = require('./crosslink.js');
  const dir = require('path').join(R.EVIDENCE, 'captures');
  const captures = X.readCaptures(dir);

  if (!captures.length) {
    console.log(`\n  ${C.dim('No captures yet. Run some searches first:')}`);
    console.log(C.dim('    sentinel connect all "SUBJECT" --into NAME\n'));
    return;
  }

  const unparsed = captures.filter((c) => c.unparsed);
  const total = captures.reduce((n, c) => n + c.results.length, 0);
  const subjects = [...new Set(captures.map((c) => c.subject))];

  console.log(`\n  ${C.b('CROSS-REFERENCE')}`);
  console.log(C.dim(`  ${captures.length} capture(s) · ${total} result(s) · `
    + `${subjects.length} subject(s) · no network call\n`));

  const { byName, edges } = X.index(captures);

  // ---- lobbying edges: an asserted relationship, not a coincidence ------
  const shared = X.sharedRegistrants(edges, { minClients: 2 });
  if (shared.length) {
    console.log(`  ${C.b('LOBBYING — one registrant, several clients')}`);
    console.log(C.dim('  A filing is a sworn statement that this firm lobbied for that'));
    console.log(C.dim('  client. These are asserted relationships, not name overlaps.\n'));
    for (const g of shared.slice(0, opts.verbose ? 999 : 8)) {
      console.log(`    ${C.b(g.registrant)}  ${C.dim(`${g.client_count} clients`)}`);
      for (const c of g.clients.slice(0, opts.verbose ? 999 : 6)) {
        console.log(`      ${c.client.slice(0, 56).padEnd(58)}`
          + C.dim(`${c.filings} filing(s) · via "${c.subjects.join('", "')}"`));
      }
      console.log('');
    }
  }

  // ---- co-occurrence across subjects ------------------------------------
  const cross = X.crossSubject(byName, { minSubjects: 2 });
  if (cross.length) {
    console.log(`  ${C.b('APPEARS UNDER MORE THAN ONE SUBJECT')}\n`);
    for (const e of cross.slice(0, opts.verbose ? 999 : 15)) {
      console.log(`    ${C.b(e.name.slice(0, 52))}`);
      console.log(C.dim(`      subjects: ${e.subjects.join(' · ')}`));
      console.log(C.dim(`      sources:  ${e.connectors.join(', ')}  (${e.hits} hit(s))`));
    }
    if (!opts.verbose && cross.length > 15) {
      console.log(C.dim(`\n    …and ${cross.length - 15} more (--verbose for all)`));
    }
  } else {
    console.log(C.dim('  Nothing appears under more than one subject yet.'));
    console.log(C.dim('  That is a real answer: these searches have not overlapped.'));
  }

  if (unparsed.length) {
    console.log(C.y(`\n  ${unparsed.length} capture(s) could not be re-parsed`));
    console.log(C.dim('  The bytes are on disk and hashed. They are not in this analysis.'));
    for (const c of unparsed.slice(0, 5)) console.log(C.dim(`    ${c.file}`));
  }

  console.log('\n' + C.dim('  ' + '─'.repeat(74)));
  console.log(C.y('  A CO-OCCURRENCE IS NOT A RELATIONSHIP.'));
  console.log(C.dim('  Two firms with similar names, a registrant with four hundred clients,'));
  console.log(C.dim('  a court caption containing a word — all look identical here. This is'));
  console.log(C.dim('  a shortlist of places to look. Confirm same-entity, then pull the'));
  console.log(C.dim('  filing itself and cite that.'));
  console.log(C.dim('\n  Open a case for what survives:  sentinel case new CASE-ID "..."\n'));
}

/**
 * Read every captured lobbying filing and say what they assert. No network.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT PART OF crosslink
 *
 * crosslink answers "what name turns up under more than one subject", over
 * every connector. That is co-occurrence, and it is worth exactly a look.
 *
 * A lobbying filing asserts the relationship. Someone signed, under
 * 2 U.S.C. 1603-1604, that this registrant lobbied for that client in that
 * quarter on those issues. Mixing an asserted relationship into a pile of
 * name overlaps loses the only thing that made it worth reading, so the
 * filings get their own reader, their own arithmetic, and their own page.
 *
 * The arithmetic is where this data misleads. income and expenses are
 * different money; amendments restate rather than add; the capture stops at
 * 25; and you only ever see the clients you searched. lobby.js defends
 * against all four — this function's job is to make sure the operator is
 * TOLD about them rather than handed a clean-looking number.
 */
/**
 * connect graph — push the captured relationships into Neo4j.
 *
 * WHY THIS IS NOT JUST "EXPORT EVERYTHING"
 *   A graph makes every edge look like a fact. `crosslink` is careful, in the
 *   terminal, to say that a name appearing under two subjects is a search
 *   result and not a relationship. If the graph then draws both as a line
 *   between two companies, that care is gone -- and the graph is the thing
 *   that gets screenshotted.
 *
 *   So co-occurrence is never an Org->Org edge. Two companies found by the
 *   same search are joined only through the Subject node naming that search,
 *   two hops apart. The only direct edge between organisations is FILED_FOR,
 *   which comes from a sworn filing with a URL on it.
 *
 * NOTHING IS WRITTEN WITHOUT --push
 *   The default prints what WOULD be written. Writing into a database is not
 *   reversible by re-running, and a graph you did not mean to build is worse
 *   than no graph.
 */
async function cmdGraph(opts) {
  const G = require('./graph.js');
  const X = require('./crosslink.js');

  const captures = X.readCaptures(R.CAPTURES);
  if (!captures.length) {
    console.log(`\n  ${C.dim('No captures yet. Search something first:')}`);
    console.log(C.dim('    sentinel connect all "NiSource" --into energy\n'));
    return;
  }

  const g = G.build(captures);
  const stmts = G.toCypher(g);

  console.log(`\n  ${C.b('Graph from the captured library')}`);
  console.log(`  ${captures.length} captures read\n`);
  console.log(`    ${String(g.orgs.length).padStart(5)}  organisations`);
  console.log(`    ${String(g.subjects.length).padStart(5)}  subjects (searches you ran)`);
  console.log(`    ${String(g.filed.length).padStart(5)}  FILED_FOR    ${C.dim('sworn lobbying filings')}`);
  console.log(`    ${String(g.appears.length).padStart(5)}  APPEARS_UNDER ${C.dim('search results, NOT links between orgs')}`);

  if (g.counts_are_floors) {
    console.log(`\n  ${C.y('TRUNCATED')} — ${g.truncated_captures} capture(s) held fewer rows than the source reported.`);
    console.log(C.dim('  Every count in this graph is a floor. Nodes carry counts_are_floors: true.'));
  }
  if (g.unparsed) {
    console.log(`\n  ${C.y(String(g.unparsed) + ' capture(s) would not parse')} and are not in the graph.`);
  }

  console.log(`\n  ${C.dim('Two companies under the same subject are TWO HOPS apart, through that')}`);
  console.log(`  ${C.dim('subject. There is no edge saying they are related, because that is not')}`);
  console.log(`  ${C.dim('a thing your captures establish.')}`);

  // --dashboard renders the same numbers the push writes, from the same
  // build(), so the page and the database cannot disagree.
  if (opts.dashboard) {
    const D = require('./graph_dashboard.js');
    const out = typeof opts.dashboard === 'string'
      ? opts.dashboard : path.join(R.EVIDENCE, 'graph-dashboard.html');
    const html = D.renderDashboard(g, {
      sideA: opts.sideA ? new RegExp(opts.sideA, 'i') : null,
      sideB: opts.sideB ? new RegExp(opts.sideB, 'i') : null,
    });
    fs.writeFileSync(out, html);
    console.log(`\n  ${C.g('dashboard')}  ${out}`);
    console.log(C.dim('  Self-contained: no script, no CDN, no font host, no request of any kind.'));
    console.log(C.dim(`    open ${out}\n`));
    if (!opts.push) return;
  }

  if (!opts.push) {
    console.log(`\n  ${C.b('Nothing was written.')} ${C.dim('This is a preview.')}`);
    console.log(C.dim('  Statements that would run:'));
    for (const st of stmts) console.log(C.dim(`    - ${st.note}`));
    console.log(`\n  ${C.dim('To write it:')}  sentinel connect graph --push\n`);
    return;
  }

  // ---- credentials --------------------------------------------------
  const env = G.readEnv(__dirname);
  // bolt:// not neo4j:// -- a single local instance is not a cluster, and the
  // routing protocol's failure message when nothing is listening is
  // "Could not perform discovery. No routing servers available", which does
  // not tell you the database is simply not started.
  const uri = process.env.NEO4J_URI || env.NEO4J_URI || 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER || env.NEO4J_USER || 'neo4j';
  const pass = process.env.NEO4J_PASSWORD || env.NEO4J_PASSWORD || '';
  // Neo4j serves several databases from one instance. Writes land in the one
  // the session names; Browser reads whichever it is pointed at. Naming it
  // explicitly, and printing it, is the difference between "it worked" and
  // "it worked somewhere you are not looking."
  const database = process.env.NEO4J_DATABASE || env.NEO4J_DATABASE || 'neo4j';

  // A placeholder copied out of the docs is not a password. Without this the
  // failure surfaces much later as "Neo4j rejected the credentials", which
  // sends you looking at the database instead of at the .env you just wrote.
  if (G.isPlaceholderPassword(pass)) {
    console.error(`\n  ${C.r('NEO4J_PASSWORD is still a placeholder.')}  ${C.dim(`("${pass}")`)}`);
    console.error(C.dim(`  Edit ${path.join(__dirname, '.env')} and put the real password in.`));
    console.error(C.dim('  It is whatever you set when you first opened the database in'));
    console.error(C.dim('  Neo4j Desktop — a fresh install makes you choose one.\n'));
    process.exit(2);
  }

  if (!pass) {
    console.error(`\n  ${C.r('NEO4J_PASSWORD is not set.')}`);
    console.error(C.dim(`  Add it to ${path.join(__dirname, '.env')} (chmod 600):`));
    console.error(C.dim('    NEO4J_URI=bolt://localhost:7687'));
    console.error(C.dim('    NEO4J_USER=neo4j'));
    console.error(C.dim('    NEO4J_PASSWORD=the-password-you-set\n'));
    process.exit(2);
  }

  // The library stays on this machine unless you say otherwise, out loud.
  // A NEO4J_URI pointing somewhere hosted would ship the whole graph of
  // who-lobbies-for-whom to someone else's server, with no visible difference
  // in the command you typed.
  if (!G.isLocal(uri) && !opts.allowRemote) {
    console.error(`\n  ${C.r('That Neo4j is not on this machine.')}  ${C.dim(uri)}`);
    console.error(C.dim('  This graph is your investigative library. Pushing it to a hosted'));
    console.error(C.dim('  instance puts it on somebody else\'s server.'));
    console.error(C.dim('  If you meant to: sentinel connect graph --push --allow-remote\n'));
    process.exit(2);
  }

  let neo4j;
  try {
    neo4j = require('neo4j-driver');
  } catch {
    console.error(`\n  ${C.r('neo4j-driver is not installed.')}`);
    console.error(C.dim('    cd modules/connectors && npm install neo4j-driver\n'));
    process.exit(2);
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
  const session = driver.session({ database });
  try {
    console.log(`\n  writing to ${C.b(uri)}  database ${C.b(database)}  as ${user} …`);
    const done = await G.push(g, session);
    for (const note of done) console.log(`    ${C.g('ok')}  ${note}`);

    // Every statement returning without error does not mean the graph is
    // there. Count it back before saying so.
    const actual = await G.verify(session);
    const problems = G.reconcile(g, actual);

    console.log('');
    console.log(`  ${C.dim('in the database now:')}`);
    for (const [k, v] of Object.entries(actual.nodes)) console.log(`    ${String(v).padStart(6)}  ${k}`);
    for (const [k, v] of Object.entries(actual.rels)) console.log(`    ${String(v).padStart(6)}  ${k}`);

    if (problems.length) {
      console.log(`\n  ${C.r('The write did not land as expected.')}`);
      for (const p of problems) {
        console.log(`    ${C.r('✗')} ${p.name}: wrote ${p.want}, found ${p.got}`);
      }
      console.log(C.dim(`\n  This is the database named "${database}". If you are looking at a`));
      console.log(C.dim('  different one in Browser you will see nothing — run  :use ' + database));
      process.exitCode = 1;
    } else {
      console.log(`\n  ${C.g('Done, and read back.')} ${C.dim('Re-running updates in place — every write is a MERGE.')}`);
      console.log(C.dim(`\n  In Neo4j Browser, select database "${database}" (or run  :use ${database}),`));
      console.log(C.dim('  clear the editor, and run ONE query at a time:'));
      console.log(C.dim('    MATCH (r:Org)-[:FILED_FOR]->(c:Org) RETURN r,c LIMIT 50\n'));
    }
  } catch (e) {
    // The driver's own messages are about its internals -- "Could not perform
    // discovery", "No routing servers available" -- which do not tell you the
    // database is simply not started, or the password is wrong. Say which.
    const code = String(e.code || '');
    const msg = String(e.message || '');
    if (/Unauthorized|AuthenticationRateLimit/.test(code)) {
      console.error(`\n  ${C.r('Neo4j rejected the credentials.')}`);
      // Say what was actually sent, or this is just "it said no".
      console.error(C.dim(`  read from   ${path.join(__dirname, '.env')}`));
      console.error(C.dim(`  uri         ${uri}`));
      console.error(C.dim(`  user        "${user}"`));
      console.error(C.dim(`  password    ${G.describeSecret(pass)}`));
      console.error('');
      console.error(C.dim('  Check that password against the database itself: open'));
      console.error(C.dim('  http://localhost:7474 and sign in with the same user and'));
      console.error(C.dim('  password. If that fails too, the value is wrong. If it works'));
      console.error(C.dim('  there but not here, the .env line is.'));
      console.error('');
      console.error(C.dim('  In Neo4j Desktop the app login is NOT the database password.'));
      console.error(C.dim('  Each instance has its own, set when the instance was created.\n'));
    } else if (/ServiceUnavailable/.test(code) || /ECONNREFUSED|routing servers|discovery/i.test(msg)) {
      console.error(`\n  ${C.r('Nothing is listening at')} ${uri}`);
      console.error(C.dim('  The database is not started, or it is on a different port.'));
      console.error(C.dim('  Neo4j Desktop: the instance must say Started, not Stopped.'));
      console.error(C.dim('  Docker: docker ps should show the container up.\n'));
    } else {
      console.error(`\n  ${C.r('Neo4j refused the write:')} ${msg}`);
      console.error(C.dim('  Nothing partial was left behind — every write is a MERGE.\n'));
    }
    process.exitCode = 1;
  } finally {
    await session.close();
    await driver.close();
  }
}

function cmdLobby(opts) {
  const L = require('./lobby.js');
  const dir = path.join(R.EVIDENCE, 'captures');
  const { filings: raw, subjects, unparsed } = L.readFilings(dir);

  if (!subjects.length) {
    console.log(`\n  ${C.dim('No lobbying captures yet. Search a client first:')}`);
    console.log(C.dim('    sentinel connect senatelda "Amazon Data Services"'));
    console.log(C.dim('    sentinel connect all "NiSource" --into energy\n'));
    return;
  }

  const { filings, superseded } = L.dedupe(raw);
  const analysis = L.analyse(filings);
  const shared = L.sharedRegistrants(analysis);

  console.log(`\n  ${C.b('LOBBYING FILINGS')}`);
  console.log(C.dim(`  ${subjects.length} capture(s) · ${raw.length} filing(s) read · `
    + `${filings.length} after collapsing ${superseded} amendment(s) · no network call\n`));

  // ---- coverage, before any number that depends on it -------------------
  const truncated = subjects.filter((s) => s.truncated);
  const unknown = subjects.filter((s) => s.total === null);
  if (truncated.length) {
    console.log(`  ${C.y('TRUNCATED — these totals are floors, not totals')}`);
    console.log(C.dim('  The connector asks for 25 filings and does not follow the next page.'));
    for (const s of truncated) {
      console.log(C.dim(`    ${s.subject.slice(0, 40).padEnd(42)}kept ${s.kept} of ${s.total}`));
    }
    console.log('');
  }
  if (unknown.length) {
    console.log(C.dim(`  ${unknown.length} capture(s) reported no total count — `
      + `whether they are complete is unknown, not assumed.\n`));
  }

  // ---- the finding this module exists for -------------------------------
  if (shared.length) {
    console.log(`  ${C.b('ONE REGISTRANT, SEVERAL CLIENTS')}`);
    console.log(C.dim('  Each row rests on signed filings, not a name overlap. "Clients" means'));
    console.log(C.dim('  clients IN THIS LIBRARY — the search is by client name, so a firm\'s'));
    console.log(C.dim('  other clients are invisible unless you searched them too.\n'));
    for (const g of shared.slice(0, opts.verbose ? 999 : 10)) {
      console.log(`    ${C.b(g.name.slice(0, 52))}  ${C.dim(`${g.clients.length} clients · ${g.filings} filings`)}`);
      for (const c of g.clients) console.log(C.dim(`      ${c.slice(0, 62)}`));
      console.log('');
    }
  } else {
    console.log(C.dim('  No registrant here files for more than one captured client.'));
    console.log(C.dim('  That is a real answer about your library, not about lobbying.\n'));
  }

  // ---- money, split and never summed ------------------------------------
  const income = L.sumOrNull(analysis.byYear.map((y) => y.income));
  const expenses = L.sumOrNull(analysis.byYear.map((y) => y.expenses));
  console.log(`  ${C.b('REPORTED FIGURES')}`);
  console.log(C.dim('  Two different kinds of money. They are never added together.'));
  console.log(`    income (outside firms paid by a client)      ${income === null ? C.dim('none reported') : '$' + income.toLocaleString('en-US')}`);
  console.log(`    expenses (organisations, in-house lobbying)  ${expenses === null ? C.dim('none reported') : '$' + expenses.toLocaleString('en-US')}`);
  console.log('');

  if (analysis.issues.length) {
    console.log(`  ${C.b('ISSUES')}`);
    for (const s of analysis.issues.slice(0, opts.verbose ? 999 : 10)) {
      console.log(`    ${s.issue.slice(0, 46).padEnd(48)}${C.dim(`${s.filings} filing(s)`)}`);
    }
    console.log('');
  }

  if (unparsed.length) {
    console.log(C.y(`  ${unparsed.length} capture(s) would not parse and are excluded`));
    for (const u of unparsed.slice(0, 5)) console.log(C.dim(`    ${u.file}`));
    console.log(C.dim('  The bytes are on disk and hashed. They are not in this analysis.\n'));
  }

  if (opts.chart) {
    const CH = require('./lobby_chart.js');
    const out = opts.chart === true
      ? path.join(R.EVIDENCE, 'lobbying.html') : path.resolve(opts.chart);
    require('fs').writeFileSync(out, CH.render({
      analysis, shared, subjects, unparsed, superseded,
      kept: filings.length, generated: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    }));
    console.log(`  ${C.g('chart written')}  ${out}`);
    console.log(C.dim('  One self-contained file. No scripts, no fonts, no network — it will'));
    console.log(C.dim('  still render years from now with the Wi-Fi off.\n'));
  }

  console.log(C.dim('  ' + '─'.repeat(74)));
  console.log(C.y('  A FILING IS AN ASSERTION, NOT A FINDING.'));
  console.log(C.dim('  It is evidence that someone SAID this, which is much stronger than a'));
  console.log(C.dim('  name overlap and still not proof of what was done. Pull the filing at'));
  console.log(C.dim('  lda.gov and cite that.\n'));
}

/**
 * connect senatelda --registrant "FIRM NAME" — every client a firm files for.
 *
 * WHY THIS IS A SEPARATE COMMAND
 *   The ordinary search asks "who lobbied for this company". This asks "who
 *   does this firm lobby for", and until it existed every answer about a
 *   registrant was silently bounded by which CLIENTS had been searched. The
 *   library said HARBINGER STRATEGIES had 2 clients across 4 filings; the API
 *   says 2,450 filings. The 2 was a measurement of the search, not of
 *   Harbinger.
 *
 * WHY IT PAGES, AND WHY IT STOPS
 *   2,450 filings is 98 requests at the API's page size. That is a lot of
 *   traffic to a public service for one question, so it stops at a page
 *   budget and SAYS SO -- with the API's own total next to what it fetched.
 *   A partial answer that announces itself is useful; a partial answer that
 *   looks complete is how you end up publishing "2 clients".
 *
 *   Each page is saved as its own capture with its own hash. Pages are not
 *   merged into one file, because then the bytes on disk would be something
 *   no server ever sent.
 */

/**
 * connect fecpac — what a committee gave, kept in its categories.
 *
 * TWO STEPS ON PURPOSE. Without --committee this only RESOLVES the name and
 * stops. A committee id typed from memory that happens to be wrong returns a
 * complete, confident, entirely false answer -- another committee's filings,
 * correctly formatted, with no sign anything went wrong. So the id is always
 * looked up, printed, and chosen by a person before any money is counted.
 *
 * Organisations often run several committees under similar names, with very
 * different rules. Picking one for you would be picking the story.
 */
// ---------------------------------------------------------------- flag args
// argv.filter(a => !a.startsWith('--')) removes the FLAG and leaves its VALUE
// in the positional list, so the value lands in whatever subject those
// positionals are joined into. This repo has been bitten by that twice:
// `--into new-albany` searched for "X new-albany" and returned Mississippi
// murder cases, and `--committee C00879080` searched the FEC for a committee
// named "AIPAC C00879080". Both failed by returning a clean, confident,
// wrong answer. Remove the pair together, always.
function flagVal(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

function flagNum(argv, name) {
  const v = flagVal(argv, name);
  if (v === null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Positional words, minus the values belonging to the named flags. */
function subjectFrom(positional, argv, flagNames) {
  const taken = new Set();
  for (const f of flagNames) {
    const v = flagVal(argv, f);
    if (v !== null) taken.add(v);
  }
  return positional.filter((w) => !taken.has(w)).join(' ').trim();
}


/**
 * connect delegation — a whole state's federal delegation, and their money.
 *
 * One command, one table. The share of a member's contributions that came
 * from political committees rather than from people is the number this
 * exists for, and it only means anything with the whole delegation beside it.
 */
/**
 * connect member — one politician, and every direction money moves.
 *
 * Money TO them, money FOR them, money AGAINST them: three flows aimed at one
 * person, reported separately everywhere else and never reconciled. The facts
 * live in the relationships between them.
 */
/**
 * connect asymmetry — concentration, with its denominator attached.
 *
 * The measure is trivial. The discipline is the floor underneath it: a
 * committee with one expenditure is 100% concentrated, and reporting that
 * beside a committee with forty-four manufactures findings out of small
 * numbers.
 */
/**
 * Turn a typed name into ONE committee id, or refuse.
 *
 * `asymmetry` used to demand --committee C00…, which meant every run began
 * with a separate lookup and a copy-paste. Every other command in this file
 * takes a name. The inconsistency was mine and it cost three commands that
 * could not run.
 *
 * Resolving is not the same as choosing. One match resolves and says which.
 * Several matches PRINT and STOP -- a name like "Americans for Prosperity"
 * covers a connected PAC and a super PAC, governed by different rules, and
 * picking the first row would be picking the answer.
 */
/**
 * Is this response worth trying again?
 *
 * STATUS 0 IS THE IMPORTANT ONE. registry.request resolves {status: 0} for a
 * timeout or a socket error — it is not an HTTP code and it never reached
 * the FEC at all. Every retry list here excluded it, so a dropped connection
 * was treated as a permanent answer:
 *
 *     in  page 21/25 · 2100 rows
 *     Error: FEC returned 0 —
 *
 * Twenty-one pages of a candidate's Schedule A, thrown away on the one class
 * of failure that would almost certainly have succeeded on the next attempt.
 * The empty half of that message is res.body, because a socket error has no
 * body; what it actually knew was in res.error and was never printed.
 *
 * A transport failure is the MOST retryable thing that can happen, not the
 * least. 502 is here for the same reason: a gateway error is the proxy
 * talking, not the API.
 */
function fecRetryable(res) {
  return res.status === 0 || [429, 500, 502, 503, 504].includes(res.status);
}

/** What went wrong, from whichever field actually holds it. */
function fecError(res) {
  const detail = res.status === 0
    ? (res.error || 'connection failed before any response')
    : String(res.body || '').slice(0, 160);
  return res.status === 0
    ? `FEC request failed before a reply — ${detail}`
    : `FEC returned ${res.status} — ${detail}`;
}

/**
 * One retrying fetcher, instead of four that drifted apart.
 *
 * They had three different retry predicates between them and only one
 * printed anything while waiting, so whether a pull survived a hiccup
 * depended on which command you happened to run.
 */
function fecFetcher({ quiet = false } = {}) {
  return async function fetchJson(url) {
    let wait = 1500;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await R.request('GET', url, {});
      if (res.status === 200) return JSON.parse(res.body);
      if (!fecRetryable(res) || attempt === 5) throw new Error(fecError(res));
      if (!quiet) {
        const what = res.status === 0 ? (res.error || 'connection failed') : String(res.status);
        console.log(C.dim(`\n    ${what} — retrying in ${wait / 1000}s (${attempt}/4)`));
      }
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
    return null;
  };
}

async function resolveCommittee(nameOrId, key, fetchJson, cmd) {
  const F = require('./fecpac.js');
  const q = nameOrId.trim();
  if (/^C\d{8}$/i.test(q)) return q.toUpperCase();

  // A PLACEHOLDER, NOT A NAME. C00XXXXXXX is what documentation writes when
  // it means "the id you actually have", and it gets pasted verbatim. Sent
  // to the name search it returns "No committee of that name is registered
  // with the FEC" -- which is true of the string and useless to the reader,
  // because the answer to a typo should not look like a fact about the
  // register.
  if (/^C0{0,2}[X?#*_]{3,}$/i.test(q) || /^C\d*[X?#*]+\d*$/i.test(q)) {
    console.log(`\n  ${C.y(`"${q}" is a placeholder, not a committee id.`)}`);
    console.log(C.dim('  Nothing was searched. Committee ids are C followed by 8 digits.'));
    console.log(C.dim('  You can skip the id entirely and type the name:\n'));
    console.log(C.dim(`    sentinel connect ${cmd} "AMERICANS FOR PROSPERITY ACTION"\n`));
    process.exit(2);
  }

  const cmts = F.parseCommittees(await fetchJson(F.committeeSearchUrl(q, key)));
  if (!cmts.length) {
    console.log(`\n  ${C.y('No committee of that name is registered with the FEC.')}`);
    console.log(C.dim('  That is a fact about the register, not a failed search.\n'));
    process.exit(2);
  }
  if (cmts.length === 1) {
    console.log(C.dim(`\n  "${nameOrId}" → ${cmts[0].committee_id}  ${cmts[0].name}`));
    return cmts[0].committee_id;
  }
  console.log(`\n  ${C.b(`${cmts.length} committees match`)} "${nameOrId}"\n`);
  for (const c of cmts.slice(0, 12)) {
    console.log(`  ${C.g(c.committee_id)}  ${c.name}`);
    console.log(C.dim(`  ${' '.repeat(12)}${c.type}${c.designation ? ' · ' + c.designation : ''}`
      + `${c.first_file_date ? ' · first filed ' + c.first_file_date.slice(0, 10) : ''}`));
    // WHOSE it is, when the register says. "Leadership PAC" names a category,
    // not a person, and the obvious guess from the committee's name is the
    // inference this desk refuses everywhere else.
    const aff = require('./fecpac.js').affiliationOf(c);
    if (aff) console.log(`  ${' '.repeat(12)}${C.b(aff)}`);
  }
  if (cmts.length > 12) console.log(C.dim(`\n  …and ${cmts.length - 12} more.`));
  console.log(`\n  ${C.b('Nothing was measured.')} ${C.dim('Pick one:')}`);
  console.log(C.dim(`    sentinel connect ${cmd} --committee ${cmts[0].committee_id}`));
  console.log(C.dim('\n  A connected PAC and a super PAC under one name are governed by'));
  console.log(C.dim('  different rules and their money means different things.'));
  console.log(C.dim('  Choosing for you would be choosing the story.\n'));
  process.exit(2);
}

/**
 * connect donors — who funded a committee, and how much of it that is.
 *
 * `fecpac` reads Schedule B and E. Both are money OUT. Nothing here read
 * Schedule A for a committee, so "whose money is this" could not be asked —
 * and was asked anyway, of a super PAC with two candidates and one state.
 */
async function cmdDonors(opts = {}) {
  const DN = require('./donors.js');
  const F = require('./fecpac.js');
  const DG = require('./delegation.js');
  const env = R.loadEnv();
  const key = R.resolveKey(R.CONNECTORS.fec, env);
  if (!key) { console.error(`\n  ${C.r('FEC_API_KEY is not set.')}\n`); process.exit(2); }
  const now = new Date().getFullYear();
  const cycle = opts.cycle || (now % 2 === 0 ? now : now - 1);
  const fetchJson = fecFetcher();

  const committee = await resolveCommittee(opts.committee, key, fetchJson, 'donors');
  const cmts = F.parseCommittees(await fetchJson(
    `${F.API}/committees/?api_key=${encodeURIComponent(key)}`
    + `&committee_id=${encodeURIComponent(committee)}&per_page=1`));
  const name = cmts.length ? cmts[0].name : committee;
  console.log(`\n  ${C.b(name)}  ${C.dim(committee)}  cycle ${cycle}`);
  if (cmts.length) {
    console.log(C.dim(`  ${cmts[0].type}${cmts[0].designation ? ' · ' + cmts[0].designation : ''}`
      + `${cmts[0].first_file_date ? ' · first filed ' + cmts[0].first_file_date.slice(0, 10) : ''}`));
    const aff0 = F.affiliationOf(await F.resolveSponsors(cmts[0], key, fetchJson));
    if (aff0) console.log(`  ${C.b(aff0)}`);
  }
  if (opts.dryRun) { console.log(C.dim('\n  DRY RUN — nothing requested.\n')); return; }

  // The committee's own summary first. Without it there is no denominator
  // and every share below would be a share of an unknown quantity.
  let totals = null;
  try {
    totals = DG.parseTotals(await fetchJson(DG.totalsUrl(committee, cycle, key)));
  } catch (e) {
    console.log(C.y(`  summary totals unavailable — ${e.message}`));
  }

  console.log(C.dim('  reading Schedule A — money in …'));
  const a = await DN.collect(fetchJson,
    (li, ld) => DN.receiptsUrl(committee, cycle, key, li, ld),
    DN.parseReceipts, 25, 2600,
    (pg, got, total, cap) => process.stdout.write(
      `\r    page ${String(pg).padStart(2)}/${cap} · ${String(total).padStart(5)} rows`));
  process.stdout.write('\n');

  const s = DN.summarise(a.rows, totals, a.truncated);
  const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');

  if (!s.rows) {
    console.log(`\n  ${C.y('Schedule A is empty for this committee and cycle.')}`);
    console.log(C.dim('  That is one register saying nothing. A committee can be funded'));
    console.log(C.dim('  entirely below the $200 itemisation threshold, or have filed'));
    console.log(C.dim('  nothing yet.'));
    if (totals && totals.receipts > 0) {
      console.log(C.dim(`  Its own summary reports ${usd(totals.receipts)} in receipts, so`));
      console.log(C.dim('  the money exists and is simply not itemised here.'));
    }
    console.log('');
    return;
  }

  // COVERAGE BEFORE ANY NAME. A reader who sees the top donor first has
  // already formed the conclusion the coverage line is meant to qualify.
  const cv = s.coverage;
  const cColour = { near_complete: C.g, partial: C.y, thin: C.r,
    truncated: C.r, unknown: C.r, over_reported: C.r }[cv.verdict] || C.dim;
  console.log(`\n  ${C.b('How much of the money this can see')}`);
  console.log(`    ${cColour(cv.verdict.toUpperCase().replace('_', ' '))}`
    + (cv.share !== null ? `  ${cv.share}% of reported receipts` : ''));
  if (cv.receipts) console.log(`    receipts reported   ${usd(cv.receipts).padStart(15)}`);
  console.log(`    itemised here       ${usd(cv.itemised).padStart(15)}   ${s.rows} rows`);
  console.log('');
  for (const line of wrap(cv.note, 68)) console.log(C.dim(`    ${line}`));

  if (s.forwarded_total > 0) {
    console.log(`\n  ${C.b('Forwarded, not given')}  ${usd(s.forwarded_total)}`
      + C.dim(`  in ${s.forwarded_rows} memo row(s)`));
    console.log(C.dim('    Earmarked money passing through a conduit. The conduit is the'));
    console.log(C.dim('    filer, not the donor, and this is never its own giving.'));
  }

  console.log(`\n  ${C.b('Where the itemised money came from')}`);
  const givenTotal = s.by_kind.reduce((a, k) => a + k.amount, 0);
  for (const k of s.by_kind) {
    const share = givenTotal > 0 ? ((k.amount / givenTotal) * 100).toFixed(1) : '—';
    console.log(`    ${String(share).padStart(5)}%  ${usd(k.amount).padStart(15)}  ${k.kind}`
      + (k.refunded ? C.y(`   (${usd(k.refunded)} refunded)`) : ''));
  }
  // Refunds are money that came in and went back out. Netting them into a
  // category printed "-0.4%  $-4,351  candidate committees", which is not a
  // kind of giving, and could drop a refunded donor off the list entirely.
  if (s.refunds && s.refunds.rows) {
    console.log(`\n  ${C.y('Returned or redesignated')}  ${usd(s.refunds.total)}`
      + C.dim(`  in ${s.refunds.rows} negative row(s)`));
    for (const r of s.refunds.to.slice(0, 5)) {
      console.log(C.dim(`    ${usd(r.amount).padStart(12)}  ${r.name}`));
    }
    console.log(C.dim('    Counted apart from the totals above, not subtracted from'));
    console.log(C.dim('    them — money refunded still arrived, and a donor whose gift'));
    console.log(C.dim('    was returned must not vanish by netting to zero.'));
  }

  const top = s.donors.slice(0, opts.limit || 25);
  console.log(`\n  ${C.b(`Donors (${s.distinct_donors} distinct, top ${top.length})`)}`);
  console.log(C.dim('       direct     forwarded  n   donor'));
  for (const d of top) {
    console.log(`    ${usd(d.direct).padStart(13)}  ${(d.forwarded ? usd(d.forwarded) : '—').padStart(11)}`
      + `  ${String(d.rows).padStart(2)}  ${d.name}`);
    const meta = [d.kind, d.where, d.employer && `employer: ${d.employer}`]
      .filter(Boolean).join(' · ');
    if (meta) console.log(C.dim(`    ${' '.repeat(30)}${meta}`));
  }

  // The share-of-whole claim, allowed only when coverage earns it.
  const t = s.donors[0];
  if (t) {
    console.log('');
    if (s.can_state_share_of_whole) {
      const share = ((t.direct + t.forwarded) / cv.receipts * 100).toFixed(1);
      console.log(`  ${C.b('Largest donor')}  ${share}% of this committee's reported receipts`);
      console.log(C.dim(`    ${t.name} — ${usd(t.direct + t.forwarded)} of ${usd(cv.receipts)}`));
    } else {
      // Denominator is DIRECT itemised money. Adding the forwarded total
      // would count earmarked dollars twice and shrink every share.
      const share = cv.itemised > 0
        ? ((t.direct + t.forwarded) / cv.itemised * 100).toFixed(1) : '—';
      console.log(`  ${C.b('Largest donor')}  ${share}% ${C.y('OF THE ITEMISED MONEY ONLY')}`);
      console.log(C.dim(`    ${t.name} — ${usd(t.direct + t.forwarded)} of ${usd(cv.itemised)} itemised.`));
      console.log(C.dim('    NOT a share of the committee. The rest of its money is not in'));
      console.log(C.dim('    these rows and could change this number in either direction.'));
    }
  }

  if (a.truncated) {
    console.log(`\n  ${C.r('TRUNCATED — a page cap was reached. These are FLOORS.')}`);
  }
  console.log(`\n  ${C.dim('Verify:')} https://www.fec.gov/data/committee/${committee}/\n`);
}

async function cmdAsymmetry(opts = {}) {
  const A = require('./asymmetry.js');
  const F = require('./fecpac.js');
  const M = require('./member.js');
  const env = R.loadEnv();
  const key = R.resolveKey(R.CONNECTORS.fec, env);
  if (!key) { console.error(`\n  ${C.r('FEC_API_KEY is not set.')}\n`); process.exit(2); }
  const now = new Date().getFullYear();
  const cycle = opts.cycle || (now % 2 === 0 ? now : now - 1);
  const dim = A.DIMENSIONS[opts.dimension];
  if (!dim) {
    console.error(`\n  unknown dimension '${opts.dimension}'. `
      + `Known: ${Object.keys(A.DIMENSIONS).join(', ')}\n`);
    process.exit(2);
  }

  const fetchJson = fecFetcher();

  // A name is allowed here. It resolves to exactly one id or the command
  // stops -- see resolveCommittee.
  opts = { ...opts, committee: await resolveCommittee(opts.committee, key, fetchJson, 'asymmetry') };

  const cmts = F.parseCommittees(await fetchJson(
    `${F.API}/committees/?api_key=${encodeURIComponent(key)}`
    + `&committee_id=${encodeURIComponent(opts.committee)}&per_page=1`));
  const name = cmts.length ? cmts[0].name : opts.committee;
  console.log(`\n  ${C.b(name)}  ${C.dim(opts.committee)}  cycle ${cycle}`);
  console.log(C.dim(`  measuring: ${dim.label}`));
  if (opts.dryRun) { console.log(C.dim('\n  DRY RUN — nothing requested.\n')); return; }

  const page = (pg, got, total, cap) => process.stdout.write(
    `\r    page ${String(pg).padStart(2)}/${cap} · ${String(total).padStart(5)} rows`);

  let rows;
  if (opts.dimension === 'vendor') {
    const b = await F.collect(fetchJson,
      (li, ld) => F.disbursementsUrl(opts.committee, cycle, key, li, ld),
      F.parseDisbursements, 25, 400, page);
    process.stdout.write('\n');
    // A conduit's forwarded rows are not its own spending and would swamp
    // any vendor concentration with pass-through noise.
    rows = b.rows.filter((r) => !F.isEarmarked(r))
      .map((r) => ({ ...r, committee: name, committee_id: opts.committee }));
  } else {
    const e = await F.collect(fetchJson,
      (li, ld) => F.independentUrl(opts.committee, cycle, key, li, ld),
      F.parseIndependent, 25, 400, page);
    process.stdout.write('\n');
    rows = F.clampToCycle(e.rows, cycle).kept
      .map((r) => ({ ...r, by: name, by_committee_id: opts.committee }));
  }

  // Schedule E rows carry a stance; Schedule B (vendor) rows do not, and
  // inventing one there would be worse than leaving it unmeasured.
  const c = A.concentrate(rows, dim.target, {
    ...(opts.minRows ? { minRows: opts.minRows } : {}),
    ...(opts.dimension === 'vendor' ? {} : { side: (r) => r.stance }),
  });
  if (!c) {
    console.log(`\n  ${C.y('Nothing filed on this dimension for that cycle.')}`);
    console.log(C.dim('  An empty result is one source saying nothing.'));
    // A Leadership PAC gives money; it does not usually spend independently.
    // Schedule E being empty is the CORRECT answer for it, and leaving the
    // reader there implies the committee did nothing.
    if (opts.dimension !== 'vendor') {
      console.log(C.dim('\n  This reads Schedule E — INDEPENDENT EXPENDITURES. A committee'));
      console.log(C.dim('  that gives to candidates rather than advertising at them files'));
      console.log(C.dim('  none, and an empty Schedule E is the right answer for it:'));
      console.log(C.dim(`    sentinel connect fecpac --committee ${opts.committee} --cycle ${cycle}   # what it GAVE`));
      console.log(C.dim(`    sentinel connect donors --committee ${opts.committee} --cycle ${cycle}   # who funded it`));
    }
    console.log('');
    return;
  }

  const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
  console.log('');
  const colour = { single_target: C.r, concentrated: C.r, narrow: C.y,
    spread: C.g, too_small: C.dim, no_money: C.dim }[c.verdict] || C.dim;
  console.log(`  ${colour(c.verdict.toUpperCase().replace('_', ' '))}  `
    + C.dim(A.VERDICTS[c.verdict]));
  console.log('');
  console.log(`    rows              ${c.rows}`);
  console.log(`    total             ${usd(c.total)}`);
  console.log(`    distinct targets  ${c.targets}`);
  if (c.top) {
    console.log(`    largest           ${c.top_share}%  ${usd(c.top.amount)}  ${c.top.name}`);
    console.log(`    HHI               ${c.hhi}   `
      + C.dim(`≈ ${c.effective_targets} effective target(s)`));
  }
  console.log('');
  for (const line of wrap(c._caution, 70)) console.log(C.dim(`    ${line}`));

  if (c.sides) {
    const P = { support_only: 'every dollar SUPPORTED a candidate',
      opposition_only: 'every dollar was spent AGAINST a candidate',
      mostly_opposition: 'more against than for',
      mostly_support: 'more for than against' }[c.sides.posture];
    console.log(`\n  ${C.b('Which way it pointed')}   ${C.dim(P)}`);
    console.log(`    for      ${usd(c.sides.for).padStart(13)}`);
    console.log(`    against  ${usd(c.sides.against).padStart(13)}`);
  }

  if (c.breakdown && c.breakdown.length > 1) {
    console.log(`\n  ${C.b('Where it went')}`);
    const hasSides = !!c.sides;
    if (hasSides) console.log(C.dim('    share            total           for        against  candidate'));
    for (const b of c.breakdown) {
      const share = ((b.amount / c.total) * 100).toFixed(1);
      let line = `    ${String(share).padStart(5)}%  ${usd(b.amount).padStart(13)}`;
      if (hasSides) {
        // A blank, not a $0, where a side has nothing: zero is a measurement
        // and most of these rows are one-sided.
        line += `  ${(b.for ? usd(b.for) : '—').padStart(12)}`
          + `  ${(b.against ? C.r(usd(b.against)) : '—').padStart(b.against ? 21 : 13)}`;
      }
      console.log(`${line}  ${b.name}`);
    }
  }
  console.log(`\n  ${C.dim('Verify:')} https://www.fec.gov/data/committee/${opts.committee}/\n`);
}


async function cmdMember(name, opts = {}) {
  const M = require('./member.js');
  const env = R.loadEnv();
  const key = R.resolveKey(R.CONNECTORS.fec, env);
  if (!key) {
    console.error(`\n  ${C.r('FEC_API_KEY is not set.')}\n`);
    process.exit(2);
  }
  const now = new Date().getFullYear();
  const cycle = opts.cycle || (now % 2 === 0 ? now : now - 1);

  const fetchJson = fecFetcher();

  // ---- who, exactly. A name is not an identity.
  let picked = null;
  if (opts.candidate) {
    // LOOK THE ID UP. Synthesising a record here left committee_id empty and
    // the command reported that absence as a fact about the register.
    const byId = M.parseCandidateMatches(
      await fetchJson(M.candidateByIdUrl(opts.candidate, key)));
    if (!byId.length) {
      console.log(`\n  ${C.y(`${opts.candidate} is not a candidate id the FEC knows.`)}`);
      console.log(C.dim('  Ids look like S6OH00163 or H4FL20023. Drop the flag and'));
      console.log(C.dim('  search by name to see the register\'s spelling.\n'));
      process.exit(2);
    }
    picked = byId[0];
  } else {
    const matches = M.parseCandidateMatches(
      await fetchJson(M.candidateSearchUrl(name, key)));
    if (!matches.length) {
      console.log(`\n  ${C.y('No candidate of that name is registered with the FEC.')}\n`);
      return;
    }
    if (matches.length > 1 && !opts.candidate) {
      console.log(`\n  ${C.b('Candidates matching')} "${name}"\n`);
      for (const m of matches) {
        console.log(`  ${C.g(m.candidate_id)}  ${m.name}  ${C.dim(`${m.party} · ${m.office} `
          + `${m.state}${m.district && m.district !== '00' ? '-' + m.district : ''}`
          + `${m.incumbent ? ' · ' + m.incumbent : ''}`)}`);
      }
      console.log(`\n  ${C.b('Nothing was counted.')} ${C.dim('Pick one:')}`);
      console.log(C.dim(`    sentinel connect member "${name}" --candidate ${matches[0].candidate_id} --cycle ${cycle}`));
      console.log(C.dim('\n  A name is not an identity. Two people share one and one person'));
      console.log(C.dim('  files under several spellings; choosing for you would be'));
      console.log(C.dim('  choosing who the story is about.\n'));
      return;
    }
    picked = matches[0];
  }

  console.log(`\n  ${C.b(picked.name)}  ${C.dim(picked.candidate_id)}  cycle ${cycle}`);
  if (opts.dryRun) {
    console.log(C.dim('\n  DRY RUN — would read Schedule A (committee money in) and'));
    console.log(C.dim('  Schedule E (spending for and against).\n'));
    return;
  }

  const page = (label) => (pg, got, total, cap) => process.stdout.write(
    `\r    ${label} page ${String(pg).padStart(2)}/${cap} · ${String(total).padStart(5)} rows`);

  // The candidate record does not always carry the committee. Ask the other
  // way round before concluding there isn't one.
  if (!picked.committee_id) {
    const cc = M.parseCandidateCommittees(
      await fetchJson(M.candidateCommitteesUrl(picked.candidate_id, cycle, key)));
    if (cc.length) {
      picked = { ...picked, committee_id: cc[0].committee_id, committee_name: cc[0].name };
    }
  }

  let contribsIn = [];
  let inTrunc = false;
  if (picked.committee_id) {
    console.log(C.dim(`  reading Schedule A — committee money into ${picked.committee_name || picked.committee_id} …`));
    const a = await M.collect(fetchJson,
      (li, ld) => M.contributionsInUrl(picked.committee_id, cycle, key, li, ld),
      M.parseContributionsIn, 25, 400, page('in '));
    process.stdout.write('\n');
    contribsIn = a.rows; inTrunc = a.truncated;
  } else {
    // Two lookups have now failed to find one. That is worth saying plainly,
    // and worth separating from the reader's likely conclusion.
    console.log(C.y('  No principal campaign committee found for this candidate'));
    console.log(C.y(`  in cycle ${cycle}, by candidate record or by committee filter.`));
    console.log(C.dim('  Money IN is UNREAD, not zero. Everything below is Schedule E'));
    console.log(C.dim('  only, so OUTSIDE PRESSURE cannot be computed — it needs the'));
    console.log(C.dim('  denominator this absence removes.'));
    console.log(C.dim(`  Check by eye: https://www.fec.gov/data/candidate/${picked.candidate_id}/`));
  }

  console.log(C.dim('  reading Schedule E — spending for and against …'));
  const e = await M.collect(fetchJson,
    (li, ld) => M.independentUrl(picked.candidate_id, cycle, key, li, ld),
    M.parseIndependent, 25, 400, page('out'));
  process.stdout.write('\n');

  const ac = M.clampToCycle(contribsIn, cycle);
  const ec = M.clampToCycle(e.rows, cycle);
  const dropped = ac.dropped.length + ec.dropped.length;
  const orgs = M.byOrganisation(ac.kept, ec.kept);
  const s = M.summarise(ac.kept, ec.kept, orgs);

  const usd = (n) => (n ? '$' + Math.round(n).toLocaleString('en-US') : '—');
  console.log('');
  if (dropped) console.log(C.dim(`  ${dropped} row(s) outside cycle ${cycle} removed here.\n`));

  console.log(`  ${C.g(usd(s.to_them_own))}  TO THEM ${C.dim('— committee contributions into their account')}`);
  if (s.to_them_forwarded) {
    console.log(`  ${C.y(usd(s.to_them_forwarded))}  forwarded through conduits `
      + C.dim(`(${s.to_them_forwarded_rows} row(s)) — individuals' money, not the committees'`));
  }
  console.log(`  ${C.b(usd(s.for_them))}  FOR THEM ${C.dim(`— independent, ${s.for_them_rows} expenditure(s). They never received it`)}`);
  console.log(`  ${C.r(usd(s.against_them))}  AGAINST THEM ${C.dim(`— independent, ${s.against_them_rows} expenditure(s)`)}`);
  console.log(C.dim(`  ${s._no_grand_total}`));

  console.log('');
  if (s.contested_ratio === 0) {
    // Zero is a finding, not a gap: nothing defended them at all.
    console.log(`  CONTESTED RATIO   ${C.r('0.00')}  `
      + C.dim('NOTHING was spent for them — every outside dollar attacked'));
  } else if (s.contested_ratio !== null) {
    const c = s.contested_ratio;
    console.log(`  CONTESTED RATIO   ${C.b(c.toFixed(2))}  `
      + C.dim(c >= 0.8 && c <= 1.25 ? 'a genuinely fought seat — both sides spending'
        : c < 0.8 ? 'more spent against them than for them'
          : 'more spent for them than against them'));
  } else if (s.for_them > 0) {
    console.log(`  CONTESTED RATIO   ${C.dim('undefined')}  `
      + C.dim('nobody spent against them — an unopposed seat, not a contested one'));
  }
  if (s.outside_pressure !== null) {
    console.log(`  OUTSIDE PRESSURE  ${C.b(s.outside_pressure.toFixed(2) + 'x')}  `
      + C.dim(s.outside_pressure > 1
        ? 'MORE money moved around them than through them — none of it theirs to control'
        : 'their own account still carried more than outside groups spent'));
  }

  const rows = orgs.slice(0, 20);
  if (rows.length) {
    console.log(`\n  ${C.b('Every organisation touching this seat')} ${C.dim(`(${orgs.length} total, top 20)`)}`);
    console.log(C.dim('         gave    forwarded          for      against   organisation'));
    for (const o of rows) {
      const f = (n) => (n ? Math.round(n).toLocaleString('en-US') : '—');
      const multi = [o.gave + o.forwarded, o.spent_for, o.spent_against]
        .filter((v) => v > 0).length > 1;
      console.log(`  ${String(f(o.gave)).padStart(11)}${String(f(o.forwarded)).padStart(13)}`
        + `${String(f(o.spent_for)).padStart(13)}${String(f(o.spent_against)).padStart(13)}`
        + `   ${multi ? C.y('! ') : '  '}${o.name.slice(0, 40)}`);
    }
  }

  const both = M.twoColumn(orgs);
  if (both.length) {
    console.log(`\n  ${C.y('IN MORE THAN ONE DIRECTION')} — ${both.length} organisation(s)`);
    console.log(C.dim('  An organisation that gives to a member AND spends against them is'));
    console.log(C.dim('  a documented fact that wants an explanation. Pull the filings.'));
  }

  const single = orgs.filter((o) => o.spent_against > 0 && !o.gave && !o.forwarded && !o.spent_for);
  if (single.length) {
    console.log(`\n  ${C.dim('Spent ONLY against them, nothing else here:')}`);
    for (const o of single.slice(0, 8)) {
      console.log(`    ${usd(o.spent_against).padStart(12)}  ${o.name}`);
    }
    console.log(C.dim('  Whether that is a committee\'s whole purpose needs its own pull:'));
    console.log(C.dim(`    sentinel connect fecpac "NAME" --committee ID --cycle ${cycle}`));
  }

  if (inTrunc || e.truncated) {
    console.log(`\n  ${C.y('TRUNCATED')} — a page cap was reached. These are FLOORS.`);
  }
  console.log(`\n  ${C.dim('Verify:')} https://www.fec.gov/data/candidate/${picked.candidate_id}/\n`);

  if (opts.csv) {
    const out = [['organisation', 'committee_id', 'gave', 'forwarded',
      'spent_for', 'spent_against'].join(',')];
    for (const o of orgs) {
      out.push([JSON.stringify(o.name), o.committee_id, o.gave, o.forwarded,
        o.spent_for, o.spent_against].join(','));
    }
    fs.writeFileSync(opts.csv, out.join('\n') + '\n');
    console.log(`  ${C.g('csv')}  ${opts.csv}  (${orgs.length} row(s))\n`);
  }
}


async function cmdDelegation(state, opts = {}) {
  const D = require('./delegation.js');
  const env = R.loadEnv();
  const key = R.resolveKey(R.CONNECTORS.fec, env);
  if (!key) {
    console.error(`\n  ${C.r('FEC_API_KEY is not set.')}`);
    console.error(C.dim('  Free from https://api.data.gov/signup/ — DATA_GOV_API_KEY works too.\n'));
    process.exit(2);
  }
  const now = new Date().getFullYear();
  const cycle = opts.cycle || (now % 2 === 0 ? now : now + 1);

  if (opts.dryRun) {
    console.log(`\n  ${C.dim('DRY RUN — would sweep')} ${state} ${opts.offices.join('+')} cycle ${cycle}`);
    console.log(C.dim('    one call per office for the roster, one per committee for totals\n'));
    return;
  }

  const fetchJson = fecFetcher();

  console.log(`\n  ${C.b(state)} federal delegation · cycle ${cycle} · `
    + opts.offices.map((o) => D.OFFICES[o]).join(' + '));
  const out = await D.sweep(fetchJson, {
    state, offices: opts.offices, cycle, key, pace: 350,
    incumbentsOnly: opts.incumbentsOnly !== false,
    onStep: (kind, a, b, c) => {
      if (kind === 'candidates') process.stdout.write(`\r    roster ${D.OFFICES[a]} · ${b} candidate(s)      `);
      else process.stdout.write(`\r    totals ${String(b).padStart(3)}/${c} · ${String(a).slice(0, 34).padEnd(34)}`);
    },
  });
  process.stdout.write('\n\n');

  // --outside adds the two directions committee totals cannot see: money
  // spent FOR and AGAINST each seat by committees the member does not control.
  if (opts.outside) {
    console.log(C.dim('  reading Schedule E for each seat …'));
    await D.addOutside(fetchJson, out.rows, { cycle, key, pace: 300,
      onStep: (k, nm, i, n) => process.stdout.write(
        `\r    outside ${String(i).padStart(3)}/${n} · ${String(nm).slice(0, 34).padEnd(34)}`) });
    process.stdout.write('\n\n');
  }

  const money = (n) => (n ? '$' + Math.round(n).toLocaleString('en-US') : '—');
  const share = (n) => (n === null || n === undefined ? '  —  ' : `${String(n.toFixed(1)).padStart(5)}%`);

  console.log(C.dim(opts.outside
    ? '   PAC%      raised   spent FOR  spent AGST   ratio   member'
    : '   PAC%   from people      raised       spent   cash left   member'));
  for (const r of out.rows) {
    const c = r.candidate, a = r.audit;
    if (!r.totals) {
      console.log(`   ${C.dim('  —  ')}                                                  `
        + `${C.dim(c.name)} ${C.dim('(no committee totals filed)')}`);
      continue;
    }
    const inc = /incumbent/i.test(c.incumbent) ? C.g('*') : ' ';
    const seat = c.office === 'S' ? 'SEN' : `${c.district || '??'}`.padStart(3, '0');
    const hot = a.pac_share_of_contributed !== null && a.pac_share_of_contributed >= 50;
    const pacCol = hot ? C.y(share(a.pac_share_of_contributed))
      : share(a.pac_share_of_contributed);
    if (opts.outside) {
      const o = r.outside || {};
      const rat = (o.contested_ratio === null || o.contested_ratio === undefined)
        ? (o.against_them ? '  —  ' : '  ·  ')
        : (o.contested_ratio === 0 ? C.r(' 0.00')
          : String(o.contested_ratio.toFixed(2)).padStart(5));
      console.log(`  ${pacCol} ${money(r.totals.receipts).padStart(11)}`
        + ` ${money(o.for_them).padStart(11)}`
        + ` ${o.against_them ? C.r(money(o.against_them).padStart(11)) : '          —'}`
        + `   ${rat}   ${inc}${seat} ${c.party || '  '} ${c.name}`);
    } else {
      console.log(`  ${pacCol}`
        + ` ${share(a.individual_share_of_contributed)}`
        + ` ${money(r.totals.receipts).padStart(12)}`
        + ` ${money(r.totals.disbursements).padStart(11)}`
        + ` ${money(r.totals.cash_on_hand).padStart(11)}`
        + `  ${inc}${seat} ${c.party || '  '} ${c.name}`);
    }
    for (const f of (a.flags || [])) {
      console.log(C.dim(`         ${f.note}${f.amount ? ' — ' + money(f.amount) : ''}`));
    }
  }

  const s = out.summary;
  console.log('');
  console.log(`  ${C.b('DELEGATION')}  ${s.with_totals} of ${s.members} with totals filed`
    + (s.missing_totals ? C.dim(`  · ${s.missing_totals} without`) : ''));
  // election_year is who is ON THE BALLOT, not who holds the seat. A senator
  // mid-term does not appear in it at all — Ohio's 2026 sweep returns one
  // senator, not two, and a table headed "delegation" that is missing a
  // sitting member is wrong in the way nobody checks.
  const senators = out.rows.filter((r) => r.candidate.office === 'S').length;
  if (opts.offices.includes('S') && senators < 2) {
    console.log(C.y(`    ${senators} senator(s) here, not 2. election_year `
      + `${cycle} is who is ON THE BALLOT — a senator mid-term is not, and is`));
    console.log(C.y('    missing from this table. Check the other class with '
      + 'its own election year.'));
  }
  if (s.excluded_non_incumbent) {
    console.log(C.dim(`    ${s.excluded_non_incumbent} non-incumbent candidate(s) on the `
      + `${s.roster_size}-name cycle roster were left out — add --all for everyone.`));
  }
  console.log(`    raised        ${money(s.receipts)}`);
  console.log(`    spent         ${money(s.disbursements)}`);
  console.log(`    from PACs     ${money(s.pac_contributions)}`
    + (s.pac_share_of_contributed !== null
      ? `   (${s.pac_share_of_contributed}% of all contributions)` : ''));
  console.log(`    cash on hand  ${money(s.cash_on_hand)}`);
  console.log(C.dim(`    ${s._note}`));

  if (opts.outside) {
    const contested = out.rows.filter((r) => r.outside && r.outside.against_them > 0);
    const undefended = contested.filter((r) => r.outside.contested_ratio === 0);
    console.log('');
    console.log(`  ${contested.length} of ${out.rows.length} seat(s) had money spent AGAINST them`);
    if (undefended.length) {
      console.log(`  ${C.r(String(undefended.length))} of those had NOTHING spent for them  `
        + C.dim('— attacked and undefended'));
    }
    console.log(C.dim('  ratio is for-money over against-money. 0.00 means nothing defended'));
    console.log(C.dim('  them; a dot means nobody spent against them at all, which is a'));
    console.log(C.dim('  different seat and not necessarily a safer one.'));
  }

  console.log(`\n  ${C.dim('PAC% is committee money as a share of CONTRIBUTIONS — individuals plus')}`);
  console.log(C.dim('  committees plus party. Not of receipts, which include loans and'));
  console.log(C.dim('  transfers and would flatter anyone who lent their own campaign money.'));
  console.log(C.dim('  Only the PRINCIPAL campaign committee is counted. A leadership PAC is'));
  console.log(C.dim('  money raised to give to OTHER members and is a different question.'));
  console.log(C.dim(`  ${C.g('*')} marks an incumbent.\n`));

  if (opts.csv) {
    const rowsOut = [['name', 'party', 'office', 'district', 'incumbent',
      'committee_id', 'committee_name', 'receipts', 'disbursements',
      'individual_contributions', 'pac_contributions', 'party_contributions',
      'contributed', 'pac_share_of_contributed', 'cash_on_hand', 'loans',
      'transfers_in', 'to_other_committees', 'coverage_end_date'].join(',')];
    for (const r of out.rows) {
      const c = r.candidate, t2 = r.totals, a = r.audit;
      rowsOut.push([
        JSON.stringify(c.name), c.party, c.office, c.district, JSON.stringify(c.incumbent),
        c.committee_id, JSON.stringify(c.committee_name),
        t2 ? t2.receipts : '', t2 ? t2.disbursements : '',
        t2 ? t2.individual_contributions : '', t2 ? t2.pac_contributions : '',
        t2 ? t2.party_contributions : '',
        a ? a.contributed : '', a ? (a.pac_share_of_contributed ?? '') : '',
        t2 ? t2.cash_on_hand : '', t2 ? t2.loans : '', t2 ? t2.transfers_in : '',
        t2 ? t2.contributions_to_other_committees : '',
        t2 ? t2.coverage_end_date : '',
      ].join(','));
    }
    fs.writeFileSync(opts.csv, rowsOut.join('\n') + '\n');
    console.log(`  ${C.g('csv')}  ${opts.csv}  (${out.rows.length} row(s))\n`);
  }
}


async function cmdFecPac(name, opts = {}) {
  const F = require('./fecpac.js');
  const env = R.loadEnv();
  const key = R.resolveKey(R.CONNECTORS.fec, env);
  if (!key) {
    console.error(`\n  ${C.r('FEC_API_KEY is not set.')}`);
    console.error(C.dim('  Free from https://api.data.gov/signup/ — DATA_GOV_API_KEY works too.'));
    console.error(C.dim('  Put it in modules/pra/.env\n'));
    process.exit(2);
  }
  const cycle = opts.cycle || (new Date().getFullYear() % 2 === 0
    ? new Date().getFullYear() : new Date().getFullYear() - 1);

  // The FEC times out on wide schedule queries and answers 504 with a JSON
  // body saying so. Crashing on it loses every page already fetched and reads
  // as a bug in this tool rather than a slow query upstream.
  const fetchJson = fecFetcher();

  // ---- step one: which committee, exactly
  console.log(`\n  ${C.b('Committees matching')} "${name}"`);
  const cmts = F.parseCommittees(await fetchJson(F.committeeSearchUrl(name, key)));
  if (!cmts.length) {
    console.log(`\n  ${C.y('No committee of that name is registered with the FEC.')}`);
    console.log(C.dim('  That is a fact about the register, not a failed search: an'));
    console.log(C.dim('  organisation can lobby for decades without ever running a'));
    console.log(C.dim('  political committee. Check the LDA instead:'));
    console.log(C.dim(`    sentinel connect senatelda --registrant "${name}"\n`));
    return;
  }
  console.log('');
  for (const c of cmts) {
    console.log(`  ${C.g(c.committee_id)}  ${c.name}`);
    console.log(C.dim(`  ${' '.repeat(12)}${c.type}${c.designation ? ' · ' + c.designation : ''}`
      + `${c.first_file_date ? ' · first filed ' + c.first_file_date.slice(0, 10) : ''}`));
    // WHOSE it is, when the register says. "Leadership PAC" names a category,
    // not a person, and the obvious guess from the committee's name is the
    // inference this desk refuses everywhere else.
    const aff = require('./fecpac.js').affiliationOf(c);
    if (aff) console.log(`  ${' '.repeat(12)}${C.b(aff)}`);
  }

  if (!opts.committee) {
    console.log(`\n  ${C.b('Nothing was counted.')} ${C.dim('Pick one and run it:')}`);
    console.log(C.dim(`    sentinel connect fecpac "${name}" --committee ${cmts[0].committee_id} --cycle ${cycle}`));
    console.log(C.dim('\n  Several committees under one name usually means a connected PAC'));
    console.log(C.dim('  AND a super PAC. They are governed by different rules and their'));
    console.log(C.dim('  money means different things. Choosing for you would be'));
    console.log(C.dim('  choosing the story.\n'));
    return;
  }

  const picked = cmts.find((c) => c.committee_id === opts.committee);
  if (!picked) {
    console.log(`\n  ${C.y(opts.committee + ' is not among the committees matching that name.')}`);
    console.log(C.dim('  Pulling it anyway would answer a question you did not ask.\n'));
    process.exit(2);
  }

  if (opts.dryRun) {
    console.log(`\n  ${C.dim('DRY RUN — would request:')}`);
    console.log(C.dim(`    Schedule B (money out)          cycle ${cycle}`));
    console.log(C.dim(`    Schedule E (independent spend)  cycle ${cycle}\n`));
    return;
  }

  // ---- step two: the money, by category
  console.log(`\n  ${C.b(picked.name)}  ${C.dim(picked.committee_id)}  cycle ${cycle}`);
  console.log(C.dim('  reading Schedule B (money out) …'));
  const b = await F.collect(fetchJson,
    (li, ld) => F.disbursementsUrl(picked.committee_id, cycle, key, li, ld),
    F.parseDisbursements, 25, 400,
    (pg, got, total, cap) => process.stdout.write(
      `\r    page ${String(pg).padStart(2)}/${cap} · ${String(total).padStart(5)} rows` + (got ? '' : ' (empty)')));
  process.stdout.write('\n');
  let contribs = b.rows.filter(F.isContribution);

  console.log(C.dim('  reading Schedule E (independent expenditures) …'));
  const e = await F.collect(fetchJson,
    (li, ld) => F.independentUrl(picked.committee_id, cycle, key, li, ld),
    F.parseIndependent, 25, 400,
    (pg, got, total, cap) => process.stdout.write(
      `\r    page ${String(pg).padStart(2)}/${cap} · ${String(total).padStart(5)} rows` + (got ? '' : ' (empty)')));
  process.stdout.write('\n');

  // Enforce the cycle here regardless of what the API did with the filter.
  const bClamp = F.clampToCycle(contribs, cycle);
  const eClamp = F.clampToCycle(e.rows, cycle);
  const droppedTotal = bClamp.dropped.length + eClamp.dropped.length;
  contribs = bClamp.kept;
  e.rows = eClamp.kept;

  const split = F.splitConduit(contribs);
  const t = F.totals(contribs, e.rows);
  const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  // Does the total describe what the label says? Ask before printing it.
  const audit = F.auditContributions(contribs);
  const cycleB = F.auditCycle(b.rows, cycle);
  const cycleE = F.auditCycle(e.rows, cycle);
  const conduit = audit.some((f) => f.kind === 'over_cap' || f.kind === 'small_average');

  console.log('');
  if (conduit) {
    console.log(`  ${C.r('READ THIS BEFORE QUOTING THE NUMBER BELOW.')}`);
    for (const f of audit) {
      for (const line of wrap(f.note, 68)) console.log(C.y(`    ${line}`));
    }
    console.log(C.dim('    A conduit forwards money that individuals earmarked for a named'));
    console.log(C.dim('    candidate. It is their giving, disclosed under their names, moving'));
    console.log(C.dim('    through this committee — not the committee giving its own funds.'));
    console.log(C.dim('    Reported as the organisation\'s donation it is simply false, and'));
    console.log(C.dim('    it is the most common error made with this exact filing.'));
    console.log(C.dim(`    Check a row against https://www.fec.gov/data/committee/${picked.committee_id}/`));
    console.log('');
  }
  for (const f of [cycleB, cycleE].filter(Boolean)) {
    console.log(`  ${C.r('CYCLE FILTER DID NOT APPLY.')}`);
    for (const line of wrap(f.note, 68)) console.log(C.y(`    ${line}`));
    console.log('');
  }

  if (droppedTotal) {
    console.log(`  ${C.dim(`${droppedTotal} row(s) outside cycle ${cycle} were removed here — `
      + `the API returned them despite the filter.`)}`);
    console.log('');
  }

  // The two halves, never one number. This is the answer the flag alone
  // could not give: what the committee gave, and what it forwarded.
  if (split.forwarded_rows) {
    console.log(`  ${C.g(usd(split.own_usd))}`
      + `  the committee's OWN contributions, in ${split.own_rows} row(s)`);
    console.log(C.dim('        no memo code — money from its own funds. This is the'));
    console.log(C.dim('        figure that belongs in a sentence beginning with its name.'));
    console.log('');
    console.log(`  ${C.y(usd(split.forwarded_usd))}`
      + `  FORWARDED for individuals, in ${split.forwarded_rows} row(s)`
      + `  (${split.forwarded_share}% of rows)`);
    console.log(C.dim('        earmarked by named individuals and passed through. Their'));
    console.log(C.dim('        giving, disclosed under their names — not the committee\'s.'));
  } else {
    console.log(`  ${C.g(usd(t.contributions_usd))}`
      + `  in ${t.contributions_rows} DIRECT CONTRIBUTION(S) to other committees`);
    console.log(C.dim('        capped, itemised, attributable — the strong material'));
  }
  console.log('');
  console.log(`  ${C.y(usd(t.ie_support_usd))}`
    + `  spent FOR candidates, in ${t.ie_support_rows} independent expenditure(s)`);
  console.log(`  ${C.y(usd(t.ie_oppose_usd))}`
    + `  spent AGAINST candidates, in ${t.ie_oppose_rows} independent expenditure(s)`);
  console.log(C.dim('        NOT donations. Uncapped, may not legally be coordinated,'));
  console.log(C.dim('        and money spent against someone is not a gift to anyone.'));
  console.log('');
  console.log(C.dim('  These are NOT added together. A contribution and an independent'));
  console.log(C.dim('  expenditure are different events; one total describing both'));
  console.log(C.dim('  describes neither.'));

  // EVERY ROW READ MUST BE ACCOUNTED FOR.
  // TEAM HUSTED, a joint fundraising committee, returned 390 Schedule B rows
  // and this command printed "$0 in 0 DIRECT CONTRIBUTION(S)" — true of
  // contributions, false about the committee, and silent about 390 rows of
  // real money. A JFC's whole function is transferring to its participants,
  // and transfers are not coded as contributions.
  const res = F.residual(b.rows);
  if (res.rows) {
    console.log(`\n  ${C.b('The rest of Schedule B')}  ${C.dim(`${res.rows} row(s), ${usd(res.total)}`)}`);
    console.log(C.dim('    Not contributions and not earmarked pass-throughs. Grouped by'));
    console.log(C.dim('    the FEC\'s own disbursement code so you can read the codes'));
    console.log(C.dim('    rather than trust this tool\'s names for them.'));
    console.log('');
    for (const t2 of res.by_type.slice(0, 12)) {
      console.log(`    ${usd(t2.amount).padStart(14)}  ${String(t2.rows).padStart(4)} row(s)  ${C.b(t2.type)}`
        + (t2.example ? C.dim(`  e.g. ${t2.example.slice(0, 44)}`) : ''));
    }
    if (res.to_committees.length) {
      console.log(`\n  ${C.b('…of which, paid to other COMMITTEES')} `
        + C.dim('(top 15) — rent and payroll have no committee id,'));
      console.log(C.dim('    so these are the rows that name affiliates, participants or'));
      console.log(C.dim('    committee vendors. For a joint fundraiser, its PARTICIPANTS.'));
      for (const c2 of res.to_committees.slice(0, 15)) {
        console.log(`    ${usd(c2.amount).padStart(14)}  ${String(c2.rows).padStart(4)}  `
          + `${C.dim(c2.committee_id)}  ${c2.name}`);
      }
      console.log(C.dim('\n    A transfer is not a gift and not an endorsement. It is money'));
      console.log(C.dim('    moving between committees, and what it MEANS depends on the'));
      console.log(C.dim('    relationship the filings declare — read the Form 1.'));
    }
  }

  const rows = F.byRecipient(contribs, e.rows).slice(0, 25);
  if (rows.length) {
    console.log(`\n  ${C.b('By recipient')} ${C.dim('(top 25)')}`);
    console.log(C.dim(split.forwarded_rows
      ? '     own+fwd*         for      against   recipient   (*mixed — see above)'
      : '    contributed       for      against   recipient'));
    for (const r of rows) {
      const f = (n) => (n ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—');
      console.log(`    ${String(f(r.contributed)).padStart(11)}`
        + `${String(f(r.ie_support)).padStart(10)}`
        + `${String(f(r.ie_oppose)).padStart(13)}   ${r.name}`);
    }
  }

  if (b.truncated || e.truncated) {
    console.log(`\n  ${C.y('TRUNCATED')} — the page cap was reached, so these are FLOORS.`);
  }
  console.log(`\n  ${C.dim('What this does NOT include:')}`);
  console.log(C.dim('    Individual contributions from people affiliated with the'));
  console.log(C.dim('    organisation. The FEC records the individual, not the'));
  console.log(C.dim('    affiliation, so attributing those is an inference about who'));
  console.log(C.dim('    someone is — not a filing. It is not computed here.'));
  console.log(`\n  ${C.dim('Verify any row:')} https://www.fec.gov/data/committee/${picked.committee_id}/\n`);
}

async function cmdRegistrant(query, opts) {
  const name = 'senatelda';
  const c = R.CONNECTORS[name];
  const env = R.loadEnv();
  const key = R.resolveKey(c, env);
  const budget = Number.isFinite(opts.pages) && opts.pages > 0 ? opts.pages : 4;

  console.log('\n' + C.b('Senate LDA — filings BY a registrant'));
  console.log(`  registrant  ${query}`);
  console.log(`  asking      registrant_name  ${C.dim('(not client_name — a different question)')}`);
  console.log(`  key         ${key ? C.g('present') : C.y('none (anonymous)')}`);
  console.log(`  page budget ${budget} × 25 filings`);
  console.log('  boundary    every hit lands as a LEAD requiring a primary source');

  if (opts.dryRun) {
    console.log('\n  ' + C.y('DRY RUN — no network call made, nothing written.') + '\n');
    return;
  }

  const clients = new Map();
  let total = null;
  let fetched = 0;
  let pagesDone = 0;

  for (let page = 1; page <= budget; page++) {
    const out = await R.runConnector(name, query, { mode: 'registrant', page });
    if (!out.ok) {
      console.error(`\n  ${C.r(`page ${page} failed:`)} ${out.error}`);
      break;
    }
    pagesDone++;
    fetched += out.results.length;

    // The API's own total, read from the capture we just wrote.
    try {
      const body = JSON.parse(fs.readFileSync(out.capturePath, 'utf8'));
      if (Number.isFinite(body.count)) total = body.count;
      for (const r of body.results || []) {
        const cn = r.client && r.client.name;
        if (!cn) continue;
        if (!clients.has(cn)) clients.set(cn, 0);
        clients.set(cn, clients.get(cn) + 1);
      }
      if (!body.next) { console.log(C.dim(`\n  page ${page}: last page`)); break; }
    } catch (e) {
      console.error(`  ${C.y(`page ${page} captured but would not parse:`)} ${e.message}`);
    }
    console.log(C.dim(`  page ${page}: ${out.results.length} filings`));
  }

  if (!pagesDone) { console.log(`\n  ${C.r('Nothing fetched.')}\n`); return; }

  const pagesAvailable = total === null ? null : Math.ceil(total / 25);
  console.log(`\n  ${C.b('CLIENTS FOUND')}  ${clients.size}`);
  for (const [cn, n] of [...clients.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${cn}`);
  }

  console.log('');
  if (total !== null && pagesAvailable > pagesDone) {
    console.log(`  ${C.y('PARTIAL')} — fetched ${fetched} of ${total} filings `
      + `(${pagesDone} of ${pagesAvailable} pages).`);
    console.log(C.dim('  This client list is a FLOOR. There are almost certainly more.'));
    console.log(C.dim(`  For all of them:  sentinel connect senatelda --registrant "${query}" --pages ${pagesAvailable}`));
    console.log(C.dim(`  That is ${pagesAvailable} requests to a public API — it will take a while.`));
  } else if (total !== null) {
    console.log(`  ${C.g('COMPLETE')} — fetched ${fetched} of ${total} filings. `
      + 'This is every client this firm filed for.');
  } else {
    console.log(`  ${C.y('The API did not report a total, so coverage is unknown.')}`);
  }
  console.log(C.dim('\n  A filing is a sworn statement that this firm lobbied for this'));
  console.log(C.dim('  client. It is not evidence that the clients know each other.\n'));
  console.log(C.dim('  Now in your captures — fold them into the graph with:'));
  console.log(C.dim('    sentinel connect graph --push\n'));
}

/**
 * connect expand — turn every registrant you already have into a search.
 *
 * THE LOOP THIS CLOSES
 *   Searching a client tells you which firms filed for it. That is one hop.
 *   The firms' OTHER clients are the second hop, and they were invisible,
 *   because the connector only ever asked client_name. Every registrant in
 *   the library is therefore a question you have not asked.
 *
 *   This asks all of them, one page each, and reports only the clients that
 *   are NOT already in your library -- because the ones you have are what you
 *   searched to get here, and listing them back looks like a discovery.
 *
 * IT ANNOUNCES BEFORE IT DIALS
 *   Same rule as `connect all`: the number of live calls is stated up front
 *   and the work is sequential. A burst of parallel requests is how a free
 *   tier revokes a key.
 */
async function cmdExpand(opts) {
  const X = require('./crosslink.js');
  const captures = X.readCaptures(R.CAPTURES);
  if (!captures.length) {
    console.log(`\n  ${C.dim('No captures yet — nothing to expand from.')}\n`);
    return;
  }

  const { byName, edges } = X.index(captures);

  // Registrants already seen, most filings first: the ones you have most
  // evidence about are the ones worth asking about first.
  const seen = new Map();
  for (const e of edges) {
    const g = seen.get(e.registrant_key) || { name: e.registrant, filings: 0 };
    g.filings++;
    seen.set(e.registrant_key, g);
  }
  const registrants = [...seen.values()].sort((a, b) => b.filings - a.filings);
  if (!registrants.length) {
    console.log(`\n  ${C.dim('No lobbying registrants in the captures yet. Search a client first:')}`);
    console.log(C.dim('    sentinel connect senatelda "Amazon Data Services"\n'));
    return;
  }

  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 10;
  const targets = registrants.slice(0, limit);

  console.log('\n' + C.b('Expand — ask every registrant who else they file for'));
  console.log(`  registrants in library   ${registrants.length}`);
  console.log(`  asking about             ${targets.length}  ${C.dim(`(--limit ${limit})`)}`);
  console.log(`  ${C.b('live calls')}               ${C.b(String(targets.length))}  ${C.dim('one page each, sequential')}`);
  console.log('  boundary                 every hit lands as a LEAD requiring a primary source');

  if (opts.dryRun) {
    console.log(`\n  ${C.y('DRY RUN — no network call made, nothing written.')}`);
    for (const t of targets) console.log(C.dim(`    would ask: ${t.name}`));
    console.log('');
    return;
  }
  console.log('');

  // What is ALREADY in the library -- and that is not the same as the
  // co-occurrence index. Names dropped from byName still exist as edge
  // endpoints, so checking byName alone reported RWE and VERIZON as "new"
  // on every single run, forever, over filings that were already captured.
  const known = new Set(byName.keys());
  for (const e of edges) { known.add(e.client_key); known.add(e.registrant_key); }
  const found = [];
  let failed = 0;

  for (const t of targets) {
    const out = await R.runConnector('senatelda', t.name, { mode: 'registrant', page: 1 });
    if (!out.ok) {
      failed++;
      console.log(`  ${C.r('fail')}  ${t.name} — ${out.error}`);
      continue;
    }
    let total = null;
    const fresh = [];
    try {
      const body = JSON.parse(fs.readFileSync(out.capturePath, 'utf8'));
      if (Number.isFinite(body.count)) total = body.count;
      const uniq = new Set();
      for (const r of body.results || []) {
        const cn = r.client && r.client.name;
        if (!cn) continue;
        const k = X.normalise(cn);
        if (uniq.has(k)) continue;
        uniq.add(k);
        if (!known.has(k)) fresh.push(cn);
      }
    } catch (e) {
      console.log(`  ${C.y('kept but unparsed')}  ${t.name} — ${e.message}`);
      continue;
    }
    const totalTxt = total === null ? '?' : String(total);
    console.log(`  ${C.g('ok')}    ${t.name}  ${C.dim(`${totalTxt} filings total · ${fresh.length} new client(s) on page 1`)}`);
    for (const cn of fresh) found.push({ registrant: t.name, client: cn, registrantTotal: total });
  }

  console.log('');
  if (!found.length) {
    console.log(`  ${C.dim('No clients on the first page that you did not already have.')}`);
    console.log(C.dim('  Page 1 is the 25 most recent filings — go deeper on one firm with:'));
    console.log(C.dim('    sentinel connect senatelda --registrant "FIRM NAME" --pages 20\n'));
  } else {
    console.log(`  ${C.b('NEW NAMES')}  ${found.length}  ${C.dim('not previously in your library')}`);
    for (const f of found) {
      console.log(`    ${f.client}`);
      console.log(C.dim(`      via ${f.registrant}`));
    }
    console.log(C.dim('\n  These are clients of firms you were already looking at. That is a'));
    console.log(C.dim('  reason to look, not a connection to anything.'));
  }

  if (registrants.length > targets.length) {
    console.log(C.dim(`\n  ${registrants.length - targets.length} registrant(s) not asked about `
      + `— raise --limit to include them.`));
  }
  if (failed) console.log(C.dim(`  ${failed} call(s) failed.`));

  console.log(C.dim('\n  Only page 1 of each firm was fetched, so every client list here is a'));
  console.log(C.dim('  FLOOR. Fold what you got into the graph with:'));
  console.log(C.dim('    sentinel connect graph --push\n'));
}

/**
 * connect sweep SET — run a named subject list across every connector.
 *
 * The subject list lived in a document, which meant retyping twelve commands
 * and, in practice, running a slightly different list each time. A list you
 * cannot re-run identically is not a library, it is a memory.
 *
 * NOTHING RUNS WITHOUT --go.
 *   A sweep is connectors × subjects. Twelve subjects across nine connectors
 *   is over a hundred live calls to public services, and that is not a thing
 *   to set off by typing a word slightly wrong. The default prints the plan
 *   and the exact call count; --go performs it.
 *
 * A SUBJECT IS A SEARCH STRING.
 *   Putting a name in the list asserts nothing about it. It says only that
 *   the name is worth asking about, which is what a library is for.
 */
async function cmdSweep(setName, opts) {
  const file = path.join(__dirname, 'subjects.json');
  let sets;
  try { sets = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    console.error(`\n  ${C.r('Cannot read subjects.json:')} ${e.message}\n`);
    process.exit(2);
  }
  const names = Object.keys(sets).filter((k) => k !== '//');

  // A set is {into, note, subjects}. A bare array -- which is what a set added
  // without reading the existing shape looks like -- used to reach
  // `set.subjects.length` and die with
  //   TypeError: Cannot read properties of undefined (reading 'length')
  // which says nothing about subjects.json and sends you into a stack trace
  // instead of to the one line that is wrong.
  const malformed = names.filter((n) => !sets[n] || !Array.isArray(sets[n].subjects));
  if (malformed.length) {
    console.error(`\n  ${C.r('subjects.json is malformed')} — ${file}\n`);
    for (const n of malformed) {
      const got = Array.isArray(sets[n]) ? 'a bare array' : typeof sets[n];
      console.error(`    "${n}" has no subjects array (found ${got})`);
    }
    console.error('\n  Each set must be an object:');
    console.error('    "name": { "into": "folder", "note": "...", "subjects": ["A", "B"] }\n');
    process.exit(2);
  }

  if (!setName || !sets[setName]) {
    console.log(`\n  ${C.b('Subject sets')}  ${C.dim(file)}\n`);
    for (const n of names) {
      const st = sets[n];
      console.log(`    ${C.b(n.padEnd(14))} ${String(st.subjects.length).padStart(3)} subjects  ${C.dim('→ ' + st.into)}`);
      console.log(`    ${' '.repeat(14)} ${C.dim(st.note)}`);
    }
    console.log(`\n  ${C.dim('usage: sentinel connect sweep SET [--go]')}\n`);
    if (setName) process.exit(2);
    return;
  }

  const set = sets[setName];
  // Count what will ACTUALLY run, by the same rules cmdAll uses: a connector
  // that takes an identifier rather than a name is skipped, and so is one
  // whose key is not set. Announcing "108 calls" and making 63 is the same
  // class of wrong as announcing 63 and making 108 -- the number is either
  // the truth or it is decoration.
  const env = R.loadEnv();
  const runnable = [];
  const skipped = [];
  for (const [name, c] of Object.entries(R.CONNECTORS)) {
    if (c.freeText === false) { skipped.push([name, 'takes an identifier, not a name']); continue; }
    if (c.keyRequired && !R.resolveKey(c, env)) { skipped.push([name, `${c.keyVar} not set`]); continue; }
    runnable.push(name);
  }
  const perSubject = runnable.length;
  const totalCalls = perSubject * set.subjects.length;

  console.log('\n' + C.b(`Sweep — ${setName}`));
  console.log(`  ${C.dim(set.note)}`);
  console.log(`  subjects    ${set.subjects.length}`);
  console.log(`  filing to   evidence/investigations/${set.into}/`);
  console.log(`  ${C.b('live calls')}  ${C.b(String(totalCalls))}  ${C.dim(`${set.subjects.length} subjects × ${perSubject} calls`)}`);
  console.log('  boundary    every hit lands as a LEAD requiring a primary source\n');
  for (const sub of set.subjects) console.log(`    ${sub}`);
  if (skipped.length) {
    console.log('');
    for (const [name, why] of skipped) console.log(C.y(`    ${name.padEnd(18)} SKIPPED — ${why}`));
  }

  if (!opts.go) {
    console.log(`\n  ${C.b('Nothing ran.')} ${C.dim('This is the plan.')}`);
    console.log(`  ${C.dim('To run it:')}  sentinel connect sweep ${setName} --go`);
    console.log(C.dim(`  That is ${totalCalls} requests to public services, made one at a time.\n`));
    return;
  }

  console.log('');
  let done = 0;
  for (const sub of set.subjects) {
    done++;
    console.log(C.b(`\n  [${done}/${set.subjects.length}] ${sub}`));
    await cmdAll(sub, { into: set.into });
  }
  console.log(`\n  ${C.g('Sweep complete.')} ${C.dim('Fold it in with:')}`);
  console.log(C.dim('    sentinel connect crosslink'));
  console.log(C.dim('    sentinel connect graph --push\n'));
}

/**
 * connect brief "NAME" — everything the library holds about one entity.
 *
 * 465 captures is not a library you can read. Nothing in this desk turned
 * captured bytes back into something a person could sit down with, so the
 * evidence existed and the reading did not.
 *
 * WHAT THIS SEPARATES, AND WHY IT IS THE WHOLE POINT
 *   A lobbying filing is a sworn statement under 2 U.S.C. 1603-1604 that a
 *   named firm lobbied for a named client. A court docket is a real case with
 *   a real caption. A corporate registration is a filed fact about a legal
 *   entity. A federal award is money that moved.
 *
 *   A full-text search hit is none of those. It is a document that contained
 *   a string. Printed in the same list they all read as "evidence", so they
 *   are printed apart, and the weaker pile says what it is.
 *
 * NAME MATCHING IS NOT IDENTIFICATION
 *   `AWS PUBLIC POLICY LLC` registered in Oklahoma matches a search for AWS
 *   and is almost certainly not Amazon. This finds strings. Confirming that
 *   two matches are the same entity is work this cannot do, and the output
 *   says so rather than implying it did.
 */
async function cmdBrief(name, opts) {
  const X = require('./crosslink.js');
  if (!name) {
    console.error('\n  usage: sentinel connect brief "NAME"\n');
    process.exit(2);
  }
  const captures = X.readCaptures(R.CAPTURES);
  if (!captures.length) {
    console.log(`\n  ${C.dim('No captures yet.')}\n`);
    return;
  }

  const needle = String(name).toLowerCase();
  const key = X.normalise(name);

  // Two grades of match. Exact-after-folding is the strong one; a substring
  // is how INTERWEST CONSTRUCTION answers a search for RWE.
  const strong = [];
  const weak = [];
  const subjectsSeen = new Set();

  for (const cap of captures) {
    for (const r of cap.results) {
      const raw = String(r.name || r.title || '');
      if (!raw) continue;
      const low = raw.toLowerCase();
      if (!low.includes(needle)) continue;
      const row = { cap, r, raw };
      const parts = X.splitParties(raw).map((p) => X.normalise(p));
      if (parts.includes(key) || X.normalise(raw) === key) strong.push(row);
      else weak.push(row);
      subjectsSeen.add(cap.subject);
    }
  }

  console.log(`\n${C.b('Brief — ' + name)}`);
  console.log(`  ${captures.length} captures searched · ${strong.length + weak.length} mention(s)`);
  console.log(`  found under ${subjectsSeen.size} subject(s): ${C.dim([...subjectsSeen].sort().join(', ') || '—')}`);

  if (!strong.length && !weak.length) {
    console.log(`\n  ${C.y('Nothing in the library mentions that string.')}`);

    // Sources abbreviate, and court captions abbreviate hardest: the caption
    // is "Licking Hts. Local School Dist. Bd. of Edn.", so a search for
    // "Licking Heights" matches nothing while the case sits right there. A
    // literal search reporting "not found" over a document it is holding is
    // the worst answer this tool can give, so before saying nothing, try the
    // longest distinctive word and say what THAT finds.
    const words = String(name).split(/\s+/).filter((w) => w.length >= 4)
      .sort((a, b) => b.length - a.length);
    for (const w of words.slice(0, 3)) {
      const lw = w.toLowerCase();
      let hits = 0;
      const where = new Set();
      for (const cap of captures) {
        for (const r of cap.results) {
          const raw = String(r.name || r.title || '');
          if (raw.toLowerCase().includes(lw)) { hits++; where.add(cap.subject); }
        }
      }
      if (hits) {
        console.log(`\n  ${C.b(`"${w}"`)} appears ${hits} time(s), under: ${C.dim([...where].sort().join(', '))}`);
        console.log(C.dim(`    sentinel connect brief "${w}"`));
      }
    }
    console.log(C.dim(`\n  Or search for it live:  sentinel connect all "${name}"\n`));
    return;
  }

  const by = (rows, conn) => rows.filter((x) => x.cap.connector === conn);

  // ---- ASSERTED ------------------------------------------------------
  const lda = by(strong, 'senatelda').concat(by(weak, 'senatelda'));
  if (lda.length) {
    console.log(`\n  ${C.b('SWORN LOBBYING FILINGS')}  ${lda.length}`);
    console.log(C.dim('  A filing is a sworn statement that this firm lobbied for this client.'));
    const seen = new Set();
    for (const { r, raw } of lda) {
      const sig = `${raw}|${r.period || ''}|${r.amount || ''}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      console.log(`    ${raw}`);
      const bits = [r.period, r.amount ? `$${r.amount}` : null, r.issues].filter(Boolean);
      if (bits.length) console.log(C.dim(`      ${bits.join(' · ')}`));
      if (r.url) console.log(C.dim(`      ${r.url}`));
    }
    const dupes = lda.length - seen.size;
    if (dupes > 0) console.log(C.dim(`    (${dupes} duplicate filing row(s) collapsed)`));
  }

  // ---- FILED FACTS ---------------------------------------------------
  for (const [conn, label, note] of [
    ['opencorporates', 'CORPORATE REGISTRATIONS', 'A registration is a filed fact about a legal entity — not proof it is the same company as the others here.'],
    ['courtlistener', 'COURT DOCKETS', 'A real case with a real caption. Read the docket before characterising it.'],
    ['usaspending', 'FEDERAL AWARDS', 'Money that moved, to a named recipient.'],
  ]) {
    const rows = by(strong, conn).concat(by(weak, conn));
    if (!rows.length) continue;
    console.log(`\n  ${C.b(label)}  ${rows.length}`);
    console.log(C.dim(`  ${note}`));
    const seen = new Set();
    for (const { r, raw } of rows.slice(0, 40)) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      console.log(`    ${raw}`);
      const bits = [r.jurisdiction, r.incorporated, r.date, r.agency,
        r.amount ? `$${r.amount}` : null].filter(Boolean);
      if (bits.length) console.log(C.dim(`      ${bits.join(' · ')}`));
      if (r.url) console.log(C.dim(`      ${r.url}`));
    }
    if (rows.length > 40) console.log(C.dim(`    …and ${rows.length - 40} more, in the captures`));
  }

  // ---- WEAKEST -------------------------------------------------------
  const docs = by(strong, 'federalregister').concat(by(weak, 'federalregister'),
    by(strong, 'regulationsgov'), by(weak, 'regulationsgov'));
  if (docs.length) {
    console.log(`\n  ${C.b('DOCUMENTS THAT MENTION THE NAME')}  ${docs.length}`);
    console.log(C.y('  These are the WEAKEST thing here.'));
    console.log(C.dim('  A document containing a string is not a fact about the entity. A'));
    console.log(C.dim('  Federal Register notice matching four searches matched four times.'));
    for (const { raw, r } of docs.slice(0, 10)) {
      console.log(C.dim(`    ${raw.slice(0, 78)}`));
      if (r.date) console.log(C.dim(`      ${r.date}`));
    }
    if (docs.length > 10) console.log(C.dim(`    …and ${docs.length - 10} more`));
  }

  if (weak.length) {
    console.log(`\n  ${C.y(`${weak.length} of these matched only as a substring`)}`);
    console.log(C.dim('  e.g. a longer name containing yours. Kept and flagged, not dropped —'));
    console.log(C.dim('  dropping silently is the worse error.'));
  }

  console.log(`\n  ${C.dim('Every line here is a LEAD. A name match is not an identification, and')}`);
  console.log(`  ${C.dim('nothing above has been read. Pull the underlying document before any')}`);
  console.log(`  ${C.dim('of it is used, then put it in a case file:')}`);
  console.log(C.dim(`    sentinel case new CASE-ID "what you are claiming"\n`));
}

async function cmdSearch(name, query, opts) {
  const c = R.CONNECTORS[name];
  if (!c) {
    console.error(`unknown connector: ${name}`);
    console.error(`known: ${Object.keys(R.CONNECTORS).join(', ')}`);
    process.exit(2);
  }
  if (!query) {
    console.error(`usage: sentinel connect ${name} "QUERY"`);
    process.exit(2);
  }

  const env = R.loadEnv();
  // Same resolver as the runner and the key check. This read env[keyVar]
  // alone and would report a key MISSING that the search then used fine.
  const key = R.resolveKey(c, env);
  const keyMissing = c.keyRequired && !key;

  // ---- announce (even without a key: rehearsing must not require one) ---
  console.log('\n' + C.b(`${c.label} — authorized run`));
  console.log(`  subject     ${query}`);
  console.log(`  calls       ${c.calls} (exactly)`);
  console.log(`  request     ${c.describe(query)}`);
  console.log(`  key         ${key ? C.g('present, sent in Authorization header only')
    : (keyMissing ? C.r(`MISSING — set ${c.keyVar} in .env`)
      : (c.keyVar ? C.y('none (anonymous)') : C.dim('none needed')))}`);
  console.log('  boundary    every hit lands as a LEAD requiring a primary source');

  if (opts.dryRun) {
    console.log('\n  ' + C.y('DRY RUN — no network call made, nothing written.'));
    if (keyMissing) console.log('  ' + C.dim(`A live run needs ${c.keyVar}.`));
    console.log('');
    return;
  }
  if (keyMissing) {
    console.error(C.r(`\n  ${c.keyVar} is not set. Add it to .env (chmod 600) and try again.\n`));
    process.exit(2);
  }

  const out = await R.runConnector(name, query, { env });
  if (!out.ok) {
    console.error(C.r(`\n  ${out.error} — nothing written.`));
    if (out.status === 401 || out.status === 403) console.error('  The key was rejected. Run: sentinel connect test\n');
    else console.error('');
    process.exit(1);
  }

  console.log('\n  ' + C.g('run complete') + ' — 1 call made, as announced');
  console.log(`  capture     evidence/${path.relative(R.EVIDENCE, out.capturePath)}`);
  console.log(`  sha256      ${out.captureHash}`);
  console.log(`  ledger      evidence/${path.relative(R.EVIDENCE, R.LEDGER)}`);

  if (out.parseError) {
    console.log('\n  ' + C.y(`response captured but could not be parsed: ${out.parseError}`));
    console.log('  The bytes are on disk and hashed. Read the capture by hand.\n');
    return;
  }

  console.log('\n  ' + C.b(`${out.results.length} candidate lead(s)`));
  if (!out.results.length) {
    console.log(C.dim('  No hits. A clean result is not proof of absence — it is one source saying nothing.\n'));
    return;
  }
  for (const r of out.results.slice(0, 15)) {
    console.log(`\n    ${C.b(r.name)}`);
    for (const [k, v] of Object.entries(r)) {
      if (k === 'name' || v === '' || v === undefined || v === null) continue;
      const val = Array.isArray(v) ? v.join(', ') : String(v);
      if (val) console.log(`      ${k.padEnd(12)} ${val}`);
    }
  }
  if (out.results.length > 15) console.log(C.dim(`\n    …and ${out.results.length - 15} more (all in the capture)`));

  console.log('\n  ' + C.y('These are LEADS, not findings.'));
  console.log(C.dim('  A name match is not an identification. Before any of this is used:'));
  console.log(C.dim('    1. confirm you have the same individual or entity, not a namesake'));
  console.log(C.dim('    2. pull the underlying official listing or docket document'));
  console.log(C.dim('    3. cite that document, not this search result'));
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { dryRun: argv.includes('--dry-run') };
  const args = argv.filter((a) => !a.startsWith('--'));
  const action = args[0] || 'test';

  if (action === 'test') return cmdTest();
  if (action === 'list') return cmdList();
  if (action === 'crosslink') return cmdCrosslink({ verbose: argv.includes('--verbose') });
  if (action === 'lobby') {
    // --chart writes to the default path; --chart <path> or --chart=<path>
    // writes where you say. A bare --chart followed by another flag is the
    // default, not a path — absorbing "--verbose" as a filename is exactly
    // the class of silent corruption that broke `--into`.
    let chart = false;
    const i = argv.findIndex((a) => a === '--chart' || a.startsWith('--chart='));
    if (i >= 0) {
      if (argv[i].startsWith('--chart=')) chart = argv[i].slice('--chart='.length);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) chart = argv[i + 1];
      else chart = true;
    }
    return cmdLobby({ verbose: argv.includes('--verbose'), chart });
  }
  if (action === 'graph') {
    const flagVal = (name) => {
      const i = argv.findIndex((a) => a === name || a.startsWith(name + '='));
      if (i < 0) return false;
      if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1);
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
      return true;
    };
    return cmdGraph({
      push: argv.includes('--push'),
      allowRemote: argv.includes('--allow-remote'),
      dashboard: flagVal('--dashboard'),
      sideA: typeof flagVal('--side-a') === 'string' ? flagVal('--side-a') : null,
      sideB: typeof flagVal('--side-b') === 'string' ? flagVal('--side-b') : null,
    });
  }
  if (action === 'all') {
    const parsed = parseAllArgs(argv.slice(1));
    if (parsed.error) {
      console.error(`\n  ${C.r(parsed.error)}\n`);
      process.exit(2);
    }
    return cmdAll(parsed.subject, parsed.opts);
  }
  // --registrant turns the senatelda search around: "who does this firm file
  // for" rather than "who filed for this company".
  if (action === 'brief') return cmdBrief(args.slice(1).join(' '), {});
  if (action === 'sweep') {
    return cmdSweep(args[1], { go: argv.includes('--go') });
  }
  if (action === 'expand') {
    const li = argv.indexOf('--limit');
    return cmdExpand({
      limit: li >= 0 && argv[li + 1] ? parseInt(argv[li + 1], 10) : undefined,
      dryRun: opts.dryRun,
    });
  }
  if (action === 'donors') {
    const cycle = flagNum(argv, '--cycle');
    const committee = flagVal(argv, '--committee')
      || subjectFrom(args.slice(1), argv, ['--cycle', '--limit']);
    if (!committee) {
      console.error('\n  usage: sentinel connect donors "COMMITTEE NAME" [--cycle 2026]');
      console.error('     or: sentinel connect donors --committee C00… [--cycle 2026]');
      console.error('\n  Who funded this committee — Schedule A, money IN.');
      console.error('\n  Schedule A itemises above $200 only, so the answer is always');
      console.error('  partial. The command reports what share of the committee\'s');
      console.error('  reported receipts it can actually see, and refuses to state a');
      console.error('  share of the whole when that share is low.\n');
      process.exit(2);
    }
    return cmdDonors({ committee, cycle,
      limit: flagNum(argv, '--limit'), dryRun: opts.dryRun });
  }
  if (action === 'asymmetry') {
    const cycle = flagNum(argv, '--cycle');
    const dim = flagVal(argv, '--dimension') || 'candidate';
    // A NAME or an id, positionally or behind --committee. Requiring the id
    // meant every run started with a lookup somewhere else.
    const committee = flagVal(argv, '--committee')
      || subjectFrom(args.slice(1), argv, ['--cycle', '--dimension', '--min-rows']);
    if (!committee) {
      console.error('\n  usage: sentinel connect asymmetry "COMMITTEE NAME" [--cycle 2024]');
      console.error('     or: sentinel connect asymmetry --committee C00… [--cycle 2024]');
      console.error('                                      [--dimension candidate|vendor]');
      console.error('\n  How concentrated is this committee\'s spending, and on what.');
      console.error('\n  A name resolves to one committee or the command stops and lists');
      console.error('  the matches. It will not pick between a connected PAC and a');
      console.error('  super PAC for you.\n');
      process.exit(2);
    }
    return cmdAsymmetry({ committee, cycle, dimension: dim,
      minRows: flagNum(argv, '--min-rows'), dryRun: opts.dryRun });
  }
  if (action === 'member') {
    const cycle = flagNum(argv, '--cycle');
    const cand = flagVal(argv, '--candidate');
    const q = subjectFrom(args.slice(1), argv, ['--cycle', '--candidate', '--csv']);
    if (!q && !cand) {
      console.error('\n  usage: sentinel connect member "NAME" [--cycle 2024]');
      console.error('  Every direction outside money moves around one politician.\n');
      process.exit(2);
    }
    return cmdMember(q, { cycle, candidate: cand, csv: flagVal(argv, '--csv'),
      dryRun: opts.dryRun });
  }
  if (action === 'delegation') {
    const state = (args[1] || '').toUpperCase();
    const cycle = flagNum(argv, '--cycle');
    if (!/^[A-Z]{2}$/.test(state)) {
      console.error('\n  usage: sentinel connect delegation OH [--cycle 2026] [--house] [--senate]');
      console.error('                                        [--all] [--outside] [--csv FILE]');
      console.error('  Sweeps every federal candidate for that state and audits their money.\n');
      process.exit(2);
    }
    const offices = [];
    if (argv.includes('--senate')) offices.push('S');
    if (argv.includes('--house')) offices.push('H');
    return cmdDelegation(state, {
      cycle, offices: offices.length ? offices : ['S', 'H'],
      csv: flagVal(argv, '--csv'), dryRun: opts.dryRun,
      incumbentsOnly: !argv.includes('--all'),
      outside: argv.includes('--outside'),
    });
  }
  if (action === 'fecpac') {
    // `args` is argv with --flags filtered out, which drops `--committee` and
    // KEEPS the id after it. Joining args into the organisation name therefore
    // searched the FEC for "AIPAC C00879080 2024" and reported, calmly, that no
    // committee of that name exists. The flag and its VALUE come out together
    // -- exactly the defect the comment forty lines below already describes for
    // `--into`, reintroduced here because I read the fix and not the reason.
    const cycle = flagNum(argv, '--cycle');
    const committee = flagVal(argv, '--committee');
    const q = subjectFrom(args.slice(1), argv, ['--cycle', '--committee']);
    if (!q) {
      console.error('\n  usage: sentinel connect fecpac "ORGANISATION" [--committee C00… --cycle 2024]');
      console.error('  Without --committee it only resolves the name and stops.\n');
      process.exit(2);
    }
    return cmdFecPac(q, { cycle, committee, dryRun: opts.dryRun });
  }
  if (argv.includes('--registrant')) {
    const i = argv.indexOf('--registrant');
    const q = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : args.slice(1).join(' ');
    const pi = argv.indexOf('--pages');
    const pages = pi >= 0 && argv[pi + 1] ? parseInt(argv[pi + 1], 10) : undefined;
    if (!q) {
      console.error('usage: sentinel connect senatelda --registrant "FIRM NAME" [--pages N]');
      process.exit(2);
    }
    return cmdRegistrant(q, { pages, dryRun: opts.dryRun });
  }
  // Flags must not survive into the subject. `connect courtlistener "X"
  // --into new-albany` searched for "X new-albany" and returned Mississippi
  // murder cases -- the same corruption that made `--into data center` search
  // for "vadata center", fixed once in `connect all` and never here.
  // NOTE ON WHY THIS READS argv AND NOT args.
  //   `args` is argv with --flags filtered out, which drops `--into` and
  //   KEEPS `new-albany`. That leftover value is what landed in the subject.
  //   The flag and its value have to be removed together, which means
  //   walking the original argv where the pairing is still visible.
  const positional = (fromIndex) => {
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
  const intoOf = (list) => {
    const i = list.indexOf('--into');
    return i >= 0 && list[i + 1] && !list[i + 1].startsWith('--') ? list[i + 1] : null;
  };

  if (action === 'search') {
    return cmdSearch(args[1], positional(2).join(' '),
      Object.assign({}, opts, { into: intoOf(argv) }));
  }
  if (R.CONNECTORS[action]) {
    return cmdSearch(action, positional(1).join(' '),
      Object.assign({}, opts, { into: intoOf(argv) }));
  }

  console.error(`unknown action: ${action}`);
  console.error('usage: cli.js test | list | all "SUBJECT" [--into INV] | crosslink | lobby [--chart] | search <connector> "QUERY" [--dry-run]');
  process.exit(2);
}

// Only run when invoked directly. Without this guard, `require`-ing the module
// to test verdictFor() fires a live run of every connector as a side effect.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { verdictFor, cmdTest, wrap, parseAllArgs, cmdLobby, cmdGraph, cmdRegistrant, cmdExpand, cmdSweep, cmdBrief, flagVal, flagNum, subjectFrom, resolveCommittee, fecRetryable, fecError, fecFetcher };
