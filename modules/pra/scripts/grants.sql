-- =====================================================================
-- Least-privilege grants for the application role.
--
-- Run this AS THE DATABASE OWNER, AFTER both migrations are applied.
-- setup_macos.sh does it for you.
--
-- The app role can read and write the working tables. It can only APPEND
-- to the two ledgers — no UPDATE, no DELETE — so the audit trail cannot
-- be quietly rewritten by the application, even if the application has a
-- bug. The database triggers block it too. Belt and suspenders.
--
-- :app_role is passed in by psql -v app_role=sentinel_app
-- =====================================================================

\set app_ident :app_role

-- Connect + schema usage
GRANT CONNECT ON DATABASE :"db_name" TO :"app_ident";
GRANT USAGE ON SCHEMA public TO :"app_ident";

-- Reference data: read-only for the app (seeded by the owner).
GRANT SELECT ON
    agencies, jurisdictions, portals, agency_portals, record_types,
    request_templates, deadline_rules, schema_version
TO :"app_ident";

-- Working tables: read + write, no delete.
GRANT SELECT, INSERT, UPDATE ON
    requests, request_history, received_records, upload_review_history,
    investigations, sources, source_links, entities, entity_aliases,
    entity_links, request_entities, notes, tags, taggings, saved_searches,
    document_text_index
TO :"app_ident";

-- Ledgers and the follow-up log: APPEND ONLY.
GRANT INSERT ON audit_ledger, export_ledger, followups TO :"app_ident";
GRANT SELECT ON audit_ledger, export_ledger, followups TO :"app_ident";
REVOKE UPDATE, DELETE ON audit_ledger, export_ledger, followups FROM :"app_ident";

-- Sequences needed by the bigserial primary keys.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_ident";

-- Views.
GRANT SELECT ON v_request_clock, v_needs_attention, v_filing_routes, v_unverified_sources
TO :"app_ident";

-- No DDL at runtime, ever.
REVOKE CREATE ON SCHEMA public FROM :"app_ident";

-- Show what the role ended up with so you can eyeball it.
\echo ''
\echo 'Effective grants for the application role:'
SELECT table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
 WHERE grantee = :'app_ident'
 GROUP BY table_name
 ORDER BY table_name;
