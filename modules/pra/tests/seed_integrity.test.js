'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./_harness.js');

const SEED = path.join(__dirname, '..', 'seed');

// Same parser the loader uses, so the test exercises the real path.
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { field += '"'; i += 1; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

function load(name) {
  const rows = parseCsv(fs.readFileSync(path.join(SEED, name), 'utf8'));
  const header = rows.shift();
  return { header, rows, objs: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}

module.exports = function run() {
  H.suite('seed_integrity — the CSVs match what the schema will accept');

  const files = ['seed_jurisdictions.csv','seed_agencies.csv','seed_portals.csv','seed_record_types.csv'];
  for (const f of files) {
    const { header, rows } = load(f);
    const bad = rows.filter((r) => r.length !== header.length);
    H.eq(`${f}: every row has ${header.length} columns`, bad.length, 0);
  }

  // Enum values the schema CHECKs.
  const J_TYPES = ['federal','state','county','city','village','township','school_district',
    'court_district','appellate_district','utility_service_area','special_district','other'];
  const { objs: jur } = load('seed_jurisdictions.csv');
  H.eq('jurisdiction_type values are all valid',
    jur.filter((j) => !J_TYPES.includes(j.jurisdiction_type)).map((j) => j.name), []);

  const P_KINDS = ['email','web_form','nextrequest','govqa','justfoia','efiling','docket_search',
    'records_search','open_data','business_registry','campaign_finance','court_appeal','mail',
    'in_person','phone','fax','other'];
  const { objs: portals } = load('seed_portals.csv');
  H.eq('portal_kind values are all valid',
    portals.filter((p) => !P_KINDS.includes(p.portal_kind)).map((p) => p.portal_id), []);

  const VERIFIED = ['unverified','verified','needs_review',''];
  H.eq('portal verified_status values are valid',
    portals.filter((p) => !VERIFIED.includes(p.verified_status || '')).map((p) => p.portal_id), []);

  const RISK = ['low','medium','high',''];
  const { objs: rt } = load('seed_record_types.csv');
  H.eq('privacy_risk_level values are valid',
    rt.filter((r) => !RISK.includes(r.privacy_risk_level || '')).map((r) => r.name), []);

  // The portals_no_credentials CHECK will reject these outright.
  H.eq('no portal account_notes contains credential words',
    portals.filter((p) => /(password|passwd|api[_ -]?key|secret|bearer)/i.test(p.account_notes || '')).map((p) => p.portal_id), []);

  // Referential integrity before the FK ever sees it.
  const names = new Set(jur.map((j) => j.name));
  H.eq('every parent_jurisdiction_name resolves',
    jur.filter((j) => j.parent_jurisdiction_name && !names.has(j.parent_jurisdiction_name)).map((j) => j.name), []);

  const { objs: ag } = load('seed_agencies.csv');
  H.eq('every agency jurisdiction_name resolves',
    ag.filter((a) => a.jurisdiction_name && !names.has(a.jurisdiction_name)).map((a) => a.name), []);

  // Uniqueness — a duplicate would silently overwrite on load.
  const dupes = (arr) => arr.filter((v, i) => arr.indexOf(v) !== i);
  H.eq('agency names are unique', dupes(ag.map((a) => a.name)), []);
  H.eq('portal ids are unique', dupes(portals.map((p) => p.portal_id)), []);
  H.eq('jurisdiction names are unique', dupes(jur.map((j) => j.name)), []);

  // The seven counties are actually present.
  for (const c of ['Franklin County','Licking County','Union County','Pickaway County','Knox County','Mahoning County','Fairfield County'])
    H.check(`${c} is seeded`, names.has(c));

  // Every county has a Board of Elections — the local-money gap.
  for (const c of ['Franklin','Licking','Union','Pickaway','Knox','Mahoning','Fairfield'])
    H.check(`${c} County has a Board of Elections row`,
      ag.some((a) => a.name === `${c} County Board of Elections`));
};
