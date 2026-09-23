#!/usr/bin/env python3
"""
shelf.py — the growth pipeline from the v0.7 audit, §7.

    PRIMARY FILE -> magic -> sha256 -> custody -> PRIMARY SHELF
                                                      |
                                        native ---+---+--- OCR
                                                  |
                                            DERIVED SHELF
                                                  |
                                              reindex
                                                  |
                                    search / leads / contradictions
                                                  |
                                            HUMAN REVIEW

WHAT THIS DOES NOT DO, ON PURPOSE
  - never writes to the PRA metadata database. Full text and machine-derived
    material stay outside it. That property is the strongest thing in your
    existing design and this script is not permitted to weaken it.
  - never marks a claim GREEN, never passes a gate, never publishes.
  - never treats OCR output as primary. Every derived file records the sha256
    of the primary it came from and is stamped DERIVED.
  - never mutates the custody ledger. Append only.

COMMANDS
  ingest <path...>     validate, hash, record custody, shelve read-only
  derive [--ocr]       native text first; OCR only where there is no text layer
  index                build the text shelf for search
  find "<q>" ["<q>"…]  search, and report what the search could NOT see
  contradict           candidate disagreements between documents
  status               census of every shelf

EXIT  0 ok · 3 refused (something failed validation) · 4 cannot verify
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(os.environ.get("SHELF_ROOT", "shelf"))
PRIMARY, DERIVED, INDEX, LEDGER = (ROOT/"primary", ROOT/"derived",
                                   ROOT/"index", ROOT/"ledger")
CUSTODY = LEDGER/"custody.jsonl"
OK, REFUSED, CANNOT = 0, 3, 4

# magic bytes -> what the file actually is. An extension is a claim, not a fact.
MAGIC = [
    (b"%PDF-",              "pdf"),
    (b"\x89PNG\r\n\x1a\n",  "png"),
    (b"\xff\xd8\xff",       "jpg"),
    (b"PK\x03\x04",         "zip"),
    (b"II*\x00",            "tif"),
    (b"MM\x00*",            "tif"),
    (b"{\\rtf",             "rtf"),
    (b"\xd0\xcf\x11\xe0",   "ole"),
]
EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sniff(head: bytes) -> str:
    for sig, kind in MAGIC:
        if head.startswith(sig):
            return kind
    try:
        head.decode("utf-8")
        return "text"
    except UnicodeDecodeError:
        return "unknown"


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ledger(rec: dict):
    LEDGER.mkdir(parents=True, exist_ok=True)
    with open(CUSTODY, "a") as f:                 # append only. never rewrite.
        f.write(json.dumps(rec, sort_keys=True) + "\n")


def shelved(sha: str):
    d = PRIMARY / sha[:2]
    return next((p for p in d.glob(sha + ".*") if p.suffix != ".json"), None) \
        if d.exists() else None


# ── ingest ────────────────────────────────────────────────────────────────
def cmd_ingest(a):
    worst = OK
    for arg in a.paths:
        p = Path(arg)
        if not p.is_file():
            print(f"  CANNOT VERIFY  {arg}: not a file"); worst = max(worst, CANNOT); continue

        size = p.stat().st_size
        if size == 0:
            print(f"  REFUSED  {p.name}: zero bytes. You have nothing.")
            worst = max(worst, REFUSED); continue

        with open(p, "rb") as f:
            head = f.read(16)
        actual = sniff(head)
        claimed = p.suffix.lower().lstrip(".") or "(none)"
        sha = sha256_of(p)

        if sha == EMPTY_SHA:
            print(f"  REFUSED  {p.name}: hashes as empty file")
            worst = max(worst, REFUSED); continue
        if actual == "unknown":
            print(f"  REFUSED  {p.name}: magic bytes unrecognised — corrupt, "
                  f"encrypted or truncated. Re-request it.")
            worst = max(worst, REFUSED); continue

        # An extension is a claim. The allowance is per (actual, claimed) pair —
        # a text file named .md is fine; a text file named .pdf is the lie this
        # check exists to catch, so never allow "actual is text" on its own.
        norm = {"jpeg":"jpg","tiff":"tif","htm":"html","yml":"yaml"}.get(claimed, claimed)
        ALLOWED = {
            "text": {"txt","md","csv","tsv","json","log","html","xml","yaml",
                     "sql","py","js","eml","vcf","(none)"},
            "zip":  {"zip","docx","xlsx","pptx","odt","ods","epub","jar"},
            "ole":  {"doc","xls","ppt","msg"},
            "rtf":  {"rtf","doc"},
        }
        mismatch = norm != actual and norm not in ALLOWED.get(actual, set())

        prior = shelved(sha)
        if prior:
            print(f"  DUPLICATE  {p.name}\n      already shelved as {prior.name}")
            ledger({"utc":now(),"event":"ingest_duplicate","sha256":sha,
                    "original_name":p.name,"shelved_as":prior.name})
            continue

        dest_dir = PRIMARY / sha[:2]; dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{sha}.{actual}"
        shutil.copy2(p, dest)
        os.chmod(dest, 0o444)                     # the primary is not editable

        meta = {"sha256":sha,"original_name":p.name,"original_path":str(p.resolve()),
                "bytes":size,"magic":actual,"claimed_extension":claimed,
                "extension_mismatch":bool(mismatch),"received_utc":now(),
                "shelf":"PRIMARY"}
        dest.with_suffix(dest.suffix + ".meta.json").write_text(
            json.dumps(meta, indent=2, sort_keys=True))
        ledger({"utc":now(),"event":"ingest","sha256":sha,
                "original_name":p.name,"bytes":size,"magic":actual,
                "extension_mismatch":bool(mismatch)})

        flag = "  ** EXTENSION MISMATCH **" if mismatch else ""
        print(f"  SHELVED  {p.name}  [{actual}, {size:,} B]{flag}")
        print(f"      sha256 {sha}")
        if mismatch:
            print(f"      the file claims .{claimed} and is actually {actual}. "
                  f"Shelved anyway — the record is what arrived — but do not "
                  f"describe it by its extension.")
            worst = max(worst, REFUSED)
    return worst


# ── derive ────────────────────────────────────────────────────────────────
MIN_CHARS = 120        # below this a PDF has no usable text layer

def native_text(p: Path, kind: str):
    if kind == "pdf":
        try:
            r = subprocess.run(["pdftotext","-layout",str(p),"-"],
                               capture_output=True, text=True, timeout=180)
            return (r.stdout, "pdftotext -layout") if r.returncode == 0 else (None, None)
        except FileNotFoundError:
            return (None, "MISSING pdftotext")
        except subprocess.TimeoutExpired:
            return (None, "TIMEOUT")
    if kind in ("text","rtf"):
        return (p.read_text(errors="replace"), "read")
    return (None, None)


def cmd_derive(a):
    DERIVED.mkdir(parents=True, exist_ok=True)
    made = ocr_needed = skipped = 0
    worst = OK
    for meta_p in sorted(PRIMARY.rglob("*.meta.json")):
        m = json.loads(meta_p.read_text())
        sha, kind = m["sha256"], m["magic"]
        # meta files end ".meta.json" — two suffixes, so with_suffix("") is wrong
        prim = Path(str(meta_p)[:-len(".meta.json")])
        out = DERIVED / f"{sha}.txt"
        if out.exists() and not a.force:
            skipped += 1; continue

        txt, method = native_text(prim, kind)
        if method and method.startswith(("MISSING","TIMEOUT")):
            print(f"  CANNOT VERIFY  {sha[:12]}… {method}"); worst = max(worst, CANNOT); continue

        if txt is not None and len(txt.strip()) >= MIN_CHARS:
            out.write_text(txt)
            DERIVED.joinpath(f"{sha}.derived.json").write_text(json.dumps(
                {"DERIVED":True,"source_sha256":sha,"method":method,
                 "chars":len(txt),"created_utc":now(),
                 "note":"Derived from the primary. NOT primary evidence."},
                indent=2, sort_keys=True))
            ledger({"utc":now(),"event":"derive","sha256":sha,
                    "method":method,"chars":len(txt)})
            made += 1
            print(f"  TEXT     {sha[:12]}…  {len(txt):>8,} chars  ({method})")
        else:
            ocr_needed += 1
            print(f"  NO TEXT LAYER  {sha[:12]}…  {m['original_name']}")
            if a.ocr:
                if shutil.which("ocrmypdf") is None:
                    print("      ocrmypdf not installed — skipping"); worst = max(worst, CANNOT); continue
                tmp = DERIVED / f"{sha}.ocr.pdf"
                r = subprocess.run(["ocrmypdf","--skip-text","--quiet",
                                    str(prim), str(tmp)],
                                   capture_output=True, text=True)
                if r.returncode == 0:
                    t,_ = native_text(tmp, "pdf")
                    if t:
                        out.write_text(t)
                        DERIVED.joinpath(f"{sha}.derived.json").write_text(json.dumps(
                            {"DERIVED":True,"source_sha256":sha,"method":"ocrmypdf",
                             "chars":len(t),"created_utc":now(),
                             "note":"OCR OUTPUT. Never cite this as the record."},
                            indent=2, sort_keys=True))
                        ledger({"utc":now(),"event":"derive_ocr","sha256":sha,"chars":len(t)})
                        made += 1; print(f"      OCR -> {len(t):,} chars")
                    tmp.unlink(missing_ok=True)

    print(f"\n  derived {made} · no text layer {ocr_needed} · already done {skipped}")
    if ocr_needed and not a.ocr:
        print("  Those files are INVISIBLE to search until OCR'd. Re-run with --ocr.")
        print("  A clean grep across them is not evidence of absence.")
    return worst


def cmd_index(a):
    INDEX.mkdir(parents=True, exist_ok=True)
    n = 0
    for t in DERIVED.glob("*.txt"):
        link = INDEX / t.name
        if link.exists(): link.unlink()
        try: link.symlink_to(t.resolve())
        except OSError: shutil.copy2(t, link)
        n += 1
    print(f"  text shelf: {n} document(s) at {INDEX}")
    return OK


# ── find ──────────────────────────────────────────────────────────────────
def corpus():
    """Every primary, with whether search can actually see it."""
    out = []
    for meta_p in sorted(PRIMARY.rglob("*.meta.json")):
        m = json.loads(meta_p.read_text())
        out.append((m, (DERIVED / f"{m['sha256']}.txt").exists()))
    return out


def cmd_find(a):
    docs = corpus()
    blind = [m for m, ok in docs if not ok]
    hits = 0
    for m, ok in docs:
        if not ok: continue
        text = (DERIVED / f"{m['sha256']}.txt").read_text(errors="replace")
        lines = text.splitlines()
        found = [(i, ln) for i, ln in enumerate(lines, 1)
                 if any(q.lower() in ln.lower() for q in a.q)]
        if found:
            hits += 1
            print(f"\n  {m['original_name']}   [{m['sha256'][:12]}…]")
            for i, ln in found[:a.max]:
                print(f"     {i:>5}  {ln.strip()[:150]}")
            if len(found) > a.max:
                print(f"     … {len(found)-a.max} more line(s)")

    print(f"\n  {hits} of {len(docs)-len(blind)} searchable document(s) matched")
    if blind:
        print(f"\n  *** {len(blind)} DOCUMENT(S) WERE NOT SEARCHED ***")
        for m in blind[:12]:
            print(f"      {m['original_name']}  ({m['magic']}, no text layer)")
        print("  A null result over these is NOT a finding. Run: shelf.py derive --ocr")
        return CANNOT
    return OK


# ── contradict ────────────────────────────────────────────────────────────
MONEY = re.compile(r"\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)")
ENTITY = re.compile(r"\b([A-Z][a-zA-Z&.'-]+(?:\s+[A-Z][a-zA-Z&.'-]+){1,4}"
                    r"(?:,?\s+(?:Inc|LLC|L\.L\.C|Corp|Co|Ltd|Foundation|Committee)\.?)?)\b")
STOP = {"The","This","That","United States","In The","Of The","See Also"}


def figures(text):
    """entity -> the dollar figures that appear on the same line."""
    out = {}
    for ln in text.splitlines():
        amts = [float(x.replace(",", "")) for x in MONEY.findall(ln)]
        if not amts: continue
        for e in ENTITY.findall(ln):
            e = e.strip()
            if len(e) < 6 or e in STOP: continue
            out.setdefault(e, set()).update(amts)
    return out


def cmd_contradict(a):
    docs = [(m, DERIVED / f"{m['sha256']}.txt") for m, ok in corpus() if ok]
    if len(docs) < 2:
        print("  CANNOT VERIFY — need at least two derived documents to compare.")
        return CANNOT

    table = {}
    for m, p in docs:
        for ent, amts in figures(p.read_text(errors="replace")).items():
            table.setdefault(ent, {})[m["sha256"]] = (m["original_name"], amts)

    found = 0
    for ent, per_doc in sorted(table.items()):
        if len(per_doc) < 2: continue
        sets = [v[1] for v in per_doc.values()]
        union = set().union(*sets)
        if len(union) < 2: continue
        if set.intersection(*sets): continue       # they agree somewhere
        found += 1
        print(f"\n  CANDIDATE DISAGREEMENT — {ent}")
        for sha, (name, amts) in per_doc.items():
            vals = ", ".join(f"${v:,.2f}" for v in sorted(amts))
            print(f"      {name[:52]:<52} {vals}")
        print(f"      [{', '.join(s[:12] for s in per_doc)}]")

    print(f"\n  {found} candidate(s) across {len(docs)} document(s)")
    print("  These are CANDIDATES, not contradictions. Two documents can carry")
    print("  different true figures — different periods, different scopes, a")
    print("  total beside a line item. Open both before you call it anything.")
    return OK


def cmd_status(a):
    docs = corpus()
    searchable = sum(1 for _, ok in docs if ok)
    mism = sum(1 for m, _ in docs if m.get("extension_mismatch"))
    ev = 0
    if CUSTODY.exists():
        ev = sum(1 for _ in open(CUSTODY))
    print(f"  root            {ROOT.resolve()}")
    print(f"  primary         {len(docs)} document(s)")
    print(f"  searchable      {searchable}")
    print(f"  no text layer   {len(docs)-searchable}")
    print(f"  ext mismatch    {mism}")
    print(f"  custody events  {ev}  (append-only)")
    if len(docs) - searchable:
        print("\n  Search coverage is incomplete. Any null result is provisional.")
        return CANNOT
    return OK


def main():
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    s = p.add_subparsers(dest="cmd", required=True)

    i = s.add_parser("ingest"); i.add_argument("paths", nargs="+"); i.set_defaults(fn=cmd_ingest)
    d = s.add_parser("derive"); d.add_argument("--ocr", action="store_true")
    d.add_argument("--force", action="store_true"); d.set_defaults(fn=cmd_derive)
    s.add_parser("index").set_defaults(fn=cmd_index)
    f = s.add_parser("find"); f.add_argument("q", nargs="+")
    f.add_argument("--max", type=int, default=6); f.set_defaults(fn=cmd_find)
    s.add_parser("contradict").set_defaults(fn=cmd_contradict)
    s.add_parser("status").set_defaults(fn=cmd_status)

    a = p.parse_args()
    for dd in (PRIMARY, DERIVED, INDEX, LEDGER): dd.mkdir(parents=True, exist_ok=True)
    sys.exit(a.fn(a))


if __name__ == "__main__":
    main()
