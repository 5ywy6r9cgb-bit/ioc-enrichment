'use strict';
/**
 * courtlistener_connector.js
 * Sentinel Entity Intelligence & Audit Layer — CourtListener connector v0.1
 *
 * PURPOSE
 *   Pull public federal/state court docket + opinion data (via CourtListener's
 *   free REST API, which mirrors RECAP/PACER filings that have already been
 *   made public) and write it into the intel schema.
 *
 * NOTE ON SCHEMA (added when this was wired into Sentinel OS):
 *   This module calls a repository interface named for the Entity Intelligence
 *   schema (institutions / relationships / persons_public_role). The live v0.7
 *   database uses entities / entity_links / sources. modules/connectors/intel_repo.js
 *   adapts one to the other, so this file runs unmodified. See that file for the
 *   mapping and for the two boundaries it enforces regardless of what is passed.
 *
 * INHERITS THE SAME BOUNDARY AS opencorporates_connector.js:
 *   - fail-closed: refuses to run without an engagement_id
 *   - provenance-first: every write carries a source_id
 *   - boundary-in-code: CASE/DOCKET metadata only. No PACER document text,
 *     no PDFs, no party addresses.
 *
 * VERIFIED AGAINST LIVE API REFERENCE (fetched 2026-06-25):
 *   - base: https://www.courtlistener.com/api/rest/v4/
 *   - auth: optional `Authorization: Token <token>`; anonymous works, rate-limited
 *   - endpoints: /search/?type=r, /dockets/:id/, /parties/?docket=:id
 *
 * This module performs NO network call unless given a live fetch fn.
 */

const CL_BASE = 'https://www.courtlistener.com/api/rest/v4';

function requireEngagement(engagementId) {
  if (!engagementId || typeof engagementId !== 'string') {
    throw new Error(
      'courtlistener_connector: refused — no engagement_id. ' +
      'Work requires a recorded engagement (consent/authority gate).'
    );
  }
  return engagementId;
}

function buildDocketSearchUrl(query, opts = {}) {
  const p = new URLSearchParams();
  p.set('q', query);
  p.set('type', 'r');
  if (opts.court) p.set('court', opts.court);
  if (opts.filed_after) p.set('filed_after', opts.filed_after);
  if (opts.filed_before) p.set('filed_before', opts.filed_before);
  if (opts.order_by) p.set('order_by', opts.order_by);
  return `${CL_BASE}/search/?${p.toString()}`;
}

function buildDocketUrl(docketId) { return `${CL_BASE}/dockets/${encodeURIComponent(docketId)}/`; }
function buildPartiesUrl(docketId) { return `${CL_BASE}/parties/?docket=${encodeURIComponent(docketId)}`; }
function authHeaders(apiToken) { return apiToken ? { Authorization: `Token ${apiToken}` } : {}; }

function mapSource(docket, fallbackUrl) {
  return {
    source_system: 'courtlistener',
    source_url: docket.absolute_url ? `https://www.courtlistener.com${docket.absolute_url}` : fallbackUrl || null,
    retrieved_at: new Date().toISOString(),
    publisher: 'CourtListener (Free Law Project)',
    reliability: 'primary_official',
    note: 'Docket metadata only; no filing text/PDF content stored.',
  };
}

function mapCourtInstitution(docket) {
  return {
    kind: 'agency',
    legal_name: docket.court_id ? String(docket.court_id).toUpperCase() : (docket.court || 'Unknown Court'),
    jurisdiction: docket.court_id || null,
    registry_id: docket.court_id || null,
    registry_system: 'courtlistener_court_id',
    status: 'active',
  };
}

const ORG_SUFFIX_RE = /\b(inc|llc|l\.l\.c|corp|corporation|co|company|ltd|lp|llp|plc)\.?\s*$/i;
function looksLikeOrg(name) { return ORG_SUFFIX_RE.test(String(name || '').trim()); }

function mapParty(party) {
  const name = (party.name || '').trim();
  if (!name) return null;
  if (looksLikeOrg(name)) {
    return { as: 'institution', row: { kind: 'company', legal_name: name, jurisdiction: null, registry_id: null, registry_system: null, status: null } };
  }
  return {
    as: 'person',
    row: { name_as_filed: name, public_role: 'filer', role_start: null, role_end: null, identity_confidence: 'unconfirmed' },
  };
}

function buildWritePlan(docket, parties, fallbackUrl) {
  if (!docket || !docket.case_name) return { ok: false, reason: 'no docket in response', plan: null };
  const source = mapSource(docket, fallbackUrl);
  const court = mapCourtInstitution(docket);
  const orgParties = [];
  const personParties = [];
  for (const raw of parties || []) {
    const mapped = mapParty(raw);
    if (!mapped) continue;
    if (mapped.as === 'institution') orgParties.push(mapped.row);
    else personParties.push(mapped.row);
  }
  return {
    ok: true,
    plan: {
      source, court_institution: court,
      case_name: docket.case_name,
      docket_number: docket.docket_number || null,
      date_filed: docket.date_filed || null,
      nature_of_suit: docket.nature_of_suit || null,
      org_parties: orgParties,
      person_parties: personParties,
      provenance_note:
        'CourtListener v4 docket metadata; court + org parties + relationships ' +
        'carry the source_id; named individuals recorded only as public-role ' +
        'filers, never as dossier entries.',
    },
  };
}

async function persistWritePlan(repo, engagementId, plan, runMeta = {}) {
  requireEngagement(engagementId);
  if (!plan) throw new Error('persistWritePlan: empty plan');

  const runId = await repo.startConnectorRun({
    connector_name: 'courtlistener', engagement_id: engagementId, source_url: runMeta.source_url || null,
  });

  try {
    const sourceId = await repo.insertSource(plan.source);
    const courtId = await repo.insertInstitution({ ...plan.court_institution, primary_source: sourceId });

    let orgCount = 0;
    const orgInstitutionIds = [];
    for (const org of plan.org_parties) {
      const id = await repo.insertInstitution({ ...org, primary_source: sourceId });
      orgInstitutionIds.push(id);
      orgCount += 1;
    }

    // Litigation edges: each org party <-> court. 'affiliated_with' is the
    // loosest available relation — a litigant before a court is not a
    // contract/ownership/payment relationship. Flagged as a follow-up:
    // consider adding 'party_to_litigation' rather than overloading this.
    let relCount = 0;
    for (const instId of orgInstitutionIds) {
      await repo.insertRelationship({
        from_institution: instId, to_institution: courtId,
        relation_type: 'affiliated_with', amount_usd: null,
        as_of_date: plan.date_filed, primary_source: sourceId,
        glassmark: 'needs_source',
      });
      relCount += 1;
    }

    let personCount = 0;
    for (const person of plan.person_parties) {
      await repo.insertPersonPublicRole({ ...person, institution_id: courtId, primary_source: sourceId });
      personCount += 1;
    }

    await repo.finishConnectorRun(runId, {
      run_status: 'completed',
      records_seen: 1 + orgCount + relCount + personCount,
      records_imported: 1 + orgCount + relCount + personCount,
    });
    await repo.audit({
      engagement_id: engagementId, entity_type: 'entity', entity_id: courtId, action: 'import',
      detail: { connector: 'courtlistener', case_name: plan.case_name, docket_number: plan.docket_number, orgs: orgCount, persons: personCount },
    });

    return { ok: true, courtId, sourceId, orgCount, personCount, relCount, runId };
  } catch (err) {
    await repo.finishConnectorRun(runId, { run_status: 'failed', error_message: err.message });
    throw err;
  }
}

async function fetchDocket(fetchFn, { docketId, apiToken }) {
  if (typeof fetchFn !== 'function') throw new Error('fetchDocket: no fetchFn injected (offline mode has no network)');
  const url = buildDocketUrl(docketId);
  let res;
  try { res = await fetchFn(url, { headers: authHeaders(apiToken) }); }
  catch (networkErr) { return { ok: false, status: null, reason: `network_error: ${networkErr.message}`, url }; }
  const status = res.status;
  if (status === 200) return { ok: true, json: await res.json(), url };
  if (status === 401) return { ok: false, status, reason: 'unauthorized (401) — check token', url };
  if (status === 404) return { ok: false, status, reason: 'not_found (404)', url };
  if (status === 429) return { ok: false, status, reason: 'rate_limited (429)', url };
  return { ok: false, status, reason: `unexpected status ${status}`, url };
}

async function fetchParties(fetchFn, { docketId, apiToken }) {
  if (typeof fetchFn !== 'function') throw new Error('fetchParties: no fetchFn injected (offline mode has no network)');
  const url = buildPartiesUrl(docketId);
  let res;
  try { res = await fetchFn(url, { headers: authHeaders(apiToken) }); }
  catch (networkErr) { return { ok: false, status: null, reason: `network_error: ${networkErr.message}`, url }; }
  if (res.status === 200) { const json = await res.json(); return { ok: true, results: json.results || [], url }; }
  return { ok: false, status: res.status, reason: `unexpected status ${res.status}`, url };
}

module.exports = {
  CL_BASE, requireEngagement,
  buildDocketSearchUrl, buildDocketUrl, buildPartiesUrl, authHeaders,
  mapSource, mapCourtInstitution, mapParty, looksLikeOrg,
  buildWritePlan, persistWritePlan, fetchDocket, fetchParties,
};
