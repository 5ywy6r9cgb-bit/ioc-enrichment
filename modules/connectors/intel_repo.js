'use strict';
/**
 * modules/connectors/intel_repo.js — the adapter.
 *
 * WHY THIS FILE EXISTS
 *
 * The courtlistener and PACER connectors were written against an "Entity
 * Intelligence" schema with tables named institutions, relationships,
 * persons_public_role, engagements and connector_runs. The v0.7 database has
 * entities, entity_links, sources, investigations and (as of migration 0003)
 * connector_runs.
 *
 * Those are the same ideas under different names. Rather than rewrite the
 * connectors — their doctrine is good and rewriting working code loses it —
 * this adapter implements the repository interface they already call, backed
 * by the real v0.7 tables.
 *
 * THE MAPPING
 *
 *   institutions          → entities (entity_kind: agency→government_body,
 *                                     company→business, other_org→nonprofit)
 *   persons_public_role   → entities (entity_kind='public_official')
 *   relationships         → entity_links
 *   engagement_id         → investigation_id  (an investigation IS the engagement)
 *   sources               → sources           (already the same)
 *   connector_runs        → connector_runs    (migration 0003)
 *
 * TWO BOUNDARIES THE ADAPTER ENFORCES REGARDLESS OF WHAT A CONNECTOR SENDS
 *
 *   1. A named individual is written as entity_kind='public_official' with a
 *      role, never as 'private_individual', and NEVER with a street address.
 *      The database has a CHECK that refuses an address on a private
 *      individual; this refuses one on a person from a connector at all.
 *      A party on a docket is a public-role filer, not a dossier subject.
 *
 *   2. Every write carries a source_id. A row that cannot say where it came
 *      from does not get written.
 */

const crypto = require('crypto');

const KIND_MAP = {
  agency: 'government_body',
  company: 'business',
  other_org: 'nonprofit',
  nonprofit: 'nonprofit',
  government_body: 'government_body',
  business: 'business',
};

// The connectors use their own confidence vocabulary; entity_links has a CHECK.
const CONFIDENCE_MAP = {
  needs_source: 'unverified',
  unconfirmed: 'unverified',
  documented: 'documented',
  confirmed: 'confirmed',
  disputed: 'disputed',
};

// sources.source_type has a CHECK; map connector notions onto it.
const SOURCE_TYPE_MAP = {
  courtlistener: 'court_filing',
  pacer: 'court_filing',
  opencorporates: 'primary_document',
  sec_edgar: 'primary_document',
  federal_register: 'primary_document',
  opensanctions: 'dataset',
  fec: 'dataset',
  senatelda: 'dataset',
  usaspending: 'dataset',
};

function slug(s, prefix) {
  const base = String(s || '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const hash = crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 8);
  return `${prefix}-${base || 'unnamed'}-${hash}`;
}

class IntelRepo {
  /**
   * @param {object} db  a Db (from modules/pra/server/db.js) or a pg client
   */
  constructor(db) {
    this.db = db;
  }

  // -------------------------------------------------------- engagement gate
  /**
   * The connectors call requireEngagement() themselves before touching the
   * repo. This is the second half of that gate: the engagement must actually
   * exist, so a typo cannot silently file work under a thread that was never
   * opened.
   */
  async assertEngagement(engagementId) {
    if (!engagementId) {
      throw new Error('intel_repo: refused — no engagement_id. Work runs under a recorded investigation or not at all.');
    }
    const res = await this.db.query(
      'SELECT investigation_id, title, status FROM investigations WHERE investigation_id = $1',
      [engagementId]
    );
    if (!res.rowCount) {
      throw new Error(
        `intel_repo: refused — no investigation "${engagementId}". `
        + 'Open it first so the work is filed under a named thread:\n'
        + `  INSERT INTO investigations (investigation_id, title) VALUES ('${engagementId}', '...');`
      );
    }
    if (['closed'].includes(res.rows[0].status)) {
      throw new Error(`intel_repo: refused — investigation "${engagementId}" is closed.`);
    }
    return res.rows[0];
  }

  // ------------------------------------------------------------ connector runs
  async startConnectorRun({ connector_name, engagement_id, source_url, connector_version = null, run_mode = 'live' }) {
    if (engagement_id) await this.assertEngagement(engagement_id);
    const res = await this.db.query(
      `INSERT INTO connector_runs
         (connector_name, connector_version, investigation_id, source_url, run_mode, run_status)
       VALUES ($1,$2,$3,$4,$5,'running')
       RETURNING run_id`,
      [connector_name, connector_version, engagement_id || null, source_url || null, run_mode]
    );
    return res.rows[0].run_id;
  }

  async finishConnectorRun(runId, { run_status, records_seen = null, records_imported = null,
                                    error_message = null, live_calls = null,
                                    capture_path = null, capture_sha256 = null } = {}) {
    await this.db.query(
      `UPDATE connector_runs
          SET run_status=$1, records_seen=$2, records_imported=$3,
              error_message=$4, finished_at=now(),
              live_calls=COALESCE($5, live_calls),
              capture_path=COALESCE($6, capture_path),
              capture_sha256=COALESCE($7, capture_sha256)
        WHERE run_id=$8`,
      [run_status, records_seen, records_imported, error_message,
       live_calls, capture_path, capture_sha256, runId]
    );
    return runId;
  }

  // ------------------------------------------------------------------ sources
  async insertSource(source) {
    const sourceType = SOURCE_TYPE_MAP[source.source_system] || 'other';
    const id = slug(`${source.source_system}-${source.source_url || source.retrieved_at}`, 'SRC');
    const res = await this.db.query(
      `INSERT INTO sources
         (source_id, title, source_type, is_primary, publisher, url, retrieved_at,
          citation_text, verified_status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unverified',$9)
       ON CONFLICT (source_id) DO UPDATE SET retrieved_at = EXCLUDED.retrieved_at
       RETURNING source_id`,
      [
        id,
        source.title || `${source.publisher || source.source_system} — retrieved ${String(source.retrieved_at || '').slice(0, 10)}`,
        sourceType,
        source.reliability === 'primary_official',
        source.publisher || null,
        source.source_url || null,
        source.retrieved_at || new Date().toISOString(),
        source.source_url ? `${source.publisher || source.source_system}, ${source.source_url}` : null,
        source.note || null,
      ]
    );
    return res.rows[0].source_id;
  }

  // ------------------------------------------------------------- institutions
  async insertInstitution(inst) {
    if (!inst.primary_source) {
      throw new Error('intel_repo.insertInstitution: refused — every row must carry a source_id');
    }
    const kind = KIND_MAP[inst.kind] || 'other';
    const name = inst.legal_name || inst.name;
    if (!name) throw new Error('intel_repo.insertInstitution: refused — no name');
    const id = slug(name, 'ENT');

    const res = await this.db.query(
      `INSERT INTO entities
         (entity_id, entity_kind, name, legal_name, registry_id, registry_source,
          status, role_summary, verified_status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unverified',$9)
       ON CONFLICT (entity_id) DO UPDATE SET
         legal_name = COALESCE(EXCLUDED.legal_name, entities.legal_name),
         registry_id = COALESCE(EXCLUDED.registry_id, entities.registry_id)
       RETURNING entity_id`,
      [id, kind, name, inst.legal_name || null, inst.registry_id || null,
       inst.registry_system || null, inst.status || null,
       inst.jurisdiction ? `jurisdiction: ${inst.jurisdiction}` : null,
       'imported by connector; unverified until a primary document is read']
    );

    await this._link(res.rows[0].entity_id, 'entity', inst.primary_source);
    return res.rows[0].entity_id;
  }

  // ------------------------------------------------- persons, public role only
  /**
   * A named individual from a public docket. Written as a PUBLIC OFFICIAL with
   * a role, never as a private individual, and never with an address — no
   * matter what the caller passes.
   */
  async insertPersonPublicRole(person) {
    if (!person.primary_source) {
      throw new Error('intel_repo.insertPersonPublicRole: refused — every row must carry a source_id');
    }
    const name = person.name_as_filed || person.name;
    if (!name) throw new Error('intel_repo.insertPersonPublicRole: refused — no name');

    // The boundary, applied here rather than trusted from the caller.
    for (const forbidden of ['street_address', 'address', 'home_address', 'dob', 'date_of_birth', 'ssn']) {
      if (person[forbidden]) {
        throw new Error(
          `intel_repo.insertPersonPublicRole: refused — "${forbidden}" was supplied for a named individual. `
          + 'A party on a public docket is a public-role filer, not a dossier subject.'
        );
      }
    }

    const id = slug(name, 'PER');
    const res = await this.db.query(
      `INSERT INTO entities
         (entity_id, entity_kind, name, role_summary, first_seen_at, last_seen_at,
          verified_status, notes)
       VALUES ($1,'public_official',$2,$3,$4,$5,'unverified',$6)
       ON CONFLICT (entity_id) DO UPDATE SET
         role_summary = COALESCE(EXCLUDED.role_summary, entities.role_summary)
       RETURNING entity_id`,
      [id, name,
       `public role: ${person.public_role || 'filer'}`,
       person.role_start || null, person.role_end || null,
       `identity ${person.identity_confidence || 'unconfirmed'}; recorded as a public-role filer only. `
       + 'A name match is not an identification — confirm same-individual before any use.']
    );

    if (person.institution_id) {
      await this.insertRelationship({
        from_institution: res.rows[0].entity_id,
        to_institution: person.institution_id,
        relation_type: 'filer_before',
        primary_source: person.primary_source,
        glassmark: 'needs_source',
      });
    }
    await this._link(res.rows[0].entity_id, 'entity', person.primary_source);
    return res.rows[0].entity_id;
  }

  // ----------------------------------------------------------- relationships
  async insertRelationship(rel) {
    if (!rel.primary_source) {
      throw new Error('intel_repo.insertRelationship: refused — every edge must carry a source_id');
    }
    if (rel.from_institution === rel.to_institution) {
      // entity_links has a CHECK against self-links; fail with a clear message.
      throw new Error('intel_repo.insertRelationship: refused — an entity cannot link to itself');
    }
    const res = await this.db.query(
      `INSERT INTO entity_links
         (from_entity_id, to_entity_id, relation, started_on, amount, source_id, confidence, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING link_id`,
      [rel.from_institution, rel.to_institution, rel.relation_type || 'affiliated_with',
       rel.as_of_date || null, rel.amount_usd || null, rel.primary_source,
       CONFIDENCE_MAP[rel.glassmark] || 'unverified',
       rel.note || 'case metadata alone does not establish outcome or fault']
    );
    return res.rows[0].link_id;
  }

  // ------------------------------------------------------------------- audit
  async audit({ engagement_id, entity_type, entity_id, action, detail }) {
    const res = await this.db.query(
      `INSERT INTO audit_ledger (actor, entity_type, entity_id, action, detail)
       VALUES ('local_operator',$1,$2,$3,$4)
       RETURNING audit_id`,
      [entity_type || 'entity', entity_id || null, action || 'import',
       JSON.stringify(Object.assign({ engagement_id }, detail || {}))]
    );
    return res.rows[0].audit_id;
  }

  /** Attach a source to a thing, via source_links. */
  async _link(entityId, entityType, sourceId) {
    await this.db.query(
      `INSERT INTO source_links (source_id, entity_type, entity_id, relation)
       VALUES ($1,$2,$3,'documents')
       ON CONFLICT DO NOTHING`,
      [sourceId, entityType, entityId]
    );
  }
}

module.exports = { IntelRepo, KIND_MAP, CONFIDENCE_MAP, SOURCE_TYPE_MAP, slug };
