"""
test_sentinel.py — every claim this system makes about itself, checked.

Run:  python3 test_sentinel.py

No network, no fixtures downloaded, no database server. If this passes on
your machine, the desk works on your machine.
"""
from __future__ import annotations
import io
import json
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sentinel import audit, export, gates, guard, ingest, store  # noqa: E402
from sentinel.cli import main as cli  # noqa: E402

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = ""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}" + (f"\n         {detail}" if detail else ""))



def _trigger_blocks(c) -> bool:
    """True if the append-only trigger refuses an UPDATE on audit."""
    try:
        c.execute("UPDATE audit SET actor='x' WHERE seq=1")
        return False
    except sqlite3.IntegrityError:
        return True


ROOT = Path(tempfile.mkdtemp(prefix="sentinel-test-"))
conn = store.open_db(ROOT)


# ── the boundary ──────────────────────────────────────────────────────────
print("\nBOUNDARY")
for payload, label in [
    ({"advertisingId": "x"}, "advertisingId"),
    ({"a": {"b": [{"hashedEmails": ["x"]}]}}, "nested hashedEmails"),
    ({"getLocationsFromAID": {}}, "getLocationsFromAID"),
    ({"subject_location": {"lat": 1}}, "subject_location"),
]:
    try:
        guard.assert_clean(payload)
        check(f"refuses {label}", False, "it did not raise")
    except guard.RefusedInput:
        check(f"refuses {label}", True)

try:
    guard.assert_clean({"title": "Purchase Order 483191", "custodian": "City of Columbus",
                        "locator": "p.1", "quote": "TOTAL $228,000.00"})
    check("passes an ordinary public record", True)
except guard.RefusedInput as ex:
    check("passes an ordinary public record", False, str(ex))


# ── ingest & container detection ──────────────────────────────────────────
print("\nINGEST")
conn.execute("INSERT INTO cases (slug,title,jurisdiction,status,opened,updated) "
             "VALUES ('t','Test Case','Ohio','OPEN','2026-01-01','2026-01-01')")

work = ROOT / "src"
work.mkdir()

real_pdf = work / "real.pdf"
real_pdf.write_bytes(b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n")

# The real-world trap: a .pdf that is a ZIP of page images.
fake_pdf = work / "agency_production.pdf"
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    for i in range(1, 6):
        z.writestr(f"{i}.jpeg", b"\xff\xd8\xff" + bytes(200))
fake_pdf.write_bytes(buf.getvalue())

txt = work / "notes.txt"
txt.write_text("plain text record")

r1 = ingest.ingest(conn, ROOT, "t", real_pdf, title="A real PDF", custodian="City")
check("real PDF classified PDF", r1["container"] == "PDF", r1["container"])

r2 = ingest.ingest(conn, ROOT, "t", fake_pdf, title="Agency production",
                   custodian="City of Dublin")
check("zip-of-images named .pdf is caught",
      r2["container"] == "ZIP_PAGE_ARCHIVE", r2["container"])
check("page count recovered from the archive", r2["pages"] == 5, str(r2["pages"]))
check("the trap is explained in the note", "OCR" in r2["detail"], r2["detail"])

r3 = ingest.ingest(conn, ROOT, "t", txt, title="Notes", custodian="Desk", shelf="DERIVED")
check("plaintext classified", r3["container"] == "PLAINTEXT", r3["container"])

again = ingest.ingest(conn, ROOT, "t", real_pdf, title="dupe", custodian="City")
check("re-ingesting identical bytes is a no-op", again["status"] == "already-held")
check("vault file exists", (ROOT / "vault" / r1["sha256"][:2] / r1["sha256"]).is_file())
check("vault verifies clean", ingest.verify_vault(conn) == [])


# ── gates ─────────────────────────────────────────────────────────────────
print("\nGATES")


def claim(text, tier, **kw):
    cur = conn.execute(
        "INSERT INTO claims (case_id,text,tier,formula,outlet,closing_gate,resolution,"
        "created,updated) VALUES (1,?,?,?,?,?,?,'2026-01-01T00:00:00+00:00',"
        "'2026-01-01T00:00:00+00:00')",
        (text, tier, kw.get("formula"), kw.get("outlet"),
         kw.get("gate"), kw.get("resolution")))
    return cur.lastrowid


def failing(cid) -> set[str]:
    return {b["gate"] for b in gates.run(conn, cid)["blocks"]}


c = claim("The contract commits $328,000.", "GREEN")
check("GREEN with no citation is blocked", "UNCITED" in failing(c))

conn.execute("INSERT INTO citations (claim_id,doc_id,locator,quote) VALUES (?,?,?,?)",
             (c, r3["id"], "p.1", ""))   # r3 is DERIVED
check("GREEN citing derived work is blocked", "PRIMARY_ONLY" in failing(c))

conn.execute("DELETE FROM citations WHERE claim_id=?", (c,))
conn.execute("INSERT INTO citations (claim_id,doc_id,locator,quote) VALUES (?,?,?,?)",
             (c, r1["id"], "p.1", "TOTAL $328,000.00"))
check("GREEN citing a primary source clears", gates.run(conn, c)["publishable"])

c2 = claim("The city has not produced Exhibit C.", "RED")
check("RED written as a statement is blocked", "RED_AS_FACT" in failing(c2))
conn.execute("UPDATE claims SET text=?, closing_gate=? WHERE id=?",
             ("Has the city produced Exhibit C?", "The signed Exhibit C.", c2))
check("RED as a question with a gate clears", gates.run(conn, c2)["publishable"])

c3 = claim("Each camera costs $6,000.", "ARITH")
check("ARITH without its formula is blocked", "UNLABELED_ARITH" in failing(c3))
conn.execute("UPDATE claims SET formula='228000 / 38 = 6000' WHERE id=?", (c3,))
conn.execute("INSERT INTO citations (claim_id,doc_id,locator) VALUES (?,?,'p.1')",
             (c3, r1["id"]))
check("ARITH with its formula clears", gates.run(conn, c3)["publishable"])

c4 = claim("The award was worth $42.3 million.", "REPORTED")
check("REPORTED with no outlet is blocked", "REPORTED_AS_DOC" in failing(c4))
conn.execute("UPDATE claims SET outlet='Signal Cleveland' WHERE id=?", (c4,))
check("REPORTED naming its outlet clears", gates.run(conn, c4)["publishable"])

c5 = claim("An apparent Ohio/Delaware governing-law conflict.", "DEAD")
check("DEAD with no resolution is blocked", "DEAD_UNEXPLAINED" in failing(c5))
conn.execute("UPDATE claims SET resolution='Delaware is scoped to the records "
             "safe-harbour clause only.' WHERE id=?", (c5,))
check("DEAD carrying its explanation clears", gates.run(conn, c5)["publishable"])


# ── the $880,000 gate ─────────────────────────────────────────────────────
print("\nRETIRED FIGURES")
c6 = claim("The Flock contract totals $880,000.", "GREEN")
conn.execute("INSERT INTO citations (claim_id,doc_id,locator) VALUES (?,?,'p.1')",
             (c6, r1["id"]))
check("before the correction, it passes", gates.run(conn, c6)["publishable"])

cli(["--root", str(ROOT), "correct", "C-4", "Flock total was wrong",
     "--retire", "880000", "--reason", "PO483191 states $228,000 on its face"])
conn2 = store.open_db(ROOT)
check("after the correction, it is blocked",
      "RETIRED_FIGURE" in {b["gate"] for b in gates.run(conn2, c6)["blocks"]})
check("a differently formatted write of it is also caught",
      "RETIRED_FIGURE" in {b["gate"] for b in gates.run(conn2, claim(
          "Columbus paid $880,000.00 for the cameras.", "GREEN"))["blocks"]})
check("the correct figure is untouched",
      "RETIRED_FIGURE" not in {b["gate"] for b in gates.run(conn2, claim(
          "Columbus paid $228,000.", "GREEN"))["blocks"]})
conn2.close()


# ── export ────────────────────────────────────────────────────────────────
print("\nEXPORT")
res = export.write(conn, ROOT, "t")
md = (Path(res["dir"]) / "dossier.md").read_text()
fj = json.loads((Path(res["dir"]) / "findings.json").read_text())

check("blocked claims are absent from the dossier body",
      "$880,000" not in md.split("## Withheld")[0])
check("but the omission is visible", "Withheld from this packet" in md)
check("open questions are posed as questions",
      "Has the city produced Exhibit C?" in md)
check("arithmetic shows its working", "228000 / 38 = 6000" in md)
check("reported material names the outlet", "Signal Cleveland" in md)
check("dead ends carry what closed them", "safe-harbour clause" in md)
check("hashes travel with the evidence register", r1["sha256"] in md)

tiers = {f["tier"] for f in fj["findings"]}
check("six desk tiers collapse to three on screen",
      tiers <= {"GREEN", "RED_APPLE", "DEAD_END"}, str(tiers))
red = [f for f in fj["findings"] if f["tier"] == "RED_APPLE"]
check("RED_APPLE exports as a question, not a claim",
      red and "question" in red[0] and "claim" not in red[0])

# The findings deck must survive the video pipeline's own front door.
try:
    from sentinel_video.findings import load_deck
    deck, errs, _ = load_deck({k: v for k, v in fj.items() if not k.startswith("_")})
    check("export is accepted by the video pipeline", errs == [], "; ".join(errs))
except ImportError:
    check("export is accepted by the video pipeline", False, "sentinel_video not importable")


# ── audit chain ───────────────────────────────────────────────────────────
print("\nAUDIT CHAIN")
ok, msg = audit.verify(conn)
check("chain verifies", ok, msg)
check("chain mirrored to disk", (ROOT / "audit.jsonl").is_file())
n_disk = len((ROOT / "audit.jsonl").read_text().strip().splitlines())
n_db = conn.execute("SELECT COUNT(*) FROM audit").fetchone()[0]
check("mirror and table agree", n_disk == n_db, f"{n_disk} vs {n_db}")

# Tamper with a row and confirm the chain names the break.
#
# The append-only TRIGGERS have to be dropped first, and that is the point of
# the exercise rather than a workaround. There are three locks on this table:
# no update/delete function in audit.py, the triggers, and the hash chain. The
# first two stop accidents. Only the third works against someone who is
# trying — someone editing the SQLite file with another tool, which is exactly
# what dropping the trigger here simulates.
check("the trigger refuses an ordinary UPDATE", _trigger_blocks(conn))
conn.execute("DROP TRIGGER audit_no_update")
conn.execute("UPDATE audit SET payload='{\"tampered\":true}' WHERE seq=2")
ok2, msg2 = audit.verify(conn)
check("editing a row breaks the chain", not ok2, msg2)
check("and the break is located", "seq 3" in msg2 or "Row 2" in msg2, msg2)

conn.close()
shutil.rmtree(ROOT, ignore_errors=True)


# ── security self-audit ───────────────────────────────────────────────────
print("\nSECURITY SELF-AUDIT")
from sentinel import security  # noqa: E402

R2 = Path(tempfile.mkdtemp(prefix="sentinel-sec-"))
c2 = store.open_db(R2)
secres = {c.id: c for c in security.audit_desk(c2, R2)}

check("no third-party import in the desk", secres["SC-1"].result == security.PASS,
      secres["SC-1"].detail)
check("the boundary is proved at runtime, not asserted",
      secres["SC-2"].result == security.PASS)
check("the dashboard binds localhost only", secres["SC-3"].result == security.PASS)
check("store is created owner-only", secres["SC-5"].result == security.PASS,
      secres["SC-5"].detail)
check("every check carries a CSF mapping",
      all(c.csf for c in secres.values()),
      str([c.id for c in secres.values() if not c.csf]))

# FAIL paths must actually fire, or the audit is decoration.
c2.execute("INSERT INTO cases (slug,title,jurisdiction,status,opened,updated) "
           "VALUES ('s','S','O','OPEN','2026-01-01','2026-01-01')")
victim = R2 / "victim.txt"
victim.write_text("original bytes")
d = ingest.ingest(c2, R2, "s", victim, title="Victim", custodian="X")
Path(d["vault"]).write_text("SOMEONE CHANGED THIS")
check("altering a vaulted file is caught",
      {c.id: c for c in security.audit_desk(c2, R2)}["SC-7"].result == security.FAIL)

c2.execute("DROP TRIGGER audit_no_update")   # lock 2; the chain is lock 3
c2.execute("UPDATE audit SET payload='{\"x\":1}' WHERE seq=1")
check("a tampered audit row is caught",
      {c.id: c for c in security.audit_desk(c2, R2)}["SC-8"].result == security.FAIL)

check("--strict exits non-zero on FAIL",
      any(c.result == security.FAIL for c in security.audit_desk(c2, R2)))

rep = security.report(list(security.audit_desk(c2, R2)))
check("the report leads with failures", rep.index("FAIL]") < rep.index("[ok"))
c2.close()
shutil.rmtree(R2, ignore_errors=True)


# ═══════════════════════════════════════════════════════════════════════════
# ORIGIN AND HUMAN DISPOSITION
#
# A machine-drafted claim and a hand-entered one are indistinguishable in the
# ledger about a week later. The ledger outlives anyone's memory of which was
# which, so the row has to carry it and the gate has to enforce it.
# ═══════════════════════════════════════════════════════════════════════════
def test_origin_and_disposition():
    import sqlite3
    import tempfile
    from pathlib import Path
    from sentinel import store, gates

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        conn = store.open_db(root)
        conn.execute("INSERT INTO cases (slug,title,status,opened) "
                     "VALUES ('c','C','OPEN','2026-01-01T00:00:00+00:00')")

        def mk(text, origin, disposed=None):
            now = "2026-08-26T00:00:00+00:00"
            cur = conn.execute(
                "INSERT INTO claims (case_id,text,tier,closing_gate,created,updated,"
                "origin,disposed_by) VALUES (1,?,'RED','a record',?,?,?,?)",
                (text, now, now, origin, disposed))
            return cur.lastrowid

        def blocked(cid):
            return [g["gate"] for g in gates.evaluate(conn, cid)
                    if not g["passed"] and g["level"] == gates.BLOCK]

        human = mk("A human question?", "human")
        check("a human-entered claim is not blocked for disposition",
           "MACHINE_UNDISPOSED" not in blocked(human))

        machine = mk("A drafted question?", "machine")
        check("a machine-drafted claim IS blocked until a person disposes of it",
           "MACHINE_UNDISPOSED" in blocked(machine))

        conn.execute("UPDATE claims SET disposed_by='Someone' WHERE id=?", (machine,))
        check("and clears once disposed",
           "MACHINE_UNDISPOSED" not in blocked(machine))

        # A claim from before the column existed. Backfilling it as 'human'
        # would assert something nobody can support -- and would launder
        # exactly the drafted claims this exists to keep visible.
        unknown = mk("An old question?", "unknown")
        check("a pre-origin claim is treated as needing disposition, not as human",
           "MACHINE_UNDISPOSED" in blocked(unknown))

        # The gate ignores tier on purpose: attaching a citation is not the
        # same act as reading the document and deciding.
        conn.execute("UPDATE claims SET tier='GREEN' WHERE id=?", (machine,))
        conn.execute("UPDATE claims SET disposed_by=NULL WHERE id=?", (machine,))
        check("promoting a machine claim to GREEN does not bypass disposition",
           "MACHINE_UNDISPOSED" in blocked(machine))


def test_migration_is_additive_and_idempotent():
    import sqlite3
    import tempfile
    from pathlib import Path
    from sentinel import store

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        db = root / "sentinel.db"
        c = sqlite3.connect(db, isolation_level=None)
        c.executescript(store.SCHEMA)
        # Rebuild claims the way it looked before origin tracking.
        c.execute("DROP TABLE claims")
        c.execute("""CREATE TABLE claims (
          id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES cases(id),
          text TEXT NOT NULL, tier TEXT NOT NULL, formula TEXT, outlet TEXT,
          closing_gate TEXT, resolution TEXT, created TEXT, updated TEXT)""")
        c.execute("INSERT INTO cases (slug,title,status,opened) "
                  "VALUES ('x','X','OPEN','2026-01-01T00:00:00+00:00')")
        c.execute("INSERT INTO claims (case_id,text,tier,created,updated) "
                  "VALUES (1,'old','RED','2026-01-01T00:00:00+00:00',"
                  "'2026-01-01T00:00:00+00:00')")
        c.close()

        conn = store.open_db(root)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(claims)")}
        check("migrate adds the origin columns to an existing desk",
           {"origin", "origin_note", "disposed_by", "disposed_at"} <= cols)
        check("a pre-existing claim survives the migration",
           conn.execute("SELECT COUNT(*) FROM claims").fetchone()[0] == 1)
        check("and is recorded as 'unknown', never backfilled as 'human'",
           conn.execute("SELECT origin FROM claims").fetchone()[0] == "unknown")

        applied = store.migrate(conn)
        check("running migrate again changes nothing", applied == [])


def test_stale_gate_survives_a_naive_timestamp():
    """A gate that CRASHES runs no other gate.

    STALE_GATE caught ValueError but not TypeError, so a claim whose `created`
    had no timezone killed the whole evaluation -- and sailed past UNCITED,
    PRIMARY_ONLY and everything else by dying before they were reached.
    """
    import tempfile
    from pathlib import Path
    from sentinel import store, gates

    with tempfile.TemporaryDirectory() as td:
        conn = store.open_db(Path(td))
        conn.execute("INSERT INTO cases (slug,title,status,opened) "
                     "VALUES ('c','C','OPEN','2026-01-01T00:00:00+00:00')")
        for stamp in ("2026-01-01", "not a date at all", ""):
            cur = conn.execute(
                "INSERT INTO claims (case_id,text,tier,closing_gate,created,updated,"
                "origin,disposed_by) VALUES (1,'q?','RED','g',?,?, 'human','x')",
                (stamp, stamp))
            res = gates.evaluate(conn, cur.lastrowid)
            check(f"a claim with created={stamp!r} still evaluates every gate",
               len(res) >= 8, f"{len(res)} gates ran")


test_origin_and_disposition()
test_migration_is_additive_and_idempotent()
test_stale_gate_survives_a_naive_timestamp()



def test_claim_list_is_reachable_and_honest():
    """`claim dispose` and `cite` both take a claim id.

    Until this existed there was no way to obtain one, so both commands were
    documented and unreachable.
    """
    import io as _io
    import contextlib
    import tempfile
    from pathlib import Path
    from types import SimpleNamespace
    from sentinel import store
    from sentinel.cli import cmd_claim_list

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        conn = store.open_db(root)
        now = "2026-08-26T00:00:00+00:00"
        conn.execute("INSERT INTO cases (slug,title,status,opened) "
                     "VALUES ('c','C','OPEN',?)", (now,))
        conn.execute("INSERT INTO claims (case_id,text,tier,closing_gate,created,"
                     "updated,origin) VALUES (1,'A drafted question?','RED','g',?,?,"
                     "'machine')", (now, now))
        conn.execute("INSERT INTO claims (case_id,text,tier,closing_gate,created,"
                     "updated,origin,disposed_by) VALUES (1,'A typed question?','RED',"
                     "'g',?,?,'human','Mark')", (now, now))

        def run(**kw):
            base = dict(case=None, needs_disposition=False, blocked=False, tier=None)
            base.update(kw)
            a = SimpleNamespace(**base)
            buf = _io.StringIO()
            with contextlib.redirect_stdout(buf):
                cmd_claim_list(a, conn, root)
            return buf.getvalue()

        out = run()
        check("claim list shows claim ids", " 1 " in out and " 2 " in out, out)
        check("a machine-drafted claim is labelled as one",
              "[machine-drafted]" in out, out)
        check("and the count of what needs a person is surfaced",
              "need a person to dispose" in out, out)

        only = run(needs_disposition=True)
        check("--needs-disposition shows only the undisposed",
              "A drafted question?" in only and "A typed question?" not in only, only)

        # An empty case and a case that does not exist are different facts.
        a = SimpleNamespace(case="nope", needs_disposition=False, blocked=False,
                            tier=None)
        raised = False
        try:
            with contextlib.redirect_stdout(_io.StringIO()):
                cmd_claim_list(a, conn, root)
        except KeyError:
            raised = True
        check("listing a case that does not exist raises rather than printing 'none'",
              raised)


test_claim_list_is_reachable_and_honest()



def test_ready_reports_distance_and_the_next_command():
    """A blocker with no stated remedy is a complaint, not a step.

    `gate run` says what is wrong; it does not say what to type. On a case
    with eight blocked claims that gap is the whole distance between an
    operator who publishes and one who has a very good library.
    """
    import io as _io, contextlib, tempfile
    from pathlib import Path
    from types import SimpleNamespace
    from sentinel import store
    from sentinel.cli import cmd_ready

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        conn = store.open_db(root)
        now = "2026-08-26T00:00:00+00:00"
        conn.execute("INSERT INTO cases (slug,title,status,opened) "
                     "VALUES ('c','C','OPEN',?)", (now,))
        for i in range(3):
            conn.execute("INSERT INTO claims (case_id,text,tier,closing_gate,"
                         "created,updated,origin) VALUES (1,?, 'RED','g',?,?,'machine')",
                         (f"Q{i}?", now, now))

        def run():
            buf = _io.StringIO()
            with contextlib.redirect_stdout(buf):
                cmd_ready(SimpleNamespace(case="c"), conn, root)
            return buf.getvalue()

        out = run()
        check("ready counts the claims", "claims       3" in out, out)
        check("and reports nothing publishable while all are undisposed",
              "PUBLISHABLE NOW   0 of 3" in out, out)
        check("it names the blocking gate", "MACHINE_UNDISPOSED" in out, out)
        check("and prints the command that clears it",
              "claim dispose 1" in out, out)
        check("an empty vault is stated, not implied",
              "documents    0 in the vault" in out, out)

        conn.execute("UPDATE claims SET disposed_by='Mark' WHERE id=1")
        out = run()
        check("disposing one claim moves the publishable count",
              "PUBLISHABLE NOW   1 of 3" in out, out)
        check("and the blocker now names only the remaining claims",
              "claims: 2, 3" in out, out)

        conn.execute("UPDATE claims SET disposed_by='Mark'")
        out = run()
        check("with nothing blocking it says so and names the export command",
              "Nothing is blocking" in out and "sdesk export c" in out, out)


test_ready_reports_distance_and_the_next_command()

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
