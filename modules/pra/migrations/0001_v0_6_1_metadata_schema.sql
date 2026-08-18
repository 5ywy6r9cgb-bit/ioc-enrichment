-- =====================================================================
-- Sentinel Public Records Atlas — v0.6.1 metadata-only schema
-- Migration: 0001_v0_6_1_metadata_schema
-- Controls: SPRA-v0.5-2026-06-23, SPRA-v0.6.0-DESIGN-2026-06-23,
--           SPRA-v0.6.1-OPERATOR-DECISIONS-2026-06-23
--
-- PRINCIPLE: The database may make the system remember better.
--            It may not make it collect more.
--
-- METADATA ONLY. No raw file bytes, no content, no extracted/OCR text,
-- no previews/thumbnails, no AI summaries, no embeddings/vectors.
-- Raw files remain OUTSIDE the database in the operator-managed
-- Received_Records/ filing folder.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. schema_version — records the applied migration
-- ---------------------------------------------------------------------
CREATE TABLE schema_version (
    version       text PRIMARY KEY,
    migration_id  text NOT NULL,
    applied_at    timestamptz NOT NULL DEFAULT now(),
    description   text
);

-- ---------------------------------------------------------------------
-- 2. agencies — reference / seed-only. No app insert path; no sync,
--    scraping, remote lookup, auto-update, or submission automation.
-- ---------------------------------------------------------------------
CREATE TABLE agencies (
    agency_id     text PRIMARY KEY,
    name          text NOT NULL,
    jurisdiction  text,
    county        text,
    state         text,
    agency_type   text,
    source        text NOT NULL DEFAULT 'seed'
);

-- ---------------------------------------------------------------------
-- 3. requests — the public-records requests (tracker)
-- ---------------------------------------------------------------------
CREATE TABLE requests (
    request_id    text PRIMARY KEY,
    agency_id     text REFERENCES agencies(agency_id),
    status        text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','planned','submitted','acknowledged',
                                      'pending','received','partial','denied',
                                      'revised','published','closed')),
    subject       text,
    scope_text    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 4. request_history — append-only request status trail
-- ---------------------------------------------------------------------
CREATE TABLE request_history (
    history_id    bigserial PRIMARY KEY,
    request_id    text NOT NULL REFERENCES requests(request_id),
    from_status   text,
    to_status     text NOT NULL,
    changed_at    timestamptz NOT NULL DEFAULT now(),
    actor         text NOT NULL DEFAULT 'local_operator',
    note          text
);

-- ---------------------------------------------------------------------
-- 5. received_records — received-file METADATA ONLY.
--    No content column exists. Locked scan fields prevent false
--    assurance. Raw files stay in Received_Records/ (external).
-- ---------------------------------------------------------------------
CREATE TABLE received_records (
    id                            text PRIMARY KEY,
    request_id                    text NOT NULL REFERENCES requests(request_id),
    original_filename             text,                 -- internal-only evidence-chain metadata
    safe_display_name             text,                 -- sanitized, editable, independently scanned
    file_type                     text,
    file_size_bytes               bigint,               -- validation / sorting
    file_size_display             text,                 -- display compatibility
    review_status                 text NOT NULL DEFAULT 'uploaded'
                                    CHECK (review_status IN ('uploaded','needs_review',
                                          'redaction_needed','redacted','approved_internal',
                                          'approved_public','rejected_private_data')),
    original_filename_scan_result text,
    display_name_scan_result      text,
    overall_scan_status           text,                 -- highest risk of the field scans
    manual_review_required        boolean NOT NULL DEFAULT true
                                    CHECK (manual_review_required = true),
    content_scan_status           text NOT NULL DEFAULT 'not_performed'
                                    CHECK (content_scan_status = 'not_performed'),
    content_scan_note             text NOT NULL DEFAULT 'Content scan not performed. Manual review required.',
    -- pointer to where the RAW file lives (filing cabinet). RELATIVE only.
    recommended_file_folder       text
                                    CHECK (recommended_file_folder IS NULL
                                      OR recommended_file_folder !~ '^([A-Za-z]:[\\/]|/|\\\\)'),
    created_at                    timestamptz NOT NULL DEFAULT now(),
    updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 6. upload_review_history — append-only review-status trail
-- ---------------------------------------------------------------------
CREATE TABLE upload_review_history (
    review_history_id   bigserial PRIMARY KEY,
    received_record_id  text NOT NULL REFERENCES received_records(id),
    from_status         text,
    to_status           text NOT NULL,
    changed_at          timestamptz NOT NULL DEFAULT now(),
    actor               text NOT NULL DEFAULT 'local_operator',
    note                text
);

-- ---------------------------------------------------------------------
-- 7. export_ledger — append-only export ledger (tamper-evidence)
-- ---------------------------------------------------------------------
CREATE TABLE export_ledger (
    export_id               bigserial PRIMARY KEY,
    exported_at             timestamptz NOT NULL DEFAULT now(),
    scope_label             text,
    suggested_filename      text,
    recommended_folder      text
                              CHECK (recommended_folder IS NULL
                                OR recommended_folder !~ '^([A-Za-z]:[\\/]|/|\\\\)'),
    record_count            integer NOT NULL,
    export_sha256           text,
    exported_metadata_only  boolean NOT NULL DEFAULT true
                              CHECK (exported_metadata_only = true),
    actor                   text NOT NULL DEFAULT 'local_operator',
    note                    text
);

-- ---------------------------------------------------------------------
-- 8. audit_ledger — append-only material-change log
-- ---------------------------------------------------------------------
CREATE TABLE audit_ledger (
    audit_id      bigserial PRIMARY KEY,
    at            timestamptz NOT NULL DEFAULT now(),
    actor         text NOT NULL DEFAULT 'local_operator',
    entity_type   text NOT NULL,     -- request | received_record | export | import
    entity_id     text,
    action        text NOT NULL,     -- create | update | status_change | import | export | strip_forbidden_field
    detail        jsonb
);

-- ---------------------------------------------------------------------
-- Append-only enforcement at the DB level (belt-and-suspenders in
-- addition to least-privilege role grants): block UPDATE/DELETE on the
-- two ledgers.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'append-only ledger: % not permitted on %', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_ledger_append_only
    BEFORE UPDATE OR DELETE ON audit_ledger
    FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER export_ledger_append_only
    BEFORE UPDATE OR DELETE ON export_ledger
    FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

-- ---------------------------------------------------------------------
-- Record this migration.
-- ---------------------------------------------------------------------
INSERT INTO schema_version (version, migration_id, description)
VALUES ('0.6.1', '0001_v0_6_1_metadata_schema',
        'Local single-user metadata-only persistence for Sentinel PRA v0.6.1');

COMMIT;
