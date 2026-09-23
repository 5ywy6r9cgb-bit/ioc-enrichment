BEGIN;

-- Migration 0009 requires the completed 0008 evidence-relationship layer.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM schema_version
        WHERE version = '0.8.0'
          AND migration_id = '0008_evidence_relationships'
    ) THEN
        RAISE EXCEPTION
            'migration 0008 (evidence_relationships) not applied. Run it first.';
    END IF;
END $$;

-- ============================================================
-- SENTINELOS 0009
-- EVIDENCE → CLAIMS → FINDINGS → FINANCIAL EVENTS
-- ============================================================

-- ============================================================
-- 1. CLAIMS
-- ============================================================

CREATE TABLE IF NOT EXISTS claims (
    claim_id            bigserial PRIMARY KEY,

    investigation_id    text
        REFERENCES investigations(investigation_id),

    statement           text NOT NULL,

    status              text NOT NULL DEFAULT 'lead'
        CHECK (
            status IN (
                'lead',
                'unverified',
                'under_review',
                'supported',
                'disputed',
                'rejected',
                'published'
            )
        ),

    assertion_type      text NOT NULL DEFAULT 'documented'
        CHECK (
            assertion_type IN (
                'documented',
                'derived',
                'hypothesis'
            )
        ),

    confidence          text NOT NULL DEFAULT 'unverified'
        CHECK (
            confidence IN (
                'unverified',
                'low',
                'medium',
                'high',
                'confirmed',
                'disputed'
            )
        ),

    limitation          text,
    reasoning           text,
    open_question       text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT claims_hypothesis_not_confirmed
        CHECK (
            NOT (
                assertion_type = 'hypothesis'
                AND confidence = 'confirmed'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_claims_investigation
    ON claims(investigation_id);

CREATE INDEX IF NOT EXISTS idx_claims_status
    ON claims(status);

CREATE INDEX IF NOT EXISTS idx_claims_assertion
    ON claims(assertion_type);

CREATE INDEX IF NOT EXISTS idx_claims_confidence
    ON claims(confidence);


-- ============================================================
-- 2. CLAIM EVIDENCE
-- ============================================================

CREATE TABLE IF NOT EXISTS claim_evidence (
    claim_evidence_id  bigserial PRIMARY KEY,

    claim_id           bigint NOT NULL
        REFERENCES claims(claim_id)
        ON DELETE CASCADE,

    source_id          text
        REFERENCES sources(source_id),

    received_record_id text
        REFERENCES received_records(id),

    role               text NOT NULL
        CHECK (
            role IN (
                'primary',
                'supporting',
                'contradicting',
                'context'
            )
        ),

    page_reference     text,
    quoted_excerpt     text,
    analyst_note       text,

    assertion_type     text NOT NULL DEFAULT 'documented'
        CHECK (
            assertion_type IN (
                'documented',
                'derived',
                'hypothesis'
            )
        ),

    confidence         text NOT NULL DEFAULT 'unverified'
        CHECK (
            confidence IN (
                'unverified',
                'low',
                'medium',
                'high',
                'confirmed',
                'disputed'
            )
        ),

    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT claim_evidence_has_source
        CHECK (
            source_id IS NOT NULL
            OR received_record_id IS NOT NULL
        ),

    CONSTRAINT claim_evidence_hypothesis_not_confirmed
        CHECK (
            NOT (
                assertion_type = 'hypothesis'
                AND confidence = 'confirmed'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim
    ON claim_evidence(claim_id);

CREATE INDEX IF NOT EXISTS idx_claim_evidence_source
    ON claim_evidence(source_id);

CREATE INDEX IF NOT EXISTS idx_claim_evidence_record
    ON claim_evidence(received_record_id);


-- ============================================================
-- 3. FINDINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS findings (
    finding_id         bigserial PRIMARY KEY,

    investigation_id   text NOT NULL
        REFERENCES investigations(investigation_id),

    finding_code       text NOT NULL,

    title              text NOT NULL,

    statement          text NOT NULL,

    status              text NOT NULL DEFAULT 'under_review'
        CHECK (
            status IN (
                'under_review',
                'supported',
                'disputed',
                'rejected',
                'published'
            )
        ),

    finding_confidence text NOT NULL DEFAULT 'low'
        CHECK (
            finding_confidence IN (
                'low',
                'medium',
                'high',
                'confirmed'
            )
        ),

    assessment         text,
    reasoning          text,
    limitations        text,
    open_question      text,

    review_decision    text NOT NULL DEFAULT 'pending'
        CHECK (
            review_decision IN (
                'pending',
                'approved',
                'returned',
                'rejected',
                'published'
            )
        ),

    reviewed_by        text,
    reviewed_at        timestamptz,

    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    UNIQUE (
        investigation_id,
        finding_code
    )
);

CREATE INDEX IF NOT EXISTS idx_findings_investigation
    ON findings(investigation_id);

CREATE INDEX IF NOT EXISTS idx_findings_status
    ON findings(status);

CREATE INDEX IF NOT EXISTS idx_findings_confidence
    ON findings(finding_confidence);

CREATE INDEX IF NOT EXISTS idx_findings_review_decision
    ON findings(review_decision);


-- ============================================================
-- 4. FINDING → CLAIM
-- ============================================================

CREATE TABLE IF NOT EXISTS finding_claims (
    finding_id         bigint NOT NULL
        REFERENCES findings(finding_id)
        ON DELETE CASCADE,

    claim_id           bigint NOT NULL
        REFERENCES claims(claim_id)
        ON DELETE RESTRICT,

    relationship       text NOT NULL DEFAULT 'supports'
        CHECK (
            relationship IN (
                'supports',
                'contradicts',
                'qualifies',
                'context'
            )
        ),

    analyst_note       text,

    created_at         timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (
        finding_id,
        claim_id
    )
);

CREATE INDEX IF NOT EXISTS idx_finding_claims_claim
    ON finding_claims(claim_id);


-- ============================================================
-- 5. FINDING BASIS
--
-- Human-readable factual basis for a finding.
-- ============================================================

CREATE TABLE IF NOT EXISTS finding_basis (
    finding_basis_id  bigserial PRIMARY KEY,

    finding_id        bigint NOT NULL
        REFERENCES findings(finding_id)
        ON DELETE CASCADE,

    key_fact          text NOT NULL,

    evidence_weight   text NOT NULL DEFAULT 'supporting'
        CHECK (
            evidence_weight IN (
                'critical',
                'strong',
                'supporting',
                'context',
                'contradicting'
            )
        ),

    basis_type        text NOT NULL DEFAULT 'fact'
        CHECK (
            basis_type IN (
                'fact',
                'derived',
                'contradiction',
                'context',
                'open_question'
            )
        ),

    analyst_note      text,

    source_id         text
        REFERENCES sources(source_id),

    claim_id          bigint
        REFERENCES claims(claim_id),

    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finding_basis_finding
    ON finding_basis(finding_id);

CREATE INDEX IF NOT EXISTS idx_finding_basis_source
    ON finding_basis(source_id);

CREATE INDEX IF NOT EXISTS idx_finding_basis_claim
    ON finding_basis(claim_id);


-- ============================================================
-- 6. FINANCIAL EVENTS
--
-- Cross-system analytical money-flow layer.
--
-- Original FEC/FARA/LDA/SEC/etc. tables remain authoritative.
-- This table does NOT replace them.
-- ============================================================

CREATE TABLE IF NOT EXISTS financial_events (
    financial_event_id   bigserial PRIMARY KEY,

    investigation_id     text
        REFERENCES investigations(investigation_id),

    event_type           text NOT NULL
        CHECK (
            event_type IN (
                'payment',
                'contribution',
                'expenditure',
                'loan',
                'grant',
                'refund',
                'transfer',
                'fee',
                'settlement',
                'purchase',
                'sale',
                'investment',
                'distribution',
                'tax',
                'other'
            )
        ),

    direction            text NOT NULL DEFAULT 'outflow'
        CHECK (
            direction IN (
                'inflow',
                'outflow',
                'transfer',
                'refund',
                'unknown'
            )
        ),

    payer_entity_id      text
        REFERENCES entities(entity_id),

    recipient_entity_id  text
        REFERENCES entities(entity_id),

    amount               numeric(24,2) NOT NULL,

    currency             char(3) NOT NULL DEFAULT 'USD',

    occurred_on          date,

    account_reference    text,

    filing_reference     text,

    description          text,

    source_id            text
        REFERENCES sources(source_id),

    claim_id             bigint
        REFERENCES claims(claim_id),

    finding_id           bigint
        REFERENCES findings(finding_id),

    assertion_type       text NOT NULL DEFAULT 'documented'
        CHECK (
            assertion_type IN (
                'documented',
                'derived',
                'hypothesis'
            )
        ),

    confidence           text NOT NULL DEFAULT 'unverified'
        CHECK (
            confidence IN (
                'unverified',
                'low',
                'medium',
                'high',
                'confirmed',
                'disputed'
            )
        ),

    source_system        text,

    source_record_id     text,

    notes                text,

    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT financial_amount_positive
        CHECK (
            amount >= 0
        ),

    CONSTRAINT financial_hypothesis_not_confirmed
        CHECK (
            NOT (
                assertion_type = 'hypothesis'
                AND confidence = 'confirmed'
            )
        ),

    CONSTRAINT financial_documented_requires_source
        CHECK (
            source_id IS NOT NULL
            OR assertion_type <> 'documented'
        )
);

CREATE INDEX IF NOT EXISTS idx_financial_events_investigation
    ON financial_events(investigation_id);

CREATE INDEX IF NOT EXISTS idx_financial_events_payer
    ON financial_events(payer_entity_id);

CREATE INDEX IF NOT EXISTS idx_financial_events_recipient
    ON financial_events(recipient_entity_id);

CREATE INDEX IF NOT EXISTS idx_financial_events_date
    ON financial_events(occurred_on);

CREATE INDEX IF NOT EXISTS idx_financial_events_source
    ON financial_events(source_id);

CREATE INDEX IF NOT EXISTS idx_financial_events_claim
    ON financial_events(claim_id);

CREATE INDEX IF NOT EXISTS idx_financial_events_finding
    ON financial_events(finding_id);

CREATE INDEX IF NOT EXISTS idx_financial_events_direction
    ON financial_events(direction);

CREATE INDEX IF NOT EXISTS idx_financial_events_assertion
    ON financial_events(assertion_type);


-- ============================================================
-- 7. FINANCIAL EVENT EVIDENCE
-- ============================================================

CREATE TABLE IF NOT EXISTS financial_event_evidence (
    financial_event_id  bigint NOT NULL
        REFERENCES financial_events(financial_event_id)
        ON DELETE CASCADE,

    source_id           text NOT NULL
        REFERENCES sources(source_id),

    role                text NOT NULL
        CHECK (
            role IN (
                'primary',
                'supporting',
                'contradicting',
                'context'
            )
        ),

    page_reference      text,

    analyst_note        text,

    created_at          timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (
        financial_event_id,
        source_id
    )
);

CREATE INDEX IF NOT EXISTS idx_financial_event_evidence_source
    ON financial_event_evidence(source_id);


-- ============================================================
-- 8. EVIDENCE GATE
--
-- A claim may be a lead or under review without evidence.
--
-- A claim CANNOT become supported/published unless it has
-- at least one primary evidence record.
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_claim_evidence_gate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN

    IF NEW.status IN ('supported', 'published') THEN

        IF NOT EXISTS (
            SELECT 1
            FROM claim_evidence ce
            WHERE ce.claim_id = NEW.claim_id
              AND ce.role = 'primary'
        ) THEN

            RAISE EXCEPTION
                'CLAIM EVIDENCE GATE: claim % cannot be marked % without at least one primary evidence record',
                NEW.claim_id,
                NEW.status;

        END IF;

    END IF;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS trg_claim_evidence_gate
    ON claims;

CREATE TRIGGER trg_claim_evidence_gate
BEFORE INSERT OR UPDATE OF status
ON claims
FOR EACH ROW
EXECUTE FUNCTION enforce_claim_evidence_gate();


-- ============================================================
-- 9. EVIDENCE INSERTION GATE
--
-- Prevents deleting the only primary evidence from a claim
-- that is already supported/published.
-- ============================================================

-- Prevent an UPDATE from removing the last primary evidence
-- from a claim that is already supported or published.
CREATE OR REPLACE FUNCTION enforce_claim_primary_evidence_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    claim_status text;
    remaining_primary integer;
BEGIN
    IF OLD.role = 'primary' AND NEW.role <> 'primary' THEN

        SELECT status
        INTO claim_status
        FROM claims
        WHERE claim_id = OLD.claim_id;

        IF claim_status IN ('supported', 'published') THEN

            SELECT COUNT(*)
            INTO remaining_primary
            FROM claim_evidence
            WHERE claim_id = OLD.claim_id
              AND evidence_id <> OLD.evidence_id
              AND role = 'primary';

            IF remaining_primary = 0 THEN
                RAISE EXCEPTION
                    'Cannot remove the only primary evidence from supported/published claim %',
                    OLD.claim_id;
            END IF;

        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_claim_primary_evidence_update
BEFORE UPDATE OF role ON claim_evidence
FOR EACH ROW
EXECUTE FUNCTION enforce_claim_primary_evidence_update();

CREATE OR REPLACE FUNCTION enforce_claim_primary_evidence_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    claim_status text;
    remaining_primary integer;
BEGIN

    SELECT status
    INTO claim_status
    FROM claims
    WHERE claim_id = OLD.claim_id;

    IF claim_status IN ('supported', 'published') THEN

        SELECT COUNT(*)
        INTO remaining_primary
        FROM claim_evidence ce
        WHERE ce.claim_id = OLD.claim_id
          AND ce.role = 'primary'
          AND ce.claim_evidence_id <> OLD.claim_evidence_id;

        IF remaining_primary = 0 THEN

            RAISE EXCEPTION
                'CLAIM EVIDENCE GATE: cannot remove the only primary evidence from % claim %',
                claim_status,
                OLD.claim_id;

        END IF;

    END IF;

    RETURN OLD;
END;
$$;


DROP TRIGGER IF EXISTS trg_claim_primary_evidence_retention
    ON claim_evidence;

CREATE TRIGGER trg_claim_primary_evidence_retention
BEFORE DELETE
ON claim_evidence
FOR EACH ROW
EXECUTE FUNCTION enforce_claim_primary_evidence_retention();


-- ============================================================
-- 10. CLAIM EVIDENCE STATUS VIEW
-- ============================================================

CREATE OR REPLACE VIEW v_claim_evidence_status AS
SELECT
    c.claim_id,
    c.investigation_id,
    c.statement,
    c.status,
    c.assertion_type,
    c.confidence,

    COUNT(ce.claim_evidence_id)
        AS evidence_count,

    COUNT(ce.claim_evidence_id)
        FILTER (
            WHERE ce.role = 'primary'
        )
        AS primary_evidence_count,

    COUNT(ce.claim_evidence_id)
        FILTER (
            WHERE ce.role = 'contradicting'
        )
        AS contradicting_evidence_count

FROM claims c

LEFT JOIN claim_evidence ce
    ON ce.claim_id = c.claim_id

GROUP BY
    c.claim_id,
    c.investigation_id,
    c.statement,
    c.status,
    c.assertion_type,
    c.confidence;


-- ============================================================
-- 11. FINDING EVIDENCE STATUS VIEW
-- ============================================================

CREATE OR REPLACE VIEW v_findings_evidence_status AS
SELECT
    f.finding_id,
    f.investigation_id,
    f.finding_code,
    f.title,
    f.status,
    f.finding_confidence,
    f.review_decision,

    COUNT(DISTINCT fc.claim_id)
        AS claim_count,

    COUNT(DISTINCT ce.claim_evidence_id)
        AS evidence_count,

    COUNT(DISTINCT ce.claim_evidence_id)
        FILTER (
            WHERE ce.role = 'primary'
        )
        AS primary_evidence_count,

    COUNT(DISTINCT ce.claim_evidence_id)
        FILTER (
            WHERE ce.role = 'contradicting'
        )
        AS contradicting_evidence_count

FROM findings f

LEFT JOIN finding_claims fc
    ON fc.finding_id = f.finding_id

LEFT JOIN claim_evidence ce
    ON ce.claim_id = fc.claim_id

GROUP BY
    f.finding_id,
    f.investigation_id,
    f.finding_code,
    f.title,
    f.status,
    f.finding_confidence,
    f.review_decision;


-- ============================================================
-- 12. MONEY FLOW VIEW
-- ============================================================

CREATE OR REPLACE VIEW v_financial_money_flow AS
SELECT
    f.financial_event_id,

    f.investigation_id,

    f.event_type,

    f.direction,

    payer.name
        AS payer,

    recipient.name
        AS recipient,

    f.amount,

    f.currency,

    f.occurred_on,

    f.account_reference,

    f.filing_reference,

    f.source_system,

    f.source_record_id,

    f.assertion_type,

    f.confidence,

    f.source_id,

    f.claim_id,

    f.finding_id

FROM financial_events f

LEFT JOIN entities payer
    ON payer.entity_id = f.payer_entity_id

LEFT JOIN entities recipient
    ON recipient.entity_id = f.recipient_entity_id;


-- ============================================================
-- 13. FINDING BASIS VIEW
-- ============================================================

CREATE OR REPLACE VIEW v_finding_basis AS
SELECT
    fb.finding_basis_id,
    fb.finding_id,

    f.finding_code,
    f.title,

    fb.key_fact,
    fb.evidence_weight,
    fb.basis_type,

    fb.source_id,
    fb.claim_id,

    fb.analyst_note

FROM finding_basis fb

JOIN findings f
    ON f.finding_id = fb.finding_id;

INSERT INTO schema_version (version, migration_id, applied_at, description)
VALUES (
    '0.9.0',
    '0009_evidence_claims_findings_financial',
    now(),
    'Evidence-backed claims, findings, finding basis, financial events, '
    'money-flow evidence, and database-enforced claim evidence gates'
)
ON CONFLICT DO NOTHING;

COMMIT;
