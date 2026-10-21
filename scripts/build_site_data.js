#!/usr/bin/env node
'use strict';
/**
 * scripts/build_site_data.js — compiles the public Records Door data file.
 *
 * Reads the PRA seed CSVs and writes site/data/atlas.json, the ONLY data the
 * public site ever sees. It runs at deploy time with every private service
 * offline, and it fails closed:
 *
 *   * Columns are ALLOW-LISTED per table. A new column added to a seed CSV
 *     does not reach the public site until someone adds it here on purpose.
 *     Operator notes (`notes`, `geocode_notes`, `account_notes`) never ship.
 *   * Every emitted value is leak-scanned for credential-shaped strings and
 *     private filesystem paths. One hit aborts the build — nothing is written.
 *
 * Usage:  node scripts/build_site_data.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEED = path.join(ROOT, 'modules', 'pra', 'seed');
const OUT = path.join(ROOT, 'site', 'data', 'atlas.json');

const PUBLIC_FIELDS = {
  agencies: ['name', 'agency_type', 'jurisdiction_name', 'address', 'city', 'state', 'zip',
    'latitude', 'longitude', 'phone', 'website_url', 'public_records_url', 'public_records_email',
    'records_portal_type', 'system_role', 'source_url', 'verified_status', 'geocode_confidence'],
  jurisdictions: ['name', 'jurisdiction_type', 'parent_jurisdiction_name', 'state', 'county',
    'centroid_lat', 'centroid_lng', 'source_url', 'verified_status'],
  record_types: ['name', 'description', 'privacy_risk_level', 'default_date_range', 'template_language'],
  portals: ['portal_id', 'name', 'portal_kind', 'url', 'jurisdiction_name', 'covers', 'login_required',
    'accepts_anonymous', 'fee_schedule_url', 'typical_fees', 'submission_notes', 'statute_ref',
    'source_url', 'verified_status', 'status'],
};

const LEAK_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key id'],
  [/AIza[0-9A-Za-z_-]{35}/, 'a Google API key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/sk-[A-Za-z0-9_-]{20,}/, 'a secret API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b[A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/, 'a NAME=value credential'],
  [/(?:^|[\s"'(])(?:\/Users\/|\/home\/|~\/sentinel|[A-Z]:\\Users\\)/, 'a private filesystem path'],
  [/\bevidence\/(?:received|captures)\//, 'a private evidence-store path'],
];

/** RFC 4180 CSV parser — quoted fields, doubled quotes, embedded newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function loadTable(file, table) {
  const [header, ...rows] = parseCsv(fs.readFileSync(path.join(SEED, file), 'utf8'));
  const allowed = PUBLIC_FIELDS[table];
  const missing = allowed.filter((k) => !header.includes(k));
  if (missing.length) throw new Error(`${file}: allow-listed column(s) missing: ${missing.join(', ')}`);
  return rows.map((r, n) => {
    if (r.length !== header.length) throw new Error(`${file}: row ${n + 2} has ${r.length} columns, expected ${header.length}`);
    const out = {};
    for (const k of allowed) out[k] = r[header.indexOf(k)].trim();
    return out;
  });
}

function leakScan(data) {
  const hits = [];
  (function walk(v, where) {
    if (typeof v === 'string') {
      for (const [re, what] of LEAK_PATTERNS) if (re.test(v)) hits.push(`${where}: looks like ${what}`);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
    }
  })(data, 'atlas');
  return hits;
}

function main() {
  const num = (s) => (s === '' || isNaN(Number(s)) ? null : Number(s));
  const bool = (s) => (/^true$/i.test(s) ? true : /^false$/i.test(s) ? false : null);

  const agencies = loadTable('seed_agencies.csv', 'agencies').map((a, i) => ({
    id: `ag-${String(i + 1).padStart(3, '0')}`,
    ...a,
    latitude: num(a.latitude),
    longitude: num(a.longitude),
  }));
  const jurisdictions = loadTable('seed_jurisdictions.csv', 'jurisdictions').map((j) => ({
    ...j, centroid_lat: num(j.centroid_lat), centroid_lng: num(j.centroid_lng),
  }));
  const record_types = loadTable('seed_record_types.csv', 'record_types');
  const portals = loadTable('seed_portals.csv', 'portals')
    .filter((p) => p.status !== 'retired')
    .map((p) => ({ ...p, login_required: bool(p.login_required), accepts_anonymous: bool(p.accepts_anonymous) }));

  const data = {
    contract: 'records-door/atlas@1',
    generated_utc: new Date().toISOString(),
    counts: { agencies: agencies.length, jurisdictions: jurisdictions.length, record_types: record_types.length, portals: portals.length },
    agencies, jurisdictions, record_types, portals,
  };

  const hits = leakScan(data);
  if (hits.length) {
    console.error(`LEAK SCAN FAILED — nothing written (${hits.length} hit(s)):\n  ` + hits.join('\n  '));
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + '\n');
  console.log(`atlas.json: ${agencies.length} agencies, ${jurisdictions.length} jurisdictions, ` +
    `${record_types.length} record types, ${portals.length} portals — leak scan clean`);
}

if (require.main === module) main();
module.exports = { parseCsv, leakScan, PUBLIC_FIELDS };
