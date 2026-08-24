"""
export.py — how work leaves the desk.

Two outputs, one rule: a claim that fails a BLOCK gate is not in either of
them. Not greyed out, not footnoted — absent. If it is not publishable it
does not get exported, and the export tells you what it left behind and why.

  dossier(...)  → a Markdown investigation packet: findings, evidence
                  register with hashes, open questions with their gates,
                  dead ends with their explanations, and the chain-of-custody
                  table. This is the thing you hand to an editor, a lawyer,
                  or another outlet.

  findings(...) → the JSON contract the video pipeline eats. Six desk tiers
                  collapse to the three that go on screen:
                      GREEN, ARITH, REPORTED → GREEN      (documented)
                      RED                    → RED_APPLE  (open question)
                      DEAD                   → DEAD_END   (chased, closed)
                      VERIFY                 → excluded until re-checked
                  ARITH keeps its formula in the narration and REPORTED keeps
                  its outlet, so the collapse never loses the distinction that
                  made the sub-tier necessary.
"""

from __future__ import annotations
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from . import audit, gates, store

TIER_MAP = {
    "GREEN": "GREEN", "ARITH": "GREEN", "REPORTED": "GREEN",
    "RED": "RED_APPLE", "DEAD": "DEAD_END",
}


def _publishable(conn: sqlite3.Connection, case_id: int) -> tuple[list, list]:
    """Run gates, return (publishable rows, withheld [(row, reasons)])."""
    ok, held = [], []
    for c in conn.execute("SELECT * FROM claims WHERE case_id=? ORDER BY id", (case_id,)):
        r = gates.run(conn, c["id"])
        if c["tier"] == "VERIFY":
            held.append((c, ["VERIFY — must be re-checked the morning of publish"]))
        elif r["publishable"]:
            ok.append(c)
        else:
            held.append((c, [f"{b['gate']}: {b['detail']}" for b in r["blocks"]]))
    return ok, held


def _cites(conn: sqlite3.Connection, claim_id: int):
    return conn.execute(
        "SELECT ci.locator, ci.quote, d.title, d.sha256, d.shelf, d.custodian "
        "FROM citations ci JOIN documents d ON d.id=ci.doc_id WHERE ci.claim_id=?",
        (claim_id,)).fetchall()


def findings(conn: sqlite3.Connection, case_slug: str) -> dict:
    """Build the findings deck the video pipeline accepts."""
    cs = store.case_by_slug(conn, case_slug)
    if cs is None:
        raise KeyError(f"No case '{case_slug}'")
    ok, held = _publishable(conn, cs["id"])

    out = []
    for c in ok:
        tier = TIER_MAP.get(c["tier"])
        if tier is None:
            continue
        cites = _cites(conn, c["id"])
        src = ({"doc": cites[0]["title"], "page": cites[0]["locator"]} if cites else None)

        if tier == "GREEN":
            text = c["text"]
            if c["tier"] == "ARITH" and c["formula"]:
                text = f"{text} (our arithmetic: {c['formula']})"
            if c["tier"] == "REPORTED" and c["outlet"]:
                text = f"{text} — reported by {c['outlet']}"
                src = src or {"doc": f"{c['outlet']} (reporting, not a filing)"}
            item = {"id": f"c{c['id']}", "tier": "GREEN", "claim": text, "confidence": "high"}
            if src:
                item["source"] = src
        elif tier == "RED_APPLE":
            item = {"id": f"c{c['id']}", "tier": "RED_APPLE", "question": c["text"],
                    "gate": c["closing_gate"] or "", "confidence": "medium"}
            if src:
                item["source"] = src
        else:
            item = {"id": f"c{c['id']}", "tier": "DEAD_END", "thread": c["text"],
                    "resolution": c["resolution"] or "", "confidence": "high"}
            if src:
                item["source"] = src
        out.append(item)

    return {
        "project": cs["title"],
        "standard": "Named Sources. Public Documents. Verified Facts.",
        "motto": "We Watch the Code.",
        "findings": out,
        "_withheld": [{"claim": c["text"], "tier": c["tier"], "reasons": r} for c, r in held],
    }


def dossier(conn: sqlite3.Connection, case_slug: str) -> str:
    """Markdown investigation packet."""
    cs = store.case_by_slug(conn, case_slug)
    if cs is None:
        raise KeyError(f"No case '{case_slug}'")
    ok, held = _publishable(conn, cs["id"])
    docs = conn.execute(
        "SELECT * FROM documents WHERE case_id=? ORDER BY received", (cs["id"],)).fetchall()
    reqs = conn.execute(
        "SELECT * FROM requests WHERE case_id=? ORDER BY priority", (cs["id"],)).fetchall()
    chain_ok, chain_msg = audit.verify(conn)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    L: list[str] = [
        f"# {cs['title']}",
        "",
        f"**{cs['jurisdiction']}** · status {cs['status']} · packet generated {now}",
        "",
        "> Named Sources. Public Documents. Verified Facts.",
        "> Every claim below traces to a document you can request yourself. Open "
        "questions are labelled as questions, never as facts. Where a thread had a "
        "legitimate explanation, that explanation is reported rather than dropped.",
        "",
        "## Summary",
        "",
        f"- {len(ok)} claim(s) clear every blocking gate and are publishable.",
        f"- {len(held)} claim(s) are withheld, listed in full at the end with the reason.",
        f"- {len(docs)} document(s) in custody.",
        f"- {len(reqs)} records request(s) associated with this case.",
        "",
    ]

    def section(title: str, tiers: tuple[str, ...]) -> None:
        rows = [c for c in ok if c["tier"] in tiers]
        if not rows:
            return
        L.append(f"## {title}")
        L.append("")
        for c in rows:
            if c["tier"] == "RED":
                L.append(f"**Open question.** {c['text']}")
                if c["closing_gate"]:
                    L.append(f"  \n*What would close it:* {c['closing_gate']}")
            elif c["tier"] == "DEAD":
                L.append(f"**Chased and closed.** {c['text']}")
                L.append(f"  \n*What closed it:* {c['resolution']}")
            else:
                L.append(f"**{c['text']}**")
                if c["tier"] == "ARITH":
                    L.append(f"  \n*Our arithmetic, not the document's:* `{c['formula']}`")
                if c["tier"] == "REPORTED":
                    L.append(f"  \n*Reported by {c['outlet']} — reporting, not a filing.*")
            for x in _cites(conn, c["id"]):
                q = f' — "{x["quote"]}"' if x["quote"] else ""
                L.append(f"  \n  Source: {x['title']}, {x['locator']} "
                         f"({x['custodian']}, SHA-256 `{x['sha256'][:16]}…`){q}")
            L.append("")

    section("Documented", ("GREEN", "ARITH", "REPORTED"))
    section("Open questions", ("RED",))
    section("Dead ends — reported, not buried", ("DEAD",))

    L += ["## Evidence register", "",
          "| Document | Custodian | Shelf | Container | Bytes | SHA-256 |",
          "|---|---|---|---|---|---|"]
    for d in docs:
        L.append(f"| {d['title']} | {d['custodian']} | {d['shelf']} | {d['container']} "
                 f"| {d['bytes']:,} | `{d['sha256']}` |")
    L.append("")

    if reqs:
        L += ["## Records requests", "",
              "| Ref | Asked of | Statute | Status | Filed | Responded |",
              "|---|---|---|---|---|---|"]
        for r in reqs:
            L.append(f"| {r['ref']} | {r['office']} | {r['statute']} | {r['status']} "
                     f"| {r['filed'] or '—'} | {r['responded'] or '—'} |")
        L.append("")

    if held:
        L += ["## Withheld from this packet", "",
              "These are recorded in the case store and are **not** published here. "
              "They appear so the omission is visible rather than silent.", ""]
        for c, reasons in held:
            L.append(f"- **[{c['tier']}]** {c['text']}")
            for r in reasons:
                L.append(f"  - {r}")
        L.append("")

    L += ["---", "",
          f"Audit chain: {'intact' if chain_ok else 'BROKEN — ' + chain_msg}. "
          f"{chain_msg if chain_ok else ''}", "",
          "If a claim here is wrong, the correction runs at the top of the next report. "
          "Not buried."]
    return "\n".join(L)


def write(conn: sqlite3.Connection, root: Path, case_slug: str,
          actor: str = "operator") -> dict:
    """Write both artefacts to <root>/exports/<slug>/ and log the export."""
    out = Path(root).expanduser() / "exports" / case_slug
    out.mkdir(parents=True, exist_ok=True)

    md = dossier(conn, case_slug)
    fj = findings(conn, case_slug)

    (out / "dossier.md").write_text(md, encoding="utf-8")
    (out / "findings.json").write_text(json.dumps(fj, indent=2), encoding="utf-8")

    digest = hashlib.sha256(md.encode("utf-8")).hexdigest()
    audit.record(conn, "export.write", actor, case_slug,
                 {"dossier_sha256": digest,
                  "published_claims": len(fj["findings"]),
                  "withheld": len(fj["_withheld"])},
                 mirror=store.audit_mirror(root))

    return {"dir": str(out), "dossier_sha256": digest,
            "published": len(fj["findings"]), "withheld": len(fj["_withheld"])}


def submit(conn: sqlite3.Connection, root: Path, case_slug: str,
           title: str, actor: str = "operator") -> dict:
    """Put an export in front of the publication gate. Does NOT publish it."""
    cs = store.case_by_slug(conn, case_slug)
    if cs is None:
        raise KeyError(f"No case '{case_slug}'")

    md = dossier(conn, case_slug)
    _, held = _publishable(conn, cs["id"])
    blocking = "; ".join(
        f"{c['text'][:50]}… [{', '.join(r)[:80]}]" for c, r in held
    )[:1000]

    digest = hashlib.sha256(md.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    cur = conn.execute(
        "INSERT INTO submissions (case_id,title,payload_hash,payload,blocking,submitted) "
        "VALUES (?,?,?,?,?,?)",
        (cs["id"], title, digest, md, blocking, now))

    audit.record(conn, "gate.submit", actor, str(cur.lastrowid),
                 {"case": case_slug, "title": title, "payload_sha256": digest,
                  "withheld": len(held)},
                 mirror=store.audit_mirror(root))

    return {"id": cur.lastrowid, "payload_sha256": digest, "withheld": len(held)}
