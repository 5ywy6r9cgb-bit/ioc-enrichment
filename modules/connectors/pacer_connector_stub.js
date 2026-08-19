'use strict';
/**
 * pacer_connector_stub.js
 * Sentinel Entity Intelligence & Audit Layer — PACER connector STUB v0.1
 *
 * STATUS: NOT WIRED TO LIVE PACER. This is a shape/contract file only.
 *
 * WHY THIS IS A STUB AND NOT A WORKING CONNECTOR:
 *   PACER is NOT a free/public API like CourtListener. Real access requires:
 *     1. An individual PACER account (https://pacer.uscourts.gov) — your own,
 *        under your own name, subject to the U.S. Courts' terms of use.
 *     2. Per-page fees ($0.10/page, capped per document) billed to that
 *        account — this connector cannot make requests "free" for you.
 *     3. The PACER Case Locator (PCL) API and each court's CM/ECF system have
 *        their own auth tokens (obtained via your PACER login), which this
 *        codebase does not have and should not try to obtain on your behalf.
 *   No scraper that bypasses PACER's login/paywall will be written here, and
 *   no API flow will be fabricated that pretends to work without real
 *   credentials — that produces code which either fails silently or violates
 *   PACER's terms of use.
 *
 * WHAT THIS FILE DOES PROVIDE:
 *   The same write-plan / persist shape as the other connectors, so that WHEN
 *   you have a PACER account + PCL API token, implementing fetchCaseByNumber
 *   below (using your own credentials, in your own .env, never committed)
 *   drops straight into the same schema — no redesign needed.
 *
 * RECOMMENDATION: for most federal docket research, CourtListener's RECAP
 * archive already mirrors a large fraction of PACER filings for free.
 * Try courtlistener_connector.js FIRST. Reach for PACER only when a specific
 * document is not in RECAP and you are willing to pay the per-page fee.
 *
 * SCHEMA NOTE (added when wired into Sentinel OS): the repo interface below is
 * satisfied by modules/connectors/intel_repo.js against the live v0.7 tables.
 */

const { requireEngagement } = require('./courtlistener_connector');

function loadPacerConfigFromEnv(env = process.env) {
  return {
    pacerUsername: env.PACER_USERNAME || null,
    pacerClientCode: env.PACER_CLIENT_CODE || null,
    pcApiToken: env.PACER_PCL_API_TOKEN || null,
  };
}

function assertConfigured(cfg) {
  if (!cfg || !cfg.pacerUsername || !cfg.pcApiToken) {
    throw new Error(
      'pacer_connector_stub: not configured. Set PACER_USERNAME and ' +
      'PACER_PCL_API_TOKEN in your own local .env after logging into your ' +
      'own PACER account. This connector will not run without real, ' +
      'operator-owned credentials.'
    );
  }
  return cfg;
}

function buildWritePlan(pclCaseRecord, fallbackUrl) {
  if (!pclCaseRecord || !pclCaseRecord.caseTitle) {
    return { ok: false, reason: 'no case record', plan: null };
  }
  return {
    ok: true,
    plan: {
      source: {
        source_system: 'pacer',
        source_url: fallbackUrl || null,
        retrieved_at: new Date().toISOString(),
        publisher: 'PACER (Administrative Office of the U.S. Courts)',
        reliability: 'primary_official',
        note: "Docket metadata only, retrieved under operator's own PACER account.",
      },
      court_institution: {
        kind: 'agency',
        legal_name: pclCaseRecord.courtId || 'Unknown Federal Court',
        jurisdiction: pclCaseRecord.courtId || null,
        registry_id: pclCaseRecord.courtId || null,
        registry_system: 'pacer_court_id',
        status: 'active',
      },
      case_name: pclCaseRecord.caseTitle,
      docket_number: pclCaseRecord.caseNumberFull || pclCaseRecord.caseNumber || null,
      date_filed: pclCaseRecord.dateFiled || null,
      // Party mapping intentionally left to the caller: reuse
      // courtlistener_connector.mapParty() so both connectors apply the exact
      // same org-vs-person heuristic and the same public-role-only boundary.
    },
  };
}

async function persistCaseOnly(repo, engagementId, plan, runMeta = {}) {
  requireEngagement(engagementId);
  if (!plan) throw new Error('persistCaseOnly: empty plan');

  const runId = await repo.startConnectorRun({
    connector_name: 'pacer', engagement_id: engagementId, source_url: runMeta.source_url || null,
  });
  try {
    const sourceId = await repo.insertSource(plan.source);
    const courtId = await repo.insertInstitution({ ...plan.court_institution, primary_source: sourceId });
    await repo.finishConnectorRun(runId, { run_status: 'completed', records_seen: 1, records_imported: 1 });
    await repo.audit({
      engagement_id: engagementId, entity_type: 'entity', entity_id: courtId,
      action: 'import', detail: { connector: 'pacer', case_name: plan.case_name },
    });
    return { ok: true, courtId, sourceId, runId };
  } catch (err) {
    await repo.finishConnectorRun(runId, { run_status: 'failed', error_message: err.message });
    throw err;
  }
}

async function fetchCaseByNumber(_fetchFn, _opts) {
  throw new Error(
    'pacer_connector_stub.fetchCaseByNumber: NOT IMPLEMENTED. This requires ' +
    "your own PACER account, your own PCL API token, and acceptance of the " +
    "U.S. Courts' terms of use. See file header comments. Consider " +
    'courtlistener_connector.js first — it covers a large share of federal ' +
    'dockets for free via RECAP.'
  );
}

module.exports = {
  loadPacerConfigFromEnv, assertConfigured,
  buildWritePlan, persistCaseOnly, fetchCaseByNumber,
};
