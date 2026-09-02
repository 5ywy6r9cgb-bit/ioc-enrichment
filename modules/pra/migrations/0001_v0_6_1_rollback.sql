-- =====================================================================
-- Sentinel PRA v0.6.1 — rollback for 0001_v0_6_1_metadata_schema
-- Drops the v0.6.1 metadata schema cleanly. Reverts to v0.5 JSON/session.
-- No raw-file data loss is possible: raw files were never in the DB.
-- =====================================================================

BEGIN;

DROP TRIGGER IF EXISTS export_ledger_append_only ON export_ledger;
DROP TRIGGER IF EXISTS audit_ledger_append_only ON audit_ledger;
DROP FUNCTION IF EXISTS prevent_ledger_mutation();

DROP TABLE IF EXISTS audit_ledger;
DROP TABLE IF EXISTS export_ledger;
DROP TABLE IF EXISTS upload_review_history;
DROP TABLE IF EXISTS received_records;
DROP TABLE IF EXISTS request_history;
DROP TABLE IF EXISTS requests;
DROP TABLE IF EXISTS agencies;
DROP TABLE IF EXISTS schema_version;

COMMIT;
