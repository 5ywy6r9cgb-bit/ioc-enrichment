-- =====================================================================
-- Sentinel OS — Public Records Atlas
-- schema.sql  (PostgreSQL 14+)
-- v0.1
-- =====================================================================
-- Notes:
--   * Designed to sit alongside existing Sentinel OS tables (Evidence
--     Vault, Claim Matrix, etc.) without modifying them.
--   * All tables use UUID primary keys for easy cross-system linking
--     (Airtable / Neo4j / object storage references).
--   * No table in this schema stores private individual data. See
--     CHECK constraints / comments marking privacy-sensitive columns.
-- =====================================================================
--
-- HISTORICAL REFERENCE ONLY. Superseded by migrations/0001_v0_6_1_metadata_schema.sql
-- and migrations/0002_v0_7_master_schema.sql, which use text slug primary keys
-- instead of UUIDs and add the append-only audit/export ledgers. Kept here
-- because v0.6.1/v0.7 were explicitly built as a rebuild of this v0.5 design.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------
-- 1. jurisdictions
-- ---------------------------------------------------------------------
CREATE TABLE jurisdictions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                TEXT NOT NULL,
    jurisdiction_type   TEXT NOT NULL CHECK (jurisdiction_type IN (
                            'state','county','city','village','township',
                            'school_district','court_district',
                            'utility_service_area','special_district'
                        )),
    parent_jurisdiction_id UUID REFERENCES jurisdictions(id) ON DELETE SET NULL,
    state               TEXT NOT NULL DEFAULT 'OH',
    county              TEXT,
    centroid_lat        NUMERIC(9,6),
    centroid_lng         NUMERIC(9,6),
    boundary_geojson_url TEXT,
    source_url          TEXT,
    verified_status     TEXT NOT NULL DEFAULT 'unverified' CHECK (verified_status IN (
                            'unverified','verified','needs_review'
                        )),
    last_verified_at    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_jurisdictions_type ON jurisdictions(jurisdiction_type);
CREATE INDEX idx_jurisdictions_parent ON jurisdictions(parent_jurisdiction_id);

-- ---------------------------------------------------------------------
-- 2. agencies
-- ---------------------------------------------------------------------
CREATE TABLE agencies (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    TEXT NOT NULL,
    agency_type             TEXT NOT NULL CHECK (agency_type IN (
                                'city_government','township_government',
                                'county_auditor','county_treasurer','county_recorder',
                                'clerk_of_courts','municipal_court','common_pleas_court',
                                'school_district','water_sewer_stormwater',
                                'public_utilities','police_fire_public_safety',
                                'public_health','gis_open_data',
                                'state_public_records_office','public_records_office',
                                'library_community_access',
                                'finance_auditor','legislative_body','other'
                            )),
    jurisdiction_id         UUID REFERENCES jurisdictions(id) ON DELETE SET NULL,
    address                 TEXT,
    city                    TEXT,
    state                   TEXT DEFAULT 'OH',
    zip                     TEXT,
    latitude                NUMERIC(9,6),
    longitude               NUMERIC(9,6),
    phone                   TEXT,
    website_url             TEXT,
    public_records_url      TEXT,
    public_records_email    TEXT,
    records_portal_type     TEXT CHECK (records_portal_type IN (
                                'email','form','nextrequest','portal',
                                'phone','in_person','mixed','unknown'
                            )) DEFAULT 'unknown',
    system_role             TEXT,           -- plain-language description of role
    source_url              TEXT NOT NULL,  -- official source backing this entry
    verified_status         TEXT NOT NULL DEFAULT 'unverified' CHECK (verified_status IN (
                                'unverified','verified','needs_review'
                            )),
    last_verified_at        TIMESTAMPTZ,
    notes                   TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agencies_type ON agencies(agency_type);
CREATE INDEX idx_agencies_jurisdiction ON agencies(jurisdiction_id);
CREATE INDEX idx_agencies_geocoord ON agencies(latitude, longitude);

-- ---------------------------------------------------------------------
-- 3. record_types
-- ---------------------------------------------------------------------
CREATE TABLE record_types (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    TEXT NOT NULL UNIQUE,
    description             TEXT,
    privacy_risk_level      TEXT NOT NULL DEFAULT 'low' CHECK (privacy_risk_level IN (
                                'low','medium','high'
                            )),
    default_date_range      TEXT,            -- e.g. "last 3 years"
    template_language        TEXT,            -- default request wording fragment
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 4. agency_record_capabilities (join table)
-- ---------------------------------------------------------------------
CREATE TABLE agency_record_capabilities (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agency_id           UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
    record_type_id      UUID NOT NULL REFERENCES record_types(id) ON DELETE CASCADE,
    likely_has_records  BOOLEAN NOT NULL DEFAULT true,
    example_request     TEXT,
    notes               TEXT,
    UNIQUE (agency_id, record_type_id)
);

-- ---------------------------------------------------------------------
-- 5. records_requests  (NOTE: tracks the *request*, never private
--    customer/account data; privacy_review_status gate is mandatory
--    before any related evidence can be marked public)
-- ---------------------------------------------------------------------
CREATE TABLE records_requests (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_title           TEXT NOT NULL,
    agency_id               UUID REFERENCES agencies(id) ON DELETE SET NULL,
    jurisdiction_id         UUID REFERENCES jurisdictions(id) ON DELETE SET NULL,
    record_type_id          UUID REFERENCES record_types(id) ON DELETE SET NULL,
    request_text            TEXT NOT NULL,   -- generated/edited request language
    status                  TEXT NOT NULL DEFAULT 'planned' CHECK (status IN (
                                'planned','submitted','acknowledged','pending',
                                'received','partial','denied','appealed',
                                'revised','published'
                            )),
    submitted_at            TIMESTAMPTZ,
    acknowledged_at         TIMESTAMPTZ,
    due_followup_at         TIMESTAMPTZ,
    received_at             TIMESTAMPTZ,
    cost_estimate           NUMERIC(10,2),
    delivery_method         TEXT,
    source_contact          TEXT,
    privacy_review_status   TEXT NOT NULL DEFAULT 'not_reviewed' CHECK (privacy_review_status IN (
                                'not_reviewed','reviewed_clean','reviewed_needs_redaction'
                            )),
    evidence_packet_id      UUID,            -- FK to evidence_packets, added below
    created_by              TEXT,            -- Sentinel OS user id/handle
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_requests_agency ON records_requests(agency_id);
CREATE INDEX idx_requests_status ON records_requests(status);

-- ---------------------------------------------------------------------
-- 6. evidence_packets
-- ---------------------------------------------------------------------
CREATE TABLE evidence_packets (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title                   TEXT NOT NULL,
    records_request_id      UUID REFERENCES records_requests(id) ON DELETE SET NULL,
    agency_id               UUID REFERENCES agencies(id) ON DELETE SET NULL,
    storage_path             TEXT,            -- object storage pointer (S3/Blob/R2)
    file_type                TEXT,
    page_count               INTEGER,
    ocr_status                TEXT DEFAULT 'pending' CHECK (ocr_status IN (
                                'pending','processing','complete','failed','not_applicable'
                            )),
    access_level              TEXT NOT NULL DEFAULT 'internal' CHECK (access_level IN (
                                'public','credentialed','internal'
                            )),
    privacy_review_status    TEXT NOT NULL DEFAULT 'not_reviewed' CHECK (privacy_review_status IN (
                                'not_reviewed','reviewed_clean','reviewed_needs_redaction','redacted'
                            )),
    source_url                TEXT,
    uploaded_by               TEXT,
    uploaded_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes                     TEXT
);

ALTER TABLE records_requests
    ADD CONSTRAINT fk_requests_evidence_packet
    FOREIGN KEY (evidence_packet_id) REFERENCES evidence_packets(id) ON DELETE SET NULL;

CREATE INDEX idx_evidence_request ON evidence_packets(records_request_id);

-- ---------------------------------------------------------------------
-- 7. map_features  (drives the spatial layer / popups)
-- ---------------------------------------------------------------------
CREATE TABLE map_features (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    feature_id              TEXT NOT NULL UNIQUE,  -- human-readable id e.g. ORG_REY_WATER
    name                    TEXT NOT NULL,
    feature_type             TEXT NOT NULL CHECK (feature_type IN (
                                'organization','water_utility','public_records',
                                'finance','community_access_point','school',
                                'court','boundary'
                            )),
    geometry_type             TEXT NOT NULL DEFAULT 'point' CHECK (geometry_type IN (
                                'point','line','polygon'
                            )),
    geojson                   JSONB,
    agency_id                 UUID REFERENCES agencies(id) ON DELETE SET NULL,
    jurisdiction_id           UUID REFERENCES jurisdictions(id) ON DELETE SET NULL,
    icon                       TEXT,             -- e.g. blue_droplet, gray_building
    color                       TEXT,
    popup_template_key          TEXT,             -- references popup_templates.md section
    record_status               TEXT NOT NULL DEFAULT 'planned' CHECK (record_status IN (
                                'planned','requested','received','reviewed','published'
                            )),
    privacy_level                TEXT NOT NULL DEFAULT 'public' CHECK (privacy_level IN (
                                'public','credentialed','internal'
                            )),
    source_url                   TEXT NOT NULL,
    next_action                   TEXT,
    last_verified_at              TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_map_features_type ON map_features(feature_type);
CREATE INDEX idx_map_features_agency ON map_features(agency_id);

-- ---------------------------------------------------------------------
-- 8. los_status  (Level-of-Service tracking for directory completeness)
-- ---------------------------------------------------------------------
CREATE TABLE los_status (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scope_type               TEXT NOT NULL CHECK (scope_type IN (
                                'agency','jurisdiction','record_type','global'
                            )),
    scope_id                  UUID,            -- nullable; null = global scorecard row
    los_stage                  TEXT NOT NULL CHECK (los_stage IN (
                                'LOS0_foundation','LOS1_intake','LOS2_processing',
                                'LOS3_verification','LOS4_relationship_intel',
                                'LOS5_governance','LOS6_customer_delivery','LOS7_scale'
                            )),
    metric_name                TEXT NOT NULL,
    metric_value                NUMERIC,
    metric_unit                 TEXT,
    measured_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes                         TEXT
);

CREATE INDEX idx_los_scope ON los_status(scope_type, scope_id);
CREATE INDEX idx_los_stage ON los_status(los_stage);

-- ---------------------------------------------------------------------
-- 9. bug_reports  (QA workflow)
-- ---------------------------------------------------------------------
CREATE TABLE bug_reports (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bug_id                   TEXT NOT NULL UNIQUE,
    reported_by               TEXT,
    date_reported              TIMESTAMPTZ NOT NULL DEFAULT now(),
    map_layer                  TEXT,
    feature_id                  TEXT,
    issue_type                   TEXT,
    screenshot_link               TEXT,
    severity                      TEXT NOT NULL CHECK (severity IN (
                                'low','medium','high','critical'
                            )),
    fix_owner                      TEXT,
    status                          TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
                                'open','in_progress','fixed','verified'
                            )),
    date_fixed                       TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- View: directory_completeness — quick LOS-1 health check
-- ---------------------------------------------------------------------
CREATE VIEW v_directory_completeness AS
SELECT
    a.id AS agency_id,
    a.name,
    a.agency_type,
    (a.public_records_url IS NOT NULL OR a.public_records_email IS NOT NULL) AS has_records_contact,
    (a.latitude IS NOT NULL AND a.longitude IS NOT NULL) AS has_geocode,
    (a.source_url IS NOT NULL) AS has_source,
    a.verified_status
FROM agencies a;

-- ---------------------------------------------------------------------
-- Privacy guardrail comment (enforced at application layer, not just DB)
-- ---------------------------------------------------------------------
COMMENT ON TABLE agencies IS
'Public office / agency directory entries only. Do NOT store private
 individual names, customer account numbers, SSNs, bank data, private
 addresses, or personal complaints in this table.';

COMMENT ON TABLE evidence_packets IS
'Stores pointers to received public records. access_level and
 privacy_review_status must both be set before a packet can be
 referenced from any public-facing map_features.popup_template_key.';
