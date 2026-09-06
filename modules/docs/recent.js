'use strict';
/**
 * recent.js — refer to the document you just fetched without retyping it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FRICTION THIS REMOVES, AND WHY IT IS NOT COSMETIC
 *
 * `doc get` saves a file named like
 *
 *   2026-09-06T04-18-35-154Z__fa126858f579__ohio-senators-get-update-on-…txt
 *
 * which is exactly right for an evidence store -- sortable, hash-stamped,
 * collision-proof -- and completely unusable as something a person types. So
 * the next command in the chain gets written with a stand-in: THE_FILE.txt,
 * or FILE.txt, or the path from a different document entirely.
 *
 * That is not a typing annoyance. A stand-in pasted verbatim is an ARGUMENT.
 * `doc quote THE_FILE.txt "…"` reports that it cannot read THE_FILE.txt,
 * which is true and useless; the worse version is a stand-in that happens to
 * name a real file, and the operator verifies a quote against the wrong
 * document and believes the answer.
 *
 * This repository has already been bitten by the same disease twice: angle
 * brackets in help text, which zsh reads as input redirection, and a literal
 * placeholder handed to `doc get` as a URL. The guards for those two live in
 * the docs test. This is the third form, and the fix is not another warning:
 * it is making the real path reachable without typing it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY FILENAME ORDER AND NOT MODIFICATION TIME
 *
 * The names begin with the UTC timestamp of the fetch, so lexical order IS
 * chronological order, and it stays correct after a copy, a restore from
 * backup, or a move between machines -- all of which rewrite mtime and none
 * of which change when the document was actually captured.
 */

const fs = require('fs');
const path = require('path');

/** Every saved document, newest first. */
function list(dir, opts = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const ext = opts.ext ? String(opts.ext).toLowerCase() : null;
  const rows = names
    .filter((n) => !n.startsWith('.'))
    .filter((n) => (ext ? n.toLowerCase().endsWith(ext) : true))
    .map((n) => ({
      name: n,
      path: path.join(dir, n),
      // The stamp and short hash the fetcher wrote into the name. Absent for a
      // file added by hand, which is a legitimate case and not an error.
      stamp: (/^(\d{4}-\d{2}-\d{2}T[\d-]+Z)__/.exec(n) || [])[1] || '',
      short: (/__([0-9a-f]{12})__/.exec(n) || [])[1] || '',
      slug: n.replace(/^[^_]*__[0-9a-f]*__/, '').replace(/\.[^.]+$/, ''),
    }));

  // ── AN UNSTAMPED FILE IS NOT THE NEWEST FILE ─────────────────────────
  //
  // A plain `.sort().reverse()` put `hand-saved-from-a-browser.txt` at the
  // top of the list, because a lower-case letter sorts after a digit. So a
  // file dropped into the folder by hand became what `--last` resolved to,
  // and every later command would have checked a quote against a document
  // nobody had just fetched.
  //
  // A file with no stamp has an UNKNOWN capture time, and unknown must not
  // rank as maximum -- the same rule this repository applies to a missing
  // result count and to a firm whose book size was never looked up. Stamped
  // files come first, newest first; unstamped ones follow, by name.
  const stamped = rows.filter((r) => r.stamp).sort((a, b) => b.stamp.localeCompare(a.stamp));
  const unstamped = rows.filter((r) => !r.stamp).sort((a, b) => a.name.localeCompare(b.name));
  return stamped.concat(unstamped);
}

/** The most recent one, or null. */
function latest(dir, opts = {}) {
  const all = list(dir, opts);
  return all.length ? all[0] : null;
}

/**
 * Does this argument look like a stand-in rather than a real path?
 *
 * Deliberately narrow. It must catch THE_FILE.txt, FILE.txt, YOUR_FILE.txt
 * and PASTE_THE_PATH without ever flagging a real document, so it fires only
 * on names that are entirely upper-case letters, digits and underscores. A
 * genuine capture always carries a lower-case slug and a timestamp, so no
 * real file in this store can match.
 */
function looksLikePlaceholder(arg) {
  if (!arg) return false;
  const base = path.basename(String(arg));
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '');
  if (!stem) return false;
  // Wholly upper-case with an underscore: THE_FILE, PASTE_THE_PATH.
  if (/^[A-Z0-9_]+$/.test(stem)) {
    // A single upper-case word could be a real, if shouty, filename. Two or
    // more joined by underscores is a stand-in every time.
    return /_/.test(stem) || /^(FILE|URL|PATH|ID)$/.test(stem);
  }
  // Mixed case, but shouting in pieces: THE_TEXT_FILE_doc_get_PRINTED. This
  // repository has shipped exactly that one, in the SDCL command table, and
  // the wholly-upper-case test above walks straight past it because of the
  // lower-case middle. Two or more all-caps segments joined by underscores is
  // not a filename anyone chose.
  const caps = stem.split('_').filter((w) => /^[A-Z][A-Z0-9]+$/.test(w));
  return caps.length >= 2;
}

/**
 * Resolve the file argument a command was given.
 *
 * Returns { path, why } on success, or { error, suggestion } describing what
 * to do instead. Never guesses: --last is explicit, and a missing file is
 * reported as missing rather than silently swapped for the newest one.
 */
function resolve(arg, dir, opts = {}) {
  if (opts.last) {
    const l = latest(dir, { ext: opts.ext });
    if (!l) {
      return {
        error: 'nothing has been fetched yet, so there is no last document',
        suggestion: 'bin/sentinel doc get "https://…"',
      };
    }
    return { path: l.path, why: `--last: ${l.name}` };
  }

  if (!arg) {
    return { error: 'no file given', suggestion: 'bin/sentinel doc last' };
  }

  if (looksLikePlaceholder(arg)) {
    return {
      error: `"${arg}" is a placeholder, not a file`,
      placeholder: true,
      suggestion: 'bin/sentinel doc last',
    };
  }

  if (!fs.existsSync(arg)) {
    return {
      error: `no such file: ${arg}`,
      suggestion: 'bin/sentinel doc last',
    };
  }

  return { path: arg, why: '' };
}

module.exports = { list, latest, looksLikePlaceholder, resolve };
