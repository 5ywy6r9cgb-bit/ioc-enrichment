-- =====================================================================
-- 0007 — record what R.C. 149.43(C)(2) actually turns on.
--
-- The requests table can describe a request in detail and cannot express
-- the two facts that decide whether statutory damages are even a live
-- question:
--
--   1. WAS A MANDAMUS ACTION COMMENCED, AND WHEN.
--      There is an `appeal_filed_at` column, and it is NOT this. An
--      administrative appeal is not a mandamus action; damages under
--      (C)(2) accrue from the filing of a mandamus action in a court of
--      competent jurisdiction. Mapping appeal_filed_at onto the damages
--      clock would reproduce, through the schema, the exact defect that
--      foia_tracker.js exists to fix — a damages figure for a case nobody
--      filed. So this is a separate column with a separate name.
--
--   2. HOW THE REQUEST WAS TRANSMITTED.
--      (C)(2) reaches only requests delivered by hand delivery, electronic
--      submission, or certified mail. `submission_method` already exists
--      but is free text with no vocabulary, so 'certified' and
--      'certified mail' and 'USPS certified' are three different values
--      and none of them can be tested. This adds a CHECK-constrained
--      column that says which of the three statutory channels, if any,
--      was used — and permits NULL, because "not recorded" is a real and
--      common state that must not be guessed at.
--
-- Neither column is inferred from anything. A NULL here means the operator
-- has not recorded the fact, and the tracker reports that rather than
-- assuming a value.
-- =====================================================================

BEGIN;

ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS mandamus_filed_on   date,
  ADD COLUMN IF NOT EXISTS mandamus_case_no    text,
  ADD COLUMN IF NOT EXISTS mandamus_court      text,
  ADD COLUMN IF NOT EXISTS delivery_method     text;

-- The vocabulary is closed on purpose. The first three satisfy the
-- (C)(2) transmission predicate; the rest are recordable and do not.
-- A value outside this list is a typo, and a typo here silently changes
-- whether damages can ever be reported.
ALTER TABLE requests
  DROP CONSTRAINT IF EXISTS requests_delivery_method_ck;
ALTER TABLE requests
  ADD CONSTRAINT requests_delivery_method_ck
  CHECK (delivery_method IS NULL OR delivery_method IN (
    'hand_delivery', 'certified_mail', 'electronic',
    'web_form', 'phone', 'in_person', 'mail'
  ));

-- A mandamus case number without a date is a half-recorded fact, and the
-- date is the half the damages clock runs on.
ALTER TABLE requests
  DROP CONSTRAINT IF EXISTS requests_mandamus_ck;
ALTER TABLE requests
  ADD CONSTRAINT requests_mandamus_ck
  CHECK (mandamus_case_no IS NULL OR mandamus_filed_on IS NOT NULL);

COMMENT ON COLUMN requests.mandamus_filed_on IS
  'Date a mandamus action was COMMENCED. Not an administrative appeal — see '
  'appeal_filed_at for that. R.C. 149.43(C)(2) statutory damages accrue from '
  'this date, not from the date of the records request.';

COMMENT ON COLUMN requests.delivery_method IS
  'How the request was transmitted. Only hand_delivery, certified_mail, and '
  'electronic satisfy the R.C. 149.43(C)(2) transmission predicate. NULL means '
  'not recorded, which is not the same as not qualifying.';

INSERT INTO schema_version (version, migration_id, applied_at, description)
VALUES ('0.7.5', '0007_mandamus_and_delivery', now(),
        'requests can record a mandamus filing and a CHECK-constrained '
        'delivery_method, so the R.C. 149.43(C)(2) predicates are recorded '
        'facts rather than inferences drawn from appeal_filed_at')
ON CONFLICT DO NOTHING;

COMMIT;
