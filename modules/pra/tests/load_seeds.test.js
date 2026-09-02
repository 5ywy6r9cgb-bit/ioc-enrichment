'use strict';
/**
 * tests/load_seeds.test.js — the seed loader's pure half.
 *
 * The loader is the only thing in this system that writes the directory every
 * other table files against. If it mis-parses a row, the damage is silent:
 * an agency lands with its privacy level in the date column and nothing ever
 * complains. So the parser and the validator are tested here directly, and
 * the real seed CSVs are parsed as part of the suite — a check that runs
 * against the actual data, not a fixture that can drift away from it.
 *
 * No database. The loader's DB half is exercised by repo_atomicity; what is
 * covered here is everything that decides whether a write should happen at all.
 */

const H = require('./_harness.js');
const path = require('path');
const fs = require('fs');
const L = require('../scripts/load_seeds.js');

const SEED_DIR = path.join(__dirname, '..', 'seed');

module.exports = function run() {
  H.suite('load_seeds');

  // ---------------------------------------------------------------- CSV
  // The single most consequential parser bug in a seed loader: a comma inside
  // a quoted field shifting every column after it. Guard it explicitly.
  {
    const grid = L.parseCsv('a,b,c\n1,"two, with comma",3\n');
    H.eq('quoted comma does not shift columns', grid[1], ['1', 'two, with comma', '3']);
  }
  H.eq('escaped double-quote unescapes',
    L.parseCsv('a\n"he said ""hi"""\n')[1], ['he said "hi"']);
  H.eq('newline inside quotes stays in the field',
    L.parseCsv('a,b\n"line1\nline2",x\n')[1], ['line1\nline2', 'x']);
  H.eq('CRLF line endings parse the same',
    L.parseCsv('a,b\r\n1,2\r\n')[1], ['1', '2']);
  H.eq('trailing row without newline is kept',
    L.parseCsv('a,b\n1,2')[1], ['1', '2']);
  H.check('blank lines are dropped', L.parseCsv('a\n\n1\n').length === 2);

  // ---------------------------------------------------------------- ids
  H.eq('slug lowercases and hyphenates', L.slug('Franklin County'), 'franklin-county');
  H.eq('slug expands & so "A & B" and "A and B" agree',
    L.slug('Parks & Recreation'), L.slug('Parks and Recreation'));
  H.eq('slug trims leading/trailing separators', L.slug('  --City of Columbus--  '), 'city-of-columbus');
  H.eq('slug of empty is empty string', L.slug(null), '');
  H.check('slug is capped at 80 chars', L.slug('x'.repeat(200)).length === 80);

  H.eq('num parses a float', L.num('39.9612'), 39.9612);
  H.eq('num of empty string is null, not 0', L.num(''), null);
  H.eq('num of garbage is null', L.num('n/a'), null);
  H.eq('bool accepts true/yes/1', [L.bool('true'), L.bool('Yes'), L.bool('1')], [true, true, true]);
  H.eq('bool of empty is null, not false', L.bool(''), null);
  H.eq('bool of "no" is false', L.bool('no'), false);

  // ------------------------------------------------------------ validate
  const jurSchema = L.SCHEMAS.jurisdictions;
  const agSchema = L.SCHEMAS.agencies;

  {
    const v = L.validateTable('jurisdictions',
      [{ _line: 2, name: 'Ohio', jurisdiction_type: null }], jurSchema);
    H.check('missing required field is a hard error',
      v.errors.some((e) => e.includes('required field "jurisdiction_type"')), v.errors.join('; '));
  }

  {
    const v = L.validateTable('jurisdictions',
      [{ _line: 2, name: 'Ohio', jurisdiction_type: 'planet' }], jurSchema);
    H.check('hard enum violation is an error, not a warning',
      v.errors.some((e) => e.includes('jurisdiction_type "planet"')) && v.warnings.length === 0);
  }

  {
    const v = L.validateTable('jurisdictions',
      [{ _line: 2, name: 'Ohio', jurisdiction_type: 'state', verified_status: 'probably' }], jurSchema);
    H.check('soft enum violation warns and does not block',
      v.errors.length === 0 && v.warnings.some((w) => w.includes('verified_status "probably"')));
  }

  {
    const v = L.validateTable('jurisdictions', [
      { _line: 2, name: 'Ohio', jurisdiction_type: 'state', centroid_lat: '95.0' },
      { _line: 3, name: 'Iowa', jurisdiction_type: 'state', centroid_lng: 'east' },
    ], jurSchema);
    H.check('latitude out of range is an error',
      v.errors.some((e) => e.includes('centroid_lat 95 out of range')), v.errors.join('; '));
    H.check('non-numeric longitude is an error',
      v.errors.some((e) => e.includes('centroid_lng "east" is not a number')), v.errors.join('; '));
  }

  {
    // Two distinct names that slug to one id would upsert onto each other and
    // silently lose a row. That has to be fatal, not a warning.
    const v = L.validateTable('jurisdictions', [
      { _line: 2, name: 'Parks & Recreation', jurisdiction_type: 'special_district' },
      { _line: 3, name: 'Parks and Recreation', jurisdiction_type: 'special_district' },
    ], jurSchema);
    H.check('slug collision between distinct names is a hard error',
      v.collisions.includes('parks-and-recreation')
      && v.errors.some((e) => e.includes('would overwrite the other')), v.errors.join('; '));
  }

  {
    // Same name twice is a duplicate row, not a collision — it upserts onto
    // itself, which is the loader's declared idempotent behaviour.
    const v = L.validateTable('jurisdictions', [
      { _line: 2, name: 'Ohio', jurisdiction_type: 'state' },
      { _line: 3, name: 'Ohio', jurisdiction_type: 'state' },
    ], jurSchema);
    H.eq('identical name twice is not a collision', v.collisions, []);
  }

  {
    const v = L.validateTable('jurisdictions', [
      { _line: 2, name: 'Ohio', jurisdiction_type: 'state' },
      { _line: 3, name: 'Franklin County', jurisdiction_type: 'county', parent_jurisdiction_name: 'Atlantis' },
    ], jurSchema);
    H.check('parent that resolves to nothing is an error',
      v.errors.some((e) => e.includes('parent_jurisdiction_name "Atlantis"')), v.errors.join('; '));
  }

  {
    const idx = L.buildJurisdictionIndex([{ name: 'Franklin County' }]);
    const bad = L.validateTable('agencies',
      [{ _line: 2, name: 'X', agency_type: 'police', jurisdiction_name: 'Nowhere County' }],
      agSchema, { jurIndex: idx });
    H.check('agency pointing at an unknown jurisdiction is a hard error',
      bad.errors.some((e) => e.includes('resolves to no jurisdiction')), bad.errors.join('; '));

    const good = L.validateTable('agencies',
      [{ _line: 2, name: 'X', agency_type: 'police', jurisdiction_name: 'Franklin County' }],
      agSchema, { jurIndex: idx });
    H.eq('agency pointing at a known jurisdiction is clean', good.errors, []);
  }

  {
    // portals.ref is optional: an unresolvable jurisdiction warns rather than
    // blocking, because a federal portal legitimately covers no Ohio row.
    const idx = L.buildJurisdictionIndex([{ name: 'Ohio' }]);
    const v = L.validateTable('portals',
      [{ _line: 2, portal_id: 'p1', name: 'P', portal_kind: 'web_form', jurisdiction_name: 'Federal' }],
      L.SCHEMAS.portals, { jurIndex: idx });
    H.check('optional ref that misses is a warning, not an error',
      v.errors.length === 0 && v.warnings.some((w) => w.includes('resolves to no jurisdiction')),
      `errors=${v.errors.join('; ')}`);
  }

  {
    const v = L.validateTable('agencies', [
      { _line: 2, name: 'X', agency_type: 'police', jurisdiction_name: null, zip: '4321' },
      { _line: 3, name: 'Y', agency_type: 'police', jurisdiction_name: null, public_records_email: 'not-an-email' },
    ], agSchema);
    H.check('malformed ZIP warns', v.warnings.some((w) => w.includes('is not a 5- or 9-digit ZIP')));
    H.check('malformed email warns', v.warnings.some((w) => w.includes('does not look like an email')));
  }

  {
    // privacy_risk_level carries a DB CHECK constraint. A bad value must be
    // reported before the transaction opens, with that fact stated.
    const v = L.validateTable('record_types',
      [{ _line: 2, name: 'X', privacy_risk_level: 'catastrophic' }], L.SCHEMAS.record_types);
    H.check('DB-checked enum names the constraint in its message',
      v.warnings.some((w) => w.includes('DB CHECK constraint will likely reject')), v.warnings.join('; '));
  }

  // -------------------------------------------------- the real seed files
  // These run against the shipped CSVs. If someone edits a seed file and
  // shifts a column, this suite fails rather than the database.
  for (const [table, schema] of Object.entries(L.SCHEMAS)) {
    const p = path.join(SEED_DIR, schema.file);
    if (!fs.existsSync(p)) { H.check(`seed file ${schema.file} exists`, false, 'not found'); continue; }
    const r = L.readCsvChecked(schema.file, schema);
    H.eq(`${schema.file}: header matches the declared manifest`, r.headerErrors, []);
    H.check(`${schema.file}: has rows`, r.rows.length > 0, `${r.rows.length} rows`);
    H.eq(`${schema.file}: no unexpected extra columns`, r.extraColumns || [], []);
    void table;
  }

  {
    // The specific row that proves quoted-comma handling on real data:
    // its description contains a comma, so a naive parser would put
    // "non-personal incident statistics" into privacy_risk_level.
    const r = L.readCsvChecked('seed_record_types.csv', L.SCHEMAS.record_types);
    const row = r.rows.find((x) => /Police\/fire incident aggregate/.test(x.name || ''));
    H.check('the comma-bearing record_type row is present', !!row);
    if (row) {
      H.eq('description keeps its embedded comma intact',
        row.description, 'Aggregate, non-personal incident statistics');
      H.eq('privacy_risk_level is not shifted by that comma', row.privacy_risk_level, 'medium');
      H.check('privacy_risk_level is a legal value for the DB CHECK',
        L.SCHEMAS.record_types.enums.privacy_risk_level.values.includes(row.privacy_risk_level));
    }
  }

  {
    // Full cross-file reference check on the shipped data — the same pass
    // --dry-run performs, asserted here so a broken seed never reaches a load.
    const jur = L.readCsvChecked('seed_jurisdictions.csv', L.SCHEMAS.jurisdictions);
    const idx = L.buildJurisdictionIndex(jur.rows);
    const vj = L.validateTable('jurisdictions', jur.rows, L.SCHEMAS.jurisdictions);
    H.eq('shipped jurisdictions validate with no errors', vj.errors, []);

    for (const table of ['agencies', 'portals', 'record_types']) {
      const schema = L.SCHEMAS[table];
      const r = L.readCsvChecked(schema.file, schema);
      const v = L.validateTable(table, r.rows, schema, { jurIndex: idx });
      H.eq(`shipped ${table} validate with no errors`, v.errors, []);
    }
  }

  {
    const q = L.qualityReport({
      agencies: [
        { verified_status: 'verified', public_records_email: 'a@b.gov', latitude: '1', longitude: '2' },
        { verified_status: 'unverified', latitude: null, longitude: null },
      ],
    });
    H.check('quality report counts unverified, contactless and uncoordinated agencies',
      q.some((s) => s.includes('agencies: 1/2 unverified') && s.includes('1 with no records contact')
        && s.includes('1 with no coordinates')), q.join(' | '));
  }

  {
    const r = L.readCsvChecked('does_not_exist.csv', { columns: [] });
    H.check('a missing seed file is reported as missing, not thrown', r.missing === true && r.rows.length === 0);
  }
};

if (require.main === module) { module.exports(); process.exit(H.report()); }
