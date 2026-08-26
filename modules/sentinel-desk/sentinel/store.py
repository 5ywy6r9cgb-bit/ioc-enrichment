"""
store.py -- the desk's database: schema, connection, and the vocabularies.

WHY SQLITE AND NOT POSTGRES
    This desk is one person on one machine. SQLite is a file. It needs no
    server to be running, survives a reboot without anyone starting anything,
    and can be backed up by copying it. The PRA module uses Postgres because it
    holds a shared evidence store with least-privilege roles; this holds one
    operator's working notes. Different problems.

WHY THE AUDIT TABLE HAS NO UPDATE OR DELETE PATH
    See audit.py. The short version: the audit log is the answer to "what did
    you do and when," which is a question asked adversarially. A log you can
    edit answers nothing.

THE VOCABULARIES ARE CLOSED ON PURPOSE
    TIERS, SHELVES, CASE_STATUS, and REQUEST_STATUS are enforced by CHECK
    constraints AND offered as argparse choices. A tier typo that reaches the
    database is a claim whose evidentiary standard nobody can query for.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

# GlassMark tiers. The evidentiary standard a claim is held to.
TIERS = ["GREEN", "ARITH", "REPORTED", "RED", "VERIFY", "DEAD"]

# Where a document sits.
#   PRIMARY    the thing itself — the filing, the contract, the minutes
#   SECONDARY  someone else describing the thing — reporting, a summary
#   DERIVED    work product: your own analysis, a rendered graphic, an intel
#              brief. gates.PRIMARY_ONLY blocks a GREEN claim that cites only
#              this, which is the structural form of the fabricated-graphic
#              lesson: a number that came out of your own renderer is not
#              evidence that the number is real.
SHELVES = ["PRIMARY", "SECONDARY", "DERIVED"]

CASE_STATUS = ["OPEN", "HOLD", "PUBLISHED", "KILLED"]

REQUEST_STATUS = [
    "DRAFTED", "FILED", "ACKNOWLEDGED", "PARTIAL",
    "FULFILLED", "DENIED", "APPEALED", "WITHDRAWN",
]

SCHEMA = f"""
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cases (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  jurisdiction  TEXT,
  status        TEXT NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ({','.join(repr(s) for s in CASE_STATUS)})),
  opened        TEXT,
  updated       TEXT,
  note          TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY,
  case_id      INTEGER REFERENCES cases(id),
  title        TEXT NOT NULL,
  custodian    TEXT,
  shelf        TEXT NOT NULL DEFAULT 'PRIMARY'
               CHECK (shelf IN ({','.join(repr(s) for s in SHELVES)})),
  -- The hash is the identity. Two files with the same bytes are one document,
  -- and a file whose bytes changed is not the document you cited.
  sha256       TEXT NOT NULL UNIQUE,
  bytes        INTEGER,
  container    TEXT,
  filename     TEXT,
  path         TEXT,
  pages        INTEGER,
  received     TEXT,
  request_ref  TEXT,
  note         TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  id            INTEGER PRIMARY KEY,
  case_id       INTEGER NOT NULL REFERENCES cases(id),
  text          TEXT NOT NULL,
  tier          TEXT NOT NULL
                CHECK (tier IN ({','.join(repr(t) for t in TIERS)})),
  formula       TEXT,
  outlet        TEXT,
  closing_gate  TEXT,
  resolution    TEXT,
  created       TEXT,
  updated       TEXT,
  -- HOW THIS CLAIM ENTERED THE LEDGER.
  --
  -- A machine-drafted claim and a hand-entered one are indistinguishable
  -- about a week later. The ledger outlives the memory of how each row got
  -- there, so the row has to carry it. 'machine' does not mean wrong -- it
  -- means nobody has read the document yet.
  origin        TEXT NOT NULL DEFAULT 'human'
                CHECK (origin IN ('human', 'machine', 'unknown')),
  origin_note   TEXT,
  -- WHO TOOK RESPONSIBILITY, AND WHEN. Empty on a machine-drafted claim
  -- until a person opens the source and decides. The MACHINE_UNDISPOSED gate
  -- refuses to publish anything that still has these empty.
  disposed_by   TEXT,
  disposed_at   TEXT
);

CREATE TABLE IF NOT EXISTS citations (
  id        INTEGER PRIMARY KEY,
  claim_id  INTEGER NOT NULL REFERENCES claims(id),
  doc_id    INTEGER NOT NULL REFERENCES documents(id),
  locator   TEXT,
  quote     TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id        INTEGER PRIMARY KEY,
  case_id   INTEGER REFERENCES cases(id),
  ref       TEXT NOT NULL UNIQUE,
  title     TEXT,
  office    TEXT,
  statute   TEXT,
  asked     TEXT,
  status    TEXT NOT NULL DEFAULT 'DRAFTED'
            CHECK (status IN ({','.join(repr(s) for s in REQUEST_STATUS)})),
  filed     TEXT,
  due       TEXT,
  priority  TEXT
);

CREATE TABLE IF NOT EXISTS corrections (
  id         INTEGER PRIMARY KEY,
  ref        TEXT NOT NULL,
  date       TEXT,
  severity   TEXT,
  headline   TEXT,
  published  TEXT,
  correct    TEXT,
  why        TEXT,
  action     TEXT
);

-- A figure that was wrong once and got corrected. gates.py checks new claims
-- against this: republishing a retired number is the most common way a
-- correction fails to take.
CREATE TABLE IF NOT EXISTS retired_figures (
  id              INTEGER PRIMARY KEY,
  figure          TEXT NOT NULL,
  reason          TEXT,
  correction_ref  TEXT
);

CREATE TABLE IF NOT EXISTS gate_results (
  id        INTEGER PRIMARY KEY,
  claim_id  INTEGER NOT NULL REFERENCES claims(id),
  gate      TEXT NOT NULL,
  level     TEXT,
  passed    INTEGER NOT NULL,
  detail    TEXT,
  ran_at    TEXT
);

CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY,
  case_id       INTEGER REFERENCES cases(id),
  title         TEXT,
  payload_hash  TEXT,
  payload       TEXT,
  blocking      TEXT,
  submitted     TEXT
);

-- The hash chain. Each row commits to the one before it, so removing or
-- editing any row breaks every hash after it. See audit.py.
CREATE TABLE IF NOT EXISTS audit (
  -- `seq` rather than `id`: this is a sequence, and the chain's meaning
  -- depends on the order. `payload` rather than `detail` because what goes in
  -- it is the whole serialised body of the action, not a description of it.
  seq        INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  action     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  subject    TEXT,
  payload    TEXT,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_claims_case    ON claims(case_id);
CREATE INDEX IF NOT EXISTS ix_citations_claim ON citations(claim_id);
CREATE INDEX IF NOT EXISTS ix_docs_case      ON documents(case_id);
CREATE INDEX IF NOT EXISTS ix_gate_claim     ON gate_results(claim_id);
CREATE INDEX IF NOT EXISTS ix_requests_case  ON requests(case_id);

-- Append-only, enforced by the database rather than by everyone remembering.
-- A trigger cannot be forgotten the way a code path can.
CREATE TRIGGER IF NOT EXISTS audit_no_update
BEFORE UPDATE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only: rows cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete
BEFORE DELETE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only: rows cannot be deleted');
END;
"""


def default_root() -> Path:
    """Where the desk lives when nobody says otherwise."""
    return Path(os.environ.get("SENTINEL_ROOT", Path.home() / "SentinelDesk"))


def audit_mirror(root: Path | str) -> Path:
    """The plain-text copy of the audit chain.

    The database can be deleted. A mirror written alongside it, append-only and
    readable without any tooling, means the chain survives losing the .db and
    can be checked with `tail`. It is a mirror, not the source of truth --
    audit.verify reads the table.
    """
    return Path(root) / "audit.jsonl"


# Columns added after a desk may already exist on disk. CREATE TABLE IF NOT
# EXISTS does nothing to a table that is already there, so a new column in
# SCHEMA above reaches a fresh desk and silently misses every existing one --
# and the failure surfaces later as "no such column" in the middle of a run.
MIGRATIONS: list[tuple[str, str, str]] = [
    # 'unknown', NOT 'human'.
    #
    # A claim that predates this column may have been typed by a person or
    # drafted by `sentinel draft`. Backfilling it as 'human' would assert
    # something nobody can support, and would launder exactly the
    # machine-drafted claims this column exists to keep visible. The honest
    # value for "the ledger cannot say" is 'unknown', and the gate treats it
    # as undisposed until a person says otherwise -- a one-time cost paid
    # once per pre-existing claim.
    ("claims", "origin",      "TEXT NOT NULL DEFAULT 'unknown'"),
    ("claims", "origin_note", "TEXT"),
    ("claims", "disposed_by", "TEXT"),
    ("claims", "disposed_at", "TEXT"),
]


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Add any column this version expects that the file on disk lacks.

    Idempotent and additive only. Nothing here drops or rewrites a column:
    this database holds unpublished investigative material and a migration
    that can lose data is not worth the convenience.

    The CHECK constraint on `origin` cannot be added by ALTER TABLE in SQLite,
    so an upgraded desk enforces it in the CLI while a fresh one enforces it in
    the schema too. Both reject the same values.
    """
    applied = []
    for table, column, decl in MIGRATIONS:
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if not cols:
            continue                      # table not created yet
        if column in cols:
            continue
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        applied.append(f"{table}.{column}")
    return applied


def open_db(root: Path | str) -> sqlite3.Connection:
    """Open (creating if needed) the desk database under `root`."""
    root = Path(root).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    # The desk holds unpublished investigative material. Other users on the
    # machine have no business in it.
    try:
        os.chmod(root, 0o700)
    except OSError:
        pass

    db_path = root / "sentinel.db"
    existed = db_path.exists()
    # WAL mode writes sentinel.db-wal and sentinel.db-shm alongside the
    # database, and those hold real page data — an unpublished claim lives in
    # the -wal file before it is checkpointed. SQLite creates them itself, at
    # whatever the process umask allows, so chmod'ing only sentinel.db leaves
    # the contents readable by every account on the machine. The desk's own
    # security self-check (SC-4) catches this, which is how it was found.
    prev_umask = os.umask(0o077)
    # A timeout, because two connections is the normal case: `sentinel serve`
    # is often open in one window while you type commands in another. WAL lets
    # them read concurrently, but a writer still needs the write lock, and
    # without a timeout the second one fails instantly with "database is
    # locked" rather than waiting the fraction of a second it needs.
    # isolation_level=None means autocommit: every statement lands when it
    # runs. This is not a preference, it is the contract the rest of the
    # package was written to — cli.py, ingest.py, and gates.py contain no
    # commit() at all. Under Python's default (an implicit transaction opened
    # on the first write and held until someone commits), `sentinel claim add`
    # would look like it worked and lose the claim at process exit, and a
    # second connection — `sentinel serve` in another window — would sit
    # behind the write lock until it timed out.
    conn = sqlite3.connect(db_path, timeout=10.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    # Still worth setting: WAL lets readers and one writer work concurrently,
    # but two writers still queue, and the wait is normally milliseconds.
    conn.execute("PRAGMA busy_timeout = 10000")
    try:
        conn.executescript(SCHEMA)
        migrate(conn)
        conn.commit()
    finally:
        os.umask(prev_umask)

    # Belt and braces: fix anything that already exists from an earlier run
    # under a looser umask. Re-running open_db repairs a desk created before
    # this was fixed, rather than leaving it permanently exposed.
    for name in ("sentinel.db", "sentinel.db-wal", "sentinel.db-shm"):
        p = root / name
        if p.exists():
            try:
                os.chmod(p, 0o600)
            except OSError:
                pass
    return conn


def case_by_slug(conn: sqlite3.Connection, slug: str) -> sqlite3.Row:
    """Fetch a case or raise. Callers treat a missing case as fatal, so the
    lookup raises rather than returning None and letting a NoneType error
    surface three frames later with no useful message."""
    row = conn.execute("SELECT * FROM cases WHERE slug=?", (slug,)).fetchone()
    if row is None:
        known = [r["slug"] for r in conn.execute("SELECT slug FROM cases ORDER BY slug")]
        raise KeyError(
            f"no case {slug!r}"
            + (f" -- known: {', '.join(known)}" if known else " -- no cases yet")
        )
    return row


def counts(conn: sqlite3.Connection) -> dict:
    """One row of numbers for `status`."""
    def n(sql, *args):
        return conn.execute(sql, args).fetchone()[0]

    return {
        "cases": n("SELECT COUNT(*) FROM cases"),
        "open_cases": n("SELECT COUNT(*) FROM cases WHERE status='OPEN'"),
        "documents": n("SELECT COUNT(*) FROM documents"),
        "claims": n("SELECT COUNT(*) FROM claims"),
        "citations": n("SELECT COUNT(*) FROM citations"),
        "uncited_claims": n(
            "SELECT COUNT(*) FROM claims c WHERE NOT EXISTS "
            "(SELECT 1 FROM citations ci WHERE ci.claim_id=c.id)"),
        "requests": n("SELECT COUNT(*) FROM requests"),
        "requests_open": n(
            "SELECT COUNT(*) FROM requests WHERE status IN "
            "('DRAFTED','FILED','ACKNOWLEDGED','PARTIAL','APPEALED')"),
        "corrections": n("SELECT COUNT(*) FROM corrections"),
        "retired_figures": n("SELECT COUNT(*) FROM retired_figures"),
        "audit_entries": n("SELECT COUNT(*) FROM audit"),
    }
