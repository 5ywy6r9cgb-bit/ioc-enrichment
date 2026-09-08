#!/usr/bin/env node
/**
 * sec_cli.js -- `sentinel sec history CIK`
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT.
 *
 * `connect sec` searches the TEXT of filings: give it a phrase, it finds
 * documents containing it. This prints one entity's FILING HISTORY: every
 * form it filed, when, and a URL you can hand straight to `doc get`. They
 * answer different questions and it is worth knowing which you are asking.
 *
 * The fetched JSON is hashed and written to the provenance ledger exactly as
 * `doc get` does, because a listing that shaped an investigation and left no
 * record of when it was pulled is not evidence of anything.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const S = require('./sec.js');
const D = require('./document.js');
const R = require('../connectors/registry.js');
const P = require('../../core/provenance/provenance.js');

const E = String.fromCharCode(27);
const C = {
  b: (s) => `${E}[1m${s}${E}[0m`,
  dim: (s) => `${E}[2m${s}${E}[0m`,
  g: (s) => `${E}[32m${s}${E}[0m`,
  y: (s) => `${E}[33m${s}${E}[0m`,
  r: (s) => `${E}[31m${s}${E}[0m`,
};

function usage() {
  console.log(`
  ${C.b('sentinel sec history CIK')}      every filing an entity has made, with URLs

    ${C.dim('bin/sentinel sec history 1577459')}
    ${C.dim('bin/sentinel sec history 1577459 --form 10-D')}
    ${C.dim('bin/sentinel sec history 1577459 --limit 20')}
    ${C.dim('bin/sentinel sec history 1577459 --from evidence/documents/CIK0001577459.json')}

  A CIK is a number. To find one by name, search the filings themselves:
    ${C.dim('bin/sentinel connect sec "Ohio Power Company"')}

  ${C.dim('Not the same as `connect sec`, which searches the TEXT of filings.')}
  ${C.dim('This lists what one entity filed, and when.')}
`);
}

function pad(s, n) {
  const t = String(s == null ? '' : s);
  return t.length >= n ? t : t + ' '.repeat(n - t.length);
}

async function cmdHistory(arg, opts) {
  const norm = S.normalizeCik(arg);
  if (!norm.cik) {
    console.error(`\n  ${C.r(norm.error)}`);
    if (norm.suggestion) console.error(C.dim(`  ${norm.suggestion}`));
    console.error('');
    process.exit(1);
  }
  const cik = norm.cik;
  const url = S.submissionsUrl(cik);
  const dir = opts.dir || path.join(R.EVIDENCE, 'documents');

  console.log(`\n${C.b('SEC filing history')}`);
  console.log(C.dim(`  ${url}\n`));

  // --from reads a submissions JSON already on disk instead of fetching.
  //
  // Two reasons it exists. The obvious one: the file may already be in the
  // evidence store from a `doc get`, and re-fetching it writes a second
  // identical capture for no gain. The one that matters more: it makes this
  // command's OUTPUT testable without a network, and a renderer that has
  // never been run against real data is a renderer nobody has checked.
  //
  // Provenance is NOT rewritten in this mode. The ledger records fetches;
  // reading a file you already have is not a new observation of the source,
  // and stamping it as one would date the capture wrongly.
  if (opts.from) {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(opts.from, 'utf8')); }
    catch (e) {
      console.error(`  ${C.r('cannot read that file as JSON:')} ${e.message}\n`);
      process.exit(1);
    }
    const p2 = S.parseSubmissions(obj, cik);
    if (!p2.ok) { console.error(`  ${C.r(p2.error)}\n`); process.exit(1); }
    console.log(C.dim(`  reading ${opts.from}`));
    console.log(C.dim('  (not re-fetched; nothing written to the ledger)\n'));
    return render(p2, {}, opts);
  }

  const env = R.loadEnv();
  const got = await D.fetchDocument(url, R.request, {
    dir,
    headers: { 'User-Agent': R.SEC_UA(env) },
  });
  if (!got.ok) {
    console.error(`  ${C.r('failed:')} ${got.error}`);
    if (got.status === 404) {
      console.error(C.dim(`  No entity at CIK ${cik}. Check the number —`));
      console.error(C.dim('  a wrong CIK 404s exactly like an entity that does not exist.'));
    } else if (got.status === 403) {
      console.error(C.dim('  sec.gov requires a declared contact in the User-Agent.'));
      console.error(`  ${C.b('Set SEC_CONTACT=you@example.com in .env, then run this again.')}`);
    }
    console.error('');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = S.parseSubmissions(JSON.parse(fs.readFileSync(got.file, 'utf8')), cik);
  } catch (e) {
    console.error(`  ${C.r('the response was not JSON:')} ${e.message}`);
    console.error(C.dim(`  saved anyway: ${got.file}`));
    process.exit(1);
  }
  if (!parsed.ok) {
    console.error(`  ${C.r(parsed.error)}`);
    console.error(C.dim(`  the bytes are saved: ${got.file}`));
    process.exit(1);
  }

  // ---- provenance, same discipline as `doc get` ------------------------
  try {
    new P.Ledger(R.LEDGER).append(P.makeRecord({
      kind: 'sec_filing_history',
      artifactId: got.sha256.slice(0, 16),
      label: `SEC filing history: ${parsed.name || cik}`,
      tool: 'sentinel sec history',
      toolVersion: R.VERSION,
      tier: 'GREEN',
      sha256: got.sha256,
      localPath: got.file,
      evidenceRoot: R.EVIDENCE,
      sourceUrl: url,
      extra: {
        cik,
        entity_name: parsed.name,
        filings_shown: parsed.shown,
        // NEVER just `filings_total`. See sec.js on the cap.
        count_is_floor: parsed.countIsFloor,
        older_files: parsed.moreFiles.length,
        result_disposition: 'entity_filing_index',
      },
    }));
  } catch (e) {
    console.log(C.y(`  ledger not written: ${e.message}`));
  }

  return render(parsed, got, opts);
}

function render(parsed, got, opts) {
  const all = parsed.filings;
  const first = all.length ? all[0].date : '';
  const last = all.length ? all[all.length - 1].date : '';

  console.log(`  ${C.b(parsed.name || '(unnamed)')}`);
  const bits = [`CIK ${parsed.cik}`];
  if (parsed.stateOfIncorporation) bits.push(parsed.stateOfIncorporation);
  if (parsed.sic) bits.push(`SIC ${parsed.sic}${parsed.sicDescription ? ` ${parsed.sicDescription}` : ''}`);
  if (parsed.entityType) bits.push(parsed.entityType);
  console.log(C.dim(`  ${bits.join('  ·  ')}`));
  console.log(C.dim(`  ${parsed.shown} filing(s)${parsed.countIsFloor ? ' SHOWN' : ''}`
    + `${first ? `,  ${first} → ${last}` : ''}`));

  // A NAME CHANGE IS A LEAD. An entity that filed under another name is one
  // an earlier search by the current name would never have found.
  if (parsed.formerNames.length) {
    console.log(`\n  ${C.b('FORMERLY')}`);
    for (const f of parsed.formerNames) {
      console.log(`    ${f.name}${f.from ? C.dim(`   ${f.from.slice(0, 10)} → ${(f.to || '').slice(0, 10)}`) : ''}`);
    }
  }

  // THE CAP, SAID OUT LOUD.
  if (parsed.truncated) {
    console.log(`\n  ${C.y('THIS IS NOT THE WHOLE HISTORY.')}`);
    console.log(C.dim('  EDGAR returns only the most recent filings here; the older ones'));
    console.log(C.dim('  are in separate files. The count above is a FLOOR.'));
    for (const f of parsed.moreFiles) {
      console.log(`    ${C.dim(`${f.from} → ${f.to}`)}  ${f.count} filing(s)`);
      console.log(C.dim(`      bin/sentinel doc get "${f.url}"`));
    }
  }

  const dereg = S.deregistrations(all);
  if (dereg.length) {
    console.log(`\n  ${C.b('REPORTING ENDED')}`);
    for (const d of dereg) {
      console.log(`    ${C.y(pad(d.form, 9))} ${d.date}`);
      console.log(C.dim(`      ${d.url}`));
    }
    console.log(C.dim('    A Form 15 SUSPENDS A DUTY TO FILE. It does not say securities were'));
    console.log(C.dim('    repaid, a case settled, or a business closed. Read the form: it names'));
    console.log(C.dim('    the rule it invokes and the holders of record it counted.'));
  }

  const rows = S.summarize(all);
  console.log(`\n  ${C.b('BY FORM')}`);
  console.log(C.dim(`    ${pad('form', 10)}${pad('n', 5)}${pad('first', 13)}${pad('last', 13)}`
    + `${pad('typical gap', 14)}since last`));
  for (const r of rows) {
    console.log(`    ${pad(r.form, 10)}${pad(r.count, 5)}${pad(r.first, 13)}${pad(r.last, 13)}`
      + `${pad(r.typicalGap == null ? C.dim('—') : `${r.typicalGap}d`, r.typicalGap == null ? 14 + 8 : 14)}`
      + `${r.sinceLast == null ? '' : `${r.sinceLast}d`}`);
  }
  console.log(C.dim('    A typical gap needs three filings; below that one interval is not a'));
  console.log(C.dim('    pattern. An annual filer is not overdue in month eleven.'));

  let shown = all;
  if (opts.form) {
    const want = String(opts.form).toUpperCase();
    shown = all.filter((f) => f.form.toUpperCase() === want);
    if (!shown.length) {
      console.log(`\n  ${C.y(`no ${opts.form} filings in what was returned`)}`);
      console.log(C.dim('  (that is not the same as none ever filed — see the counts above)'));
    }
  }
  const limit = Number(opts.limit) || 0;
  const clipped = limit > 0 && shown.length > limit;
  const list = clipped ? shown.slice(-limit) : shown;

  if (list.length) {
    console.log(`\n  ${C.b('TIMELINE')}${opts.form ? C.dim(`  (${opts.form} only)`) : ''}`);
    for (const f of list) {
      console.log(`    ${f.date}  ${pad(f.form, 9)} ${f.url}`);
      if (!f.hasPrimaryDocument) {
        console.log(C.dim('               ↑ no single document — this is the filing index'));
      }
    }
    if (clipped) {
      console.log(C.dim(`\n    ${shown.length - limit} earlier filing(s) not shown `
        + `(--limit ${limit}). A limit is not a count.`));
    }
  }

  console.log(`\n  ${C.dim('Fetch any of them:')}`);
  console.log(C.dim('    bin/sentinel doc get "<paste a URL from above>"'));
  if (got && got.sha256) {
    console.log(C.dim(`\n  ledger  evidence/manifests/provenance.jsonl`));
  }
  console.log(C.dim('\n  Fetching is not reading, and a list of filings is not a finding.\n'));
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const action = argv[0];
  const VALUE_FLAGS = new Set(['--form', '--limit', '--dir', '--from']);
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const positional = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    if (i > 0 && VALUE_FLAGS.has(argv[i - 1])) return false;
    return true;
  });

  if (action === 'history') {
    return cmdHistory(positional[1], {
      form: val('--form'), limit: val('--limit'), dir: val('--dir'),
      from: val('--from'),
    });
  }
  usage();
  return action && action !== 'help' ? 1 : 0;
}

main().then((c) => process.exit(c || 0)).catch((e) => {
  console.error(`\n  ${C.r('error:')} ${e.message}\n`);
  process.exit(1);
});
