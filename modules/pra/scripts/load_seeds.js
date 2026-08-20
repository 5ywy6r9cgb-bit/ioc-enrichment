#!/usr/bin/env node
'use strict';
/**
 * scripts/load_seeds.js — load the reference CSVs into the database.
 *
 *   node scripts/load_seeds.js              validate, then load everything
 *   node scripts/load_seeds.js --dry-run    validate only; write nothing, touch no DB rows
 *   node scripts/load_seeds.js --strict     treat data-quality warnings as errors
 *   node scripts/load_seeds.js --only=agencies,portals   load a subset
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
 *
 * The "verify before you write" pass:
 *   1. VALIDATE-THEN-LOAD. Every file is fully parsed and checked before a
 *      single row is written. A hard error anywhere aborts with a
 *      line-numbered report, so a bad value on row 400 never leaves a
 *      half-applied seed. Same discipline you apply to a source: confirm it
 *      before you rely on it.
 *   2. HEADER ASSERTION against a declared manifest. A shifted or renamed
 *      column is caught here, not silently mapped to null three columns over.
 *   3. DRY-RUN VALIDATES REFERENCES from the CSVs, not the DB, so --dry-run
 *      on an empty database still proves every agency and portal resolves.
 *   4. SLUG-COLLISION DETECTION. Two names that slug to one id would silently
 *      upsert onto each other, losing one. That is an error.
 *   5. INSERT vs UPDATE counts, plus a directory-health summary.
 *   6. Missing seed files are skipped with a notice instead of crashing.
 *
 * Pure functions are exported for testing; the DB is only touched when this
 * file is run directly.
 */

const fs = require('fs');
const path = require('path');

const SEED_DIR = path.join(__dirname, '..', 'seed');

// ==================================================================== CSV
/**
 * A real CSV parser — the seed files have quoted fields containing commas and
 * newlines (portal "covers" text, agency notes). A naive split on comma
 * silently shifts every column after the first quoted comma.
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
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/**
 * Parse a seed file into objects AND validate its header against the schema.
 * Rows carry a hidden _line for error messages (actual 1-based file line).
 */
function readCsvChecked(name, schema) {
  const p = path.join(SEED_DIR, name);
  if (!fs.existsSync(p)) return { missing: true, rows: [], header: [], headerErrors: [] };

  const grid = parseCsv(fs.readFileSync(p, 'utf8'));
  if (grid.length === 0) return { rows: [], header: [], headerErrors: [`${name}: file is empty`] };

  const header = grid.shift().map((h) => h.trim());
  const expected = new Set(schema.columns);
  const seen = new Set(header);
  const headerErrors = [];
  for (const col of schema.columns) {
    if (!seen.has(col)) headerErrors.push(`${name}: missing expected column "${col}"`);
  }
  const extra = header.filter((h) => !expected.has(h));

  const rows = grid.map((r, idx) => {
    const obj = { _line: idx + 2 };
    header.forEach((h, i) => { obj[h] = (r[i] === undefined || r[i] === '') ? null : r[i]; });
    return obj;
  });
  return { rows, header, headerErrors, extraColumns: extra };
}

// ==================================================================== ids
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

// ==================================================================== schema
// Declared manifests: expected columns, id source, required fields, value
// rules. Enum sets marked `soft` warn; anything else is a hard error because
// it will break the insert or the meaning of the row.
const SCHEMAS = {
  jurisdictions: {
    file: 'seed_jurisdictions.csv',
    idFrom: 'name',
    columns: ['name', 'jurisdiction_type', 'parent_jurisdiction_name', 'state', 'county',
      'centroid_lat', 'centroid_lng', 'boundary_geojson_url', 'source_url', 'verified_status'],
    required: ['name', 'jurisdiction_type'],
    lat: ['centroid_lat'], lng: ['centroid_lng'],
    enums: {
      jurisdiction_type: { soft: false, values: ['federal', 'state', 'county', 'city', 'village', 'township',
        'school_district', 'court_district', 'appellate_district', 'utility_service_area', 'special_district', 'other'] },
      verified_status: { soft: true, values: ['unverified', 'verified', 'needs_review'] },
    },
  },
  agencies: {
    file: 'seed_agencies.csv',
    idFrom: 'name',
    ref: { column: 'jurisdiction_name', table: 'jurisdictions' },
    columns: ['name', 'agency_type', 'jurisdiction_name', 'address', 'city', 'state', 'zip',
      'latitude', 'longitude', 'phone', 'website_url', 'public_records_url',
      'public_records_email', 'records_portal_type', 'system_role', 'source_url',
      'verified_status', 'notes', 'geocode_source', 'geocode_confidence', 'geocode_notes'],
    required: ['name', 'agency_type', 'jurisdiction_name'],
    lat: ['latitude'], lng: ['longitude'], zip: ['zip'], email: ['public_records_email'],
    enums: {
      records_portal_type: { soft: true, values: ['email', 'form', 'nextrequest', 'portal', 'phone', 'mail', 'in_person', 'mixed', 'unknown'] },
      geocode_confidence: { soft: true, values: ['high', 'medium', 'low'] },
      verified_status: { soft: true, values: ['unverified', 'verified', 'needs_review'] },
    },
  },
  portals: {
    file: 'seed_portals.csv',
    idFrom: 'portal_id',
    ref: { column: 'jurisdiction_name', table: 'jurisdictions', optional: true },
    columns: ['portal_id', 'name', 'portal_kind', 'url', 'jurisdiction_name', 'covers',
      'login_required', 'account_notes', 'accepts_anonymous', 'fee_schedule_url',
      'typical_fees', 'submission_notes', 'statute_ref', 'source_url', 'verified_status',
      'status', 'notes'],
    required: ['portal_id', 'name'],
    enums: {
      portal_kind: { soft: false, values: ['email', 'web_form', 'nextrequest', 'govqa', 'justfoia', 'efiling',
        'docket_search', 'records_search', 'open_data', 'business_registry', 'campaign_finance',
        'court_appeal', 'mail', 'in_person', 'phone', 'fax', 'other'] },
      verified_status: { soft: true, values: ['unverified', 'verified', 'needs_review'] },
      status: { soft: true, values: ['active', 'changed', 'dead', 'unknown'] },
    },
  },
  record_types: {
    file: 'seed_record_types.csv',
    idFrom: 'name',
    columns: ['name', 'description', 'privacy_risk_level', 'default_date_range', 'template_language'],
    required: ['name'],
    enums: {
      // This one has a DB CHECK constraint. A stray value fails the insert
      // mid-transaction, so it is reported loudly and --strict stops pre-flight.
      privacy_risk_level: { soft: true, values: ['low', 'medium', 'high'], likelyChecked: true },
    },
  },
};

// ==================================================================== validate
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;

/**
 * Validate one table against its schema plus (for agencies/portals) the
 * jurisdiction index. errors block the load; warnings do not unless --strict.
 */
function validateTable(name, rows, schema, ctx = {}) {
  const errors = [];
  const warnings = [];
  const idIndex = new Map();
  const slugOwners = new Map();

  rows.forEach((r) => {
    const where = `${schema.file}:${r._line}`;

    for (const col of schema.required || []) {
      if (r[col] === null || r[col] === undefined || String(r[col]).trim() === '') {
        errors.push(`${where}: required field "${col}" is empty`);
      }
    }

    const rawId = r[schema.idFrom];
    if (rawId) {
      const id = schema.idFrom === 'portal_id' ? String(rawId).trim() : slug(rawId);
      idIndex.set(id, rawId);
      if (!slugOwners.has(id)) slugOwners.set(id, []);
      slugOwners.get(id).push(String(rawId));
    }

    for (const col of schema.lat || []) {
      if (r[col] != null) {
        const v = num(r[col]);
        if (v === null) errors.push(`${where}: ${col} "${r[col]}" is not a number`);
        else if (v < -90 || v > 90) errors.push(`${where}: ${col} ${v} out of range [-90,90]`);
      }
    }
    for (const col of schema.lng || []) {
      if (r[col] != null) {
        const v = num(r[col]);
        if (v === null) errors.push(`${where}: ${col} "${r[col]}" is not a number`);
        else if (v < -180 || v > 180) errors.push(`${where}: ${col} ${v} out of range [-180,180]`);
      }
    }
    for (const col of schema.zip || []) {
      if (r[col] != null && !ZIP_RE.test(String(r[col]).trim())) {
        warnings.push(`${where}: ${col} "${r[col]}" is not a 5- or 9-digit ZIP`);
      }
    }
    for (const col of schema.email || []) {
      if (r[col] != null && !EMAIL_RE.test(String(r[col]).trim())) {
        warnings.push(`${where}: ${col} "${r[col]}" does not look like an email`);
      }
    }

    for (const [col, rule] of Object.entries(schema.enums || {})) {
      const val = r[col];
      if (val != null && !rule.values.includes(String(val).trim())) {
        const msg = `${where}: ${col} "${val}" not in {${rule.values.join(', ')}}`
          + (rule.likelyChecked ? ' — a DB CHECK constraint will likely reject this row' : '');
        if (rule.soft) warnings.push(msg); else errors.push(msg);
      }
    }

    if (schema.ref && r[schema.ref.column] != null) {
      const jid = slug(r[schema.ref.column]);
      if (ctx.jurIndex && !ctx.jurIndex.has(jid)) {
        const m = `${where}: ${schema.ref.column} "${r[schema.ref.column]}" resolves to no jurisdiction`;
        if (schema.ref.optional) warnings.push(m); else errors.push(m);
      }
    }
  });

  if (name === 'jurisdictions') {
    rows.forEach((r) => {
      if (r.parent_jurisdiction_name != null) {
        const pid = slug(r.parent_jurisdiction_name);
        if (!idIndex.has(pid)) {
          errors.push(`${schema.file}:${r._line}: parent_jurisdiction_name "${r.parent_jurisdiction_name}" resolves to no jurisdiction in this file`);
        }
      }
    });
  }

  const collisions = [];
  for (const [id, names] of slugOwners) {
    const distinct = [...new Set(names)];
    if (distinct.length > 1) {
      collisions.push(id);
      errors.push(`${schema.file}: id "${id}" is produced by ${distinct.length} different names (${distinct.join(' | ')}) — one would overwrite the other`);
    }
  }

  return { errors, warnings, idIndex, collisions };
}

/** Directory-health facts worth printing after a load. Signal, not errors. */
function qualityReport(tables) {
  const q = [];
  const ag = tables.agencies || [];
  if (ag.length) {
    const unver = ag.filter((r) => (r.verified_status || 'unverified') !== 'verified').length;
    const noContact = ag.filter((r) => !r.public_records_email && !r.public_records_url).length;
    const noCoords = ag.filter((r) => num(r.latitude) === null || num(r.longitude) === null).length;
    q.push(`agencies: ${unver}/${ag.length} unverified · ${noContact} with no records contact · ${noCoords} with no coordinates`);
  }
  const jr = tables.jurisdictions || [];
  if (jr.length) {
    const unver = jr.filter((r) => (r.verified_status || 'unverified') !== 'verified').length;
    q.push(`jurisdictions: ${unver}/${jr.length} unverified`);
  }
  const po = tables.portals || [];
  if (po.length) {
    const unver = po.filter((r) => (r.verified_status || 'unverified') !== 'verified').length;
    q.push(`portals: ${unver}/${po.length} unverified — run: sentinel pra portals`);
  }
  return q;
}

// ==================================================================== load
function buildJurisdictionIndex(jurRows) {
  const idx = new Map();
  for (const r of jurRows) if (r.name) idx.set(slug(r.name), slug(r.name));
  return idx;
}

// Each loader returns { inserted, updated }. RETURNING (xmax = 0) tells an
// insert apart from an update on a conflicting key.
async function loadJurisdictions(client, rows) {
  let inserted = 0; let updated = 0;
  for (const r of rows) {
    const id = slug(r.name);
    const parentId = r.parent_jurisdiction_name ? slug(r.parent_jurisdiction_name) : null;
    const res = await client.query(
      `INSERT INTO jurisdictions
         (jurisdiction_id, name, jurisdiction_type, parent_id, state, county,
          centroid_lat, centroid_lng, boundary_geojson_url, source_url, verified_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'unverified'))
       ON CONFLICT (jurisdiction_id) DO UPDATE SET
         name=EXCLUDED.name, jurisdiction_type=EXCLUDED.jurisdiction_type,
         parent_id=EXCLUDED.parent_id, state=EXCLUDED.state, county=EXCLUDED.county,
         centroid_lat=EXCLUDED.centroid_lat, centroid_lng=EXCLUDED.centroid_lng,
         boundary_geojson_url=EXCLUDED.boundary_geojson_url, source_url=EXCLUDED.source_url,
         verified_status=EXCLUDED.verified_status
       RETURNING (xmax = 0) AS inserted`,
      [id, r.name, r.jurisdiction_type, parentId, r.state, r.county,
       num(r.centroid_lat), num(r.centroid_lng), r.boundary_geojson_url, r.source_url, r.verified_status]
    );
    if (res.rows[0].inserted) inserted += 1; else updated += 1;
  }
  return { inserted, updated };
}

async function loadAgencies(client, rows, jurIndex) {
  let inserted = 0; let updated = 0;
  for (const r of rows) {
    const jname = r.jurisdiction_name || r.jurisdiction;
    const jid = jname ? (jurIndex.get(slug(jname)) || null) : null;
    const id = slug(r.name);
    const res = await client.query(
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
         source_url=EXCLUDED.source_url, verified_status=EXCLUDED.verified_status, notes=EXCLUDED.notes
       RETURNING (xmax = 0) AS inserted`,
      [id, r.name, jname, r.county || null, r.state, r.agency_type, jid,
       r.address, r.city, r.zip, num(r.latitude), num(r.longitude), r.phone,
       r.website_url, r.public_records_url, r.public_records_email, r.records_portal_type,
       r.system_role, r.source_url, r.verified_status, r.notes]
    );
    if (res.rows[0].inserted) inserted += 1; else updated += 1;
  }
  return { inserted, updated };
}

async function loadPortals(client, rows, jurIndex) {
  let inserted = 0; let updated = 0;
  for (const r of rows) {
    const jid = r.jurisdiction_name ? (jurIndex.get(slug(r.jurisdiction_name)) || null) : null;
    const res = await client.query(
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
         verified_status=EXCLUDED.verified_status, status=EXCLUDED.status, notes=EXCLUDED.notes
       RETURNING (xmax = 0) AS inserted`,
      [r.portal_id, r.name, r.portal_kind, r.url, jid, r.covers, bool(r.login_required),
       r.account_notes, bool(r.accepts_anonymous), r.fee_schedule_url, r.typical_fees,
       r.submission_notes, r.statute_ref, r.source_url, r.verified_status, r.status, r.notes]
    );
    if (res.rows[0].inserted) inserted += 1; else updated += 1;
  }
  return { inserted, updated };
}

async function loadRecordTypes(client, rows) {
  let inserted = 0; let updated = 0;
  for (const r of rows) {
    const id = slug(r.name);
    const res = await client.query(
      `INSERT INTO record_types
         (record_type_id, name, description, privacy_risk_level, default_date_range, template_language)
       VALUES ($1,$2,$3,COALESCE($4,'low'),$5,$6)
       ON CONFLICT (record_type_id) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description,
         privacy_risk_level=EXCLUDED.privacy_risk_level,
         default_date_range=EXCLUDED.default_date_range, template_language=EXCLUDED.template_language
       RETURNING (xmax = 0) AS inserted`,
      [id, r.name, r.description, r.privacy_risk_level, r.default_date_range, r.template_language]
    );
    if (res.rows[0].inserted) inserted += 1; else updated += 1;
  }
  return { inserted, updated };
}

const LOADERS = {
  jurisdictions: (client, rows) => loadJurisdictions(client, rows),
  agencies: (client, rows, jx) => loadAgencies(client, rows, jx),
  portals: (client, rows, jx) => loadPortals(client, rows, jx),
  record_types: (client, rows) => loadRecordTypes(client, rows),
};

// ==================================================================== main
function parseArgs(argv) {
  const args = { dryRun: false, strict: false, only: null };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--strict') args.strict = true;
    else if (a.startsWith('--only=')) args.only = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const order = ['jurisdictions', 'agencies', 'portals', 'record_types']; // FK order
  const selected = args.only ? order.filter((t) => args.only.includes(t)) : order;

  // 1. Read + validate everything BEFORE opening a transaction.
  const parsed = {};
  const allErrors = [];
  const allWarnings = [];

  for (const t of order) {
    const r = readCsvChecked(SCHEMAS[t].file, SCHEMAS[t]);
    if (r.missing) {
      if (selected.includes(t)) console.warn(`  note: ${SCHEMAS[t].file} not found — skipping ${t}`);
      parsed[t] = { rows: [], header: [] };
      continue;
    }
    allErrors.push(...r.headerErrors);
    for (const ex of r.extraColumns || []) allWarnings.push(`${SCHEMAS[t].file}: unexpected column "${ex}" (ignored)`);
    parsed[t] = r;
  }

  const jurIndex = buildJurisdictionIndex(parsed.jurisdictions.rows);

  const tablesForQuality = {};
  for (const t of order) {
    const v = validateTable(t, parsed[t].rows, SCHEMAS[t], { jurIndex });
    allErrors.push(...v.errors);
    allWarnings.push(...v.warnings);
    tablesForQuality[t] = parsed[t].rows;
  }

  // 2. Report.
  if (allWarnings.length) {
    console.log(`\n  warnings (${allWarnings.length}):`);
    for (const w of allWarnings) console.log(`    ⚠ ${w}`);
  }
  const hardStop = allErrors.length > 0 || (args.strict && allWarnings.length > 0);
  if (allErrors.length) {
    console.log(`\n  errors (${allErrors.length}):`);
    for (const e of allErrors) console.log(`    ✗ ${e}`);
  }
  if (hardStop) {
    console.error(`\n  refusing to load: ${allErrors.length} error(s)`
      + (args.strict ? ` and --strict with ${allWarnings.length} warning(s)` : '')
      + '. Nothing was written.\n');
    process.exit(1);
  }

  // 3. Quality signal, printed whether or not we write.
  const quality = qualityReport(tablesForQuality);
  if (quality.length) { console.log('\n  directory health:'); for (const line of quality) console.log(`    · ${line}`); }

  if (args.dryRun) {
    console.log('\n  DRY RUN — validated and reference-checked, nothing written:');
    for (const t of selected) console.log(`    ${t.padEnd(14)} ${parsed[t].rows.length} rows OK`);
    console.log('');
    return;
  }

  // 4. Load, atomically.
  const { Db } = require('../server/db.js');
  const db = new Db();
  if (!(await db.isAvailable())) {
    console.error(`\n  database not reachable: ${db.lastError()}\n  Is Postgres running? See config/local.example.env\n`);
    process.exit(2);
  }

  const counts = await db.withTransaction(async (client) => {
    const out = {};
    for (const t of selected) out[t] = await LOADERS[t](client, parsed[t].rows, jurIndex);
    return out;
  });

  console.log('\n  loaded:');
  for (const t of selected) {
    const c = counts[t];
    console.log(`    ${t.padEnd(14)} ${String(c.inserted).padStart(4)} inserted   ${String(c.updated).padStart(4)} updated`);
  }
  console.log('');
  await db.close();
}

if (require.main === module) {
  main().catch((e) => { console.error('\n  seed load failed:', e.message, '\n'); process.exit(1); });
}

module.exports = {
  parseCsv, readCsvChecked, slug, num, bool,
  SCHEMAS, validateTable, buildJurisdictionIndex, qualityReport,
};
