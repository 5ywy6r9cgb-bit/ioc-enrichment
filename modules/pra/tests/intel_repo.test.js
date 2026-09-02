'use strict';
const H = require('./_harness.js');
const { IntelRepo, KIND_MAP, CONFIDENCE_MAP } = require('../../connectors/intel_repo.js');
const cl = require('../../connectors/courtlistener_connector.js');
const pacer = require('../../connectors/pacer_connector_stub.js');

/** Minimal fake: records calls, satisfies the adapter's queries. */
function fakeDb(overrides = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (/from investigations/i.test(text)) {
        return overrides.noInvestigation
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ investigation_id: 'inv', title: 'T', status: 'active' }] };
      }
      if (/returning run_id/i.test(text)) return { rows: [{ run_id: 'run-1' }] };
      if (/returning source_id/i.test(text)) return { rows: [{ source_id: 'SRC-1' }] };
      if (/returning entity_id/i.test(text)) return { rows: [{ entity_id: 'ENT-1' }] };
      if (/returning link_id/i.test(text)) return { rows: [{ link_id: 1 }] };
      if (/returning audit_id/i.test(text)) return { rows: [{ audit_id: 1 }] };
      return { rows: [], rowCount: 0 };
    },
  };
}

module.exports = async function run() {
  H.suite('intel_repo — the adapter, and the boundaries it enforces itself');

  // --- the engagement gate, both halves
  H.throws('connector refuses without an engagement_id', () => cl.requireEngagement(null), 'no engagement_id');
  H.throws('connector refuses a non-string engagement_id', () => cl.requireEngagement(42), 'no engagement_id');

  const repoNo = new IntelRepo(fakeDb({ noInvestigation: true }));
  await H.throwsAsync('adapter refuses an engagement that was never opened',
    () => repoNo.assertEngagement('nope'), 'no investigation');
  await H.throwsAsync('adapter refuses an empty engagement', () => repoNo.assertEngagement(''), 'no engagement_id');

  // --- provenance is not optional
  const repo = new IntelRepo(fakeDb());
  await H.throwsAsync('an institution without a source is refused',
    () => repo.insertInstitution({ kind: 'agency', legal_name: 'X' }), 'must carry a source_id');
  await H.throwsAsync('a relationship without a source is refused',
    () => repo.insertRelationship({ from_institution: 'A', to_institution: 'B' }), 'must carry a source_id');
  await H.throwsAsync('a person without a source is refused',
    () => repo.insertPersonPublicRole({ name_as_filed: 'Y' }), 'must carry a source_id');

  // --- THE PERSON BOUNDARY: enforced by the adapter, not trusted from callers
  for (const field of ['street_address', 'address', 'home_address', 'dob', 'date_of_birth', 'ssn']) {
    await H.throwsAsync(`a person carrying "${field}" is refused`,
      () => repo.insertPersonPublicRole({ name_as_filed: 'Y', primary_source: 'SRC-1', [field]: 'x' }),
      'public-role filer, not a dossier subject');
  }
  const okPerson = await repo.insertPersonPublicRole({ name_as_filed: 'Jane Doe', primary_source: 'SRC-1' });
  H.check('a name-only person is accepted', okPerson === 'ENT-1');
  // entity_kind is a SQL LITERAL here, not a bound parameter — precisely so a
  // caller cannot influence it. Assert against the statement, not the params.
  const personSql = repo.db.calls.find((c) => /INSERT INTO entities/i.test(c.text) && c.params.includes('Jane Doe'));
  H.check('a person insert was issued', !!personSql);
  H.check('entity_kind is hardcoded to public_official',
    personSql && /'public_official'/.test(personSql.text));
  H.check('private_individual never appears in the person path',
    personSql && !/private_individual/.test(personSql.text));
  H.check('entity_kind is not caller-controllable (it is a literal, not a param)',
    personSql && !personSql.params.includes('public_official'));
  H.check('the recorded note warns that a name match is not an identification',
    personSql && personSql.params.some((p) => typeof p === 'string' && p.includes('not an identification')));

  // --- no self-links (entity_links has a CHECK; fail with a readable message)
  await H.throwsAsync('a self-referencing edge is refused',
    () => repo.insertRelationship({ from_institution: 'A', to_institution: 'A', primary_source: 'SRC-1' }),
    'cannot link to itself');

  // --- vocabulary mapping onto the real CHECK constraints
  H.eq('agency maps to government_body', KIND_MAP.agency, 'government_body');
  H.eq('company maps to business', KIND_MAP.company, 'business');
  H.eq("the connectors' needs_source maps to unverified", CONFIDENCE_MAP.needs_source, 'unverified');
  H.eq('unconfirmed maps to unverified', CONFIDENCE_MAP.unconfirmed, 'unverified');

  // --- the org / person heuristic
  for (const n of ['Acme Water Services, LLC', 'Beta Utility Corp', 'Gamma Holdings Inc.', 'Delta Partners LLP'])
    H.check(`"${n}" is treated as an organization`, cl.looksLikeOrg(n));
  for (const n of ['Jane Q. Attorney', 'Larry Householder', 'Maria Santos'])
    H.check(`"${n}" is not treated as an organization`, !cl.looksLikeOrg(n));

  // --- the write plan is pure: no DB, no network
  const plan = cl.buildWritePlan(
    { case_name: 'A v. B', court_id: 'ohsd', date_filed: '2026-01-01', docket_number: '1:26-cv-1' },
    [{ name: 'B Corp' }, { name: 'A Person' }]
  );
  H.check('a valid docket produces a plan', plan.ok);
  H.eq('orgs and persons are split correctly',
    [plan.plan.org_parties.length, plan.plan.person_parties.length], [1, 1]);
  H.check('the plan carries a provenance note', !!plan.plan.provenance_note);
  H.check('an empty docket produces no plan', !cl.buildWritePlan(null, []).ok);

  // --- PACER refuses rather than pretending
  await H.throwsAsync('PACER live fetch is not implemented and says so',
    () => pacer.fetchCaseByNumber(null, {}), 'NOT IMPLEMENTED');
  H.throws('PACER refuses to run unconfigured', () => pacer.assertConfigured({}), 'not configured');
  H.check('PACER config reads only from env, never hardcoded',
    pacer.loadPacerConfigFromEnv({}).pcApiToken === null);
};
