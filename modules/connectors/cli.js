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
const RECENCY = require('./recency.js');
const FSCAN = require('./farascan.js');

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

/**
 * `sentinel connect foreign` — who owns the companies that lobby Congress.
 *
 * Reads captures already on disk. No network call, so it costs nothing and can
 * be re-run after every senatelda pull.
 */
function cmdForeign(opts = {}) {
  const F = require('./foreign.js');
  console.log(`\n  ${C.b('FOREIGN OWNERSHIP DECLARED IN LOBBYING FILINGS')}`);

  const { filings, captures, unparsed } = F.readFilings(R.CAPTURES);
  if (!filings.length) {
    console.log(C.y('\n  No Senate LDA captures on disk yet.'));
    console.log(C.dim('  Pull a firm\'s book first:'));
    console.log(C.dim('    bin/sentinel connect senatelda --registrant "FIRM NAME" --pages 20\n'));
    return;
  }

  const { clients, byCountry, flags, totals } = F.collect(filings);

  // ── COVERAGE FIRST, ALWAYS ────────────────────────────────────────────
  // Every number below is drawn from what the operator happened to search.
  // Said here, before any finding, because a denominator quoted after a
  // result reads as a caveat and a denominator quoted before it is a fact.
  console.log(C.dim(`  ${captures} capture(s) · ${totals.filings.toLocaleString()} distinct filing(s)`
    + ` · no network call`));
  if (unparsed) console.log(C.y(`  ${unparsed} capture(s) would not parse and are NOT in this analysis`));
  console.log(C.dim(`  ${totals.withForeign} filing(s) declared a foreign owner`
    + `  ·  ${totals.clientsWithForeign} distinct client(s)`));
  console.log(C.dim(`  ${totals.foreignPPB} filing(s) list a principal place of business outside the US`
    + (totals.unknownPPB ? `  ·  ${totals.unknownPPB} did not state one` : '')));
  console.log(C.dim(`  ${totals.govClients} filing(s) name a government client`));
  console.log(C.y('\n  THIS IS A FLOOR, NOT A CENSUS. It covers the filings you have pulled,'));
  console.log(C.dim('  not the LDA. A company absent here has not been shown to declare nothing.'));

  // ── by country ────────────────────────────────────────────────────────
  const roll = F.countryRollup(byCountry);
  if (roll.length && !opts.client) {
    console.log(`\n  ${C.b('DECLARED OWNER COUNTRIES')}  ${C.dim('(counted in clients, not filings)')}`);
    for (const r of roll.slice(0, opts.verbose ? 999 : 20)) {
      console.log(`    ${String(r.clients).padStart(4)}  ${r.country}`);
    }
    if (!opts.verbose && roll.length > 20) {
      console.log(C.dim(`    …and ${roll.length - 20} more (--verbose for all)`));
    }
  }

  // ── client → owner, with the chain the filer wrote ────────────────────
  const rows = F.clientRows(clients, opts);
  if (!rows.length) {
    console.log(C.y('\n  No client matches that filter.'));
    console.log(C.dim('  That is a fact about your filter and your captures, not about the LDA.\n'));
    return;
  }
  console.log(`\n  ${C.b('CLIENT AND ITS DECLARED FOREIGN OWNERS')}`);
  for (const row of rows.slice(0, opts.verbose ? 999 : 25)) {
    console.log(`\n    ${C.b(row.client.slice(0, 62))}`
      + (row.government ? C.y('  [government client]') : '')
      + C.dim(`  ${row.filings} filing(s)`));
    for (const o of row.owners) {
      const pct = o.pct === null ? '   ?' : `${String(Number(o.pct).toFixed(0)).padStart(3)}%`;
      console.log(`      ${C.g(pct)}  ${o.display.slice(0, 52).padEnd(54)}`
        + C.dim(`[${o.country || 'no country given'}]`));
      // The filer's own words about the structure. This is the most valuable
      // text in the record and it lives inside a name field.
      if (o.chain) {
        console.log(C.dim(`             via ${o.chain.pct}% of ${o.chain.via.slice(0, 60)}`));
      } else if (o.note) {
        console.log(C.dim(`             ${o.note.slice(0, 72)}`));
      }
    }
  }
  if (!opts.verbose && rows.length > 25) {
    console.log(C.dim(`\n    …and ${rows.length - 25} more client(s) (--verbose for all)`));
  }

  // ── what is wrong with the data, said out loud ────────────────────────
  const anyFlag = flags.domesticInForeignField.length || flags.selfReference.length
    || flags.zeroPercent.length;
  if (anyFlag) {
    console.log(`\n  ${C.y('READ THESE BEFORE CITING ANY ROW ABOVE')}`);
    if (flags.domesticInForeignField.length) {
      console.log(C.dim(`\n    ${flags.domesticInForeignField.length} row(s) name a US country INSIDE the foreign-entity field.`));
      console.log(C.dim('    The field UNDERSTATES foreignness there — a foreign parent disclosed'));
      console.log(C.dim('    through its US arm. Do not read them as domestic:'));
      for (const f of flags.domesticInForeignField.slice(0, opts.verbose ? 999 : 4)) {
        console.log(C.dim(`      ${f.client.slice(0, 34)}  <=  ${f.owner.slice(0, 40)}`));
      }
    }
    if (flags.selfReference.length) {
      console.log(C.dim(`\n    ${flags.selfReference.length} row(s) name the CLIENT ITSELF as its own foreign owner.`));
      console.log(C.dim('    Either a filer shortcut for a foreign parent of the same name, or a'));
      console.log(C.dim('    junk row. This tool will not decide which — read the filing:'));
      for (const f of flags.selfReference.slice(0, opts.verbose ? 999 : 4)) {
        console.log(C.dim(`      ${f.client.slice(0, 34)}  [${f.country}]`));
      }
    }
    if (flags.zeroPercent.length) {
      console.log(C.dim(`\n    ${flags.zeroPercent.length} row(s) declare 0.00% ownership.`));
      console.log(C.dim('    That is a declared foreign INTEREST that is not equity — a coalition'));
      console.log(C.dim('    member, a fund. Counting it as ownership would be false; dropping it'));
      console.log(C.dim('    would hide a disclosure. It is shown with its stated 0%.'));
    }
  }

  console.log('\n' + C.dim('  ' + '─'.repeat(74)));
  console.log(C.y('  OWNERSHIP IS NOT CONTROL, AND IT IS NOT AGENCY.'));
  console.log(C.dim('  A declared foreign owner says nothing about who directed the lobbying,'));
  console.log(C.dim('  what position was taken, or whether any government was involved. The'));
  console.log(C.dim('  disclosure exists so that the ownership is NOT a secret — reporting it'));
  console.log(C.dim('  as though it were is the easiest false claim available here.'));
  console.log(C.dim('\n  22 U.S.C. 613(h) is why this lives in the LDA and not in FARA: an agent'));
  console.log(C.dim('  who registers under the LDA for a foreign principal that is not a foreign'));
  console.log(C.dim('  government or political party is exempt from FARA registration.\n'));
}

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
    + `${subjects.length} subject(s) · no network call`));

  // ---- is what we read COMPLETE? ---------------------------------------
  //
  // Every count below is drawn from these captures. Whether a capture holds
  // everything its source had is a fact about coverage, and it belongs above
  // the findings rather than nowhere. Three states: cut short, complete, and
  // the source never said — which is not the same as complete.
  const cut = captures.filter((c) => c.truncated === true).length;
  const dunno = captures.filter((c) => c.truncated === null && !c.unparsed).length;
  if (cut || dunno) {
    const parts = [];
    if (cut) parts.push(`${cut} held fewer rows than the source reported`);
    if (dunno) parts.push(`${dunno} reported no usable total, so completeness is UNKNOWN`);
    console.log(C.y(`  coverage: ${parts.join(' · ')}`));
    console.log(C.dim('  Every count below is a floor.'));
  }
  console.log('');

  const { byName, edges, phraseSubjects } = X.index(captures);

  // ---- the improbable overlaps, before the big ones ---------------------
  //
  // Ordered FIRST and deliberately. `sharedRegistrants` below sorts by client
  // count, so ALPINE GROUP PARTNERS (398 clients) heads it on every run of
  // every investigation forever, followed by twenty more mega-firms. A firm
  // that represents four hundred clients carrying two of your subjects is the
  // least surprising row in the data; the six-client shop carrying both a
  // utility and a data-center operator is the story, and it was on page three.
  const conc = X.concentrated(edges, { minClients: 2, minSubjects: 2 });
  if (conc.length) {
    console.log(`  ${C.b('ONE REGISTRANT, SEVERAL OF YOUR THREADS')}`);
    console.log(C.dim('  Firms whose sworn filings connect more than one thread you are'));
    console.log(C.dim('  working. Ordered by whether the engagements OVERLAPPED IN TIME —'));
    console.log(C.dim('  carrying two sides at once is a different fact from carrying one,'));
    console.log(C.dim('  then the other two years later, and they look identical undated.\n'));
    for (const g of conc.slice(0, opts.verbose ? 999 : 10)) {
      // Concurrency is the headline, because it is the difference between
      // "carried both sides" and "carried one, then years later the other".
      const when = g.concurrent === true ? C.y('OVERLAPPING in time')
        : g.concurrent === false ? C.dim('never at the same time')
          : C.dim('dates unknown');
      console.log(`    ${C.b(g.registrant)}  ${when}`);
      console.log(C.dim(`      bridges ${g.threads} of your threads`
        + ` across ${g.clients_on_subjects} of ${g.client_count} client(s) the library knows`
        + (g.span ? `  ·  ${g.span.from}–${g.span.to}` : '')));
      // Without this line, a firm the library knows only through the
      // operator's own searches looks maximally concentrated -- because the
      // denominator IS the search list. Brownstein Hyatt led this section on
      // 4-of-4 and turned out to have 16,026 filings.
      if (g.denominator_is_search_list) {
        console.log(C.y('      NO DENOMINATOR — every client known for this firm came from your'));
        console.log(C.dim('      own searches, so "bridges N of N" is true of any firm at all.'));
        console.log(C.dim(`      Pull its book before believing this row:`));
        console.log(C.dim(`        sentinel connect senatelda --registrant "${g.registrant}" --pages 20`));
      }
      for (const m of g.matched.slice(0, opts.verbose ? 999 : 5)) {
        const yrs = m.from === null ? '' : (m.from === m.to ? ` ${m.from}` : ` ${m.from}–${m.to}`);
        console.log(`      ${m.client.slice(0, 44).padEnd(46)}`
          + C.dim(`${String(m.filings).padStart(3)} filing(s)${yrs.padEnd(11)} ${m.subjects.join(', ')}`));
      }
      console.log('');
    }
    if (!opts.verbose && conc.length > 10) {
      console.log(C.dim(`    …and ${conc.length - 10} more (--verbose for all)\n`));
    }
    // Said here rather than only in the closing block, because this section is
    // the one that looks most like a finding and is read first.
    console.log(C.dim('  "Clients the library knows" is only the clients YOU SEARCHED. A firm'));
    console.log(C.dim('  shown with four may have four hundred; 1000+ captures are truncated.'));
    console.log(C.dim('  Get a real client list with:  sentinel connect senatelda \\'));
    console.log(C.dim('    --registrant "FIRM NAME" --pages 20'));
    console.log(C.dim('  "Lobbies for both sides" is an inference no filing states.\n'));
  }

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
  const cross = X.crossSubject(byName, { minSubjects: 2, phraseSubjects });
  if (cross.length) {
    console.log(`  ${C.b('APPEARS UNDER MORE THAN ONE SUBJECT')}\n`);
    for (const e of cross.slice(0, opts.verbose ? 999 : 15)) {
      console.log(`    ${C.b(e.name.slice(0, 52))}`);
      console.log(C.dim(`      subjects: ${e.subjects.join(' · ')}`));
      // A phrase you searched is not a thread this name bridges. Shown, so
      // nothing is hidden; separated, so it cannot read as a connection.
      if (e.phraseSubjects && e.phraseSubjects.length) {
        console.log(C.dim(`      also answered the search: ${e.phraseSubjects.join(' · ')}`));
      }
      console.log(C.dim(`      sources:  ${e.connectors.join(', ')}  (${e.hits} hit(s))`));
    }
    if (!opts.verbose && cross.length > 15) {
      console.log(C.dim(`\n    …and ${cross.length - 15} more (--verbose for all)`));
    }
  } else {
    console.log(C.dim('  Nothing appears under more than one subject yet.'));
    console.log(C.dim('  That is a real answer: these searches have not overlapped.'));
    if (phraseSubjects && phraseSubjects.size) {
      console.log(C.dim(`  (${phraseSubjects.size} of your subjects are full-text PHRASES, not`));
      console.log(C.dim('  entities — a name answering one of those is the search working,'));
      console.log(C.dim('  not two investigations meeting.)'));
    }
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

    // ONE LINE PER SUBJECT, not per capture.
    //
    // A subject searched sixty times has sixty truncated captures, and this
    // printed every one: a real run emitted roughly six hundred consecutive
    // identical `ALPINE GROUP PARTNERS LLC  kept 25 of 7346` lines and pushed
    // the actual analysis off the top of the scrollback. A coverage warning
    // that buries the thing it is warning about is not a warning.
    const bySubject = new Map();
    for (const s of truncated) {
      const cur = bySubject.get(s.subject);
      if (!cur) { bySubject.set(s.subject, { kept: s.kept, total: s.total, captures: 1 }); continue; }
      cur.captures++;
      cur.kept = Math.max(cur.kept, s.kept);       // best coverage we achieved
      cur.total = Math.max(cur.total, s.total);
    }
    const rows = [...bySubject.entries()]
      .sort((a, b) => (b[1].total - b[1].kept) - (a[1].total - a[1].kept));
    const show = opts.verbose ? rows.length : Math.min(rows.length, 12);
    for (const [subject, t] of rows.slice(0, show)) {
      const times = t.captures > 1 ? ` ${C.dim(`(×${t.captures} captures)`)}` : '';
      console.log(C.dim(`    ${subject.slice(0, 40).padEnd(42)}kept ${t.kept} of ${t.total}`) + times);
    }
    if (rows.length > show) {
      console.log(C.dim(`    …and ${rows.length - show} more subject(s) (--verbose for all)`));
    }
    console.log(C.dim(`    ${rows.length} subject(s) across ${truncated.length} truncated capture(s)`));
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

    // REFUSE AN OUTPUT PATH THAT IS NOT AN HTML FILE.
    //
    // zsh does NOT treat `#` as a comment interactively (interactive_comments
    // is off by default), so pasting
    //
    //     sentinel connect lobby --chart     # the money view
    //
    // passes `#` as the value of --chart, and the chart was written to a file
    // literally named `#` in the repo root. Two such files accumulated before
    // anyone noticed, and one of them was mistaken for junk and deleted.
    //
    // Anything that does not end in .html is far more likely to be shell
    // debris than an intended filename, and writing HTML to it is silent.
    if (opts.chart !== true && !/\.html?$/i.test(String(opts.chart))) {
      console.error(`\n  ${C.r('--chart needs an .html path, or no value at all.')}`);
      console.error(C.dim(`  Got: ${JSON.stringify(String(opts.chart))}`));
      console.error(C.dim('  If you pasted a command with a trailing # comment, zsh passed the'));
      console.error(C.dim('  comment as an argument — zsh does not strip # interactively.'));
      console.error(C.dim(`\n  Default:  sentinel connect lobby --chart`));
      console.error(C.dim(`  Explicit: sentinel connect lobby --chart out.html\n`));
      process.exit(2);
    }

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
 *   A sweep is connectors × subjects. Twelve subjects across ten connectors
 *   is over a hundred live calls to public services, and that is not a thing
 *   to set off by typing a word slightly wrong. The default prints the plan
 *   and the exact call count; --go performs it.
 *
 * A SUBJECT IS A SEARCH STRING.
 *   Putting a name in the list asserts nothing about it. It says only that
 *   the name is worth asking about, which is what a library is for.
 *
 * --new-only SKIPS SUBJECTS ALREADY CAPTURED IN THE LAST 24 HOURS.
 *   Off by default, and it must stay off by default. Re-asking is how you
 *   find out something changed, and a sweep that silently declined to search
 *   would leave "asked, found nothing" indistinguishable from "never asked" —
 *   the one confusion this desk cannot afford. The plan therefore always
 *   REPORTS what would repeat, and only skips when the operator says to.
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

  // ---- what of this plan has already been paid for ---------------------
  //
  // The plan used to state the call count and stop there, which is the truth
  // but not the whole of it: re-running a set an hour later announced the same
  // hundred calls and gave no hint that ninety of them would fetch bytes the
  // library already holds. Worse, the duplicates land as separate captures,
  // and a subject with two identical captures reads later as a subject with
  // corroboration.
  //
  // A subject counts as fresh if ANY runnable connector has not answered it
  // inside the window. Requiring all of them would suppress a subject whose
  // one new connector has never been asked.
  const now = new Date();
  const lib = RECENCY.load(R.CAPTURES);
  const WINDOW_H = 24;
  const repeats = new Map();          // subject -> hours since the newest capture
  for (const sub of set.subjects) {
    const ages = runnable.map((n) => lib.ageHours(n, sub, now));
    if (ages.every((a) => a !== null && a < WINDOW_H)) {
      repeats.set(sub, Math.min(...ages));
    }
  }
  const willRun = opts.newOnly
    ? set.subjects.filter((s) => !repeats.has(s))
    : set.subjects;
  const totalCalls = perSubject * willRun.length;

  console.log('\n' + C.b(`Sweep — ${setName}`));
  console.log(`  ${C.dim(set.note)}`);
  console.log(`  subjects    ${set.subjects.length}`);
  console.log(`  filing to   evidence/investigations/${set.into}/`);
  console.log(`  ${C.b('live calls')}  ${C.b(String(totalCalls))}  ${C.dim(`${willRun.length} subjects × ${perSubject} calls`)}`);
  console.log('  boundary    every hit lands as a LEAD requiring a primary source');
  if (repeats.size) {
    console.log(`  ${C.y('repeats')}     ${repeats.size} of ${set.subjects.length} subjects were fully captured in the last ${WINDOW_H}h`);
    console.log(`  ${' '.repeat(11)} ${C.dim(opts.newOnly
      ? 'skipped, because you asked for --new-only'
      : 'they will be asked again — pass --new-only to skip them')}`);
  }
  console.log('');
  for (const sub of set.subjects) {
    const age = repeats.get(sub);
    if (age === undefined) { console.log(`    ${sub}`); continue; }
    const note = opts.newOnly ? 'skipping' : 'repeat';
    console.log(`    ${C.dim(sub)}  ${C.y(`(${note} — asked ${RECENCY.describeAge(age)})`)}`);
  }
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

  // --new-only can empty the plan. Say that, rather than printing "Sweep
  // complete" over zero calls, which reads as a run that found nothing.
  if (!willRun.length) {
    console.log(`\n  ${C.y('Nothing to run.')} ${C.dim(`Every subject in this set was captured in the last ${WINDOW_H}h.`)}`);
    console.log(C.dim('  Drop --new-only to ask them again, or read what you already have:'));
    console.log(C.dim('    sentinel connect crosslink\n'));
    return;
  }

  console.log('');
  let done = 0;
  for (const sub of willRun) {
    done++;
    console.log(C.b(`\n  [${done}/${willRun.length}] ${sub}`));
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
  const passthru = {
    exact: opts.exact, any: opts.any, dockets: opts.dockets,
    allforms: opts.allforms, pageid: opts.pageid,
    candidate: opts.candidate, committee: opts.committee, cycle: opts.cycle,
  };
  console.log(`  request     ${c.describe(query, passthru)}`);
  console.log(`  key         ${key ? C.g('present, sent in Authorization header only')
    : (keyMissing ? C.r(`MISSING — set ${c.keyVar} in .env`)
      : (c.keyVar ? C.y('none (anonymous)') : C.dim('none needed')))}`);
  console.log('  boundary    every hit lands as a LEAD requiring a primary source');

  // Say so if this exact question was already answered today. Announced BEFORE
  // the call, not after, so the operator can still decide not to make it — a
  // note printed alongside the results is a receipt, not a choice.
  //
  // It reports and does not refuse. A deliberate re-run is legitimate (the
  // source may have moved, and re-asking is how you find out), and a command
  // that quietly declined to search would leave "asked, found nothing" and
  // "never asked" looking identical in the library. Only `sweep --new-only`
  // skips, and only because the operator typed the flag.
  const priorAge = RECENCY.load(R.CAPTURES).ageHours(name, query);
  if (priorAge !== null && priorAge < 24) {
    console.log(`  ${C.y('repeat')}      asked ${RECENCY.describeAge(priorAge)}`
      + C.dim(' — the library already holds an answer to this'));
  }

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

  const out = await R.runConnector(name, query, Object.assign({ env }, passthru));
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

  // HOW MUCH OF THE ANSWER IS THIS? A page of 100 rows off a source holding
  // 5,000 looks exactly like a complete answer of 100 once it is written down,
  // and the difference is the whole finding. A connector that knows its own
  // denominator says so HERE -- next to the count, before anything is totalled
  // -- and not in a footnote under the results.
  const connFor = R.CONNECTORS[out.connector || name];
  if (connFor && typeof connFor.coverage === 'function' && out.capturePath) {
    try {
      const body = JSON.parse(fs.readFileSync(out.capturePath, 'utf8'));
      const cov = connFor.coverage(body, query);
      if (cov) console.log('  ' + C.y('coverage') + '    ' + cov);
    } catch { /* the capture is on disk either way */ }
  }

  if (!out.results.length) {
    console.log(C.dim('  No hits. A clean result is not proof of absence — it is one source saying nothing.'));

    // A zero has two causes that look identical from here: the source really
    // holds nothing, or the parser missed the schema and matched nothing it
    // was handed. The second reports a confident, wrong absence. A connector
    // that can tell them apart says so.
    const conn = R.CONNECTORS[out.connector || name];
    if (conn && typeof conn.diagnose === 'function' && out.capturePath) {
      try {
        const body = JSON.parse(fs.readFileSync(out.capturePath, 'utf8'));
        const note = conn.diagnose(body, query);
        if (note) console.log(C.dim(`  ${note}`));
      } catch { /* the capture is on disk either way */ }
    }
    console.log('');
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


/**
 * sentinel connect farascan --match "REGEX"
 *
 * Walk the whole active FARA register and report which registered foreign
 * agents have filed for a principal matching the pattern.
 *
 * The output leads with COVERAGE rather than with hits. That ordering is
 * deliberate: the dangerous result from this command is not a false hit, it
 * is a confident zero. "No registered foreign agent has ever filed for a
 * surveillance company" is a very strong claim, and it is only worth
 * anything if the scan can say how much of the register it actually read.
 */
async function cmdFaraScan(pattern, opts = {}) {
  if (!pattern && !opts.countries) {
    console.error('\n  ' + C.r('farascan needs a pattern: --match "hikvision|nso|q cyber"')
      + C.dim('\n  or a country: --country "ISRAEL"  (exact, for a country ranking)') + '\n');
    process.exit(2);
  }

  console.log(`\n${C.b('FARA register scan')}`);
  console.log(`  ${opts.countries ? 'country    ' : 'pattern    '} ${opts.countries ? [...opts.countries].join(' | ') : pattern}`);
  console.log(`  scope       every ACTIVE registrant's filed documents`);
  // Naming the matched FIELD is the whole point of --country. A count taken
  // off the name field and reported as a country total is wrong in both
  // directions at once -- see the note above matchesCountry() in farascan.js.
  console.log(opts.countries
    ? `  matched on  ${C.g('the COUNTRY FIELD ONLY, exact')} ${C.dim('— a conduit named in the principal is not counted')}`
    : `  matched on  foreign principal name and country ${C.dim('(not the firm name)')}`);
  if (opts.countries) {
    console.log(C.y('  NOT A RANKING BY ITSELF') + C.dim(' — registrants is a headcount, not spend,'));
    console.log(C.dim('              not activity, and not influence. Run the same command per'));
    console.log(C.dim('              country and compare only the numbers you measured yourself.'));
  }
  console.log(C.dim(`  pacing      ~${opts.intervalMs ?? FSCAN.DEFAULT_INTERVAL_MS}ms between calls; cached copies are reused for ${opts.freshDays || 7} days`));
  if (opts.limit) console.log(C.y(`  LIMIT       ${opts.limit} registrants — this is a PARTIAL scan`));
  console.log('');

  let n = 0;
  const out = await FSCAN.scan(pattern, Object.assign({}, opts, {
    onProgress: (p) => {
      n += 1;
      if (p.failed) {
        const why = p.throttled ? C.y('rate limited') : C.r('no answer');
        process.stdout.write(`\r  ${String(n).padStart(4)}  ${why}  ${p.reg.number} ${p.reg.name.slice(0, 40).padEnd(44)}\n`);
        return;
      }
      const mark = p.hits ? C.g('HIT') : '   ';
      // padEnd, not a fixed run of spaces: the progress line is redrawn with a
      // carriage return, so a short name leaves the TAIL of the previous, longer
      // one on screen. "Zeno Group, Inc.          liance LLC" -- which reads as
      // part of the registrant's name and is the tail of another registrant.
      process.stdout.write(`\r  ${String(n).padStart(4)}  ${mark}  ${String(p.docs).padStart(5)} docs  ${p.reg.name.slice(0, 44).padEnd(46)}`);
      if (p.hits) process.stdout.write('\n');
    },
  }));
  process.stdout.write('\r' + ' '.repeat(90) + '\r');

  if (!out.ok) {
    console.error(`\n  ${C.r(out.error)}\n`);
    process.exit(1);
  }

  // ---- coverage FIRST -------------------------------------------------
  console.log(`\n  ${C.b('COVERAGE')}  ${FSCAN.coverageLine(out)}`);
  console.log(C.dim(`  ${out.docsRead} document(s) read, ${out.fromCache} registrant(s) served from cache`));
  if (out.registrantsFailed) {
    const t = out.registrantsThrottled || 0;
    console.log(C.y(`\n  ${out.registrantsFailed} registrant(s) did not answer. They are UNKNOWN, not empty.`));
    if (t) {
      console.log(C.dim(`  ${t} of them were RATE LIMITED — the scan caused that silence, not DOJ.`));
      console.log(C.dim(`  Pacing ended at ${out.finalIntervalMs}ms. Re-run: everything already read is`));
      console.log(C.dim('  cached and free, so each pass covers more of the register than the last.'));
    }
    for (const f of out.failures.slice(0, 12)) {
      console.log(C.dim(`    ${f.number.padEnd(8)} ${f.name.slice(0, 44).padEnd(46)} ${f.error}`));
    }
    if (out.failures.length > 12) console.log(C.dim(`    …and ${out.failures.length - 12} more`));
    console.log(C.dim('    Re-run to retry them; answered registrants come from cache and cost nothing.'));
  }

  // ---- hits ------------------------------------------------------------
  if (!out.hits.length) {
    console.log(`\n  ${C.y('No principal matched that pattern in what was read.')}`);
    console.log(C.dim('  That is a bounded null, not an absence. It says nothing about the'));
    console.log(C.dim('  registrants above that did not answer, about TERMINATED registrants'));
    console.log(C.dim('  (this scans the ACTIVE list only), or about a principal filed under'));
    console.log(C.dim('  a name your pattern does not spell the same way.\n'));
    return;
  }

  console.log(`\n  ${C.b(`${out.hits.length} registrant(s) filed for a matching principal`)}\n`);
  for (const h of out.hits) {
    console.log(`  ${C.b(h.registrant)}  ${C.dim('#' + h.number)}`);
    for (const p of h.principals) {
      const span = p.first === p.last
        ? String(p.first || '').slice(0, 10)
        : `${String(p.first || '').slice(0, 10)} .. ${String(p.last || '').slice(0, 10)}`;
      console.log(`    ${String(p.docs).padStart(4)}  ${span}  ${p.principal}${p.country ? `  [${p.country}]` : ''}`);
      console.log(C.dim(`          ${p.types.join(', ')}`));
      if (p.sample) console.log(C.dim(`          ${p.sample}`));
    }
    console.log('');
  }

  console.log('  ' + C.y('These are FILINGS, not findings.'));
  console.log(C.dim('  A registrant appearing here filed for that principal. It does not say'));
  console.log(C.dim('  the principal directed anything, and it is not a link between two'));
  console.log(C.dim('  clients of the same firm. Pull the Exhibit AB before writing anything.\n'));
}


/**
 * sentinel connect farascan --intermediaries
 *
 * Who is actually behind the foreign principal, read out of the name field.
 * Runs entirely off the farascan cache — no network calls at all — so it is
 * only as complete as the last scan's coverage, and it says so.
 */
function cmdFaraLayers(opts = {}) {
  const out = FSCAN.intermediaries(opts);
  if (!out.ok) {
    console.error(`\n  ${C.r(out.error)}\n`);
    process.exit(1);
  }

  console.log(`\n${C.b('FARA — the layer behind the principal')}`);
  console.log(C.dim('  read from the cache written by `connect farascan`; no network calls'));
  console.log('');
  console.log(`  ${C.b('COVERAGE')}  ${out.registrantsRead} registrant file(s) read`
    + `, ${out.principalsSeen} named principal(s)`
    + `, ${out.layered} of them name a layer`);
  if (out.unreadable) {
    console.log(C.y(`  ${out.unreadable} cache file(s) were unreadable and are unknown, not empty.`));
  }
  console.log(C.dim('  This is only as complete as your last scan. If that scan did not read'));
  console.log(C.dim('  the whole register, neither did this.'));

  if (!out.rows.length) {
    console.log(`\n  ${C.y('No principal in the cache names a conduit.')}\n`);
    return;
  }

  console.log('');
  const self = out.rows.filter((r) => r.selfAffiliated);
  if (self.length) {
    console.log(`  ${C.b('ROUTED THROUGH THE REGISTRANT\'S OWN AFFILIATE')}  ${C.dim(`${self.length}`)}`);
    console.log(C.dim('  (name-overlap heuristic — it catches Mercury/Mercury and misses'));
    console.log(C.dim('   Burson/BCW, so a firm absent here is not thereby unrelated)'));
    for (const r of self) print(r);
    console.log('');
  }

  const rest = out.rows.filter((r) => !r.selfAffiliated && !r.contested);
  if (rest.length) {
    console.log(`  ${C.b('ROUTED THROUGH A THIRD PARTY')}  ${C.dim(`${rest.length}`)}`);
    for (const r of rest.slice(0, opts.verbose ? 9999 : 40)) print(r);
    if (!opts.verbose && rest.length > 40) {
      console.log(C.dim(`\n    …and ${rest.length - 40} more (--verbose for all)`));
    }
  }

  // Rows where the grammar puts a law firm in the client position and a
  // sovereign body in the conduit position. Printed with NO direction
  // asserted, because the record does not support one.
  const contested = out.rows.filter((r) => r.contested);
  if (contested.length) {
    console.log(`\n  ${C.y('DIRECTION UNRESOLVED')}  ${C.dim(`${contested.length}`)}`);
    console.log(C.dim('  The wording puts a firm where the client should be and a state body'));
    console.log(C.dim('  where the conduit should be. Either the registrant wrote it backwards'));
    console.log(C.dim('  or meant something the form has no field for. Not guessed at:'));
    for (const r of contested) {
      console.log(`\n    ${r.party}  ${C.y('\u27f7')}  ${r.conduit}`);
      console.log(C.dim(`      filed ${r.registrant} #${r.regNumber}  ·  ${r.docs} doc(s)`));
      console.log(C.dim(`      as    "${r.raw}"`));
    }
  }

  if (opts.byConduit) {
    // Flip the rollup: rank the CONDUITS by how many separate foreign
    // clients and separate registrants each one sits between. A conduit that
    // appears once is a contract; one that appears across several unrelated
    // registrants is a structural position in the market.
    const hubs = new Map();
    for (const r of out.rows) {
      if (r.contested) continue;                 // direction unknown, so the
                                                 // conduit is unknown too
      const k = r.conduit.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const h = hubs.get(k) || { name: r.conduit, clients: new Set(),
        registrants: new Set(), docs: 0, first: r.first, last: r.last };
      h.clients.add(r.party);
      h.registrants.add(r.regNumber);
      h.docs += r.docs;
      if (r.first && r.first < h.first) h.first = r.first;
      if (r.last && r.last > h.last) h.last = r.last;
      if (r.conduit.length > h.name.length) h.name = r.conduit;
      hubs.set(k, h);
    }
    const ranked = [...hubs.values()]
      .sort((a, b) => (b.registrants.size - a.registrants.size)
        || (b.clients.size - a.clients.size) || (b.docs - a.docs));

    console.log(`\n  ${C.b('BY CONDUIT')}  ${C.dim(`${ranked.length} distinct intermediaries`)}`);
    console.log(C.dim('  Ranked by how many SEPARATE REGISTRANTS route through them. One'));
    console.log(C.dim('  registrant is a contract; several unrelated ones is a position.'));
    console.log(C.dim('  Contested rows are excluded — an unknown direction means an'));
    console.log(C.dim('  unknown conduit.\n'));
    for (const h of ranked.slice(0, opts.verbose ? 9999 : 25)) {
      if (h.registrants.size < 2 && !opts.verbose) continue;
      console.log(`    ${C.b(h.name)}`);
      console.log(C.dim(`      ${h.registrants.size} registrant(s)  ·  ${h.clients.size} foreign client(s)`
        + `  ·  ${h.docs} doc(s)  ·  ${String(h.first).slice(0, 10)}..${String(h.last).slice(0, 10)}`));
      for (const c of [...h.clients].slice(0, 8)) console.log(C.dim(`        ${c}`));
      if (h.clients.size > 8) console.log(C.dim(`        …and ${h.clients.size - 8} more`));
      console.log('');
    }
    if (!opts.verbose) {
      console.log(C.dim('  Conduits used by only one registrant are hidden; --verbose shows all.'));
    }
  }

  console.log('\n  ' + C.y('The split is an INTERPRETATION OF WORDING, not a field on the form.'));
  console.log(C.dim('  FARA never asks which side is the conduit. "X through Y" and "X on'));
  console.log(C.dim('  behalf of Y" put the client on opposite sides, so the raw string is'));
  console.log(C.dim('  printed under every row. Check the reading before you use it.\n'));

  function print(r) {
    const span = r.first === r.last ? String(r.first || '').slice(0, 10)
      : `${String(r.first || '').slice(0, 10)}..${String(r.last || '').slice(0, 10)}`;
    console.log(`\n    ${C.b(r.party)}${r.country ? C.dim(`  [${r.country}]`) : ''}`);
    console.log(`      via   ${r.conduit}${r.ambiguous ? C.y('   ← more than one layer, split may be incomplete') : ''}`);
    const variants = (r.nameVariants && r.nameVariants.length > 1)
      ? C.dim(`  (filed under ${r.nameVariants.length} different registrant names)`) : '';
    console.log(C.dim(`      filed ${r.registrant} #${r.regNumber}  ·  ${r.docs} doc(s)  ·  ${span}`) + variants);
    console.log(C.dim(`      as    "${r.raw}"`));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { dryRun: argv.includes('--dry-run') };
  const args = argv.filter((a) => !a.startsWith('--'));
  const action = args[0] || 'test';

  // A flag takes exactly the next token, and only when that token is not
  // itself a flag. `--country --verbose` means no country, not a country
  // called "--verbose".
  const flagValue = (name) => {
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1) || null;
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };

  if (action === 'test') return cmdTest();
  if (action === 'list') return cmdList();
  if (action === 'crosslink') return cmdCrosslink({ verbose: argv.includes('--verbose') });
  if (action === 'foreign') {
    return cmdForeign({
      verbose: argv.includes('--verbose'),
      country: flagValue('--country'),
      client: flagValue('--client'),
    });
  }
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
  if (action === 'farascan') {
    const flagVal = (name) => {
      const i = argv.findIndex((a) => a === name || a.startsWith(name + '='));
      if (i < 0) return null;
      if (argv[i].startsWith(name + '=')) return argv[i].slice(name.length + 1);
      return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
    };
    const num = (v) => (v === null ? undefined : parseInt(v, 10));
    if (argv.includes('--intermediaries') || argv.includes('--layers')) {
      return cmdFaraLayers({
        verbose: argv.includes('--verbose'),
        byConduit: argv.includes('--by-conduit'),
      });
    }
    // --country takes a "|"-separated list of EXACT country values as FARA
    // records them, so merging GREAT BRITAIN into UNITED KINGDOM is a choice
    // the operator types and the capture records -- not one a matcher makes.
    const cRaw = flagVal('--country');
    const countries = cRaw
      ? new Set(String(cRaw).split('|').map((c) => FSCAN.countryKey(c)).filter(Boolean))
      : null;
    if (countries && !countries.size) {
      console.error('\n  ' + C.r('--country was given nothing to match on.') + '\n');
      process.exit(2);
    }
    return cmdFaraScan(flagVal('--match') || (countries ? '' : args.slice(1).join(' ')), {
      countries,
      limit: num(flagVal('--limit')),
      freshDays: num(flagVal('--fresh-days')),
      intervalMs: num(flagVal('--interval')),
      refresh: argv.includes('--refresh'),
    });
  }
  if (action === 'brief') return cmdBrief(args.slice(1).join(' '), {});
  if (action === 'sweep') {
    return cmdSweep(args[1], {
      go: argv.includes('--go'),
      newOnly: argv.includes('--new-only'),
    });
  }
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
        if (/^--(into|only|skip|pages|limit|chart|country|client|registrant|match|as|cycle)$/.test(a)
            && argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
        continue;
      }
      if (seen++ < fromIndex) continue;
      out.push(a);
    }
    return out;
  };
  // Flags that carry a VALUE. Built once: the same bag was being spelled out
  // at four call sites, and a flag added to three of them is a flag that
  // works in `connect search fecspend` and silently does nothing in
  // `connect fecspend` -- which reads as "the committee spent nothing".
  const searchFlags = () => ({
    exact: argv.includes('--exact'),
    any: argv.includes('--any'),
    dockets: argv.includes('--dockets'),
    allforms: argv.includes('--allforms'),
    pageid: argv.includes('--pageid'),
    // Booleans: they say which FILTER the positional query is, the way
    // --pageid does. Not values -- see the note in `positional`.
    candidate: argv.includes('--candidate'),
    committee: argv.includes('--committee'),
    cycle: flagValue('--cycle'),
  });
  const intoOf = (list) => {
    const i = list.indexOf('--into');
    return i >= 0 && list[i + 1] && !list[i + 1].startsWith('--') ? list[i + 1] : null;
  };

  if (action === 'search') {
    return cmdSearch(args[1], positional(2).join(' '),
      Object.assign({}, opts, searchFlags(), { into: intoOf(argv) }));
  }
  if (R.CONNECTORS[action]) {
    return cmdSearch(action, positional(1).join(' '),
      Object.assign({}, opts, searchFlags(), { into: intoOf(argv) }));
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

module.exports = { verdictFor, cmdTest, cmdFaraScan, cmdFaraLayers, wrap, parseAllArgs, cmdLobby, cmdGraph, cmdRegistrant, cmdExpand, cmdSweep, cmdBrief };
