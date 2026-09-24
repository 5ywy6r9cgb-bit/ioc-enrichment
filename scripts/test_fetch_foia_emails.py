#!/usr/bin/env python3
"""
test_fetch_foia_emails.py — no network, no mailbox, no credentials.

Every message is built in memory. Where a check is about a defect, the same
input is first run through the ORIGINAL script (fetch_foia_emails.orig.py,
if present beside this file) to show the defect was real, and then through
the fixed one to show it is gone. A test that only proves the new code
works is half a test; the other half is proof there was something to fix.

    python3 test_fetch_foia_emails.py
"""

import importlib.util
import json
import os
import sys
import tempfile
from email.message import EmailMessage
from pathlib import Path

HERE = Path(__file__).resolve().parent
PASSED = FAILED = 0
FAILURES = []


def check(label, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print(f"    PASS  {label}")
    else:
        FAILED += 1
        FAILURES.append(label)
        print(f"    FAIL  {label}" + (f"  — {detail}" if detail else ""))


def suite(name):
    print(f"\n  {name}")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


F = load(HERE / "fetch_foia_emails.py", "fixed")
ORIG_PATH = HERE / "fetch_foia_emails.orig.py"
O = load(ORIG_PATH, "orig") if ORIG_PATH.exists() else None


def message(*attachments, sender="Records <records@columbus.gov>"):
    m = EmailMessage()
    m["From"] = sender
    m["Subject"] = "Your public records request"
    m.set_content("Please find attached the responsive records.")
    for name, data in attachments:
        m.add_attachment(data, maintype="application", subtype="octet-stream", filename=name)
    return m


def sandbox():
    d = Path(tempfile.mkdtemp(prefix="foia-test-"))
    (d / "work").mkdir()
    return d


# ════════════════════════════════════════════════════════════ path traversal
suite("an attachment name can never choose where the file lands")

if O:
    box = sandbox()
    os.chdir(box / "work")
    # records/RR-2026-1/../../ is the working directory — outside records/.
    O.save_attachments(message(("../../escaped.txt", b"planted")), "RR-2026-1")
    check("ORIGINAL: '../../escaped.txt' wrote OUTSIDE records/ — the defect was real",
          (box / "work" / "escaped.txt").exists())
    O.save_attachments(message(("../../../climbed.txt", b"planted")), "RR-2026-1")
    check("ORIGINAL: one more '../' climbs out of the working directory too",
          (box / "climbed.txt").exists())

    target = box / "absolute-target.txt"
    O.save_attachments(message((str(target), b"planted")), "RR-2026-1")
    check("ORIGINAL: an absolute name REPLACED the destination directory entirely",
          target.exists())

box = sandbox()
records = box / "work" / "records"
out = F.save_attachments(message(("../../escaped.txt", b"planted")), "RR-2026-1", records, {})
check("FIXED: '../../escaped.txt' does not escape",
      not (box / "work" / "escaped.txt").exists() and not (box / "escaped.txt").exists())
F.save_attachments(message(("../../../climbed.txt", b"planted")), "RR-2026-1", records, {})
check("FIXED: nor does '../../../climbed.txt'", not (box / "climbed.txt").exists())
check("nothing at all exists outside records/",
      all(F.inside(p, records) for p in box.rglob("*") if p.is_file()),
      [str(p) for p in box.rglob("*") if p.is_file() and not F.inside(p, records)])
check("and it IS saved, inside records/, under a clean name",
      Path(out[0]["saved_path"]).exists() and F.inside(Path(out[0]["saved_path"]), records),
      out[0].get("saved_path"))
check("and the review entry says it was renamed", out[0].get("renamed_to") == "escaped.txt",
      out[0].get("renamed_to"))
check("keeping the name the agency actually sent", out[0]["filename"] == "../../escaped.txt")

target = box / "absolute-target.txt"
out = F.save_attachments(message((str(target), b"planted")), "RR-2026-1", records, {})
check("FIXED: an absolute name cannot replace the destination", not target.exists())
check("it lands inside records/", F.inside(Path(out[0]["saved_path"]), records))

for raw, want in [
    ("..\\..\\windows-style.txt", "windows-style.txt"),
    ("C:\\Users\\clerk\\Desktop\\report.pdf", "report.pdf"),
    ("..", "attachment"),
    ("...", "attachment"),
    ("", "attachment"),
    (".hidden-record.pdf", "hidden-record.pdf"),
    ("bad\x00name\x07.pdf", "bad_name_.pdf"),
    ('a:b*c?"d<e>f|g.pdf', "a_b_c__d_e_f_g.pdf"),
]:
    got = F.safe_filename(raw)
    check(f"safe_filename({raw!r}) -> {want!r}", got == want, f"got {got!r}")

long_name = "x" * 400 + ".pdf"
got = F.safe_filename(long_name)
check("an overlong name is capped", len(got) <= F.MAX_NAME_LEN, str(len(got)))
check("and keeps its extension", got.endswith(".pdf"))

check("the folder half of the path is cleaned too",
      F.safe_folder_key("../../etc") == "etc", F.safe_folder_key("../../etc"))

# ════════════════════════════════════════════════════════════ size limits
suite("one message cannot fill the disk, and nothing is dropped silently")

box = sandbox()
records = box / "records"
old_a, old_m = F.MAX_ATTACHMENT_BYTES, F.MAX_MESSAGE_BYTES
F.MAX_ATTACHMENT_BYTES, F.MAX_MESSAGE_BYTES = 1000, 1500
try:
    out = F.save_attachments(message(("huge.pdf", b"x" * 2000)), "RR-2026-2", records, {})
    check("an attachment over the limit is not written",
          not any(records.rglob("huge.pdf")))
    check("but it is still listed in the review entry", out and out[0]["filename"] == "huge.pdf")
    check("with the reason it was held back", "per-attachment limit" in out[0].get("held_back", ""))
    check("and its real size", out[0]["size_bytes"] == 2000)

    out = F.save_attachments(message(("a.pdf", b"a" * 900), ("b.pdf", b"b" * 900)),
                             "RR-2026-3", records, {})
    check("the first attachment under the message limit is written", "saved_path" in out[0])
    check("the one that would cross it is held back",
          "per-message limit" in out[1].get("held_back", ""), out[1])
finally:
    F.MAX_ATTACHMENT_BYTES, F.MAX_MESSAGE_BYTES = old_a, old_m

# ════════════════════════════════════════════════════════════ duplicates
suite("running it twice does not copy every record twice")

if O:
    box = sandbox()
    os.chdir(box)
    msg = message(("response.pdf", b"%PDF the agency's records"))
    for _ in range(3):
        O.save_attachments(msg, "RR-2026-4")
    copies = list((box / "records" / "RR-2026-4").iterdir())
    check(f"ORIGINAL: three runs made {len(copies)} copies of one record",
          len(copies) == 3, [c.name for c in copies])

box = sandbox()
records = box / "records"
manifest = {}
msg = message(("response.pdf", b"%PDF the agency's records"))
runs = [F.save_attachments(msg, "RR-2026-4", records, manifest) for _ in range(3)]
files = [p for p in (records / "RR-2026-4").iterdir()]
check("FIXED: three runs, one file", len(files) == 1, [f.name for f in files])
check("later runs point at the first copy",
      runs[1][0].get("duplicate_of_earlier_copy") and runs[1][0]["saved_path"] == runs[0][0]["saved_path"])
check("the digest is recorded, so the file can be verified later",
      runs[0][0]["sha256"] == __import__("hashlib").sha256(b"%PDF the agency's records").hexdigest())

out = F.save_attachments(message(("response.pdf", b"DIFFERENT bytes, same name")),
                         "RR-2026-4", records, manifest)
check("different bytes under the same name are kept, not treated as a duplicate",
      not out[0].get("duplicate_of_earlier_copy") and Path(out[0]["saved_path"]).exists())
check("and do not overwrite the first", (records / "RR-2026-4" / "response.pdf").read_bytes()
      == b"%PDF the agency's records")

F.save_manifest(records, manifest)
check("the manifest survives a restart", F.load_manifest(records) == manifest)

(records / F.MANIFEST_NAME).write_text("{ not json")
try:
    F.load_manifest(records)
    check("a corrupt manifest stops the run rather than starting over", False)
except SystemExit as e:
    check("a corrupt manifest stops the run rather than starting over", "not valid JSON" in str(e))

# ════════════════════════════════════════════════════════════ domains
suite("the sender's ADDRESS decides the agency, not the display name")

cases = [
    ('Records <records@columbus.gov>', "Columbus Division of Police"),
    ('records@columbus.gov', "Columbus Division of Police"),
    ('Clerk <clerk@police.columbus.gov>', "Columbus Division of Police"),
    ('"columbus.gov" <anyone@elsewhere.example>', None),
    ('Someone <someone@notcolumbus.gov>', None),
    ('Someone <someone@columbus.gov.elsewhere.example>', None),
    ('PUCO <docketing@puco.ohio.gov>', "PUCO"),
    ('no address at all', None),
    ('', None),
]
if O:
    check("ORIGINAL: a display name of \"columbus.gov\" matched Columbus police",
          O.match_agency_by_domain('"columbus.gov" <anyone@elsewhere.example>')
          == "Columbus Division of Police")
    check("ORIGINAL: notcolumbus.gov matched Columbus police",
          O.match_agency_by_domain("someone@notcolumbus.gov") == "Columbus Division of Police")
for sender, want in cases:
    got = F.match_agency_by_domain(sender)
    check(f"FIXED: {sender!r} -> {want!r}", got == want, f"got {got!r}")

# ════════════════════════════════════════════════════════════ review merge
suite("a re-run never undoes a decision made in the dashboard")

existing = [
    {"message_hash": "aaa", "subject": "old", "accepted": True, "reviewer_note": "confirmed by phone"},
    {"message_hash": "gone", "subject": "moved out of the folder", "accepted": True},
]
fresh = [
    {"message_hash": "aaa", "subject": "old (refetched)", "accepted": False},
    {"message_hash": "bbb", "subject": "new", "accepted": False},
]
merged = {e["message_hash"]: e for e in F.merge_review(existing, fresh)}
check("an accepted entry stays accepted", merged["aaa"]["accepted"] is True)
check("a note the dashboard added is kept", merged["aaa"].get("reviewer_note") == "confirmed by phone")
check("machine fields are refreshed", merged["aaa"]["subject"] == "old (refetched)")
check("a new message arrives unaccepted", merged["bbb"]["accepted"] is False)
check("a message no longer in the folder keeps its history", "gone" in merged)

box = sandbox()
bad = box / "review_queue.json"
bad.write_text("[ broken")
try:
    F.load_review(bad)
    check("a corrupt review file is refused, not overwritten", False)
except SystemExit as e:
    check("a corrupt review file is refused, not overwritten",
          "not valid JSON" in str(e) and bad.read_text() == "[ broken")

# ════════════════════════════════════════════════════════════ report
print()
total = PASSED + FAILED
if FAILED:
    print(f"  FAIL — {FAILED} of {total} checks failed")
    for f in FAILURES:
        print(f"    {f}")
else:
    print(f"  PASS — {total}/{total} checks")
if not O:
    print("  (fetch_foia_emails.orig.py not found beside this file — the "
          "before/after demonstrations were skipped)")
sys.exit(1 if FAILED else 0)
