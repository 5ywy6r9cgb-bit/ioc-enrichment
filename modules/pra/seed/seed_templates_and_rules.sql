-- =====================================================================
-- Sentinel PRA — letter templates and the follow-up clock
--
-- Run as the database owner, after both migrations.
-- Idempotent: ON CONFLICT DO UPDATE, so re-running refreshes in place.
--
-- THE CITATION RULE
-- Every statute reference below is one you must re-check before you send
-- anything. Ohio law changes, and a wrong citation in a records request
-- hands the office a reason to dismiss you. The drafter prints a warning
-- to that effect on every draft it produces.
--
-- THE DEADLINE RULE — read this before touching deadline_rules
-- Ohio R.C. 149.43 sets NO fixed day count. Inspection is "promptly";
-- copies come "within a reasonable period of time." Every Ohio row below
-- is therefore rule_basis='operator_policy' — YOUR follow-up cadence, not
-- a legal deadline. The ONLY statutory row here is the federal FOIA
-- 20-business-day determination, which is a real number in real law
-- (5 U.S.C. 552(a)(6)(A)(i)) and applies to FEDERAL agencies only.
-- Mislabeling a cadence as a deadline would put a false claim of legal
-- entitlement into a letter over your name. The test suite asserts that
-- no Ohio row is ever marked statutory.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Letter templates
-- ---------------------------------------------------------------------

INSERT INTO request_templates
  (template_id, name, kind, jurisdiction_scope, statute_citation, subject_line, body, guidance, source_url, verified_status)
VALUES

('oh-initial-general', 'Ohio — initial records request (general)', 'initial', 'OH', 'R.C. 149.43',
 'Public records request — {{subject}}',
$body$To the Records Custodian, {{agency_name}}:

Under Ohio's Public Records Act, R.C. 149.43, I request copies of the following
public records:

{{scope_text}}

{{date_range_clause}}

Please provide the records in electronic format where they already exist in that
form, sent to the address below. If any portion of a requested record is exempt,
please redact that portion and provide the remainder, and identify in writing the
specific exemption relied upon for each redaction, as R.C. 149.43(B)(1) requires.

If you believe this request is ambiguous or overly broad, please contact me
rather than denying it, and I will revise it. R.C. 149.43(B)(2) requires that I
be given that opportunity.

If any cost will exceed $25.00, please tell me the estimate before you begin.

I am not required to identify myself or state a purpose, and I make no waiver of
that by providing contact information for delivery.

{{requester_block}}$body$,
 'The default opening request. Keep the scope concrete: an office, a record type, and a date range. A specific request gets a faster and cleaner response than a broad one, and it is much harder to refuse.',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'unverified'),

('oh-initial-bwc', 'Ohio — body-worn camera / incident records request', 'initial', 'OH', 'R.C. 149.43(A)(17)',
 'Public records request — incident and body-worn camera records, {{subject}}',
$body$To the Records Custodian, {{agency_name}}:

Under Ohio's Public Records Act, R.C. 149.43, I request the following records:

{{scope_text}}

{{date_range_clause}}

Ohio law treats certain portions of body-worn camera recordings as restricted
under R.C. 149.43(A)(17). I am requesting the releasable portions. Where a
portion is restricted, please release the remainder and identify in writing which
specific subsection you rely on for each withheld portion.

Please also provide the associated incident or offense report, the CAD/dispatch
log, and any written policy governing retention and release of these recordings.

If retention will cause any responsive recording to be destroyed before this
request is fulfilled, please place a litigation hold on it and tell me you have
done so.

If any cost will exceed $25.00, please tell me the estimate before you begin.

{{requester_block}}$body$,
 'Use for police and fire incident records. The retention-hold sentence matters: BWC footage is often on a short retention clock, and a request that arrives late is worth nothing.',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'unverified'),

('oh-followup-1', 'Ohio — first follow-up (friendly)', 'followup', 'OH', 'R.C. 149.43',
 'Following up — public records request {{request_id}}',
$body$To the Records Custodian, {{agency_name}}:

On {{submitted_date}} I sent the records request below. I have not yet received
an acknowledgement, and I want to make sure it reached the right office rather
than assume anything went wrong.

Original request:
{{scope_text}}

Could you confirm you received it, and let me know roughly when I might expect a
response? If this office is not the correct custodian, I would appreciate being
pointed to the one that is.

{{requester_block}}$body$,
 'Send at your 7-day mark. Deliberately friendly and blame-free — most non-responses are backlog or a misrouted email, not obstruction, and an accusatory first follow-up costs you the cooperation you need later.',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'unverified'),

('oh-followup-2', 'Ohio — second follow-up (formal, on the record)', 'followup', 'OH', 'R.C. 149.43',
 'Second request — public records request {{request_id}}',
$body$To the Records Custodian, {{agency_name}}:

This is my second written follow-up regarding the public records request I
submitted on {{submitted_date}}. My first follow-up was sent on {{followup_date}}.
I have received no substantive response.

Original request:
{{scope_text}}

R.C. 149.43(B)(1) requires that public records be made available for inspection
promptly and that copies be provided within a reasonable period of time. It has
now been {{days_open}} days.

Please respond in writing with one of the following:
  1. the responsive records, or
  2. a cost estimate, if fees will exceed $25.00, or
  3. a denial identifying each record withheld and the specific legal authority
     for withholding it, as R.C. 149.43(B)(3) requires.

I am keeping a record of this correspondence.

{{requester_block}}$body$,
 'Send at your 21-day mark. This one is written to be read later by a special master — it establishes the timeline plainly and without hostility. Note it does NOT claim a specific statutory deadline was missed, because Ohio does not set one.',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'unverified'),

('oh-narrowing', 'Ohio — response to "overly broad"', 'narrowing', 'OH', 'R.C. 149.43(B)(2)',
 'Revised request — {{request_id}}',
$body$To the Records Custodian, {{agency_name}}:

Thank you for your response indicating that my request of {{submitted_date}} was
overly broad.

R.C. 149.43(B)(2) provides that when a request is denied as ambiguous or overly
broad, the office shall provide the requester an opportunity to revise it, and
shall inform the requester of the manner in which records are maintained and
accessed in the ordinary course of business. So that I can revise this
accurately, please tell me:

  1. how these records are organized and indexed in the ordinary course,
  2. what date ranges or record series are available, and
  3. what scope you could fulfill without undue burden.

In the meantime, I revise my request to:

{{scope_text}}

{{date_range_clause}}

If this revision is still too broad, please tell me specifically which part, and
I will narrow it further.

{{requester_block}}$body$,
 'A breadth denial is an opening, not a loss — the statute obliges them to explain how their records are actually organized, which is information you did not have before. Ask for it.',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'unverified'),

('oh-fee-dispute', 'Ohio — cost and format challenge', 'fee_dispute', 'OH', 'R.C. 149.43(B)',
 'Cost estimate question — {{request_id}}',
$body$To the Records Custodian, {{agency_name}}:

Thank you for the cost estimate of {{fee_quoted}} for my request {{request_id}}.
Before I authorize it, I have questions.

R.C. 149.43(B)(6) permits an office to charge the actual cost of the medium on
which records are duplicated. It does not permit charges for search time, review
time, or redaction labor.

Please provide an itemized breakdown showing:
  1. the number of pages or items,
  2. the per-unit cost and what medium it reflects, and
  3. any component of this estimate that is not duplication cost.

If these records exist in electronic form, I request them electronically instead,
which under R.C. 149.43(B)(6) should reduce the cost to little or nothing. If you
maintain that an electronic copy is unavailable, please tell me the format in
which the records are actually stored.

{{requester_block}}$body$,
 'Fees are the most common soft denial. Asking for the itemization usually resolves it, because a charge for staff time cannot survive being written down. Verify the exact subsection before sending.',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'unverified'),

('oh-denial-response', 'Ohio — response to a denial', 'denial_response', 'OH', 'R.C. 149.43(B)(3)',
 'Request for the legal basis of denial — {{request_id}}',
$body$To the Records Custodian, {{agency_name}}:

I received your response of {{response_date}} denying, in whole or in part, my
request {{request_id}}.

R.C. 149.43(B)(3) requires that a denial include an explanation, including legal
authority. If the request was denied in part, the office must redact the exempt
portion and release the rest.

Please provide in writing:
  1. the specific statutory exemption relied upon for each record or portion
     withheld, cited by section,
  2. whether any responsive record was withheld in full that could instead be
     released in redacted form, and
  3. confirmation that all non-exempt portions have been released.

If your position is that no responsive records exist, please state that
explicitly, and describe where such records would be kept if they did exist.

I am preserving this correspondence.

{{requester_block}}$body$,
 'Never accept a bare denial. A denial that cannot name its exemption in writing usually becomes a production. Point 3 matters most — "no records exist" and "we will not give them to you" are very different answers.',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'unverified'),

('oh-appeal-coc', 'Ohio — Court of Claims complaint preparation checklist', 'appeal', 'OH', 'R.C. 2743.75',
 'Court of Claims public records complaint — preparation checklist',
$body$PREPARATION CHECKLIST — NOT A LETTER TO SEND.

R.C. 2743.75 provides an expedited path for public records disputes through the
Ohio Court of Claims. It is designed to be usable without a lawyer, and the
filing fee is $25.00.

Before filing, assemble:

  [ ] The original request, with the date sent and proof of delivery
  [ ] Every follow-up you sent, with dates
  [ ] Every response received, in full
  [ ] A plain timeline: what you asked, when, and what happened
  [ ] The specific records still outstanding

Confirm before filing:
  [ ] The office is a "public office" under R.C. 149.43(A)(1)
  [ ] The records sought are "records" under R.C. 149.011(G)
  [ ] You have not filed a mandamus action on the same request — you must
      choose one path or the other
  [ ] The current filing fee and procedure, from the court's own page

What to expect: a special master is appointed, mediation is offered first, and
most matters resolve there. Final orders may be appealed to the court of appeals
for the district where the public office has its principal place of business.

VERIFY EVERY DETAIL ABOVE against ohiocourtofclaims.gov before you file. Fees and
procedures change, and this checklist is a starting point, not legal advice.

{{requester_block}}$body$,
 'This is a checklist, never a letter. It exists so the appeal path is in front of you at the 45-day mark instead of being something you look up from scratch under pressure. It is not legal advice.',
 'https://ohiocourtofclaims.gov/public-records/', 'unverified')

ON CONFLICT (template_id) DO UPDATE SET
  name=EXCLUDED.name, kind=EXCLUDED.kind, jurisdiction_scope=EXCLUDED.jurisdiction_scope,
  statute_citation=EXCLUDED.statute_citation, subject_line=EXCLUDED.subject_line,
  body=EXCLUDED.body, guidance=EXCLUDED.guidance, source_url=EXCLUDED.source_url,
  verified_status=EXCLUDED.verified_status;


-- ---------------------------------------------------------------------
-- Deadline rules — the follow-up clock
--
-- Note the rule_basis column on every row. Ohio = operator_policy.
-- Federal FOIA = statutory. That distinction is load-bearing.
-- ---------------------------------------------------------------------

INSERT INTO deadline_rules
  (rule_id, label, jurisdiction_scope, rule_basis, statute_citation, days, day_basis,
   applies_to_status, action_on_breach, template_id, source_url, verified_status, notes, active)
VALUES

('oh-ack-7', 'No acknowledgement after 7 days', 'OH', 'operator_policy', NULL, 7, 'calendar',
 'submitted', 'followup', 'oh-followup-1',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'verified',
 'YOUR cadence, not law. R.C. 149.43 sets no acknowledgement deadline. Most non-responses at this stage are backlog or a misrouted email.', true),

('oh-substantive-21', 'No substantive response after 21 days', 'OH', 'operator_policy', NULL, 21, 'calendar',
 'submitted', 'escalate', 'oh-followup-2',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'verified',
 'YOUR cadence. The second follow-up is written to establish a timeline for a later reader.', true),

('oh-acked-nothing-30', 'Acknowledged but nothing produced after 30 days', 'OH', 'operator_policy', NULL, 30, 'calendar',
 'acknowledged', 'followup', 'oh-followup-2',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'verified',
 'YOUR cadence. An acknowledgement is not a production.', true),

('oh-appeal-45', 'No response after 45 days — consider Court of Claims', 'OH', 'operator_policy', NULL, 45, 'calendar',
 'submitted', 'appeal', 'oh-appeal-coc',
 'https://ohiocourtofclaims.gov/public-records/', 'verified',
 'YOUR cadence. R.C. 2743.75 sets no waiting period before filing; 45 days is a self-imposed trigger to stop and consider the appeal path.', true),

('oh-denial-3', 'Denial received — respond within 3 days', 'OH', 'operator_policy', NULL, 3, 'calendar',
 'denied', 'review', 'oh-denial-response',
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'verified',
 'YOUR cadence. Respond to a denial while the file is fresh; ask for the exemption in writing.', true),

('oh-partial-7', 'Partial production received — review within 7 days', 'OH', 'operator_policy', NULL, 7, 'calendar',
 'partial', 'review', NULL,
 'https://codes.ohio.gov/ohio-revised-code/section-149.43', 'verified',
 'YOUR cadence. Check what is missing against what you asked for, before the thread goes cold.', true),

('fed-foia-20', 'Federal FOIA — 20 business day determination', 'US', 'statutory', '5 U.S.C. 552(a)(6)(A)(i)', 20, 'business',
 'submitted', 'followup', NULL,
 'https://www.foia.gov/', 'unverified',
 'STATUTORY and FEDERAL ONLY. Federal agencies must make a determination within 20 business days, extendable in unusual circumstances. This rule must never be applied to an Ohio public office.', true)

ON CONFLICT (rule_id) DO UPDATE SET
  label=EXCLUDED.label, jurisdiction_scope=EXCLUDED.jurisdiction_scope,
  rule_basis=EXCLUDED.rule_basis, statute_citation=EXCLUDED.statute_citation,
  days=EXCLUDED.days, day_basis=EXCLUDED.day_basis,
  applies_to_status=EXCLUDED.applies_to_status, action_on_breach=EXCLUDED.action_on_breach,
  template_id=EXCLUDED.template_id, source_url=EXCLUDED.source_url,
  verified_status=EXCLUDED.verified_status, notes=EXCLUDED.notes, active=EXCLUDED.active;

COMMIT;
