'use strict';
const H = require('./_harness.js');
const clock = require('../server/deadline_engine.js');

const OH_RULES = [
  { rule_id:'oh-ack-7',  label:'no ack 7',  jurisdiction_scope:'OH', rule_basis:'operator_policy', days:7,  day_basis:'calendar', applies_to_status:'submitted', action_on_breach:'followup', template_id:'oh-followup-1', active:true },
  { rule_id:'oh-sub-21', label:'no sub 21', jurisdiction_scope:'OH', rule_basis:'operator_policy', days:21, day_basis:'calendar', applies_to_status:'submitted', action_on_breach:'escalate', template_id:'oh-followup-2', active:true },
  { rule_id:'oh-app-45', label:'appeal 45', jurisdiction_scope:'OH', rule_basis:'operator_policy', days:45, day_basis:'calendar', applies_to_status:'submitted', action_on_breach:'appeal',   template_id:'oh-appeal-coc', active:true },
  { rule_id:'fed-20',    label:'FOIA 20',   jurisdiction_scope:'US', rule_basis:'statutory', statute_citation:'5 U.S.C. 552', days:20, day_basis:'business', applies_to_status:'submitted', action_on_breach:'followup', active:true },
];

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

module.exports = function run() {
  H.suite('deadline_engine — the clock, and the line it must not cross');

  // --- day math
  H.eq('daysBetween counts whole days', clock.daysBetween(daysAgo(10), new Date()), 10);
  H.eq('daysBetween ignores time of day', clock.daysBetween(new Date('2026-01-01T23:59:00Z'), new Date('2026-01-02T00:01:00Z')), 1);
  H.eq('businessDays skips a weekend', clock.businessDaysBetween(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-08T00:00:00Z')), 5);

  // --- breaches
  const req = { request_id:'R1', status:'submitted', submitted_at: daysAgo(25), first_response_at:null };
  const b = clock.evaluateRequest(req, OH_RULES);
  H.eq('25 days trips exactly the 7 and 21 day rules', b.map(x=>x.rule_id).sort(), ['oh-ack-7','oh-sub-21']);
  H.check('most overdue is ordered first', b[0].rule_id === 'oh-ack-7');
  H.check('Ohio breach is labelled as cadence, not law', b.every(x => x.basis_label.includes('not a legal deadline')));
  H.check('Ohio breach never claims statutory basis', b.every(x => x.basis === 'operator_policy'));

  // --- re-anchoring: an answer stops the silence clock
  const answered = { request_id:'R2', status:'submitted', submitted_at: daysAgo(60), first_response_at: daysAgo(1) };
  H.eq('a response silences the "no response" rules', clock.evaluateRequest(answered, OH_RULES).length, 0);

  // --- closed requests are not nagged about
  const closed = { request_id:'R3', status:'closed', submitted_at: daysAgo(90), first_response_at:null };
  H.eq('closed requests trip nothing', clock.evaluateRequest(closed, OH_RULES).length, 0);

  // --- status gating
  const drafted = { request_id:'R4', status:'draft', submitted_at:null, created_at: daysAgo(90) };
  H.eq('an unsubmitted draft trips nothing', clock.evaluateRequest(drafted, OH_RULES).length, 0);

  // --- jurisdiction filtering
  H.check('federal rule does not fire on an Ohio request',
    !clock.evaluateRequest(req, OH_RULES).some(x => x.rule_id === 'fed-20'));
  // 25 calendar days is only 18 business days — below the 20-business-day
  // threshold, so the rule correctly does NOT fire yet. Use a window that
  // genuinely exceeds it.
  H.check('federal rule does not fire at 18 business days',
    !clock.evaluateRequest(req, OH_RULES, { jurisdictionScope:'US' }).some(x => x.rule_id === 'fed-20'));
  const oldFed = { request_id:'F1', status:'submitted', submitted_at: daysAgo(40), first_response_at:null };
  H.check('federal rule fires once 20 business days have passed',
    clock.evaluateRequest(oldFed, OH_RULES, { jurisdictionScope:'US' }).some(x => x.rule_id === 'fed-20'));
  H.check('the federal rule IS labelled statutory, correctly',
    clock.evaluateRequest(oldFed, OH_RULES, { jurisdictionScope:'US' })
      .find(x => x.rule_id === 'fed-20').basis_label.includes('statutory'));

  // --- THE LOAD-BEARING ASSERTION
  H.throws('refuses to evaluate if an Ohio rule is marked statutory',
    () => clock.evaluateRequest(req, OH_RULES.concat([
      { rule_id:'oh-bad', jurisdiction_scope:'OH', rule_basis:'statutory', days:1, day_basis:'calendar', active:true },
    ])), 'statutory');

  // --- triage ordering: appeal outranks followup
  const t = clock.triage([
    { request_id:'A', status:'submitted', submitted_at: daysAgo(10) },
    { request_id:'B', status:'submitted', submitted_at: daysAgo(50) },
  ], OH_RULES);
  H.eq('triage puts the appeal-level request first', t[0].request_id, 'B');
  H.eq('triage reports every rule tripped', t[0].breach_count, 3);
};
