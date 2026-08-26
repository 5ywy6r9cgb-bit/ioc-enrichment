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

  if (!subject.length) return { error: 'no subject. usage: connect all "<subject>" [--into <name>]' };

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
    console.error('\n  usage: sentinel connect all "<subject>" [--into <investigation>]\n');
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
  if (opts.into) console.log(`  filing to   evidence/investigations/${opts.into}/`);
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
    console.log(C.dim('    sentinel connect all "<subject>" --into <name>\n'));
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
  console.log(C.dim('\n  Open a case for what survives:  sentinel case new <ID> "..."\n'));
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
 * connect senatelda --registrant "<firm>" — every client a firm files for.
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
    console.log(C.dim('    sentinel connect senatelda --registrant "<firm>" --pages 20\n'));
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

async function cmdSearch(name, query, opts) {
  const c = R.CONNECTORS[name];
  if (!c) {
    console.error(`unknown connector: ${name}`);
    console.error(`known: ${Object.keys(R.CONNECTORS).join(', ')}`);
    process.exit(2);
  }
  if (!query) {
    console.error(`usage: sentinel connect ${name} "<query>"`);
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
    return cmdGraph({
      push: argv.includes('--push'),
      allowRemote: argv.includes('--allow-remote'),
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
  if (action === 'expand') {
    const li = argv.indexOf('--limit');
    return cmdExpand({
      limit: li >= 0 && argv[li + 1] ? parseInt(argv[li + 1], 10) : undefined,
      dryRun: opts.dryRun,
    });
  }
  if (argv.includes('--registrant')) {
    const i = argv.indexOf('--registrant');
    const q = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : args.slice(1).join(' ');
    const pi = argv.indexOf('--pages');
    const pages = pi >= 0 && argv[pi + 1] ? parseInt(argv[pi + 1], 10) : undefined;
    if (!q) {
      console.error('usage: sentinel connect senatelda --registrant "<firm>" [--pages N]');
      process.exit(2);
    }
    return cmdRegistrant(q, { pages, dryRun: opts.dryRun });
  }
  if (action === 'search') return cmdSearch(args[1], args.slice(2).join(' '), opts);
  if (R.CONNECTORS[action]) return cmdSearch(action, args.slice(1).join(' '), opts);

  console.error(`unknown action: ${action}`);
  console.error('usage: cli.js test | list | all "<subject>" [--into INV] | crosslink | lobby [--chart] | search <connector> "<query>" [--dry-run]');
  process.exit(2);
}

// Only run when invoked directly. Without this guard, `require`-ing the module
// to test verdictFor() fires a live run of every connector as a side effect.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { verdictFor, cmdTest, wrap, parseAllArgs, cmdLobby, cmdGraph, cmdRegistrant, cmdExpand };
