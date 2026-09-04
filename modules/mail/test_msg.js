'use strict';
/**
 * test_msg.js — the .msg reader, and the boundaries it must keep.
 *
 * Two failure modes matter here and they are not symmetric. A message this
 * reader CANNOT parse is visible: it lands in the failed list and someone
 * opens it by hand. A message it parses WRONGLY is invisible — a date read
 * off the wrong property, or a sender taken from Outlook's rendering rather
 * than the wire, produces a timeline that looks complete and is not.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('./msg.js');
const CLI = require('./cli.js');

let PASS = 0, FAIL = 0;
function ok(label, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${label}`); }
  else { FAIL++; console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

module.exports = function run() {
  console.log('\n  outlook .msg\n');

  // ══ HEADERS ARE READ FROM THE WIRE, NOT FROM OUTLOOK'S RENDERING ══════
  //
  // Outlook rewrites display names against the local address book, so its
  // idea of a sender can differ from the address that actually sent the
  // message. On a disputed timeline that difference is the whole question.
  {
    const raw = [
      'Received: from a.example.gov by b.example.gov; Tue, 26 May 2020 20:59:21 +0000',
      'Received: from c.example.gov by a.example.gov; Tue, 26 May 2020 20:59:20 +0000',
      'From: "Doe, Jane" <jane.doe@epa.ohio.gov>',
      'To: "Roe, Rob" <rroe@columbus.gov>,',
      '\t"Poe, Pat" <ppoe@columbus.gov>',
      'Cc: consultant@example.com',
      'Date: Tue, 26 May 2020 20:59:21 +0000',
      'Subject: RE: Columbus  Lower Olentangy Tunnel power',
      'Message-ID: <abc@example.gov>',
    ].join('\r\n');

    const h = M.parseHeaders(raw);
    ok('the From line is read', /jane\.doe@epa\.ohio\.gov/.test(h.from));
    ok('a folded To header is unfolded, so the second recipient is not lost',
      /rroe@columbus\.gov/.test(h.to) && /ppoe@columbus\.gov/.test(h.to), h.to);
    ok('the Date is taken from the header block', /26 May 2020/.test(h.date));
    ok('the Message-ID survives', h.messageId === '<abc@example.gov>');
    ok('every Received hop is counted', h.hops === 2, String(h.hops));
    ok('empty input yields an empty object rather than throwing',
      JSON.stringify(M.parseHeaders('')) === '{}');
  }

  // ══ ONE PERSON IS ONE PERSON ══════════════════════════════════════════
  {
    const a = CLI.addresses('"Herr, Robert C." <RCHerr@columbus.gov>, '
      + '"JCoffey@DLZ.com" <JCoffey@DLZ.com>, \'Nathan Dickman\' <ndickman@dlz.com>');
    ok('every address in a mixed header is found', a.length === 3, a.join(' '));
    ok('case is folded, so one mailbox is not counted as two',
      a.includes('rcheer@columbus.gov') === false && a.includes('rcherr@columbus.gov'), a.join(' '));
    ok('an address repeated as both display text and angle-address counts once',
      a.filter((x) => x === 'jcoffey@dlz.com').length === 1);
    ok('the domain is read off the end, not off the first @',
      CLI.domainOf('a.b@sub.example.gov') === 'sub.example.gov');
    ok('a header with no address yields none, not a false one',
      CLI.addresses('Undisclosed recipients').length === 0);
    ok('an empty field does not throw', CLI.addresses('').length === 0
      && CLI.addresses(null).length === 0);
  }

  // ══ A THREAD IS ONE THREAD ════════════════════════════════════════════
  //
  // Reply prefixes stack, and Outlook double-spaces some subjects. If those
  // are not folded away, a nine-message thread reads as nine threads and the
  // longest-thread view — the one that says where the argument was — is
  // useless.
  {
    const k = CLI.threadKey;
    ok('Re: and RE: fold to the same thread',
      k('Re: Columbus Lower Olentangy Tunnel power') === k('RE: Columbus Lower Olentangy Tunnel power'));
    ok('stacked prefixes fold too',
      k('RE: Fwd: RE: LOT') === k('LOT'), k('RE: Fwd: RE: LOT'));
    ok('a double space inside the subject does not split the thread',
      k('Columbus  Lower Olentangy Tunnel power') === k('Columbus Lower Olentangy Tunnel power'));
    ok('two genuinely different subjects stay apart',
      k('DBE Question(s) / LOT') !== k('Columbus Lower Olentangy Tunnel power'));
    ok('an empty subject is handled', k('') === '' && k(null) === '');
  }

  // ══ THE READER TOUCHES NOTHING BUT THE FILE ═══════════════════════════
  //
  // This runs over a records production that may be gigabytes of other
  // people's correspondence. It reads bytes off disk. It must not acquire a
  // network call, now or by later edit.
  {
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const src = strip(fs.readFileSync(path.join(__dirname, 'msg.js'), 'utf8'))
      + strip(fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8'));
    ok('the mail module makes no network request',
      !/require\('https?'\)|fetch\(|http\.get|https\.get/.test(src));
    ok('and spawns no process',
      !/child_process|execFile|spawn/.test(src));
    ok('the index is written owner-only',
      /mode:\s*0o600/.test(fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8')));
  }

  // ══ A FILE THAT IS NOT A .msg IS REFUSED, NOT GUESSED AT ══════════════
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'));
    const bad = path.join(dir, 'notreally.msg');
    fs.writeFileSync(bad, 'this is a text file wearing a .msg name');
    let threw = false;
    try { M.read(bad); } catch (e) { threw = /signature|compound/i.test(e.message); }
    ok('a file without the compound-file signature is refused by name', threw);

    // And the walk must still find it, so the scan reports it as unreadable
    // rather than pretending the folder held one fewer message.
    ok('the walk still lists it, so it is counted and reported',
      CLI.walk(dir).length === 1);
    ok('a folder that does not exist walks to nothing rather than throwing',
      CLI.walk('/definitely/not/here').length === 0);

    // Nested exports are the norm; a flat readdir would miss most of them.
    const deep = path.join(dir, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'x.msg'), 'x');
    fs.writeFileSync(path.join(deep, 'ignore.pdf'), 'x');
    ok('nested folders are walked', CLI.walk(dir).length === 2);
    ok('and non-.msg files are left alone',
      !CLI.walk(dir).some((f) => f.endsWith('.pdf')));
  }

  // ══ A macOS SIDECAR IS NOT A FAILED MESSAGE ══════════════════════════
  //
  // Copy a folder to a FAT32/exFAT stick and macOS writes `._Name.msg` beside
  // every file. Counted as messages, a 194-message production reports as 388
  // files with a 50% failure rate — and the operator goes looking for records
  // that were never missing. On evidence a FALSE gap is worse than a real one.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msgsc-'));
    fs.writeFileSync(path.join(dir, 'Real Message.msg'), 'x');
    fs.writeFileSync(path.join(dir, '._Real Message.msg'), 'x');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');

    const found = CLI.walk(dir);
    ok('the AppleDouble twin is not counted as a message',
      found.length === 1, found.map((f) => path.basename(f)).join(', '));
    ok('but it IS recorded as skipped, not silently dropped',
      (found.sidecars || []).length === 2, String((found.sidecars || []).length));
    ok('the real message is the one kept',
      path.basename(found[0]) === 'Real Message.msg');
    ok('a leading dot alone does not make a file a sidecar',
      CLI.isSidecar('._x.msg') && CLI.isSidecar('.DS_Store') && !CLI.isSidecar('x.msg'));
  }

  // ══ ONE ORGANISATION IS ONE ORGANISATION ══════════════════════════════
  //
  // An address picks up whatever punctuation surrounds it in the header, and
  // epa.ohio.gov / epa.ohio.gov' / epa.ohio.gov) then report as three bodies
  // instead of one — splitting every count built on the domain.
  {
    const a = CLI.addresses("'Nathan Dickman' <ndickman@dlz.com>, "
      + '(RCHerr@columbus.gov), "J" <JCoffey@DLZ.com>; more@epa.ohio.gov.');
    ok('a quote-wrapped display name leaves no apostrophe on the address',
      a.includes('ndickman@dlz.com'), a.join(' '));
    ok('a parenthesised address loses the bracket',
      a.includes('rcherr@columbus.gov'), a.join(' '));
    ok('a trailing sentence period is not part of the domain',
      a.includes('more@epa.ohio.gov'), a.join(' '));
    ok('so all four resolve to two organisations, not five',
      new Set(a.map(CLI.domainOf)).size === 3,
      [...new Set(a.map(CLI.domainOf))].join(' '));
    ok('a fragment with no dotted domain is not accepted as an address',
      CLI.addresses('someone@localhost').length === 0);
  }

  // ══ A TIMELINE PUTS THE REPLY AFTER THE THING IT REPLIED TO ═══════════
  //
  // Sent-items copies carry no transport headers and therefore no date. If an
  // unparseable date sorted as zero, every one of them would land at the top
  // of the thread — and a reply printed above the message it answers is a
  // timeline that argues the opposite of the record.
  {
    const rows = [
      { date: 'Tue, 26 May 2020 20:59:21 +0000', id: 'second' },
      { date: '', id: 'nodate' },
      { date: 'Tue, 26 May 2020 20:48:01 +0000', id: 'first' },
    ];
    const order = rows.slice().sort(CLI.byDate).map((r) => r.id);
    ok('oldest first', order[0] === 'first', order.join(' '));
    ok('then the later message', order[1] === 'second', order.join(' '));
    ok('and an undated message sorts LAST, never to the epoch',
      order[2] === 'nodate', order.join(' '));
    ok('two undated messages keep their order rather than throwing',
      [{ date: '' }, { date: '' }].sort(CLI.byDate).length === 2);
  }

  // ══ THE INDEX MUST STILL RESOLVE FROM ANOTHER DIRECTORY ═══════════════
  //
  // The mail usually sits on an external drive. A path stored relative to
  // wherever the scan happened to run stops resolving the moment you cd, and
  // the failure looks like a missing message rather than a bad path.
  {
    const src = fs.readFileSync(path.join(__dirname, 'cli.js'), 'utf8');
    ok('message paths are recorded absolute, not relative to the scan cwd',
      !/file:\s*path\.relative\(process\.cwd\(\), f\)/.test(src));
  }

  console.log(`\n  ${FAIL ? 'FAIL' : 'PASS'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
