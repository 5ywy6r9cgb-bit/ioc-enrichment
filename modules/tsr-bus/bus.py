"""
tsr_bus/bus.py — The communication layer between Sentinel Research Desk
and OpenMontage.

Local-only by design (binds 127.0.0.1). This is not meant to be exposed
to the internet — it's the "nervous system" connecting two processes
running on the same machine (or same private network), not a public API.

Run:
    uvicorn bus:app --host 127.0.0.1 --port 8420

Both systems then talk to it via tsr_bus/client.py rather than reading
each other's files directly.
"""

from __future__ import annotations
import sqlite3
import json
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from schema import SentinelRecord, RecordStatus, GlassMarkTier

DB_PATH = Path(__file__).parent / "tsr_bus.sqlite3"

app = FastAPI(title="TSR Bus", description="Sentinel Research Desk <-> OpenMontage bridge")


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS records (
            record_id TEXT PRIMARY KEY,
            case_id TEXT NOT NULL,
            status TEXT NOT NULL,
            glass_mark_tier TEXT NOT NULL,
            origin_system TEXT NOT NULL,
            updated_utc TEXT NOT NULL,
            payload_json TEXT NOT NULL
        )
    """)
    # Append-only audit trail. Never UPDATE or DELETE from this table —
    # that's what makes it a chain of custody instead of just a log.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS record_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            record_id TEXT NOT NULL,
            from_status TEXT,
            to_status TEXT NOT NULL,
            actor TEXT,
            occurred_utc TEXT NOT NULL
        )
    """)
    # Full-text search over the fields investigators actually search by.
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
            record_id UNINDEXED, case_id, headline, summary, tokenize='porter'
        )
    """)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _log_event(conn, record_id, from_status, to_status, actor):
    conn.execute(
        "INSERT INTO record_events (record_id, from_status, to_status, actor, occurred_utc) VALUES (?, ?, ?, ?, ?)",
        (record_id, from_status, to_status, actor, datetime.now(timezone.utc).isoformat()),
    )


def _index_fts(conn, record: SentinelRecord):
    conn.execute("DELETE FROM records_fts WHERE record_id=?", (record.record_id,))
    conn.execute(
        "INSERT INTO records_fts (record_id, case_id, headline, summary) VALUES (?, ?, ?, ?)",
        (record.record_id, record.case, record.headline, record.summary),
    )


@app.on_event("startup")
def init_db():
    with db():
        pass  # creates table if missing


@app.post("/records", response_model=SentinelRecord)
def publish_record(record: SentinelRecord):
    """
    Either system calls this to publish or update a record.
    Pydantic validation (the "form") already ran before this line executes —
    if the payload didn't match SentinelRecord's shape, this endpoint
    was never reached; FastAPI returns 422 automatically.
    """
    record.updated_utc = datetime.now(timezone.utc)
    with db() as conn:
        existing = conn.execute("SELECT status FROM records WHERE record_id=?", (record.record_id,)).fetchone()
        conn.execute(
            """INSERT INTO records (record_id, case_id, status, glass_mark_tier, origin_system, updated_utc, payload_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(record_id) DO UPDATE SET
                 status=excluded.status,
                 glass_mark_tier=excluded.glass_mark_tier,
                 updated_utc=excluded.updated_utc,
                 payload_json=excluded.payload_json""",
            (
                record.record_id, record.case, record.status,
                record.glass_mark_tier, record.origin_system,
                record.updated_utc.isoformat(), record.model_dump_json(),
            ),
        )
        _log_event(conn, record.record_id, existing[0] if existing else None, record.status, record.actor)
        _index_fts(conn, record)
    return record


@app.get("/records/{record_id}", response_model=SentinelRecord)
def get_record(record_id: str):
    with db() as conn:
        row = conn.execute("SELECT payload_json FROM records WHERE record_id=?", (record_id,)).fetchone()
    if not row:
        raise HTTPException(404, f"No record: {record_id}")
    return SentinelRecord(**json.loads(row[0]))


@app.get("/records", response_model=list[SentinelRecord])
def list_records(
    case: Optional[str] = None,
    status: Optional[RecordStatus] = None,
    origin_system: Optional[str] = None,
):
    """
    OpenMontage's primary pull point: e.g.
      GET /records?status=ready
    to fetch everything cleared for broadcast production.
    """
    q = "SELECT payload_json FROM records WHERE 1=1"
    params = []
    if case:
        q += " AND case_id=?"
        params.append(case)
    if status:
        q += " AND status=?"
        params.append(status.value if hasattr(status, "value") else status)
    if origin_system:
        q += " AND origin_system=?"
        params.append(origin_system)

    with db() as conn:
        rows = conn.execute(q, params).fetchall()
    return [SentinelRecord(**json.loads(r[0])) for r in rows]


@app.post("/records/{record_id}/advance")
def advance_status(record_id: str, new_status: RecordStatus):
    """
    Explicit status transitions instead of free-form edits, so the
    handoff between systems is always an auditable, named event
    (e.g. Research Desk marks 'sealed' -> OpenMontage marks 'in_production').
    """
    with db() as conn:
        row = conn.execute("SELECT payload_json FROM records WHERE record_id=?", (record_id,)).fetchone()
        if not row:
            raise HTTPException(404, f"No record: {record_id}")
        record = SentinelRecord(**json.loads(row[0]))

        # Hard gate: Red-tier material cannot advance to broadcast pickup, ever.
        if new_status == RecordStatus.READY_FOR_BROADCAST and record.glass_mark_tier == GlassMarkTier.RED.value:
            raise HTTPException(409, "Red-tier record cannot be marked ready-for-broadcast.")

        old_status = record.status
        record.status = new_status
        record.updated_utc = datetime.now(timezone.utc)
        conn.execute(
            "UPDATE records SET status=?, updated_utc=?, payload_json=? WHERE record_id=?",
            (record.status, record.updated_utc.isoformat(), record.model_dump_json(), record_id),
        )
        _log_event(conn, record_id, old_status, new_status, actor=None)
    return record


@app.get("/records/{record_id}/history")
def record_history(record_id: str):
    """Full chain of custody for one record: every status transition, in order."""
    with db() as conn:
        rows = conn.execute(
            "SELECT from_status, to_status, actor, occurred_utc FROM record_events WHERE record_id=? ORDER BY event_id ASC",
            (record_id,),
        ).fetchall()
    return [
        {"from_status": r[0], "to_status": r[1], "actor": r[2], "occurred_utc": r[3]}
        for r in rows
    ]


@app.get("/search", response_model=list[SentinelRecord])
def search_records(q: str = Query(..., min_length=2)):
    """Full-text search across headline/summary/case. e.g. GET /search?q=paladin"""
    with db() as conn:
        rows = conn.execute(
            """SELECT r.payload_json FROM records_fts f
               JOIN records r ON r.record_id = f.record_id
               WHERE records_fts MATCH ?
               ORDER BY rank""",
            (q,),
        ).fetchall()
    return [SentinelRecord(**json.loads(r[0])) for r in rows]


@app.get("/health")
def health():
    return {"status": "ok", "db": str(DB_PATH)}
