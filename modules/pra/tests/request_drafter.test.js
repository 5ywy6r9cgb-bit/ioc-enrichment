'use strict';
const H = require('./_harness.js');
const d = require('../server/request_drafter.js');

const TPL = {
  template_id:'t1', kind:'followup', statute_citation:'R.C. 149.43',
  subject_line:'Following up — {{request_id}}',
  body:'To {{agency_name}}:\n\n{{scope_text}}\n\n{{date_range_clause}}\n\n{{requester_block}}',
};
const AGENCY = { name:'Test Office', public_records_email:'records@test.gov', verified_status:'verified' };

module.exports = function run() {
  H.suite('request_drafter — three refusals');

  const good = d.draft(TPL, {
    agency: AGENCY,
    request: { request_id:'R1', scope_text:'All contracts', date_range_start:'2024-01-01', date_range_end:'2024-12-31' },
    operator: { name:'A Person', contact:'a@example.org' },
  });
  H.check('a complete draft is sendable', good.sendable);
  H.check('placeholders are filled', !good.body.includes('{{'));
  H.check('agency name substituted', good.body.includes('Test Office'));
  H.check('date range clause rendered', good.body.includes('2024-01-01'));
  H.check('citation warning always rides along', good.warnings.some(w => w.code === 'VERIFY_CITATION'));

  // 1. unfilled placeholder
  const missing = d.draft(TPL, { agency: AGENCY, request: { request_id:'R1' }, operator:{name:'A',contact:'b'} });
  H.check('an unfilled placeholder blocks sending', !missing.sendable);
  H.check('the unfilled name is reported', missing.unfilled.includes('scope_text'));

  // 2. private data
  for (const [label, scope] of [
    ['SSN', 'records for 123-45-6789'],
    ['card number', 'card 4111 1111 1111 1111'],
    ['account number', 'account number 99887766'],
    ['street address', 'resident at 742 Evergreen Terrace'],
  ]) {
    const bad = d.draft(TPL, { agency: AGENCY, request: { request_id:'R1', scope_text: scope }, operator:{name:'A',contact:'b'} });
    H.check(`${label} in scope blocks sending`, !bad.sendable && bad.blockers.some(x => x.code === 'PRIVATE_DATA'));
  }

  // 3. high privacy risk
  const hi = d.draft(TPL, {
    agency: AGENCY, request:{ request_id:'R1', scope_text:'x' },
    recordType:{ name:'Personnel files', privacy_risk_level:'high' }, operator:{name:'A',contact:'b'},
  });
  H.check('a high-risk record type blocks by default', !hi.sendable);
  const ack = d.draft(TPL, {
    agency: AGENCY, request:{ request_id:'R1', scope_text:'x' },
    recordType:{ name:'Personnel files', privacy_risk_level:'high' }, operator:{name:'A',contact:'b'},
    extra:{ acknowledgeHighRisk:true },
  });
  H.check('deliberate acknowledgement clears the high-risk block', ack.sendable);
  H.check('but it is kept as a warning', ack.warnings.some(w => w.code === 'HIGH_PRIVACY_RISK_ACKNOWLEDGED'));

  // route + verification warnings
  const noRoute = d.draft(TPL, {
    agency:{ name:'Unknown Office', verified_status:'unverified' },
    request:{ request_id:'R1', scope_text:'x' }, operator:{name:'A',contact:'b'},
  });
  H.check('missing records route warns', noRoute.warnings.some(w => w.code === 'NO_KNOWN_ROUTE'));
  H.check('unverified agency warns', noRoute.warnings.some(w => w.code === 'UNVERIFIED_AGENCY'));

  // the drafter never sends
  H.check('drafter exposes no send function', typeof d.send === 'undefined');
};
