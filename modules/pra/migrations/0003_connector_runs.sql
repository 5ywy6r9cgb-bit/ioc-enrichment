-- =====================================================================
-- Sentinel PRA — migration 0003: connector_runs
--
-- WHY THIS EXISTS
-- The connectors written for the Entity Intelligence layer record every run:
-- which connector, under which engagement, what it saw, what it imported,
-- and whether it failed. The v0.7 schema had nowhere to put that.
--
-- It matters for the same reason the export ledger matters. A connector that
-- fetched 1000 records and imported 25 must SAY so — "1000 seen, 25 imported"
-- is honest; reporting only the 25 quietly turns a truncation into a silent
-- lie about coverage. The RATIFICATION record calls this out by name in the
-- EDGAR run ("1000 seen, 25 imported — truncation announced in run notes").
--
-- A failed run is kept, not deleted. A connector that has been quietly broken
-- for a week must not look like a source with nothing to report.
-- =====================================================================

BEGIN;

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_version WHERE version = '0.7.0') THEN
        RAISE EXCEPTION 'v0.7 master schema not applied. Run 0002 first.';
    END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS connector_runs (
    run_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_name   text NOT NULL,
    connector_version text,
    -- The engagement/authority gate. In this schema an investigation IS the
    -- engagement: work is done under a named, recorded thread or not at all.
    investigation_id text REFERENCES investigations(investigation_id) ON DELETE SET NULL,
    engagement_ref   text,          -- free-text authority note when no investigation row exists yet
    source_url       text,
    run_mode         text NOT NULL DEFAULT 'live'
                        CHECK (run_mode IN ('live','dry_run','replay')),
    run_status       text NOT NULL DEFAULT 'running'
                        CHECK (run_status IN ('running','completed','failed','refused')),
    -- Honesty about coverage: both numbers, always.
    records_seen     integer,
    records_imported integer,
    truncated        boolean GENERATED ALWAYS AS (
                        records_seen IS NOT NULL
                        AND records_imported IS NOT NULL
                        AND records_imported < records_seen
                     ) STORED,
    capture_path     text,          -- RELATIVE path into evidence/, never absolute
    capture_sha256   text,
    live_calls       integer NOT NULL DEFAULT 0,
    error_message    text,
    started_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz,
    actor            text NOT NULL DEFAULT 'local_operator',
    notes            text,
    CONSTRAINT connector_runs_relative_capture CHECK (
        capture_path IS NULL OR capture_path !~ '^([A-Za-z]:[\\/]|/|\\\\)'
    ),
    -- No credential may ever land in a run record.
    CONSTRAINT connector_runs_no_credentials CHECK (
        (notes IS NULL OR notes !~* '(password|passwd|api[_ -]?key|secret|bearer|token\s*[:=])')
        AND (error_message IS NULL OR error_message !~* '(password|passwd|api[_ -]?key|secret|bearer)')
    )
);

CREATE INDEX IF NOT EXISTS idx_connector_runs_connector    ON connector_runs(connector_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_connector_runs_investigation ON connector_runs(investigation_id);
CREATE INDEX IF NOT EXISTS idx_connector_runs_status       ON connector_runs(run_status);

-- A run record is append-only once finished: the same discipline as the
-- ledgers. Updating status/counts while it is still 'running' is allowed;
-- rewriting a finished run is not.
CREATE OR REPLACE FUNCTION prevent_finished_run_mutation() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'connector_runs: a run record is never deleted (run %)', OLD.run_id;
    END IF;
    IF OLD.run_status IN ('completed','failed','refused') THEN
        RAISE EXCEPTION
          'connector_runs: run % is already %; a finished run cannot be rewritten',
          OLD.run_id, OLD.run_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS connector_runs_append_only ON connector_runs;
CREATE TRIGGER connector_runs_append_only
    BEFORE UPDATE OR DELETE ON connector_runs
    FOR EACH ROW EXECUTE FUNCTION prevent_finished_run_mutation();

-- What ran, what it cost, and what it actually covered.
CREATE OR REPLACE VIEW v_connector_activity AS
SELECT
    r.run_id, r.connector_name, r.connector_version, r.run_status, r.run_mode,
    i.title              AS investigation,
    r.records_seen, r.records_imported, r.truncated,
    r.live_calls, r.capture_sha256,
    r.started_at, r.finished_at,
    CASE WHEN r.finished_at IS NOT NULL
         THEN round(extract(epoch FROM (r.finished_at - r.started_at))::numeric, 1)
    END                  AS duration_s,
    r.error_message
FROM connector_runs r
LEFT JOIN investigations i ON i.investigation_id = r.investigation_id
ORDER BY r.started_at DESC;

INSERT INTO schema_version (version, migration_id, description)
VALUES ('0.7.1', '0003_connector_runs',
        'Connector run ledger: seen-vs-imported honesty, append-only once finished')
ON CONFLICT (version) DO NOTHING;

COMMIT;
