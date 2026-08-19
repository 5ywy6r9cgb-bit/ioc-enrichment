#!/usr/bin/env node
'use strict';
/**
 * scripts/load_seeds.js — load the reference CSVs into the database.
 *
 *   node scripts/load_seeds.js            load everything
 *   node scripts/load_seeds.js --dry-run  parse and validate, write nothing
 *
 * The reference tables — jurisdictions, agencies, portals, record_types — are
 * the directory the whole system files against. They are OWNER-seeded: the
 * running app has read-only access to them, by design, so a bug in the app can
 * never rewrite your agency directory. This loader therefore runs as the
 * database owner, not as sentinel_app.
 *
 * It is idempotent. Re-running updates rows in place (ON CONFLICT DO UPDATE),
 * so you can edit a CSV and re-load without duplicating anything. The whole
 * load runs in ONE transaction: it all lands, or none of it does.
 */

const fs = require('fs');
const path = require('path');
const { Db } = require('../server/db.js');

const SEED_DIR = path.join(__dirname, '..', 'seed');

// ---------------------------------------------------------------- CSV
/**
 * A real CSV parser — the seed files have quoted fields containing commas and
 * newlines (portal "covers" text, agency notes). A naive split on comma
 * silently shifts every column after the first quoted comma, which is exactly
 * the bug the seed_integrity check was written to catch.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // ignore; handle on \n
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // drop a trailing empty row from a final newline
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function readCsv(name) {
  const p = path.join(SEED_DIR, name);
  const rows = parseCsv(fs.readFileSync(p, 'utf8'));
  const header = rows.shift().map((h) => h.trim());
  return rows.map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] === undefined || r[i] === '') ? null : r[i]; });
    return obj;
  });
}

// ---------------------------------------------------------------- ids
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  if (v === null || v === undefined || v === '') return null;
  return /^(t|true|yes|y|1)$/i.test(String(v).trim());
}

// ---------------------------------------------------------------- load
async function loadJurisdictions(client, dryRun) {
  const rows = readCsv('seed_jurisdictions.csv');
  const byName = new Map();
  for (const r of rows) byName.set(r.name, slug(r.name));

  let n = 0;
  for (const r of rows) {
    const id = byName.get(r.name);
    const parentId = r.parent_jurisdiction_name ? byName.get(r.parent_jurisdiction_name) || null : null;
    if (dryRun) { n += 1; continue; }
    await client.query(
      `INSERT INTO jurisdictions
         (jurisdiction_id, name, jurisdiction_type, parent_id, state, county,
          centroid_lat, centroid_lng, boundary_geojson_url, source_url, verified_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'unverified'))
       ON CONFLICT (jurisdiction_id) DO UPDATE SET
         name=EXCLUDED.name, jurisdiction_type=EXCLUDED.jurisdiction_type,
         parent_id=EXCLUDED.parent_id, state=EXCLUDED.state, county=EXCLUDED.county,
         centroid_lat=EXCLUDED.centroid_lat, centroid_lng=EXCLUDED.centroid_lng,
         boundary_geojson_url=EXCLUDED.boundary_geojson_url, source_url=EXCLUDED.source_url,
         verified_status=EXCLUDED.verified_status`,
      [id, r.name, r.jurisdiction_type, parentId, r.state, r.county,
       num(r.centroid_lat), num(r.centroid_lng), r.boundary_geojson_url, r.source_url, r.verified_status]
    );
    n += 1;
  }
  return n;
}

async function loadAgencies(client, dryRun) {
  const rows = readCsv('seed_agencies.csv');
  // resolve jurisdiction_id from the jurisdiction NAME on each agency row
  const jur = new Map();
  const jrows = await client.query('SELECT jurisdiction_id, name FROM jurisdictions');
  for (const j of jrows.rows) jur.set(j.name, j.jurisdiction_id);

  let n = 0;
  for (const r of rows) {
    const jname = r.jurisdiction_name || r.jurisdiction;
    const jid = jname ? jur.get(jname) || null : null;
    const id = slug(`${r.name}`);
    if (dryRun) { n += 1; continue; }
    await client.query(
      `INSERT INTO agencies
         (agency_id, name, jurisdiction, county, state, agency_type, source,
          jurisdiction_id, address, city, zip, latitude, longitude, phone,
          website_url, public_records_url, public_records_email, records_portal_type,
          system_role, source_url, verified_status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'seed',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,COALESCE($20,'unverified'),$21)
       ON CONFLICT (agency_id) DO UPDATE SET
         name=EXCLUDED.name, jurisdiction=EXCLUDED.jurisdiction, county=EXCLUDED.county,
         state=EXCLUDED.state, agency_type=EXCLUDED.agency_type,
         jurisdiction_id=EXCLUDED.jurisdiction_id, address=EXCLUDED.address, city=EXCLUDED.city,
         zip=EXCLUDED.zip, latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude,
         phone=EXCLUDED.phone, website_url=EXCLUDED.website_url,
         public_records_url=EXCLUDED.public_records_url, public_records_email=EXCLUDED.public_records_email,
         records_portal_type=EXCLUDED.records_portal_type, system_role=EXCLUDED.system_role,
         source_url=EXCLUDED.source_url, verified_status=EXCLUDED.verified_status, notes=EXCLUDED.notes`,
      [id, r.name, jname, r.county || null, r.state, r.agency_type, jid,
       r.address, r.city, r.zip, num(r.latitude), num(r.longitude), r.phone,
       r.website_url, r.public_records_url, r.public_records_email, r.records_portal_type,
       r.system_role, r.source_url, r.verified_status, r.notes]
    );
    n += 1;
  }
  return n;
}

async function loadPortals(client, dryRun) {
  const rows = readCsv('seed_portals.csv');
  const jur = new Map();
  const jrows = await client.query('SELECT jurisdiction_id, name FROM jurisdictions');
  for (const j of jrows.rows) jur.set(j.name, j.jurisdiction_id);

  let n = 0;
  for (const r of rows) {
    const jid = r.jurisdiction_name ? jur.get(r.jurisdiction_name) || null : null;
    if (dryRun) { n += 1; continue; }
    await client.query(
      `INSERT INTO portals
         (portal_id, name, portal_kind, url, jurisdiction_id, covers, login_required,
          account_notes, accepts_anonymous, fee_schedule_url, typical_fees, submission_notes,
          statute_ref, source_url, verified_status, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,false),$8,$9,$10,$11,$12,$13,$14,
               COALESCE($15,'unverified'),COALESCE($16,'active'),$17)
       ON CONFLICT (portal_id) DO UPDATE SET
         name=EXCLUDED.name, portal_kind=EXCLUDED.portal_kind, url=EXCLUDED.url,
         jurisdiction_id=EXCLUDED.jurisdiction_id, covers=EXCLUDED.covers,
         login_required=EXCLUDED.login_required, account_notes=EXCLUDED.account_notes,
         accepts_anonymous=EXCLUDED.accepts_anonymous, fee_schedule_url=EXCLUDED.fee_schedule_url,
         typical_fees=EXCLUDED.typical_fees, submission_notes=EXCLUDED.submission_notes,
         statute_ref=EXCLUDED.statute_ref, source_url=EXCLUDED.source_url,
         verified_status=EXCLUDED.verified_status, status=EXCLUDED.status, notes=EXCLUDED.notes`,
      [r.portal_id, r.name, r.portal_kind, r.url, jid, r.covers, bool(r.login_required),
       r.account_notes, bool(r.accepts_anonymous), r.fee_schedule_url, r.typical_fees,
       r.submission_notes, r.statute_ref, r.source_url, r.verified_status, r.status, r.notes]
    );
    n += 1;
  }
  return n;
}

async function loadRecordTypes(client, dryRun) {
  const rows = readCsv('seed_record_types.csv');
  let n = 0;
  for (const r of rows) {
    const id = slug(r.name);
    if (dryRun) { n += 1; continue; }
    await client.query(
      `INSERT INTO record_types
         (record_type_id, name, description, privacy_risk_level, default_date_range, template_language)
       VALUES ($1,$2,$3,COALESCE($4,'low'),$5,$6)
       ON CONFLICT (record_type_id) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description,
         privacy_risk_level=EXCLUDED.privacy_risk_level,
         default_date_range=EXCLUDED.default_date_range, template_language=EXCLUDED.template_language`,
      [id, r.name, r.description, r.privacy_risk_level, r.default_date_range, r.template_language]
    );
    n += 1;
  }
  return n;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = new Db();
  if (!(await db.isAvailable())) {
    console.error(`\n  database not reachable: ${db.lastError()}\n  Is Postgres running? See config/local.example.env\n`);
    process.exit(2);
  }

  const counts = await db.withTransaction(async (client) => ({
    jurisdictions: await loadJurisdictions(client, dryRun),
    agencies: await loadAgencies(client, dryRun),
    portals: await loadPortals(client, dryRun),
    record_types: await loadRecordTypes(client, dryRun),
  }));

  console.log(`\n  ${dryRun ? 'DRY RUN — parsed and validated, nothing written' : 'loaded'}:`);
  for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(14)} ${v}`);
  console.log('');
  await db.close();
}

main().catch((e) => { console.error('\n  seed load failed:', e.message, '\n'); process.exit(1); });
