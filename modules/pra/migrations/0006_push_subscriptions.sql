-- =====================================================================
-- Sentinel PRA — migration 0006: push_subscriptions
--
-- Lets the desk reach a phone. A Web Push subscription is per-browser-
-- install, not per-person — the same phone re-added after clearing site
-- data gets a new endpoint, which is why endpoint is the natural primary
-- key, not something the operator names.
--
-- WHAT IS STORED: the three opaque values the Web Push protocol requires
-- to address an already-registered device (endpoint URL + two public keys
-- for message encryption). No device identifier, no location, no personal
-- data — this is transport addressing, not a device profile.
--
-- WHAT IS NOT STORED HERE: the VAPID private key. That lives in the
-- operator's environment (PRA_VAPID_PRIVATE_KEY), never in a table a
-- backup or export could carry.
-- =====================================================================

BEGIN;

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_version WHERE version = '0.7.3') THEN
        RAISE EXCEPTION 'migration 0005 (federal_jurisdiction) not applied. Run it first.';
    END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS push_subscriptions (
    subscription_id  bigserial PRIMARY KEY,
    endpoint         text NOT NULL UNIQUE,
    p256dh_key       text NOT NULL,
    auth_key         text NOT NULL,
    label            text,                 -- operator-set, e.g. 'iPhone — Safari'
    created_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at     timestamptz NOT NULL DEFAULT now(),
    -- A push that comes back 404/410 means the browser discarded the
    -- subscription (uninstall, cleared data, expiry). Recorded, not deleted
    -- immediately, so a run of failures is visible before the row vanishes.
    last_push_failed_at timestamptz,
    consecutive_failures integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_failures
    ON push_subscriptions(consecutive_failures) WHERE consecutive_failures > 0;

INSERT INTO schema_version (version, migration_id, description)
VALUES ('0.7.4', '0006_push_subscriptions',
        'push_subscriptions table for the mobile shell — Web Push addressing only, no VAPID secret, no device data')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------
-- POST-APPLY grant (run as owner, matches scripts/grants.sql pattern):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO sentinel_app;
--   GRANT USAGE, SELECT ON push_subscriptions_subscription_id_seq TO sentinel_app;
-- DELETE is intentionally granted here — unlike the ledgers, this table is a
-- live address book, not a history. Removing a dead subscription is a normal
-- write, not a rewrite of the past.
-- ---------------------------------------------------------------------
