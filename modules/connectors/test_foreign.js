#!/usr/bin/env node
'use strict';
/**
 * test_foreign.js
 *
 * Every check here names the real defect it exists to stop. The throwaway
 * script this module replaced produced three wrong numbers in one run:
 * 25,526 filings (rows, not filings), 25,526 foreign PPBs (every domestic
 * client counted as foreign), and 120 distinct owner pairs (punctuation
 * variants counted separately).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./foreign.js');

let PASS = 0;
let FAIL = 0;
function check(what, cond, detail) {
  if (cond) { PASS++; console.log(`    PASS  ${what}`); }
  else { FAIL++; console.log(`    FAIL  ${what}${detail ? `\n          ${detail}` : ''}`); }
}

const filing = (uuid, clientName, entities, extra = {}) => ({
  filing_uuid: uuid,
  client: Object.assign({ name: clientName }, extra.client || {}),
  foreign_entities: entities,
});

module.exports = function run() {
  console.log('\n  foreign.js — foreign ownership declared in lobbying filings\n');

  // ══ 1. THE FILER WRITES THE CHAIN INTO THE NAME FIELD ══════════════════
  //
  // "BYTEDANCE LTD. (OWNS 100% OF BYTEDANCE INC.; 100% OF TIKTOK LTD.)".
  // Left glued on, every parenthetical variant is a separate entity and one
  // owner splits into four. EdgeConnex declared seven Luxembourg vehicles
  // this way and the raw list showed thirteen rows.
  {
    const a = F.splitNote('BYTEDANCE LTD. (OWNS 100% OF BYTEDANCE INC.; 100% OF TIKTOK LTD.)');
    check('the parenthetical is split off the entity name',
      a.name === 'BYTEDANCE LTD.', a.name);
    check('and kept — it is the filer describing the structure in their own words',
      /OWNS 100% OF BYTEDANCE INC/.test(a.note), a.note);

    check('a plain name is untouched',
      F.splitNote('SUBARU CORPORATION').name === 'SUBARU CORPORATION');
    check('a name that is only a parenthetical is not emptied',
      F.splitNote('(SEE ATTACHED)').name === '(SEE ATTACHED)');
    check('null and undefined do not throw',
      F.splitNote(null).name === '' && F.splitNote(undefined).name === '');

    const step = F.chainStep('(THROUGH ITS 73.1% INTEREST IN HERDON TOPCO LP, WHICH OWNS 99%)');
    check('an intermediate vehicle is read out of the note',
      step && step.pct === '73.1' && /HERDON TOPCO LP/.test(step.via), JSON.stringify(step));
    check('a note that names no chain yields null, not a fabricated one',
      F.chainStep('(OWNS 100% OF TIKTOK LTD.)') === null);
  }

  // ══ 2. FILINGS, NOT ROWS ═══════════════════════════════════════════════
  //
  // The same filing comes back under every search that touched it and on
  // every re-run. 25,526 rows on disk were 14,104 filings — the difference
  // measured how often the operator searched.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-'));
    const one = { results: [filing('uuid-1', 'TIKTOK, INC.', [
      { name: 'BYTEDANCE LTD.', country_display: 'Cayman Islands', ownership_percentage: '100.00' },
    ])] };
    // the identical filing, captured twice under two different searches
    fs.writeFileSync(path.join(dir, 'live_capture_senatelda_TIKTOK_2026-01-01T00-00-00-000Z.json'),
      JSON.stringify(one));
    fs.writeFileSync(path.join(dir, 'live_capture_senatelda_BYTEDANCE_2026-01-02T00-00-00-000Z.json'),
      JSON.stringify(one));
    // a capture that will not parse must be reported, not silently skipped
    fs.writeFileSync(path.join(dir, 'live_capture_senatelda_BROKEN_2026-01-03T00-00-00-000Z.json'),
      '{ not json');

    const read = F.readFilings(dir);
    check('one filing captured twice counts once',
      read.filings.length === 1, String(read.filings.length));
    check('all three captures are counted as captures',
      read.captures === 3, String(read.captures));
    check('an unparseable capture is reported rather than silently dropped',
      read.unparsed === 1, String(read.unparsed));

    check('a directory that does not exist yields nothing rather than throwing',
      F.readFilings(path.join(dir, 'nope')).filings.length === 0);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ══ 3. PUNCTUATION IS NOT A DIFFERENT COMPANY ══════════════════════════
  //
  // "EDGECONNEX" and "EDGECONNEX, INC." are one client. "EQT INFRASTRUCTURE
  // IV INVESTMENTS S.A.R.L" and "...S.A.R.L." are one entity. Counted apart,
  // 120 distinct pairs were reported where there were closer to 100.
  {
    const { clients } = F.collect([
      filing('f1', 'EDGECONNEX', [
        { name: 'EQT INFRASTRUCTURE IV INVESTMENTS S.A.R.L (THROUGH ITS 44.9% INTEREST IN ECHO LUXCO S.A.R.L)',
          country_display: 'Luxembourg', ownership_percentage: '32.50' }]),
      filing('f2', 'EDGECONNEX, INC.', [
        { name: 'EQT INFRASTRUCTURE IV INVESTMENTS S.A.R.L. (THROUGH ITS 44.9% INTEREST IN ECHO LUXCO S.A.R.L.)',
          country_display: 'Luxembourg', ownership_percentage: '32.50' }]),
    ]);
    check('two spellings of one client are one client',
      clients.size === 1, String(clients.size));
    const [c] = [...clients.values()];
    check('two spellings of one owner are one owner',
      c.owners.size === 1, [...c.owners.keys()].join(' | '));
    check('the shorter client spelling is the one displayed',
      c.display === 'EDGECONNEX', c.display);
    check('both filings are still counted',
      c.filings.size === 2, String(c.filings.size));
  }

  // ══ 4. THE THREE THINGS THAT MUST BE SAID OUT LOUD ═════════════════════
  {
    const { flags, totals } = F.collect([
      // A US country INSIDE the foreign-entity field. Emirati money disclosed
      // through its US arm: the field UNDERSTATES foreignness, so a rollup
      // that silently treats it as domestic is wrong in the worst direction.
      filing('g1', 'TERRA-GEN, LLC', [
        { name: 'MASDAR TG CORPORATION C/O MASDAR AMERICAS LLC',
          country: 'US', country_display: 'United States of America',
          ownership_percentage: '50.00' }]),
      // The client naming itself.
      filing('g2', 'CARL ZEISS, INC.', [
        { name: 'CARL ZEISS, INC.', country_display: 'Germany', ownership_percentage: '100.00' }]),
      // 0.00% — a declared foreign INTEREST that is not equity.
      filing('g3', 'AD HOC COALITION ON BANCO ESPIRTO SANTO', [
        { name: 'ELLIOTT INTERNATIONAL L.P.', country: 'KY',
          country_display: 'Cayman Islands', ownership_percentage: '0.00' }]),
      // A government client with a foreign PPB and no foreign entity at all.
      filing('g4', 'SOME MINISTRY', [], {
        client: { name: 'SOME MINISTRY', client_government_entity: true,
          ppb_country: 'NO', ppb_country_display: 'Norway' } }),
    ]);

    check('a domestic country inside the foreign-entity field is flagged',
      flags.domesticInForeignField.length === 1
        && /MASDAR/.test(flags.domesticInForeignField[0].owner),
      JSON.stringify(flags.domesticInForeignField));
    check('a client naming itself as its own foreign owner is flagged',
      flags.selfReference.length === 1 && /CARL ZEISS/.test(flags.selfReference[0].client),
      JSON.stringify(flags.selfReference));
    check('a 0.00% declaration is flagged as an interest that is not equity',
      flags.zeroPercent.length === 1 && /ELLIOTT/.test(flags.zeroPercent[0].owner),
      JSON.stringify(flags.zeroPercent));

    // ...and none of the three is DROPPED. Hiding a flagged row would hide a
    // real disclosure; the operator decides, not the tool.
    check('flagged rows are still counted, not filtered away',
      totals.withForeign === 3, String(totals.withForeign));

    check('a government client is counted',
      totals.govClients === 1, String(totals.govClients));
    check('"United States of America" is not counted as a foreign PPB',
      totals.foreignPPB === 1, String(totals.foreignPPB));
  }

  // ══ 5. THE COUNTRY ROLLUP COUNTS CLIENTS, NOT ROWS ═════════════════════
  //
  // EdgeConneX alone declared seven Luxembourg vehicles. Counted by row,
  // Luxembourg leads the table because ONE company has a complex structure —
  // which is a fact about that company, not about Luxembourg.
  {
    const { byCountry } = F.collect([
      filing('h1', 'EDGECONNEX', Array.from({ length: 7 }, (_, i) => ({
        name: `EQT VEHICLE ${i} S.A.R.L`, country_display: 'Luxembourg',
        ownership_percentage: '25.00' }))),
      filing('h2', 'ACCENTURE, LLP', [
        { name: 'ACCENTURE PLC', country_display: 'Ireland', ownership_percentage: '100.00' }]),
    ]);
    const roll = F.countryRollup(byCountry);
    const lux = roll.find((r) => r.country === 'Luxembourg');
    check('seven vehicles of one client count as one client for Luxembourg',
      lux && lux.clients === 1, JSON.stringify(roll));
    check('and the rollup is sorted by client count',
      roll[0].clients >= roll[roll.length - 1].clients);
  }

  // ══ 6. FILTERS NARROW, THEY DO NOT INVENT ══════════════════════════════
  {
    const { clients } = F.collect([
      filing('i1', 'TIKTOK, INC.', [
        { name: 'BYTEDANCE LTD.', country_display: 'Cayman Islands', ownership_percentage: '100.00' },
        { name: 'ZHANG YIMING', country_display: 'Singapore', ownership_percentage: '21.00' }]),
      filing('i2', 'ACCENTURE, LLP', [
        { name: 'ACCENTURE PLC', country_display: 'Ireland', ownership_percentage: '100.00' }]),
    ]);
    check('no filter returns every client',
      F.clientRows(clients).length === 2);
    check('a country filter keeps only matching owners',
      F.clientRows(clients, { country: 'singapore' }).length === 1
        && F.clientRows(clients, { country: 'singapore' })[0].owners.length === 1);
    check('a client filter matches on the normalised name',
      F.clientRows(clients, { client: 'tiktok' }).length === 1);
    check('a filter that matches nothing returns nothing, not everything',
      F.clientRows(clients, { country: 'atlantis' }).length === 0);

    const [tk] = F.clientRows(clients, { client: 'tiktok' });
    check('owners are ordered by declared stake',
      tk.owners[0].display === 'BYTEDANCE LTD.', tk.owners.map((o) => o.display).join(', '));
    // A missing percentage must not sort as zero-and-forgotten or as 100.
    const { clients: c2 } = F.collect([filing('j1', 'X CO', [
      { name: 'NO PCT LTD', country_display: 'France' }])]);
    check('a missing ownership percentage is null, not 0 and not 100',
      [...c2.values()][0].owners.get('no pct').pct === null);
  }

  // ══ 7. THE BOUNDARY IS PRINTED, NOT ASSUMED ════════════════════════════
  {
    const src = fs.readFileSync(require.resolve('./cli.js'), 'utf8');
    check('the command states coverage before any finding',
      /THIS IS A FLOOR, NOT A CENSUS/.test(src));
    check('and says ownership is not control',
      /OWNERSHIP IS NOT CONTROL/.test(src));
    check('and cites the statute that puts this in the LDA and not FARA',
      /613\(h\)/.test(src));
    check('a --country value cannot leak into a positional subject',
      /--\(into\|only\|skip\|pages\|limit\|chart\|country\|client/.test(src));
  }

  console.log(`\n  ${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS}/${PASS + FAIL} checks\n`);
  return FAIL;
};

if (require.main === module) process.exit(module.exports() ? 1 : 0);
