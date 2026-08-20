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
             "VALUES ('t','Test Case','Ohio','ACTIVE','2026-01-01','2026-01-01')")

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

c2.execute("UPDATE audit SET payload='{\"x\":1}' WHERE seq=1")
check("a tampered audit row is caught",
      {c.id: c for c in security.audit_desk(c2, R2)}["SC-8"].result == security.FAIL)

check("--strict exits non-zero on FAIL",
      any(c.result == security.FAIL for c in security.audit_desk(c2, R2)))

rep = security.report(list(security.audit_desk(c2, R2)))
check("the report leads with failures", rep.index("FAIL]") < rep.index("[ok"))
c2.close()
shutil.rmtree(R2, ignore_errors=True)


print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
