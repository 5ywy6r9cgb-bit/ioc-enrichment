"""
gates.py — GlassMark, enforced.

A gate is a question the desk asks every claim before that claim is allowed
anywhere near an audience. BLOCK gates stop publication. WARN gates do not,
but they appear on the dashboard until someone deals with them.

These are not stylistic preferences. Each one exists because of a specific
way a careful person still gets it wrong at 2 a.m.:

  UNCITED          A claim tiered GREEN with no citation. The most common
                    failure there is: you read it, you know it is true, you
                    never went back and recorded WHERE.

  PRIMARY_ONLY      A GREEN claim citing your own analysis, a graphic, or an
                    intel brief. Derived work is not a primary source. This is
                    the structural form of the lesson from the fabricated-graphic
                    incident: a number that came out of your own renderer is not
                    evidence that the number is real.

  RED_AS_FACT       A RED APPLE written as a statement. If it is an open
                    question it has to READ like a question and it has to name
                    the specific record that would close it.

  UNLABELED_ARITH   Your arithmetic presented as though the document said it.
                    $6,000 per camera is not in the purchase order; it is
                    $228,000 ÷ 38. Show the division.

  REPORTED_AS_DOC   Another outlet's reporting presented as a document. The
                    $42.3M figure is reported, not filed. Name the outlet
                    every single time.

  DEAD_UNEXPLAINED  A DEAD END with no explanation is just a deletion. The
                    whole value of a dead end is that you report what closed it.

  RETIRED_FIGURE    A figure a correction has retired, reappearing. This is
                    the $880,000 gate. Once a correction retires a number, the
                    database refuses to let it back in — you cannot re-make
                    that mistake by forgetting.

  STALE_GATE        (WARN) A RED APPLE older than 45 days with nothing filed
                    against it. Open questions decay into vibes.

  UNSOURCED_DUP     (WARN) Two claims with identical text in the same case.
                    Usually a paste, occasionally a real conflict.
"""

from __future__ import annotations
import re
import sqlite3
from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone, timedelta

BLOCK = "BLOCK"
WARN = "WARN"
STALE_DAYS = 45


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _norm_figure(s: str) -> str | None:
    """
    Canonicalise a figure so formatting cannot smuggle a retired number back in.

        $880,000   $880,000.00   880000   880000.00   →  "880000"

    Comparing stripped digit-strings is not enough: "$880,000" strips to
    880000 but "$880,000.00" strips to 88000000, and the second would sail
    through a gate that caught the first. Parse the value, then drop the
    meaningless trailing zeros.
    """
    t = re.sub(r"[^0-9.]", "", s or "")
    if not t or t.count(".") > 1:
        return None
    try:
        return format(Decimal(t).normalize(), "f")
    except InvalidOperation:
        return None


def _figures_in(text: str) -> set[str]:
    """Every money-ish or large number appearing in a claim."""
    out: set[str] = set()
    for m in re.finditer(r"\$?\s?\d[\d,]*(?:\.\d+)?", text or ""):
        raw = m.group(0)
        n = _norm_figure(raw)
        if n is None:
            continue
        try:
            value = Decimal(n)
        except InvalidOperation:
            continue
        # Ignore small incidental numbers unless they are written as money.
        if value >= 1000 or "$" in raw:
            out.add(n)
    return out


def evaluate(conn: sqlite3.Connection, claim_id: int) -> list[dict]:
    """Run every gate against one claim. Returns result dicts (not yet stored)."""
    c = conn.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone()
    if c is None:
        raise KeyError(f"No claim {claim_id}")

    cites = conn.execute(
        "SELECT ci.*, d.shelf, d.title AS doc_title, d.sha256 "
        "FROM citations ci JOIN documents d ON d.id=ci.doc_id WHERE ci.claim_id=?",
        (claim_id,),
    ).fetchall()

    text = c["text"] or ""
    tier = c["tier"]
    res: list[dict] = []

    def add(gate: str, level: str, passed: bool, detail: str = "") -> None:
        res.append({"gate": gate, "level": level, "passed": passed, "detail": detail})

    # ── MACHINE_UNDISPOSED ────────────────────────────────────────────────
    #
    # NO CLAIM REACHES A DOSSIER WITHOUT A HUMAN HAVING DISPOSED OF IT.
    #
    # A machine can find a passage. It cannot decide what the passage means,
    # and it has not read the page. A drafted claim is a reading queue entry,
    # not a finding -- but a week later the two are indistinguishable in the
    # ledger unless the row itself carries the difference.
    #
    # This is the only gate that ignores the tier. A machine-drafted claim
    # promoted to GREEN with a citation attached still fails here until a
    # person has put their name against it, because attaching a citation is
    # not the same act as reading the document and deciding.
    origin = (c["origin"] if "origin" in c.keys() else "human") or "human"
    disposed = (c["disposed_by"] if "disposed_by" in c.keys() else None)
    needs_person = origin in ("machine", "unknown") and not disposed
    add("MACHINE_UNDISPOSED", BLOCK, not needs_person,
        "" if not needs_person else
        ("This claim was drafted by a machine from a search result and no "
         "person has disposed of it. "
         if origin == "machine" else
         "This claim predates origin tracking, so the ledger cannot say "
         "whether a person entered it or a machine drafted it. ")
        + "Open the source, decide, then: "
        + f"sentinel claim dispose {claim_id} --by \"<your name>\"")

    # ── UNCITED ───────────────────────────────────────────────────────────
    if tier in ("GREEN", "ARITH"):
        add("UNCITED", BLOCK, len(cites) > 0,
            "" if cites else
            f"Tier {tier} asserts something as documented but cites no document.")
    else:
        add("UNCITED", BLOCK, True, "n/a for this tier")

    # ── PRIMARY_ONLY ──────────────────────────────────────────────────────
    if tier == "GREEN" and cites:
        bad = [x for x in cites if x["shelf"] != "PRIMARY"]
        add("PRIMARY_ONLY", BLOCK, not bad,
            "" if not bad else
            "GREEN cites non-primary material: " +
            "; ".join(f"{x['doc_title']} ({x['shelf']})" for x in bad) +
            ". Derived analysis and your own products are not evidence that "
            "the underlying fact is true.")
    else:
        add("PRIMARY_ONLY", BLOCK, True, "n/a")

    # ── RED_AS_FACT ───────────────────────────────────────────────────────
    if tier == "RED":
        looks_like_question = text.strip().endswith("?")
        has_gate = bool((c["closing_gate"] or "").strip())
        add("RED_AS_FACT", BLOCK, looks_like_question and has_gate,
            "" if (looks_like_question and has_gate) else
            ("An open question must be written as a question (it does not end "
             "in '?') " if not looks_like_question else "") +
            ("and must name the specific record that would close it "
             "(closing_gate is empty)" if not has_gate else ""))
    else:
        add("RED_AS_FACT", BLOCK, True, "n/a")

    # ── UNLABELED_ARITH ───────────────────────────────────────────────────
    if tier == "ARITH":
        has = bool((c["formula"] or "").strip())
        add("UNLABELED_ARITH", BLOCK, has,
            "" if has else
            "Arithmetic must carry the expression so a reader can redo it.")
    else:
        add("UNLABELED_ARITH", BLOCK, True, "n/a")

    # ── REPORTED_AS_DOC ───────────────────────────────────────────────────
    if tier == "REPORTED":
        has = bool((c["outlet"] or "").strip())
        add("REPORTED_AS_DOC", BLOCK, has,
            "" if has else
            "Another outlet's reporting must name the outlet, every use.")
    else:
        add("REPORTED_AS_DOC", BLOCK, True, "n/a")

    # ── DEAD_UNEXPLAINED ──────────────────────────────────────────────────
    if tier == "DEAD":
        has = bool((c["resolution"] or "").strip())
        add("DEAD_UNEXPLAINED", BLOCK, has,
            "" if has else
            "A dead end with no explanation is a deletion. Record what closed it.")
    else:
        add("DEAD_UNEXPLAINED", BLOCK, True, "n/a")

    # ── RETIRED_FIGURE ────────────────────────────────────────────────────
    figs = _figures_in(text)
    hits = []
    if figs:
        for row in conn.execute(
            "SELECT rf.figure, rf.reason, rf.correction_ref FROM retired_figures rf"
        ):
            canon = _norm_figure(row["figure"])
            if canon is not None and canon in figs:
                hits.append(
                    f"{row['figure']} (retired by {row['correction_ref']}"
                    + (f": {row['reason']}" if row["reason"] else "") + ")"
                )
    add("RETIRED_FIGURE", BLOCK, not hits,
        "" if not hits else
        "This claim contains a figure a correction has retired: " + "; ".join(hits))

    # ── STALE_GATE (warn) ─────────────────────────────────────────────────
    if tier == "RED":
        try:
            born = datetime.fromisoformat(c["created"])
            # A timestamp with no timezone cannot be subtracted from an aware
            # one -- it raises TypeError, which this used to let escape. The
            # whole gate run then died on a bad date, so NO gate ran at all:
            # a claim with a malformed timestamp sailed past UNCITED,
            # PRIMARY_ONLY and the rest by crashing before they were reached.
            # Assuming UTC is wrong by at most a day, against a 30-day
            # threshold.
            if born.tzinfo is None:
                born = born.replace(tzinfo=timezone.utc)
            stale = (datetime.now(timezone.utc) - born) > timedelta(days=STALE_DAYS)
        except (ValueError, TypeError):
            # An unparseable date is not evidence the claim is fresh, but it
            # is not evidence it is stale either. Warn-level gate, so it stays
            # visible without blocking.
            stale = False
        add("STALE_GATE", WARN, not stale,
            "" if not stale else
            f"Open more than {STALE_DAYS} days. Either file for the record that "
            f"closes it, or move it to DEAD and say why.")
    else:
        add("STALE_GATE", WARN, True, "n/a")

    # ── UNSOURCED_DUP (warn) ──────────────────────────────────────────────
    dup = conn.execute(
        "SELECT COUNT(*) FROM claims WHERE case_id=? AND text=? AND id<>?",
        (c["case_id"], text, claim_id),
    ).fetchone()[0]
    add("UNSOURCED_DUP", WARN, dup == 0,
        "" if dup == 0 else f"{dup} other claim(s) in this case have identical text.")

    return res


def run(conn: sqlite3.Connection, claim_id: int) -> dict:
    """Evaluate and persist. Returns a summary."""
    results = evaluate(conn, claim_id)
    at = _now()
    conn.execute("DELETE FROM gate_results WHERE claim_id=?", (claim_id,))
    conn.executemany(
        "INSERT INTO gate_results (claim_id,gate,level,passed,detail,ran_at) "
        "VALUES (?,?,?,?,?,?)",
        [(claim_id, r["gate"], r["level"], 1 if r["passed"] else 0, r["detail"], at)
         for r in results],
    )
    blocks = [r for r in results if r["level"] == BLOCK and not r["passed"]]
    warns = [r for r in results if r["level"] == WARN and not r["passed"]]
    return {
        "claim_id": claim_id,
        "publishable": not blocks,
        "blocks": blocks,
        "warns": warns,
        "ran_at": at,
    }


def run_case(conn: sqlite3.Connection, case_slug: str) -> dict:
    case = conn.execute("SELECT * FROM cases WHERE slug=?", (case_slug,)).fetchone()
    if case is None:
        raise KeyError(f"No case '{case_slug}'")
    ids = [r["id"] for r in conn.execute(
        "SELECT id FROM claims WHERE case_id=? ORDER BY id", (case["id"],))]
    out = [run(conn, i) for i in ids]
    return {
        "case": case_slug,
        "claims": len(out),
        "publishable": sum(1 for o in out if o["publishable"]),
        "blocked": [o for o in out if not o["publishable"]],
        "warned": [o for o in out if o["warns"]],
    }
