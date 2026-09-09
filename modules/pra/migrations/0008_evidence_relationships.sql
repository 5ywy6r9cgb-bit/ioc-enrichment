-- =====================================================================
-- 0008 — say what KIND of claim an edge is, separately from how sure
--        of it we are.
--
-- entity_links already has `confidence`, and it answers a different
-- question than the one that keeps going wrong. Keep them straight:
--
--   confidence      HOW SURE ARE WE THIS IS TRUE?
--                   unverified / documented / confirmed / disputed
--
--   assertion_type  WHAT KIND OF CLAIM IS THIS, AT ALL?
--                   documented / derived / hypothesis
--
-- A derived edge can be perfectly certain — the arithmetic is sound —
-- and still not be a thing any document says. A hypothesis can be
-- strongly suspected and remain a lead. Collapsing those two axes into
-- one column is how a lead ends up rendered the same as a filing, which
-- is the failure `sentinel connect graph` already refuses to commit and
-- the reason Episode 01 exists.
--
-- Both columns use the word 'documented' and they mean compatible
-- things: confidence='documented' says a source supports it,
-- assertion_type='documented' says a source ASSERTS it. The CHECK at the
-- bottom forbids the one combination that cannot be true either way.
--
-- NO COLUMN DEFAULT, deliberately. A default would mean every future
-- insert that forgets this field silently claims the strongest available
-- evidentiary status — the exact failure mode the column exists to
-- prevent. A caller that does not state it gets an error, not a guess.
--
-- WHAT THIS MIGRATION DOES NOT DO: started_on and ended_on already exist
-- (migration 0002) and already hold data. See the note above occurred_on
-- for why that data is not moved.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The column, with no default.
-- ---------------------------------------------------------------------
ALTER TABLE entity_links
    ADD COLUMN IF NOT EXISTS assertion_type text;

-- ---------------------------------------------------------------------
-- 2. Backfill EXISTING rows explicitly, conservatively, and visibly.
--
-- This is a one-time decision about data that predates the column. It
-- downgrades every pre-migration edge to the weakest category rather
-- than assuming it was documented, because nothing in those rows records
-- which it was. Promoting one later is a deliberate act with a person
-- behind it, which is the point.
--
-- Note this does NOT read `confidence` to infer an assertion_type.
-- confidence='confirmed' would look like a safe promotion and is not:
-- the connectors set confidence from a glassmark grade that never
-- distinguished an asserted fact from an inferred one, so deriving one
-- axis from the other here would manufacture a distinction the source
-- data never made.
-- ---------------------------------------------------------------------
UPDATE entity_links
    SET assertion_type = 'hypothesis'
    WHERE assertion_type IS NULL;

-- ---------------------------------------------------------------------
-- 3. Now that every row has a value, enforce it going forward.
-- ---------------------------------------------------------------------
ALTER TABLE entity_links
    ALTER COLUMN assertion_type SET NOT NULL;

ALTER TABLE entity_links
    DROP CONSTRAINT IF EXISTS entity_links_assertion_type_ck;
ALTER TABLE entity_links
    ADD CONSTRAINT entity_links_assertion_type_ck
    CHECK (assertion_type IN ('documented', 'derived', 'hypothesis'));

-- An edge nobody has documented cannot simultaneously be confirmed.
-- Everything else is a legitimate pairing: a derived edge can be
-- confirmed (the inputs and the arithmetic both check out), and a
-- documented edge can be disputed (the document exists and is contested).
--
-- NOT VALID, and this is the interesting part of the migration.
--
-- Step 2 backfills every legacy row to 'hypothesis'. Any row already
-- carrying confidence='confirmed' therefore lands on exactly the pairing
-- this constraint forbids, and a plain ADD CONSTRAINT aborts the whole
-- migration — on precisely the databases that have real data in them.
--
-- The three ways out and why this is the one:
--
--   * Drop the rule. Loses a real invariant to make a migration tidy.
--   * Backfill confirmed rows to 'documented'. That is inferring one axis
--     from the other, which step 2 explicitly refuses to do, and it would
--     promote unreviewed rows to the strongest status this column has.
--   * Rewrite their confidence. Mutates existing evidence grading to fit
--     a new column. Never.
--
-- NOT VALID enforces the rule on every INSERT and UPDATE from now on and
-- grandfathers the existing rows instead of pretending they comply. The
-- incoherence is real, it belongs to a human, and it stays visible until
-- one resolves it. List them:
--
--   SELECT link_id, relation, confidence, source_id, notes
--     FROM entity_links
--    WHERE assertion_type = 'hypothesis' AND confidence = 'confirmed';
--
-- Each one is a row somebody confirmed before this column existed. Decide
-- what kind of claim it actually was, set assertion_type accordingly, and
-- when none are left:
--
--   ALTER TABLE entity_links
--     VALIDATE CONSTRAINT entity_links_hypothesis_not_confirmed_ck;
--
-- which then verifies the whole table and marks the rule fully enforced.
-- =====================================================================
ALTER TABLE entity_links
    DROP CONSTRAINT IF EXISTS entity_links_hypothesis_not_confirmed_ck;
ALTER TABLE entity_links
    ADD CONSTRAINT entity_links_hypothesis_not_confirmed_ck
    CHECK (NOT (assertion_type = 'hypothesis' AND confidence = 'confirmed'))
    NOT VALID;

-- ---------------------------------------------------------------------
-- 4. When it happened.
--
-- started_on / ended_on already exist and are already written to, so
-- this adds only occurred_on — the single-instant case a range cannot
-- express without lying about a duration.
--
-- PRE-0008 ROWS ARE NOT REWRITTEN. intel_repo.insertRelationship wrote
-- an instantaneous `as_of_date` into started_on because it was the only
-- date column there was, so some existing started_on values are really
-- occurred_on values. They are not moved, because a row with started_on
-- set and ended_on null is ALSO exactly what an ongoing relationship
-- looks like, and nothing in the row distinguishes the two. Guessing
-- would put a fabricated distinction into the evidence table to make a
-- migration tidier. From this migration forward the adapter writes
-- occurred_on for a point in time; older rows stay as recorded.
-- ---------------------------------------------------------------------
ALTER TABLE entity_links
    ADD COLUMN IF NOT EXISTS occurred_on date;

-- A row states an instant or an interval, never both. Written as an
-- enforced constraint rather than a comment nobody re-reads, and phrased
-- to permit every pre-0008 row (occurred_on is null in all of them).
ALTER TABLE entity_links
    DROP CONSTRAINT IF EXISTS entity_links_when_ck;
ALTER TABLE entity_links
    ADD CONSTRAINT entity_links_when_ck
    CHECK (occurred_on IS NULL OR (started_on IS NULL AND ended_on IS NULL));

-- An interval that ends before it starts is a data-entry error, not a
-- relationship. NOT VALID for the same reason as above: started_on and
-- ended_on already hold data this migration did not write, and a backwards
-- interval in there is a bug to find, not a reason the migration cannot
-- apply. Find them, fix them, then VALIDATE CONSTRAINT:
--
--   SELECT link_id, started_on, ended_on FROM entity_links
--    WHERE ended_on < started_on;
ALTER TABLE entity_links
    DROP CONSTRAINT IF EXISTS entity_links_interval_ck;
ALTER TABLE entity_links
    ADD CONSTRAINT entity_links_interval_ck
    CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on)
    NOT VALID;

-- ---------------------------------------------------------------------
-- 5. Indexes.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_entity_links_relation
    ON entity_links(relation);

CREATE INDEX IF NOT EXISTS idx_entity_links_occurred
    ON entity_links(occurred_on);

CREATE INDEX IF NOT EXISTS idx_entity_links_started
    ON entity_links(started_on);

CREATE INDEX IF NOT EXISTS idx_entity_links_assertion
    ON entity_links(assertion_type);

-- ---------------------------------------------------------------------
-- 6. Documentation that travels with the database.
-- ---------------------------------------------------------------------
COMMENT ON COLUMN entity_links.assertion_type IS
    'WHAT KIND of claim this edge is — a separate axis from confidence, which '
    'says how sure we are. documented = a source asserts this relationship; '
    'derived = calculated or inferred from documented facts; hypothesis = an '
    'investigative lead requiring verification. NO COLUMN DEFAULT: callers '
    'must state it, and an INSERT that omits it fails rather than claiming '
    'the strongest status by accident. Rows predating this column were '
    'backfilled to hypothesis on 2026-09-09, not assumed to be documented, '
    'and not inferred from confidence.';

COMMENT ON COLUMN entity_links.confidence IS
    'HOW SURE we are the edge is true — not what kind of claim it is, which '
    'is assertion_type. A derived edge can be confirmed; a documented edge '
    'can be disputed. Only hypothesis+confirmed is refused, by CHECK.';

COMMENT ON COLUMN entity_links.occurred_on IS
    'Date of an INSTANTANEOUS event — a filing date, a vote, a payment. '
    'Mutually exclusive with started_on/ended_on by CHECK. Null on every row '
    'written before migration 0008, including ones whose started_on actually '
    'holds an instant; those were left as recorded rather than guessed at.';

COMMENT ON COLUMN entity_links.started_on IS
    'Start of a relationship spanning a range — a lobbying registration, an '
    'employment period. Use with ended_on. Mutually exclusive with '
    'occurred_on by CHECK.';

COMMENT ON COLUMN entity_links.ended_on IS
    'End of the interval opened by started_on. Null means the relationship is '
    'ongoing as of last verification, OR that the end was never recorded — '
    'the column does not distinguish those, so do not report one as the other.';

INSERT INTO schema_version (version, migration_id, applied_at, description)
VALUES ('0.8.0', '0008_evidence_relationships', now(),
        'entity_links records what KIND of claim an edge is (assertion_type, '
        'no default, explicit backfill to hypothesis) separately from how sure '
        'of it we are (confidence), plus an instantaneous occurred_on date '
        'constrained to be mutually exclusive with the started_on/ended_on '
        'interval')
ON CONFLICT DO NOTHING;

COMMIT;
