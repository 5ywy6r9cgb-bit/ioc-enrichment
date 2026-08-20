-- =====================================================================
-- Sentinel PRA — migration 0004: lobbying disclosure
--
-- THE PROBLEM THIS SCHEMA IS SHAPED AROUND
--
-- Ohio's OLAC agent search shows ONLY CURRENT engagements. Terminated
-- engagements simply vanish from the search results. That means the tool
-- that looks like a history is actually a snapshot, and a 2019–2025
-- timeline cannot be read out of it directly.
--
-- Two consequences, both encoded below:
--
--   1. ENGAGEMENTS ARE OBSERVED, NOT DECLARED. lobbying_engagements records
--      first_seen_on / last_seen_on / still_present. Crawl nightly and the
--      history builds itself: the night an engagement stops appearing is the
--      night you learn it ended. The search tool will never tell you that;
--      your own observation log will.
--
--   2. THE FILINGS ARE THE ARCHIVE. Activity & expenditure reports (AERs)
--      are the durable record. lobbying_filings holds them, and the raw HTML
--      hash ties each back to the captured bytes in evidence/.
--
-- AMENDMENTS ARE THE POINT. An amended filing that adds travel, gifts, or
-- expenditure after the original is the single highest-value signal in this
-- data — it is a late disclosure, visible only by comparing versions. The
-- amends_filing_id self-reference plus the amendment_diff column exist for
-- exactly that comparison.
--
-- PRIVACY BOUNDARY, UNCHANGED: a lobbyist is a PUBLIC ROLE. Names of agents
-- and officers are recorded as such. No home address, no personal contact
-- detail, ever — the same rule entities_no_private_home_address enforces.
-- =====================================================================

BEGIN;

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_version WHERE version = '0.7.1') THEN
        RAISE EXCEPTION 'migration 0003 (connector_runs) not applied. Run it first.';
    END IF;
END
$guard$;

-- ---------------------------------------------------------------------
-- 1. lobbying_filings — the durable archive
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lobbying_filings (
    filing_id           text PRIMARY KEY,            -- e.g. OLAC AER number '1270720'
    registry            text NOT NULL DEFAULT 'oh_olac'
                            CHECK (registry IN ('oh_olac','us_senate_lda','other')),
    filing_type         text,                        -- AER, registration, termination
    filing_period       text,                        -- '2023 May-Aug'
    filing_date         date,
    confirmation_number text,

    employer_entity_id  text REFERENCES entities(entity_id) ON DELETE SET NULL,
    employer_name_raw   text NOT NULL,               -- exactly as filed, never normalized away
    agent_entity_id     text REFERENCES entities(entity_id) ON DELETE SET NULL,
    agent_name_raw      text,
    firm_entity_id      text REFERENCES entities(entity_id) ON DELETE SET NULL,

    -- Amendment chain. A filing that amends another points at it.
    amends_filing_id    text REFERENCES lobbying_filings(filing_id) ON DELETE SET NULL,
    is_amendment        boolean NOT NULL DEFAULT false,
    amendment_seq       integer,

    -- What the filing discloses. NULL means "not stated"; false means
    -- "stated as none" — a distinction that matters when comparing versions.
    reports_expenditure boolean,
    reports_travel      boolean,
    reports_gifts       boolean,
    expenditure_total   numeric(14,2),

    -- Custody of the captured page. RELATIVE path only.
    raw_html_path       text,
    raw_html_sha256     text,
    screenshot_path     text,
    source_url          text,
    source_id           text REFERENCES sources(source_id) ON DELETE SET NULL,
    connector_run_id    uuid REFERENCES connector_runs(run_id) ON DELETE SET NULL,

    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    verified_status     text NOT NULL DEFAULT 'unverified'
                            CHECK (verified_status IN ('unverified','verified','needs_review')),
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lobbying_filings_relative_paths CHECK (
        (raw_html_path IS NULL  OR raw_html_path  !~ '^([A-Za-z]:[\\/]|/|\\\\)') AND
        (screenshot_path IS NULL OR screenshot_path !~ '^([A-Za-z]:[\\/]|/|\\\\)')
    ),
    CONSTRAINT lobbying_filings_amendment_self CHECK (amends_filing_id IS NULL OR amends_filing_id <> filing_id)
);
CREATE INDEX IF NOT EXISTS idx_lobbying_filings_employer ON lobbying_filings(lower(employer_name_raw));
CREATE INDEX IF NOT EXISTS idx_lobbying_filings_agent    ON lobbying_filings(lower(agent_name_raw));
CREATE INDEX IF NOT EXISTS idx_lobbying_filings_date     ON lobbying_filings(filing_date);
CREATE INDEX IF NOT EXISTS idx_lobbying_filings_amends   ON lobbying_filings(amends_filing_id);

DROP TRIGGER IF EXISTS lobbying_filings_touch ON lobbying_filings;
CREATE TRIGGER lobbying_filings_touch BEFORE UPDATE ON lobbying_filings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- 2. lobbying_engagements — agent ↔ employer, OBSERVED over time
--
--    This is the table that defeats the "current engagements only" limit.
--    Every crawl stamps last_seen_on. An engagement that stops appearing
--    keeps its last_seen_on and flips still_present to false, which is the
--    only way to learn a relationship ended.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lobbying_engagements (
    engagement_id     bigserial PRIMARY KEY,
    registry          text NOT NULL DEFAULT 'oh_olac',
    agent_name_raw    text NOT NULL,
    agent_registry_id text,                       -- OLAC agent id, e.g. '1182'
    agent_entity_id   text REFERENCES entities(entity_id) ON DELETE SET NULL,
    employer_name_raw text NOT NULL,
    employer_entity_id text REFERENCES entities(entity_id) ON DELETE SET NULL,

    -- OLAC flags which branch each registration covers.
    branch_legislative boolean,
    branch_executive   boolean,
    branch_retirement  boolean,

    -- The observation window. NOT a claim about the contract's real dates —
    -- only about when this system saw the engagement listed.
    first_seen_on     date NOT NULL DEFAULT CURRENT_DATE,
    last_seen_on      date NOT NULL DEFAULT CURRENT_DATE,
    still_present     boolean NOT NULL DEFAULT true,
    observation_count integer NOT NULL DEFAULT 1,

    source_id         text REFERENCES sources(source_id) ON DELETE SET NULL,
    connector_run_id  uuid REFERENCES connector_runs(run_id) ON DELETE SET NULL,
    notes             text,
    UNIQUE (registry, agent_name_raw, employer_name_raw)
);
CREATE INDEX IF NOT EXISTS idx_lobbying_eng_agent    ON lobbying_engagements(lower(agent_name_raw));
CREATE INDEX IF NOT EXISTS idx_lobbying_eng_employer ON lobbying_engagements(lower(employer_name_raw));
CREATE INDEX IF NOT EXISTS idx_lobbying_eng_present  ON lobbying_engagements(still_present);

-- ---------------------------------------------------------------------
-- 3. lobbying_bills — what was lobbied on
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lobbying_bills (
    bill_ref_id     bigserial PRIMARY KEY,
    filing_id       text REFERENCES lobbying_filings(filing_id) ON DELETE CASCADE,
    bill_number     text,                      -- 'HB6', 'SB52'
    bill_title      text,
    issue_text      text,                      -- free-text subject where no bill number
    position        text,                      -- support/oppose/monitor, where stated
    employer_name_raw text,
    agent_name_raw  text,
    notes           text,
    UNIQUE (filing_id, bill_number, issue_text)
);
CREATE INDEX IF NOT EXISTS idx_lobbying_bills_number ON lobbying_bills(upper(bill_number));

-- ---------------------------------------------------------------------
-- 4. lobbying_amendments — the late-disclosure signal
--
--    One row per detected difference between an original filing and the
--    amendment that supersedes it. Written by the diff step, never by hand.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lobbying_amendments (
    amendment_id    bigserial PRIMARY KEY,
    original_filing_id  text NOT NULL REFERENCES lobbying_filings(filing_id) ON DELETE CASCADE,
    amended_filing_id   text NOT NULL REFERENCES lobbying_filings(filing_id) ON DELETE CASCADE,
    detected_at     timestamptz NOT NULL DEFAULT now(),
    days_after_original integer,

    added_expenditure boolean NOT NULL DEFAULT false,
    added_travel      boolean NOT NULL DEFAULT false,
    added_gifts       boolean NOT NULL DEFAULT false,
    added_bills       text[],
    removed_bills     text[],
    amount_delta      numeric(14,2),

    -- The flag is a QUESTION, not a finding. "Late disclosure detected" means
    -- material appeared in an amendment that was absent from the original —
    -- which has innocent explanations (correcting an error, a late invoice)
    -- as often as not. It is a prompt to go read both filings.
    -- 'insufficient_data' is not a fourth kind of finding, it is the absence
    -- of one: a field missing from a capture is UNKNOWN, and calling that
    -- 'no_material_change' would assert something the data cannot support.
    flag              text CHECK (flag IN ('late_disclosure_candidate','correction_candidate','no_material_change','insufficient_data')),
    diff_json         jsonb,
    reviewed          boolean NOT NULL DEFAULT false,
    reviewer_note     text,
    CONSTRAINT lobbying_amendments_distinct CHECK (original_filing_id <> amended_filing_id),
    UNIQUE (original_filing_id, amended_filing_id)
);
CREATE INDEX IF NOT EXISTS idx_lobbying_amendments_flag ON lobbying_amendments(flag) WHERE NOT reviewed;

-- ---------------------------------------------------------------------
-- 5. Working views
-- ---------------------------------------------------------------------

-- Engagements that USED to be listed and are not any more. This is the
-- history OLAC's own search cannot give you.
CREATE OR REPLACE VIEW v_lobbying_ended_engagements AS
SELECT agent_name_raw, agent_registry_id, employer_name_raw,
       first_seen_on, last_seen_on, observation_count,
       (last_seen_on - first_seen_on) AS days_observed
FROM lobbying_engagements
WHERE NOT still_present
ORDER BY last_seen_on DESC;

-- Two employers reached through the same agent. A genuine node — but only
-- a node: a shared agent is a lead, not a relationship between the clients.
CREATE OR REPLACE VIEW v_lobbying_shared_agents AS
SELECT a.agent_name_raw,
       a.employer_name_raw AS employer_a,
       b.employer_name_raw AS employer_b,
       a.still_present     AS a_current,
       b.still_present     AS b_current
FROM lobbying_engagements a
JOIN lobbying_engagements b
  ON a.agent_name_raw = b.agent_name_raw
 AND a.employer_name_raw < b.employer_name_raw;

-- Amendments still waiting on a human read.
CREATE OR REPLACE VIEW v_lobbying_unreviewed_amendments AS
SELECT am.amendment_id, am.flag, am.days_after_original,
       f.employer_name_raw, f.agent_name_raw,
       am.original_filing_id, am.amended_filing_id,
       am.added_expenditure, am.added_travel, am.added_gifts, am.amount_delta
FROM lobbying_amendments am
JOIN lobbying_filings f ON f.filing_id = am.amended_filing_id
WHERE NOT am.reviewed
ORDER BY
  CASE am.flag WHEN 'late_disclosure_candidate' THEN 0 WHEN 'correction_candidate' THEN 1 ELSE 2 END,
  am.days_after_original DESC NULLS LAST;

INSERT INTO schema_version (version, migration_id, description)
VALUES ('0.7.2', '0004_lobbying',
        'Lobbying disclosure: filings archive, observed engagements (defeats current-only search), bills, amendment detection')
ON CONFLICT (version) DO NOTHING;

COMMIT;
