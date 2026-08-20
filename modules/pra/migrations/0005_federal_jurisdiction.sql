-- =====================================================================
-- Sentinel PRA — migration 0005: a jurisdiction may have no state
--
-- WHAT WAS WRONG
--
-- jurisdictions.state was NOT NULL DEFAULT 'OH'. That encoded an assumption
-- from the first week of this system — that everything it tracks is in Ohio —
-- into a constraint. Two things break under it:
--
--   1. A FEDERAL jurisdiction has no state. PACER, FEC, SAM.gov, USAspending
--      and the Senate LDA registry are national. Filing them under a state is
--      not a rounding error, it is a wrong fact in the directory that every
--      later query inherits.
--
--   2. The DEFAULT was worse than the NOT NULL. A row inserted without a
--      state silently became an Ohio row. Nothing raised, nothing logged, and
--      the wrong answer looked exactly like a right one. This system's whole
--      discipline is that an unknown stays visibly unknown; a default that
--      invents a value is the opposite of that.
--
-- WHAT THIS DOES
--
-- state becomes nullable and loses its default. NULL now means what it should
-- have meant all along: this jurisdiction is not within a single state. Every
-- Ohio row in the seed file states 'OH' explicitly, so nothing relies on the
-- default; the loader has always written the column.
--
-- No data is changed. Existing rows keep the state they already have.
-- =====================================================================

BEGIN;

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_version WHERE version = '0.7.2') THEN
        RAISE EXCEPTION 'migration 0004 (lobbying) not applied. Run it first.';
    END IF;
END
$guard$;

ALTER TABLE jurisdictions ALTER COLUMN state DROP NOT NULL;
ALTER TABLE jurisdictions ALTER COLUMN state DROP DEFAULT;

COMMENT ON COLUMN jurisdictions.state IS
  'Two-letter state code, or NULL for a jurisdiction that is not within one state (federal, multi-state). NULL means "no single state", never "unknown, assume Ohio".';

INSERT INTO schema_version (version, migration_id, description)
VALUES ('0.7.3', '0005_federal_jurisdiction',
        'jurisdictions.state is nullable with no default — a federal jurisdiction has no state, and a default silently invented one')
ON CONFLICT (version) DO NOTHING;

COMMIT;
