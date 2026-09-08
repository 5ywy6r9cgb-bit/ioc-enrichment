#!/usr/bin/env python3
"""
provenance.py — the shared spine of Sentinel OS.

Every tool in this repo already invented the same discipline independently:
  * PRA               — metadata-only records, SHA-256 manifests, append-only ledgers
  * OpenMontage       — "every render emits a manifest: input hashes, output hash"
  * Atlas Vuln        — "nothing enters the record without a source and a hash"

This module is that discipline written once, so a received record, a rendered
video, and a CVE report all describe their provenance in ONE shape. That shared
shape is what lets the PRA evidence database index every artifact the whole
system produces, not just public-records files.

A provenance record answers four questions about an artifact:
  WHAT is it        — kind, id, a human label
  WHERE did it come from — source url / local path / upstream artifact ids
  IS IT INTACT      — sha256 of the exact bytes
  WHEN / BY WHAT    — utc timestamp, tool + version, and the inputs that made it

Design rules (match the rest of the repo):
  * Pure standard library. No dependencies.
  * Paths recorded RELATIVE to an evidence root — never absolute. An absolute
    path leaks the operator's machine layout and breaks portability.
  * The ledger is append-only. This module never rewrites or deletes a line.
  * Nothing here reaches the network.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

SCHEMA_VERSION = "provenance/1"
_ABS_PATH = re.compile(r"^([A-Za-z]:[\\/]|/|\\\\)")


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------

def sha256_bytes(data: bytes) -> str:
    """SHA-256 of a byte string, lowercase hex."""
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str, _chunk: int = 1024 * 1024) -> str:
    """SHA-256 of a file, streamed so large videos don't blow up memory."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(_chunk), b""):
            h.update(block)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    """SHA-256 of text, UTF-8 encoded."""
    return sha256_bytes(text.encode("utf-8"))


def sha256_json(obj: Any) -> str:
    """
    Stable SHA-256 of a JSON-serializable object. Keys are sorted and separators
    fixed, so the same logical object always hashes identically regardless of
    dict insertion order.
    """
    return sha256_text(json.dumps(obj, sort_keys=True, separators=(",", ":")))


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def is_absolute(path: str) -> bool:
    return bool(_ABS_PATH.match(path or ""))


def relativize(path: str, evidence_root: Optional[str]) -> str:
    """
    Express `path` relative to the evidence root. Refuses to emit an absolute
    path — an artifact record must be portable and must not leak machine layout.
    """
    if not path:
        return path
    if evidence_root:
        try:
            rel = os.path.relpath(os.path.abspath(path), os.path.abspath(evidence_root))
            if not rel.startswith(".."):
                return rel
        except ValueError:
            pass  # different drive on Windows, fall through
    if is_absolute(path):
        # Keep only the basename rather than record an absolute path.
        return os.path.basename(path)
    return path


# ---------------------------------------------------------------------------
# Sourcing tiers — carried over from the Flock production GlassMark scheme,
# generalized so every module speaks the same sourcing language.
# ---------------------------------------------------------------------------

TIERS = {
    "GREEN":        "primary document/artifact in custody (we hold the file and its hash)",
    "ATTRIBUTED":   "another party's material, credited to its source",
    "SOURCE_NEEDED": "not verified yet — must not be published or asserted",
    "GENERATED":    "produced by this system (a render, a report), traceable to its inputs",
    "NA":           "no factual claim attached",
}


def valid_tier(tier: str) -> bool:
    return tier in TIERS


# ---------------------------------------------------------------------------
# The provenance record
# ---------------------------------------------------------------------------

def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_record(
    *,
    kind: str,
    artifact_id: str,
    label: str = "",
    tool: str = "",
    tool_version: str = "",
    tier: str = "GENERATED",
    sha256: Optional[str] = None,
    local_path: Optional[str] = None,
    evidence_root: Optional[str] = None,
    source_url: Optional[str] = None,
    source_ref: Optional[str] = None,
    inputs: Optional[Iterable[Dict[str, Any]]] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Build one provenance record.

    kind         'received_record' | 'video_build' | 'vuln_report' | 'source' | ...
    artifact_id  stable id within its kind (a request id, a build id, a report id)
    tier         a sourcing tier (see TIERS); defaults to GENERATED
    sha256       hash of the artifact bytes, if it is a file/blob
    local_path   where the artifact lives, recorded RELATIVE to evidence_root
    inputs       list of {artifact_id?, sha256?, path?, note?} that produced it
    extra        module-specific fields (kept in their own namespace)

    Raises on an invalid tier — a wrong tier is worse than no tier.
    """
    if not kind or not artifact_id:
        raise ValueError("provenance record requires kind and artifact_id")
    if not valid_tier(tier):
        raise ValueError(f"unknown sourcing tier {tier!r}; valid: {sorted(TIERS)}")

    rec: Dict[str, Any] = {
        "schema": SCHEMA_VERSION,
        "kind": kind,
        "artifact_id": artifact_id,
        "label": label or "",
        "tier": tier,
        "recorded_at": utc_now(),
        "tool": tool or "",
        "tool_version": tool_version or "",
    }
    if sha256:
        rec["sha256"] = sha256
    if local_path is not None:
        rel = relativize(local_path, evidence_root)
        if is_absolute(rel):
            raise ValueError(f"refusing to record an absolute path: {local_path!r}")
        rec["local_path"] = rel
    if source_url:
        rec["source_url"] = source_url
    if source_ref:
        rec["source_ref"] = source_ref

    norm_inputs: List[Dict[str, Any]] = []
    for i in (inputs or []):
        item = {k: v for k, v in i.items() if v is not None}
        if "path" in item:
            item["path"] = relativize(item["path"], evidence_root)
        norm_inputs.append(item)
    if norm_inputs:
        rec["inputs"] = norm_inputs

    if extra:
        rec["extra"] = extra

    # A content hash of the record itself (minus its own hash field), so the
    # ledger line is tamper-evident the same way every module already is.
    rec["record_sha256"] = sha256_json({k: v for k, v in rec.items()})
    return rec


# ---------------------------------------------------------------------------
# The append-only ledger
# ---------------------------------------------------------------------------

GENESIS = "genesis"


def chain_value(prev: Optional[str], record_sha: str) -> str:
    """sha256(previous chain value + this record's own hash)."""
    return sha256_text(f"{prev or GENESIS}:{record_sha}")


class Ledger:
    """
    Append-only JSONL provenance ledger. One record per line. This class never
    rewrites or truncates the file — same guarantee PRA enforces at the database
    level with its append-only triggers.
    """

    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    def chain_tip(self) -> Optional[str]:
        """The chain value of the last line, or None for an empty/unchained ledger."""
        for row in reversed(self.read_all()):
            if row.get("chain_sha256"):
                return row["chain_sha256"]
        return None

    def append(self, record: Dict[str, Any]) -> Dict[str, Any]:
        """
        Append one record, linked to the one before it.

        WHAT record_sha256 PROVES, AND WHAT IT DOES NOT. Every record carries
        a hash of its own body, so editing a line in place is detectable. That
        leaves two edits invisible: DELETING a line (the survivors all still
        verify) and REORDERING or INSERTING one built with make_record(),
        which computes a perfectly valid record_sha256.

        chain_sha256 = sha256(previous chain value + this record's own hash),
        so each line depends on every line before it.

        THE LIMIT, SAID OUT LOUD: this cannot detect TRUNCATION. Cutting the
        file off at line N leaves a chain that verifies perfectly, because
        nothing inside a file can attest to what is no longer in it. That
        needs an anchor kept elsewhere.

        record_sha256 IS NOT RECOMPUTED -- a ledger whose old rows suddenly
        failed verification would be worse than no chain at all.
        """
        if "record_sha256" not in record:
            raise ValueError("record must be built with make_record()")
        prev = self.chain_tip()
        linked = dict(record)
        linked["prev_sha256"] = prev or GENESIS
        linked["chain_sha256"] = chain_value(prev, record["record_sha256"])
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(linked, sort_keys=True, separators=(",", ":")) + "\n")
        return linked

    def read_all(self) -> List[Dict[str, Any]]:
        if not os.path.exists(self.path):
            return []
        out = []
        with open(self.path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    def verify(self) -> Dict[str, Any]:
        """
        Two questions, answered separately because they fail differently.

            tampered — was a line EDITED after it was written?
            breaks   — was a line DELETED, MOVED, or INSERTED?

        UNCHAINED ROWS ARE NOT FAILURES. A ledger written before chaining
        existed has no chain fields, and reporting thousands of an operator's
        real captures as broken would make the check something to ignore --
        which is the only way a tamper check ever actually fails.
        """
        rows = self.read_all()
        tampered = []
        breaks = []
        unchained = 0
        chained = 0
        expected_prev = None
        skip = ("record_sha256", "prev_sha256", "chain_sha256")

        for idx, row in enumerate(rows):
            line = idx + 1

            body = {k: v for k, v in row.items() if k not in skip}
            if row.get("record_sha256") != sha256_json(body):
                tampered.append({"line": line, "artifact_id": row.get("artifact_id")})

            # AN UNCHAINED ROW IS ONLY LEGITIMATE BEFORE THE CHAIN STARTS.
            # Rows written before chaining existed sit at the top of the file;
            # the chain begins and never stops. Allowing one ANYWHERE -- which
            # the first version did, in the name of backward compatibility --
            # lets a forged line omit the chain fields and be waved through.
            if not row.get("chain_sha256"):
                if chained > 0:
                    breaks.append({
                        "line": line,
                        "artifact_id": row.get("artifact_id"),
                        "why": ("an UNCHAINED row appears after the chain began — a line "
                                "was inserted, or two ledgers were spliced together"),
                    })
                unchained += 1
                continue
            chained += 1
            want = chain_value(expected_prev, row.get("record_sha256"))
            if row["chain_sha256"] != want:
                moved = (row.get("prev_sha256") or GENESIS) != (expected_prev or GENESIS)
                breaks.append({
                    "line": line,
                    "artifact_id": row.get("artifact_id"),
                    "why": ("the previous link does not match the line above it — a line "
                            "was removed, moved, or inserted") if moved
                           else "the chain value does not match this record — the row was edited",
                })
            expected_prev = row["chain_sha256"]

        return {
            "total": len(rows),
            "tampered": tampered,
            "breaks": breaks,
            "chained": chained,
            "unchained": unchained,
            "tip": expected_prev,
            "truncation_detectable": False,
            "ok": not tampered and not breaks,
        }


if __name__ == "__main__":
    # Tiny smoke test so `python3 provenance.py` proves the module runs.
    r = make_record(kind="video_build", artifact_id="demo-001", label="smoke test",
                    tool="provenance.py", tool_version=SCHEMA_VERSION,
                    tier="GENERATED", sha256=sha256_text("hello"))
    print(json.dumps(r, indent=2))
