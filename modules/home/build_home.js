#!/usr/bin/env node
'use strict';
/**
 * modules/home/build_home.js — the front door.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 *
 * This system has eleven modules, four browser surfaces, ten connectors and
 * roughly sixty commands, and no way in. Everything is reachable and nothing
 * is findable. At 11pm the question is not "what is the architecture", it is
 * "where do I click to see my FOIAs" — and the honest answer was to remember
 * `sentinel pra foia`, which is the name of a module rather than the name of
 * the job.
 *
 * So: one folder on the Desktop. Double-click things. Every entry says what it
 * is for in a sentence, and what it CANNOT tell you.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS BUILDS, AND WHAT IT DOES NOT COPY
 *
 * It writes launchers and a README. It does NOT copy evidence, cases, the
 * FOIA store, or captures to the Desktop. Everything it creates either runs a
 * command in the repo or opens a file that already lives in the repo. Two
 * reasons, and the second is the one that matters:
 *
 *   1. A copy goes stale the moment you file the next request.
 *   2. The Desktop is the least protected place on the machine — it is what
 *      gets screen-shared, backed up to whatever cloud is signed in, and shown
 *      to someone looking over a shoulder. Case material stays in the repo,
 *      under the gitignore that CI enforces.
 *
 * Re-running is safe and is how you refresh: every file is rewritten from
 * scratch. Nothing here is stateful, so there is nothing to lose by re-running
 * and nothing to migrate.
 */

const fs = require('fs');
const path = require('path');

/** The shelf. Order is the order a day actually goes in. */
function entries(root) {
  return [
    {
      file: '1 — Records requests (FOIA).command',
      title: 'Records requests',
      cmd: `"${root}/bin/sentinel" foia dash`,
      blurb: 'Every records request on one screen: what is denied, what has gone '
           + 'silent, what needs a letter today. Builds the page and opens it.',
      caveat: 'The Ohio clock on that page is YOUR follow-up cadence. '
            + 'R.C. 149.43 sets no deadline, so nothing there is overdue as a matter of law.',
    },
    {
      file: '2 — What needs me today.command',
      title: 'The triage, in the terminal',
      cmd: `"${root}/bin/sentinel" foia`,
      blurb: 'The same triage as the screen, but in text, and it stays open so '
           + 'you can act on it. A denial ranks above a long silence.',
      caveat: 'It proposes. It does not send, file, or decide.',
      hold: true,
    },
    {
      file: '3 — Case desk.command',
      title: 'Cases and exhibits',
      cmd: `"${root}/bin/sentinel" dash`,
      blurb: 'Your case files: exhibits, pages read, open questions, contradictions, '
           + 'and whether a case can be published yet.',
      caveat: 'A case with an open question or an unresolved conflict is BLOCKED, '
            + 'and there is no override. That is deliberate.',
    },
    {
      file: '4 — Research desk.command',
      title: 'The research desk',
      cmd: `"${root}/bin/sentinel" desk`,
      blurb: 'The single browser surface over the whole system. Opens offline and '
           + 'makes no network request to load.',
    },
    {
      file: '5 — Search the sources.command',
      title: 'Ask the connectors',
      cmd: `"${root}/bin/sentinel" connect test`,
      blurb: 'Checks which sources are reachable and which keys are set. From there: '
           + '`sentinel connect sweep SET` to run a whole subject list.',
      caveat: 'Every hit is a LEAD. A name match is not an identification, and no '
            + 'search result can be cited — only a document you fetched and read.',
      hold: true,
    },
    {
      file: '6 — Check nothing was altered.command',
      title: 'Verify the evidence chain',
      cmd: `"${root}/bin/sentinel" prov verify "${root}/evidence/manifests/provenance.jsonl"`,
      blurb: 'Re-hashes every captured file and compares it to the ledger written '
           + 'when it arrived.',
      caveat: 'A file whose hash no longer matches is not corrupted — it is a file '
            + 'you can no longer cite.',
      hold: true,
    },
    {
      file: '7 — Open the repo folder.command',
      title: 'The repository itself',
      cmd: `open "${root}"`,
      blurb: 'The code, the docs, and the evidence tree.',
    },
  ];
}

/**
 * A double-clickable .command file.
 *
 * `hold: true` keeps the window open after the command finishes. That is the
 * difference between a launcher and a flash of black — a terminal that closes
 * on exit is useless for anything whose OUTPUT is the point, and worse than
 * useless when the output was an error nobody got to read.
 */
function launcher(e, root) {
  const hold = e.hold
    ? '\nprintf \'\\n\\033[2mPress Return to close this window.\\033[0m\\n\'\nread -r _\n'
    : '';
  return `#!/bin/bash
# ${e.title}
#
# ${e.blurb.replace(/\n/g, '\n# ')}
#
# Built by \`sentinel home\`. Re-run that to refresh this folder.
# Editing this file is fine; re-running overwrites it.

cd "${root}" || { echo "Sentinel is not at ${root} any more. Re-run: sentinel home"; read -r _; exit 1; }

${e.cmd}
STATUS=$?

if [ $STATUS -ne 0 ]; then
  printf '\\n\\033[31mThat did not work (exit %s).\\033[0m\\n' "$STATUS"
  printf '\\033[2mIf this used to work, the repo may have moved. Re-run: sentinel home\\033[0m\\n'
  printf '\\n\\033[2mPress Return to close this window.\\033[0m\\n'
  read -r _
fi
${hold}`;
}

/** The README. Plain language, no jargon, says what each thing cannot do. */
function readme(root, list) {
  const shelf = list.map((e) => {
    const caveat = e.caveat ? `\n   *${e.caveat}*` : '';
    return `**${e.file.replace(/\.command$/, '')}**\n   ${e.blurb}${caveat}`;
  }).join('\n\n');

  return `# Sentinel

Everything in this folder is a shortcut. Double-click one.

The system itself lives at:
\`${root}\`

Nothing in this folder holds your case material. These are doors, not copies —
so nothing here goes stale, and nothing sensitive is sitting on your Desktop.

---

## What each one is for

${shelf}

---

## The one rule the whole system runs on

A search result is a **lead**. A name appearing under two subjects is a **place
to look**. A lobbying filing is an **asserted relationship**. Only a document
you actually fetched, hashed and read supports a **claim** — and the claim
cites the document, never the search that found it.

Everything here is built to keep those four apart, because they look identical
once they are in a paragraph.

## If something stops working

The launchers hard-code where the repo is. If you move it, re-run:

\`\`\`
cd /path/to/wherever/you/moved/it
bin/sentinel home
\`\`\`

That rebuilds this folder. It is safe to run any time.

## The commands behind these buttons

\`\`\`
sentinel foia            what needs you, most urgent first
sentinel foia dash       build the records screen and open it
sentinel case status ID  can this case be published, and what is blocking
sentinel connect test    which sources are reachable
sentinel connect sweep   run a whole subject list
sentinel prov verify     check nothing was altered
sentinel help            all of it
\`\`\`

---

*Generated by \`sentinel home\`. Re-running rewrites this folder from scratch.*
`;
}

/**
 * Build it.
 *
 * `dest` defaults to ~/Desktop/Sentinel. Returns what was written so the
 * caller — and the test — can assert on it rather than parsing stdout.
 */
function build(opts = {}) {
  const root = opts.root || path.resolve(__dirname, '..', '..');
  const home = opts.home || process.env.HOME || '';
  const dest = opts.dest || path.join(home, 'Desktop', 'Sentinel');

  const list = entries(root);
  fs.mkdirSync(dest, { recursive: true });

  const written = [];
  for (const e of list) {
    const p = path.join(dest, e.file);
    fs.writeFileSync(p, launcher(e, root));
    fs.chmodSync(p, 0o755);       // or it is not double-clickable
    written.push(p);
  }

  const rp = path.join(dest, 'READ ME FIRST.md');
  fs.writeFileSync(rp, readme(root, list));
  written.push(rp);

  return { dest, root, written, entries: list };
}

module.exports = { build, entries, launcher, readme };

if (require.main === module) {
  const C = {
    b: (s) => `\x1b[1m${s}\x1b[0m`,
    d: (s) => `\x1b[2m${s}\x1b[0m`,
    g: (s) => `\x1b[32m${s}\x1b[0m`,
  };
  const argv = process.argv.slice(2);
  const di = argv.indexOf('--dest');
  const r = build({ dest: di >= 0 && argv[di + 1] ? path.resolve(argv[di + 1]) : undefined });

  console.log('');
  console.log(`  ${C.b('Sentinel folder built')}`);
  console.log(`  ${C.d(r.dest)}`);
  console.log('');
  for (const e of r.entries) console.log(`    ${e.file}`);
  console.log(`    READ ME FIRST.md`);
  console.log('');
  console.log(`  ${C.d('Double-click any of them. Nothing here holds case material —')}`);
  console.log(`  ${C.d('they run commands in the repo, which stays at')} ${r.root}`);
  console.log('');
  console.log(`  ${C.g('Safe to re-run any time.')} ${C.d('It rewrites the folder from scratch.')}`);
  console.log('');
}
