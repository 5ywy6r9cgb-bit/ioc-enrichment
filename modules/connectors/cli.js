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
    const key = c.keyVar ? (env[c.keyVar] || '') : '';
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
  const key = c.keyVar ? (env[c.keyVar] || '') : '';
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
  if (action === 'all') {
    const parsed = parseAllArgs(argv.slice(1));
    if (parsed.error) {
      console.error(`\n  ${C.r(parsed.error)}\n`);
      process.exit(2);
    }
    return cmdAll(parsed.subject, parsed.opts);
  }
  if (action === 'search') return cmdSearch(args[1], args.slice(2).join(' '), opts);
  if (R.CONNECTORS[action]) return cmdSearch(action, args.slice(1).join(' '), opts);

  console.error(`unknown action: ${action}`);
  console.error('usage: cli.js test | list | all "<subject>" [--into INV] | search <connector> "<query>" [--dry-run]');
  process.exit(2);
}

// Only run when invoked directly. Without this guard, `require`-ing the module
// to test verdictFor() fires a live run of every connector as a side effect.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { verdictFor, cmdTest, wrap, parseAllArgs };
