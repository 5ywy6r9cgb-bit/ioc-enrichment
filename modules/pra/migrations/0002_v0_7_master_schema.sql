-- =====================================================================
-- Sentinel Public Records Atlas — v0.7 MASTER RESEARCH SCHEMA
-- Migration: 0002_v0_7_master_schema
-- Requires:  0001_v0_6_1_metadata_schema applied first.
--
-- PRINCIPLE (unchanged from v0.6.1):
--   The database may make the system remember better.
--   It may not make it collect more.
--
-- The core record tables remain METADATA-ONLY. Raw files stay in the
-- operator-managed Received_Records/ folder, outside the database.
--
-- v0.7 adds, on top of that unchanged foundation:
--   * jurisdictions            (rebuilt from the v0.5 reference schema)
--   * agencies                 (expanded with contact + filing-route fields)
--   * portals                  (WHERE and HOW to file — courts, NextRequest,
--                               GovQA, e-filing, docket search, in person)
--   * record_types             (what you can ask for)
--   * request_templates        (initial / follow-up / narrowing / appeal)
--   * requests                 (expanded: clock, cost, portal, thread)
--   * followups                (append-only log of every nudge sent)
--   * deadline_rules           (operator policy + statutory citations)
--   * investigations           (thread grouping, e.g. LOT Ratepayer Trail)
--   * entities / entity_links  (due-diligence: people, orgs, contracts)
--   * sources                  (citation ledger — named sources, primary docs)
--   * document_text_index      (OPT-IN ONLY, gated, see section 14)
--   * notes, tags, saved_searches
--
-- Everything below is additive. Nothing in 0001 is dropped or altered
-- in a way that changes existing behavior.
-- =====================================================================

BEGIN;

-- Guard: refuse to run if 0001 was never applied.
DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_version WHERE version = '0.6.1') THEN
        RAISE EXCEPTION
          'v0.6.1 base migration not applied. Run 0001_v0_6_1_metadata_schema.sql first.';
    END IF;
END
$guard$;

-- Shared updated_at trigger function (idempotent).
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------
-- 1. jurisdictions
-- ---------------------------------------------------------------------
CREATE TABLE jurisdictions (
    jurisdiction_id     text PRIMARY KEY,          -- slug, e.g. 'oh-franklin-columbus'
    name                text NOT NULL,
    jurisdiction_type   text NOT NULL CHECK (jurisdiction_type IN (
                            'federal','state','county','city','village','township',
                            'school_district','court_district','appellate_district',
                            'utility_service_area','special_district','other')),
    parent_id           text REFERENCES jurisdictions(jurisdiction_id) ON DELETE SET NULL,
    state               text NOT NULL DEFAULT 'OH',
    county              text,
    centroid_lat        numeric(9,6),
    centroid_lng        numeric(9,6),
    boundary_geojson_url text,
    source_url          text,
    verified_status     text NOT NULL DEFAULT 'unverified'
                            CHECK (verified_status IN ('unverified','verified','needs_review')),
    last_verified_at    timestamptz,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_jurisdictions_type   ON jurisdictions(jurisdiction_type);
CREATE INDEX idx_jurisdictions_parent ON jurisdictions(parent_id);
CREATE TRIGGER jurisdictions_touch BEFORE UPDATE ON jurisdictions
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ---------------------------------------------------------------------
-- 2. agencies — expand the v0.6.1 seed table into a working directory.
--    (ALTER, not CREATE: the v0.6.1 table and its FKs stay intact.)
-- ---------------------------------------------------------------------
ALTER TABLE agencies
    ADD COLUMN IF NOT EXISTS jurisdiction_id      text REFERENCES jurisdictions(jurisdiction_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS address              text,
    ADD COLUMN IF NOT EXISTS city                 text,
    ADD COLUMN IF NOT EXISTS zip                  text,
    ADD COLUMN IF NOT EXISTS latitude             numeric(9,6),
    ADD COLUMN IF NOT EXISTS longitude            numeric(9,6),
    ADD COLUMN IF NOT EXISTS phone                text,
    ADD COLUMN IF NOT EXISTS website_url          text,
    ADD COLUMN IF NOT EXISTS public_records_url   text,
    ADD COLUMN IF NOT EXISTS public_records_email text,
    ADD COLUMN IF NOT EXISTS records_portal_type  text,
    ADD COLUMN IF NOT EXISTS records_custodian    text,   -- office/title only, never a private individual
    ADD COLUMN IF NOT EXISTS system_role          text,
    ADD COLUMN IF NOT EXISTS source_url           text,
    ADD COLUMN IF NOT EXISTS verified_status      text NOT NULL DEFAULT 'unverified',
    ADD COLUMN IF NOT EXISTS last_verified_at     timestamptz,
    ADD COLUMN IF NOT EXISTS response_notes       text,   -- observed behavior: slow, fee-happy, helpful
    ADD COLUMN IF NOT EXISTS avg_response_days    integer,
    ADD COLUMN IF NOT EXISTS notes                text,
    ADD COLUMN IF NOT EXISTS created_at           timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at           timestamptz NOT NULL DEFAULT now();

ALTER TABLE agencies DROP CONSTRAINT IF EXISTS agencies_verified_status_chk;
ALTER TABLE agencies ADD CONSTRAINT agencies_verified_status_chk
    CHECK (verified_status IN ('unverified','verified','needs_review'));

CREATE INDEX IF NOT EXISTS idx_agencies_jurisdiction ON agencies(jurisdiction_id);
CREATE INDEX IF NOT EXISTS idx_agencies_type         ON agencies(agency_type);

DROP TRIGGER IF EXISTS agencies_touch ON agencies;
CREATE TRIGGER agencies_touch BEFORE UPDATE ON agencies
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ---------------------------------------------------------------------
-- 3. portals — WHERE and HOW you file. The filing-route registry.
--    Covers records portals, court dockets, e-filing, and search systems.
-- ---------------------------------------------------------------------
CREATE TABLE portals (
    portal_id           text PRIMARY KEY,
    name                text NOT NULL,
    portal_kind         text NOT NULL CHECK (portal_kind IN (
                            'email','web_form','nextrequest','govqa','justfoia',
                            'efiling','docket_search','records_search','open_data',
                            'business_registry','campaign_finance','court_appeal',
                            'mail','in_person','phone','fax','other')),
    url                 text,
    jurisdiction_id     text REFERENCES jurisdictions(jurisdiction_id) ON DELETE SET NULL,
    covers              text,                       -- plain language: what lives here
    login_required      boolean NOT NULL DEFAULT false,
    account_notes       text,                       -- how to register; NEVER store credentials
    accepts_anonymous   boolean,                    -- Ohio: ID/purpose generally cannot be required
    fee_schedule_url    text,
    typical_fees        text,
    submission_notes    text,                       -- quirks, character limits, attachment rules
    statute_ref         text,
    source_url          text,
    verified_status     text NOT NULL DEFAULT 'unverified'
                            CHECK (verified_status IN ('unverified','verified','needs_review')),
    last_verified_at    timestamptz,
    last_checked_at     timestamptz,
    status              text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','changed','dead','unknown')),
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- Hard rule: no credentials in this database, ever.
    CONSTRAINT portals_no_credentials CHECK (
        account_notes IS NULL OR account_notes !~* '(password|passwd|api[_ -]?key|secret|bearer)'
    )
);
CREATE INDEX idx_portals_kind         ON portals(portal_kind);
CREATE INDEX idx_portals_jurisdiction ON portals(jurisdiction_id);
CREATE TRIGGER portals_touch BEFORE UPDATE ON portals
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Which portals serve which agency (an agency can have several routes).
CREATE TABLE agency_portals (
    agency_id   text NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
    portal_id   text NOT NULL REFERENCES portals(portal_id) ON DELETE CASCADE,
    route_role  text NOT NULL DEFAULT 'records_request'
                    CHECK (route_role IN ('records_request','docket_lookup','efiling',
                                          'data_download','appeal','escalation','other')),
    is_primary  boolean NOT NULL DEFAULT false,
    notes       text,
    PRIMARY KEY (agency_id, portal_id, route_role)
);


-- ---------------------------------------------------------------------
-- 4. record_types — the catalog of what you can ask for.
-- ---------------------------------------------------------------------
CREATE TABLE record_types (
    record_type_id      text PRIMARY KEY,
    name                text NOT NULL,
    description         text,
    privacy_risk_level  text NOT NULL DEFAULT 'low'
                            CHECK (privacy_risk_level IN ('low','medium','high')),
    default_date_range  text,
    template_language   text,       -- the scope sentence dropped into a letter
    common_exemptions   text,       -- what they usually cite to withhold this
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------
-- 5. investigations — the thread a request belongs to.
--    Separate threads sharing an entity stay explicitly distinct.
-- ---------------------------------------------------------------------
CREATE TABLE investigations (
    investigation_id    text PRIMARY KEY,
    title               text NOT NULL,
    summary             text,
    status              text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','held','published','closed')),
    glassmark           text CHECK (glassmark IS NULL OR
                            glassmark IN ('GREEN_LIGHT','RED_APPLE','DEAD_END','UNCLASSIFIED')),
    opened_at           timestamptz NOT NULL DEFAULT now(),
    closed_at           timestamptz,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER investigations_touch BEFORE UPDATE ON investigations
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ---------------------------------------------------------------------
-- 6. request_templates — reusable letter bodies with {{placeholders}}.
-- ---------------------------------------------------------------------
CREATE TABLE request_templates (
    template_id     text PRIMARY KEY,
    name            text NOT NULL,
    kind            text NOT NULL CHECK (kind IN (
                        'initial','followup','narrowing','fee_waiver',
                        'fee_dispute','denial_response','appeal','withdrawal','thank_you')),
    jurisdiction_scope text NOT NULL DEFAULT 'OH',
    statute_citation   text,
    subject_line       text,
    body               text NOT NULL,
    guidance           text,        -- when to use it, what to watch for
    source_url         text,
    verified_status    text NOT NULL DEFAULT 'unverified'
                        CHECK (verified_status IN ('unverified','verified','needs_review')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER request_templates_touch BEFORE UPDATE ON request_templates
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ---------------------------------------------------------------------
-- 7. requests — expand the v0.6.1 tracker with the clock and the route.
-- ---------------------------------------------------------------------
ALTER TABLE requests
    ADD COLUMN IF NOT EXISTS investigation_id  text REFERENCES investigations(investigation_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS portal_id         text REFERENCES portals(portal_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS record_type_id    text REFERENCES record_types(record_type_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS template_id       text REFERENCES request_templates(template_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS submitted_at      timestamptz,
    ADD COLUMN IF NOT EXISTS submission_method text,
    ADD COLUMN IF NOT EXISTS confirmation_ref  text,   -- their tracking number
    ADD COLUMN IF NOT EXISTS acknowledged_at   timestamptz,
    ADD COLUMN IF NOT EXISTS first_response_at timestamptz,
    ADD COLUMN IF NOT EXISTS fulfilled_at      timestamptz,
    ADD COLUMN IF NOT EXISTS closed_at         timestamptz,
    ADD COLUMN IF NOT EXISTS next_action_at    timestamptz,
    ADD COLUMN IF NOT EXISTS followup_count    integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS priority          text NOT NULL DEFAULT 'normal',
    ADD COLUMN IF NOT EXISTS date_range_start  date,
    ADD COLUMN IF NOT EXISTS date_range_end    date,
    ADD COLUMN IF NOT EXISTS estimated_fee     numeric(10,2),
    ADD COLUMN IF NOT EXISTS fee_quoted        numeric(10,2),
    ADD COLUMN IF NOT EXISTS fee_paid          numeric(10,2),
    ADD COLUMN IF NOT EXISTS denial_reason     text,
    ADD COLUMN IF NOT EXISTS exemption_cited   text,
    ADD COLUMN IF NOT EXISTS appeal_filed_at   timestamptz,
    ADD COLUMN IF NOT EXISTS appeal_case_no    text,
    ADD COLUMN IF NOT EXISTS sent_text         text,   -- exact text of what you sent
    ADD COLUMN IF NOT EXISTS notes             text;

ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_priority_chk;
ALTER TABLE requests ADD CONSTRAINT requests_priority_chk
    CHECK (priority IN ('low','normal','high','urgent'));

CREATE INDEX IF NOT EXISTS idx_requests_status        ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_agency        ON requests(agency_id);
CREATE INDEX IF NOT EXISTS idx_requests_investigation ON requests(investigation_id);
CREATE INDEX IF NOT EXISTS idx_requests_next_action   ON requests(next_action_at);

DROP TRIGGER IF EXISTS requests_touch ON requests;
CREATE TRIGGER requests_touch BEFORE UPDATE ON requests
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ---------------------------------------------------------------------
-- 8. followups — append-only record of every nudge, call, and reply.
-- ---------------------------------------------------------------------
CREATE TABLE followups (
    followup_id     bigserial PRIMARY KEY,
    request_id      text NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    direction       text NOT NULL CHECK (direction IN ('sent','received')),
    channel         text NOT NULL CHECK (channel IN ('email','portal','phone','mail','in_person','other')),
    template_id     text REFERENCES request_templates(template_id) ON DELETE SET NULL,
    summary         text,
    full_text       text,       -- your own correspondence, not agency file content
    actor           text NOT NULL DEFAULT 'local_operator',
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_followups_request ON followups(request_id, occurred_at);

CREATE TRIGGER followups_append_only
    BEFORE UPDATE OR DELETE ON followups
    FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();


-- ---------------------------------------------------------------------
-- 9. deadline_rules — the clock.
--
--    IMPORTANT AND DELIBERATE: Ohio R.C. 149.43 sets NO fixed day count.
--    Inspection is "promptly"; copies are "within a reasonable period of
--    time." Any day number in this table for Ohio is OPERATOR POLICY —
--    a self-imposed follow-up cadence — NOT a statutory deadline.
--    rule_basis makes that distinction explicit and unmissable.
-- ---------------------------------------------------------------------
CREATE TABLE deadline_rules (
    rule_id             text PRIMARY KEY,
    label               text NOT NULL,
    jurisdiction_scope  text NOT NULL DEFAULT 'OH',
    rule_basis          text NOT NULL CHECK (rule_basis IN ('statutory','operator_policy','court_rule')),
    statute_citation    text,
    days                integer,
    day_basis           text NOT NULL DEFAULT 'calendar'
                            CHECK (day_basis IN ('calendar','business')),
    applies_to_status   text,        -- which request status starts this clock
    action_on_breach    text,        -- 'followup' | 'escalate' | 'appeal' | 'review'
    template_id         text REFERENCES request_templates(template_id) ON DELETE SET NULL,
    source_url          text,
    verified_status     text NOT NULL DEFAULT 'unverified'
                            CHECK (verified_status IN ('unverified','verified','needs_review')),
    notes               text,
    active              boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------
-- 10. sources — the citation ledger.
--     Named sources. Public documents. Verified facts.
--     Every claim in a published piece should point at a row here.
-- ---------------------------------------------------------------------
CREATE TABLE sources (
    source_id       text PRIMARY KEY,
    title           text NOT NULL,
    source_type     text NOT NULL CHECK (source_type IN (
                        'primary_document','ordinance','court_filing','contract',
                        'loan_application','audit_report','meeting_minutes','dataset',
                        'news_article','press_release','named_interview','other')),
    is_primary      boolean NOT NULL DEFAULT false,
    publisher       text,
    author          text,
    published_at    date,
    url             text,
    archive_url     text,
    retrieved_at    timestamptz,
    local_path      text,           -- RELATIVE path into Received_Records/ only
    sha256          text,
    citation_text   text,
    glassmark       text CHECK (glassmark IS NULL OR
                        glassmark IN ('GREEN_LIGHT','RED_APPLE','DEAD_END','UNCLASSIFIED')),
    verified_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verified_status IN ('unverified','verified','needs_review')),
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sources_relative_path_only CHECK (
        local_path IS NULL OR local_path !~ '^([A-Za-z]:[\\/]|/|\\\\)'
    )
);
CREATE INDEX idx_sources_type ON sources(source_type);
CREATE TRIGGER sources_touch BEFORE UPDATE ON sources
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE source_links (
    source_id       text NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
    entity_type     text NOT NULL CHECK (entity_type IN
                        ('request','received_record','investigation','entity','claim')),
    entity_id       text NOT NULL,
    relation        text,
    PRIMARY KEY (source_id, entity_type, entity_id)
);


-- ---------------------------------------------------------------------
-- 11. entities — due diligence subjects.
--     PRIVACY RULE, ENFORCED: no residential-address-level identification
--     of private individuals. entity_kind 'private_individual' may not
--     carry a street address.
-- ---------------------------------------------------------------------
CREATE TABLE entities (
    entity_id       text PRIMARY KEY,
    entity_kind     text NOT NULL CHECK (entity_kind IN (
                        'business','nonprofit','government_body','public_official',
                        'private_individual','property','contract','project','other')),
    name            text NOT NULL,
    legal_name      text,
    registry_id     text,       -- SOS charter number, EIN-of-record, parcel ID
    registry_source text,
    jurisdiction_id text REFERENCES jurisdictions(jurisdiction_id) ON DELETE SET NULL,
    role_summary    text,
    street_address  text,
    city            text,
    state           text,
    status          text,
    first_seen_at   date,
    last_seen_at    date,
    risk_flags      text,
    verified_status text NOT NULL DEFAULT 'unverified'
                        CHECK (verified_status IN ('unverified','verified','needs_review')),
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT entities_no_private_home_address CHECK (
        entity_kind <> 'private_individual' OR street_address IS NULL
    )
);
CREATE INDEX idx_entities_kind ON entities(entity_kind);
CREATE INDEX idx_entities_name ON entities(lower(name));
CREATE TRIGGER entities_touch BEFORE UPDATE ON entities
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE entity_aliases (
    alias_id    bigserial PRIMARY KEY,
    entity_id   text NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    alias       text NOT NULL,
    alias_type  text,
    source_id   text REFERENCES sources(source_id) ON DELETE SET NULL
);

CREATE TABLE entity_links (
    link_id         bigserial PRIMARY KEY,
    from_entity_id  text NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    to_entity_id    text NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    relation        text NOT NULL,   -- 'contracts_with','officer_of','owns','subsidiary_of','donated_to'
    started_on      date,
    ended_on        date,
    amount          numeric(14,2),
    source_id       text REFERENCES sources(source_id) ON DELETE SET NULL,
    confidence      text NOT NULL DEFAULT 'unverified'
                        CHECK (confidence IN ('unverified','documented','confirmed','disputed')),
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT entity_links_no_self CHECK (from_entity_id <> to_entity_id)
);
CREATE INDEX idx_entity_links_from ON entity_links(from_entity_id);
CREATE INDEX idx_entity_links_to   ON entity_links(to_entity_id);

CREATE TABLE request_entities (
    request_id  text NOT NULL REFERENCES requests(request_id) ON DELETE CASCADE,
    entity_id   text NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    relation    text,
    PRIMARY KEY (request_id, entity_id)
);


-- ---------------------------------------------------------------------
-- 12. notes, tags
-- ---------------------------------------------------------------------
CREATE TABLE notes (
    note_id     bigserial PRIMARY KEY,
    entity_type text NOT NULL,
    entity_id   text NOT NULL,
    body        text NOT NULL,
    actor       text NOT NULL DEFAULT 'local_operator',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notes_target ON notes(entity_type, entity_id);

CREATE TABLE tags (
    tag         text PRIMARY KEY,
    color       text,
    description text
);

CREATE TABLE taggings (
    tag         text NOT NULL REFERENCES tags(tag) ON DELETE CASCADE,
    entity_type text NOT NULL,
    entity_id   text NOT NULL,
    PRIMARY KEY (tag, entity_type, entity_id)
);

CREATE TABLE saved_searches (
    search_id   text PRIMARY KEY,
    name        text NOT NULL,
    query_sql   text,
    query_desc  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------
-- 13. received_records — a few operational columns.
--     Still METADATA ONLY. No content column is added here.
-- ---------------------------------------------------------------------
ALTER TABLE received_records
    ADD COLUMN IF NOT EXISTS source_id      text REFERENCES sources(source_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS received_on    date,
    ADD COLUMN IF NOT EXISTS page_count     integer,
    ADD COLUMN IF NOT EXISTS sha256         text,   -- integrity of the external file
    ADD COLUMN IF NOT EXISTS operator_notes text;

DROP TRIGGER IF EXISTS received_records_touch ON received_records;
CREATE TRIGGER received_records_touch BEFORE UPDATE ON received_records
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ---------------------------------------------------------------------
-- 14. document_text_index — OPT-IN, GATED, NEVER AUTOMATIC.
--
--     This is the ONLY table in the system that may hold document text,
--     and it is deliberately hard to write to:
--       * operator_consent must be literally true
--       * the linked received_record must already be human-reviewed and
--         marked approved_internal or approved_public
--       * a trigger re-checks that on every insert and update
--     Nothing writes here as a side effect of upload, import, or export.
-- ---------------------------------------------------------------------
CREATE TABLE document_text_index (
    text_id             bigserial PRIMARY KEY,
    received_record_id  text NOT NULL UNIQUE
                            REFERENCES received_records(id) ON DELETE CASCADE,
    operator_consent    boolean NOT NULL DEFAULT false
                            CHECK (operator_consent = true),
    consent_at          timestamptz NOT NULL DEFAULT now(),
    consent_actor       text NOT NULL DEFAULT 'local_operator',
    extraction_method   text NOT NULL CHECK (extraction_method IN ('manual_paste','pdf_text','ocr')),
    redaction_confirmed boolean NOT NULL DEFAULT false
                            CHECK (redaction_confirmed = true),
    body                text NOT NULL,
    body_tsv            tsvector,
    indexed_at          timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION gate_document_text_index() RETURNS trigger AS $$
DECLARE
    rec_status text;
BEGIN
    SELECT review_status INTO rec_status
      FROM received_records WHERE id = NEW.received_record_id;

    IF rec_status IS NULL THEN
        RAISE EXCEPTION 'document_text_index: no such received_record %', NEW.received_record_id;
    END IF;

    IF rec_status NOT IN ('approved_internal','approved_public') THEN
        RAISE EXCEPTION
          'document_text_index: record % is "%" — it must be human-reviewed and approved before any text is indexed',
          NEW.received_record_id, rec_status;
    END IF;

    NEW.body_tsv := to_tsvector('english', coalesce(NEW.body, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_text_index_gate
    BEFORE INSERT OR UPDATE ON document_text_index
    FOR EACH ROW EXECUTE FUNCTION gate_document_text_index();

CREATE INDEX idx_document_text_fts ON document_text_index USING GIN (body_tsv);


-- ---------------------------------------------------------------------
-- 15. Working views — what you actually look at every morning.
-- ---------------------------------------------------------------------

-- Age and clock state of every open request.
CREATE OR REPLACE VIEW v_request_clock AS
SELECT
    r.request_id,
    r.subject,
    r.status,
    a.name                            AS agency_name,
    p.name                            AS portal_name,
    p.url                             AS portal_url,
    i.title                           AS investigation,
    r.submitted_at,
    r.acknowledged_at,
    r.first_response_at,
    CASE WHEN r.submitted_at IS NULL THEN NULL
         ELSE (CURRENT_DATE - r.submitted_at::date) END          AS days_since_submitted,
    CASE WHEN r.first_response_at IS NULL AND r.submitted_at IS NOT NULL
         THEN (CURRENT_DATE - r.submitted_at::date) END          AS days_without_response,
    r.followup_count,
    r.next_action_at,
    r.priority,
    r.fee_quoted,
    r.confirmation_ref
FROM requests r
LEFT JOIN agencies a       ON a.agency_id = r.agency_id
LEFT JOIN portals  p       ON p.portal_id = r.portal_id
LEFT JOIN investigations i ON i.investigation_id = r.investigation_id
WHERE r.status NOT IN ('closed','published');

-- Anything that has gone quiet past the operator's own threshold.
CREATE OR REPLACE VIEW v_needs_attention AS
SELECT c.*,
       CASE
         WHEN c.next_action_at IS NOT NULL AND c.next_action_at <= now() THEN 'action_due'
         WHEN c.days_without_response >= 30 THEN 'stale_30d'
         WHEN c.days_without_response >= 14 THEN 'stale_14d'
         WHEN c.days_without_response >= 7  THEN 'nudge_7d'
         ELSE 'ok'
       END AS attention_reason
FROM v_request_clock c
WHERE (c.next_action_at IS NOT NULL AND c.next_action_at <= now())
   OR c.days_without_response >= 7;

-- The filing route for every agency: where to send it, one row per route.
CREATE OR REPLACE VIEW v_filing_routes AS
SELECT
    a.agency_id, a.name AS agency, a.agency_type, a.jurisdiction,
    a.public_records_email, a.public_records_url,
    p.portal_id, p.name AS portal, p.portal_kind, p.url AS portal_url,
    ap.route_role, ap.is_primary,
    p.login_required, p.typical_fees, p.submission_notes,
    p.verified_status AS portal_verified, p.last_checked_at
FROM agencies a
LEFT JOIN agency_portals ap ON ap.agency_id = a.agency_id
LEFT JOIN portals p         ON p.portal_id  = ap.portal_id;

-- Everything that is still riding on an unverified source.
CREATE OR REPLACE VIEW v_unverified_sources AS
SELECT s.source_id, s.title, s.source_type, s.is_primary,
       s.verified_status, s.url, s.retrieved_at, s.glassmark
FROM sources s
WHERE s.verified_status <> 'verified'
ORDER BY s.is_primary DESC, s.created_at;


-- ---------------------------------------------------------------------
-- 16. Record the migration.
-- ---------------------------------------------------------------------
INSERT INTO schema_version (version, migration_id, description)
VALUES ('0.7.0', '0002_v0_7_master_schema',
        'Master research schema: jurisdictions, portals, templates, clock, entities, sources, gated text index');

COMMIT;
