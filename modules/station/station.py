#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TSR station: the ledger in, a public-safe, self-contained static website out.

  station build [--ledger L] [--out DIR] [--theme ocean-depths] [--approve NAME] [--sign] [--base-url URL]
  station images DIR           share cards, the 10-slide carousel and the social image (needs Playwright)
  station keygen               create YOUR Ed25519 publishing key on this machine (printed: public key only)
  station verify DIR           re-hash every file against the manifest and check the signature
  station artifact DIR OUT     re-pack a built site for hosts that wrap the entry page
  station viewer DIR OUT.html  the ledger signature as a standalone p5.js art viewer (seed = the ledger)
  station themes               the theme-factory themes and their contrast
  station selftest             build a small ledger offline and prove the safety rules hold

What reaches the site: findings PUBLISH_WITH_ATTRIBUTION in full; PUBLISH_AS_QUESTION as the question
only; the money, figures, relationships, events, corrections and sources behind those. What never
does: findings awaiting re-pull, on hold or internal (counted, not shown); the firewall text;
private people's names; desk notes; anything on your never-print list. Every sentence that ships is
run through the ledger's number gate and the epistemic rule first, and the finished files are
scanned for anything that must never be printed. A build that fails any of this writes nothing.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MODULES = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import pages as PG  # noqa: E402
import themes as TH  # noqa: E402

VERSION = "station/1.0.0"
PUBLISH, QUESTION = "PUBLISH_WITH_ATTRIBUTION", "PUBLISH_AS_QUESTION"
KEY_DIR = os.path.join(os.path.expanduser("~"), ".sentinel", "station")
_P = "/"  # patterns are assembled at run time so this file does not match its own scan
BUILTIN_NEVER = [  # generic leaks, independent of any private list
    (_P + "Users" + _P + r"[^/\s]+", "a local home path"), (_P + "home" + _P + "claude", "a build-machine path"), (_P + "root" + _P, "a build-machine path"),
    (r"\." + "claude" + _P + "uploads", "an upload path"), (r"[A-Za-z0-9._%+-]+@(?!darpa\.mil)[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "an e-mail address"),
    (r"CASE_20\d\d", "a case identifier"), (r"\bCRB\d{4,}", "a case number"),
]


class BuildError(Exception):
    pass


def ledger_tools():
    p = os.path.join(MODULES, "ledger")
    if p not in sys.path:
        sys.path.append(p)
    import lib_ledger, moneytrace, gate, epistemic  # noqa: E401
    return lib_ledger, moneytrace, gate, epistemic


def primitives():
    p = os.path.join(MODULES, "coin")
    if p not in sys.path:
        sys.path.append(p)
    import primitives as P
    return P


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def dump(obj):
    return (json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


# ------------------------------------------------------------------------------------------ public subset
DESK_TITLE = {"desk_document": "Desk case file", "desk_log": "Desk terminal log", "desk_note": "Desk note", "code": "Desk tool output",
              "records_response": "Records response held by the desk"}


def is_desk_source(s):
    return s.get("kind") in ("desk_document", "desk_log", "desk_note", "code") or s.get("status") in ("upload", "desk_document", "operator_stated")
def public_subset(L):
    F = L["findings"]
    pub = {f["id"] for f in F if f["publication"] == PUBLISH}
    qs = {f["id"] for f in F if f["publication"] == QUESTION}
    shown = pub | qs
    ents = {e["id"]: e for e in L["entities"]}
    findings = []
    for f in F:
        if f["id"] in pub:
            g = {k: f.get(k) for k in ("id", "lane", "title", "headline", "statement", "glassmark", "evidence_class", "level", "publication",
                                       "sources", "entities", "figures", "does_not_show", "ordinary_explanation", "adverse_explanation",
                                       "discriminator", "dispute_log", "missing_records", "public_interest", "status", "snapshot",
                                       "proof_profile", "causal")}
            g["anchors"] = [{k: a.get(k) for k in ("src", "loc", "quote", "status", "where")} for a in f.get("anchors") or []]
            findings.append(g)
        elif f["id"] in qs:
            findings.append({"id": f["id"], "lane": f["lane"], "title": f["question"], "question": f["question"], "publication": QUESTION,
                             "glassmark": f["glassmark"], "evidence_class": f["evidence_class"], "sources": f["sources"],
                             "missing_records": f.get("missing_records") or [], "discriminator": f.get("discriminator"),
                             "public_interest": {"what_changes_if_known": (f.get("public_interest") or {}).get("what_changes_if_known")},
                             "snapshot": f.get("snapshot"), "causal": {"rung": 0, "rung_code": "C0", "rung_name": "OBSERVED", "competing": []},
                             "proof_profile": {}})
    money = [dict({k: m.get(k) for k in ("id", "from", "to", "amount_usd", "amount_text", "kind", "period", "snapshot", "sources", "locator",
                                         "evidence_class", "is_floor", "caveat", "quote", "verification")},
                  findings=[x for x in m["findings"] if x in pub]) for m in L["money_flows"] if set(m["findings"]) & pub]
    figures = [dict({k: x.get(k) for k in ("id", "label", "value", "unit", "kind", "entity", "period", "snapshot", "sources", "locator",
                                           "evidence_class", "is_floor", "semantics", "quote", "verification")},
                    findings=[y for y in x["findings"] if y in pub]) for x in L["figures"] if set(x["findings"]) & pub]
    rels = [dict({k: r.get(k) for k in ("id", "from", "to", "type", "rel_class", "rung", "rung_name", "alleged", "evidence_class", "level",
                                        "sources", "locator", "period", "limitation")},
                 findings=[y for y in (r.get("findings") or []) if y in pub]) for r in L["relationships"] if set(r.get("findings") or []) & pub]
    tl = [dict(t, findings=[y for y in t["findings"] if y in shown]) for t in L["timeline"]
          if set(t["findings"]) & pub or (set(t["findings"]) & qs and t.get("grade") == "GREEN")]
    for t in tl:
        t["evidence"] = [{"src": e.get("src"), "loc": e.get("loc")} for e in t.get("evidence") or []]
    corr = [c for c in L["corrections"] if c.get("findings") and set(c["findings"]) <= shown]
    rq_ids = set(x for f in findings for x in f.get("missing_records") or [])
    rq = [{k: r.get(k) for k in ("id", "priority", "lane", "question", "record_target", "url", "status", "what_it_resolves", "action_type")}
          for r in L["records_queue"] if r["id"] in rq_ids]
    used_ents = set()
    for f in findings:
        used_ents.update(f.get("entities") or [])
    for x in money + rels:
        used_ents.update([x["from"], x["to"]])
    for x in figures:
        if x.get("entity"):
            used_ents.add(x["entity"])
    entities = []
    for eid in sorted(used_ents):
        e = ents.get(eid)
        if not e:
            continue
        if e.get("public_figure_or_org") is False:
            nm = "(private person, not named)" if e.get("type") == "person" else e["name"]
            entities.append({"id": eid, "name": nm, "type": e.get("type"), "public_figure_or_org": False})
        else:
            entities.append({"id": eid, "name": e["name"], "type": e.get("type"), "aliases": e.get("aliases") or []})
    src_ids = set()
    for coll in (findings, money, figures, rels):
        for x in coll:
            src_ids.update(x.get("sources") or [])
    for t in tl:
        src_ids.update(e["src"] for e in t["evidence"] if e.get("src"))
    for a in [a for f in findings for a in f.get("anchors") or []]:
        src_ids.add(a["src"])
    for p in L["meta"].get("method_precedents", []):
        src_ids.add(p["src"])
    sources = []
    for s in L["sources"]:
        if s["id"] not in src_ids:
            continue
        row = {k: s.get(k) for k in ("id", "title", "kind", "status", "url", "date", "publisher", "sha256")}
        if is_desk_source(s):  # the desk's own working files: identified by hash, never by file name or project
            row.update(title=DESK_TITLE.get(s.get("kind"), "Desk record") + " ({})".format(s["id"]), publisher="The Sentinel Report desk",
                       url=None, desk=True)
        sources.append(row)
    desk_ids = {s["id"] for s in sources if s.get("desk")}
    for f in findings:
        for a in f.get("anchors") or []:
            a["desk"] = a.get("src") in desk_ids
    V = L["vocabularies"]
    m = L["metrics"]["verification"]
    held = {"awaiting_repull": sum(1 for f in F if f["publication"] == "PUBLISH_AFTER_VERIFY"),
            "on_hold": sum(1 for f in F if f["publication"] == "HOLD"), "internal": sum(1 for f in F if f["publication"] == "INTERNAL")}
    meta = {k: L["meta"].get(k) for k in ("title", "standard", "as_of", "built", "schema", "private_individuals_policy", "no_grand_total_rule",
                                          "reasoning", "method_precedents")}
    meta["scope"] = ("Findings the desk has cleared for publication, drawn from public records and documents in its custody. Findings still "
                     "being verified are counted but not shown.")
    return {
        "schema": "tsr.public/1", "meta": meta,
        "vocabularies": {k: V[k] for k in ("glassmark", "evidence_class", "publication", "level_ladder", "money_kinds", "lanes", "relationship_classes",
                                            "causal_ladder", "epistemic_rule", "competing_models", "say")},
        "findings": findings, "money_flows": money, "figures": figures, "relationships": rels, "timeline": tl, "corrections": corr,
        "corrections_total": len(L["corrections"]), "records_queue": rq, "entities": entities, "sources": sources, "held": held,
        "verification": {"numbers_machine_verified": m.get("numbers_machine_verified"), "numbers_total": m.get("numbers_total"),
                         "quotes_word_for_word": sum(1 for q in L["verification"]["quotes"] if q.get("status") == "PASS"),
                         "arithmetic": m.get("arithmetic"), "custody_hashes": m.get("custody_hashes"), "uploads": m.get("uploads_unchanged")},
        "commitments": {"desk_ledger_sha256": None},
    }


# ------------------------------------------------------------------------------------------ gates
def gate_texts(P, L_full):
    """Every sentence the site ships goes through the ledger's number gate and epistemic rule."""
    lib, trace, gate, ep = ledger_tools()
    problems = []
    for f in P["findings"]:
        texts = [("title", f["title"])]
        if f["publication"] == PUBLISH:
            texts += [("headline", f["headline"]), ("statement", f["statement"])]
        else:
            texts += [("question", f["question"])]
        for label, t in texts:
            res, clean = gate.run(t, L_full)
            for r in res:
                bad = [c for c, _ in r["flags"] if c not in ("CONTEXT_UNCONFIRMED",)]
                if r["status"] not in ("MATCH", "QUESTION_ONLY") or bad:
                    if not (r["status"] == "QUESTION_ONLY" and f["publication"] == QUESTION and not bad):
                        problems.append("{} {}: {} {} {}".format(f["id"], label, r["number"], r["status"], bad))
            for i in ep.check(t, L_full):
                if i["status"] == "FAIL":
                    problems.append("{} {}: epistemic {} ('{}')".format(f["id"], label, i["rule"], i["word"]))
    for f in P["findings"]:
        for line in f.get("does_not_show") or []:
            for i in ep.check(line, L_full):
                if i["status"] == "FAIL":
                    problems.append("{} does-not-show: epistemic {} ('{}')".format(f["id"], i["rule"], i["word"]))
    for t in P["timeline"]:
        for i in ep.check(t["event"], L_full):
            if i["status"] == "FAIL":
                problems.append("{} event: epistemic {} ('{}')".format(t["id"], i["rule"], i["word"]))
    for c in P["corrections"]:
        for i in ep.check(c["what_is_right"], L_full):
            if i["status"] == "FAIL":
                problems.append("{} correction: epistemic {} ('{}')".format(c["id"], i["rule"], i["word"]))
    return problems


def never_patterns(extra_files):
    pats = [(re.compile(p, re.I), lbl) for p, lbl in BUILTIN_NEVER]
    for path in [os.path.join(os.path.expanduser("~"), ".sentinel", "ledger", "forbidden.txt")] + list(extra_files or []):
        if path and os.path.isfile(path):
            for n, line in enumerate(open(path, encoding="utf-8"), 1):
                s = line.strip()
                if s and not s.startswith("#"):
                    pats.append((re.compile(re.escape(s), re.I), "{} line {}".format(os.path.basename(path), n)))
    return pats


def scan(root, pats):
    hits = []
    for d, _, files in os.walk(root):
        for fn in files:
            p = os.path.join(d, fn)
            if fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".woff2", ".pyc")):
                continue
            text = open(p, encoding="utf-8", errors="replace").read()
            if fn == "site.css":
                text = re.sub(r"url\(data:[^)]+\)", "", text)
            for rx, lbl in pats:
                if rx.search(text):
                    hits.append((os.path.relpath(p, root), lbl))
    return hits


# ------------------------------------------------------------------------------------------ art spec
def art_spec(P, digest):
    fam = PG.FAMILY
    by_kind = {}
    for m in P["money_flows"]:
        by_kind.setdefault(m["kind"], []).append(m)
    flows = []
    import math
    for k, ms in by_kind.items():
        vals = [float(m["amount_usd"]) for m in ms if m.get("amount_usd")]
        lo, hi = (min(vals), max(vals)) if vals else (1, 1)
        for m in ms:
            v = float(m["amount_usd"] or lo or 1)
            w = 0.5 if hi == lo else (math.log(v) - math.log(lo)) / (math.log(hi) - math.log(lo))
            flows.append({"from": m["from"], "to": m["to"], "family": fam.get(k, "spending"), "w": round(w, 4),
                          "verified": m.get("verification") == "PASS"})
    unresolved = [r for r in P["relationships"] if r.get("type") == "UNRESOLVED_RECIPIENTS"]
    for r in unresolved:
        flows.append({"from": r["from"], "to": None, "family": "contracts", "w": 0.5, "verified": True})
    # the chain that ends in unknown recipients: money reaching a party with no outflow of record
    outs = set(m["from"] for m in P["money_flows"])
    for m in P["money_flows"]:
        if m["kind"] in ("CONTRACT_SCHEDULE", "CONTRACT_TERMS") and m["to"] not in outs:
            flows.append({"from": m["to"], "to": None, "family": "contracts", "w": 0.35, "verified": True})
            outs.add(m["to"])
    deg = {}
    for x in P["money_flows"] + P["relationships"]:
        for n in (x["from"], x["to"]):
            deg[n] = deg.get(n, 0) + 1
    for r in P["relationships"]:  # topology beneath the money: thinner currents along each typed record
        flows.append({"from": r["from"], "to": r["to"], "family": PG.REL_COLOR.get(r.get("rel_class"), "onchain"),
                      "w": round(min(1.0, (r.get("rung") or 0) / 6.0), 4), "verified": not r.get("alleged"), "d": 0.4})
    wires = [{"from": r["from"], "to": r["to"], "rung": r.get("rung", 0), "alleged": bool(r.get("alleged"))} for r in P["relationships"]]
    return {"digest": digest, "nodes": [{"id": n, "weight": d} for n, d in sorted(deg.items())], "flows": flows, "wires": wires}


# ------------------------------------------------------------------------------------------ css
def css(theme_key):
    t = TH.tokens(theme_key)
    fonts_dir = os.path.join(HERE, "assets", "fonts")
    faces = []
    import base64
    need = [t["fonts"]["head"], t["fonts"]["body"], t["fonts"]["mono"]]
    bold_body = {"dejavu-sans": "dejavu-sans-bold", "freesans": "freesans-bold"}.get(t["fonts"]["body"])
    if bold_body:
        need.append(bold_body)
    for key in dict.fromkeys(need):
        p = os.path.join(fonts_dir, key + ".woff2")
        if not os.path.exists(p):
            continue
        b64 = base64.b64encode(open(p, "rb").read()).decode()
        faces.append('@font-face{{font-family:"{fam}";src:url(data:font/woff2;base64,{b}) format("woff2");font-weight:{w};font-style:normal;font-display:swap}}'.format(
            fam=TH.FONT_FAMILY[key], b=b64, w=TH.FONT_WEIGHT[key]))
    fam = lambda k: '"{}", {}'.format(TH.FONT_FAMILY[k], TH.FALLBACK[TH.FONT_FAMILY[k]])
    decl = lambda d: "".join("--{}:{};".format(k, v) for k, v in d.items())
    scale = "--fs-xs:12px;--fs-s:14px;--fs-m:16px;--fs-l:19px;--fs-xl:25px;--fs-2xl:34px;--fs-3xl:clamp(36px,5.4vw,60px);"
    fonts = "--font-head:{};--font-body:{};--font-mono:{};".format(fam(t["fonts"]["head"]), fam(t["fonts"]["body"]), fam(t["fonts"]["mono"]))
    tokens = (":root{{color-scheme:dark;{d}{s}{f}}}\n"
              "@media (prefers-color-scheme: light){{:root:not([data-theme=\"dark\"]){{color-scheme:light;{l}}}}}\n"
              ":root[data-theme=\"light\"]{{color-scheme:light;{l}}}\n"
              ":root[data-theme=\"dark\"]{{color-scheme:dark;{d}}}\n").format(d=decl(t["dark"]), l=decl(t["light"]), s=scale, f=fonts)
    head = "/* theme: {} (theme-factory); tokens generated by station {} */\n".format(t["name"], VERSION)
    return head + "\n".join(faces) + "\n" + tokens + open(os.path.join(HERE, "assets", "base.css"), encoding="utf-8").read(), t


# ------------------------------------------------------------------------------------------ build
def build(args):
    lib, trace_mod, gate, ep = ledger_tools()
    L = json.load(open(args.ledger, encoding="utf-8"))
    P = public_subset(L)
    P["commitments"]["desk_ledger_sha256"] = sha256_bytes(open(args.ledger, "rb").read())
    problems = gate_texts(P, L)
    if problems and not args.allow_ungated:
        raise BuildError("the gate refused {} sentence(s):\n  ".format(len(problems)) + "\n  ".join(problems))
    pub_bytes = dump(P)
    digest = sha256_bytes(pub_bytes)
    out = os.path.abspath(args.out)
    stage = tempfile.mkdtemp(prefix=".station-", dir=os.path.dirname(out) or ".")
    try:
        css_text, theme = css(args.theme)
        approved = bool(args.approve)
        built = args.built or datetime.date.today().isoformat()
        key = load_key() if args.sign else None
        import importlib.util
        want_images = not args.no_images and importlib.util.find_spec("playwright") is not None
        site = {"status": {"approved": approved, "line": ("Approved for publication by {} · built {} · public ledger {}".format(args.approve, built, digest[:16])
                                                          if approved else "Preview build · not yet approved for publication · built {} · public ledger {}".format(built, digest[:16]))},
                "digest": digest, "built": built, "schema": L["meta"].get("schema"), "version": VERSION, "theme_name": theme["name"],
                "base_url": (args.base_url.rstrip("/") + "/") if args.base_url else "", "art": art_spec(P, digest),
                "page_ids": set(f["id"] for f in P["findings"]), "signed": bool(key), "images": want_images,
                "signature_fp": fingerprint(key[1]) if key else None,
                "desc": "Findings from public records, each traced to its line, cell or page, with the limits of what it shows."}
        w = lambda rel, data: _write(stage, rel, data)
        w("data/public-ledger.json", pub_bytes)
        w("assets/site.css", css_text.encode("utf-8"))
        for fn in ("art.js", "site.js"):
            w("assets/" + fn, open(os.path.join(HERE, "assets", fn), "rb").read())
        w("index.html", PG.full(*PG.page_home(site, P)).encode("utf-8"))
        w("findings.html", PG.full(*PG.page_findings(site, P)).encode("utf-8"))
        for f in P["findings"]:
            w("f/{}.html".format(f["id"]), PG.full(*PG.page_finding(site, P, f)).encode("utf-8"))
        traces = {}
        for f in P["findings"]:
            if f["publication"] != PUBLISH:
                continue
            rows = [m for m in P["money_flows"] if f["id"] in m["findings"]]
            if rows:
                start = rows[0]["from"]
                traces[f["id"]] = trace_mod.trace(dict(P, relationships=P["relationships"]), start, "down", None, 3)
        w("money.html", PG.full(*PG.page_money(site, P, traces)).encode("utf-8"))
        w("map.html", PG.full(*PG.page_map(site, P)).encode("utf-8"))
        w("timeline.html", PG.full(*PG.page_timeline(site, P)).encode("utf-8"))
        w("method.html", PG.full(*PG.page_method(site, P)).encode("utf-8"))
        w("corrections.html", PG.full(*PG.page_corrections(site, P)).encode("utf-8"))
        w("sources.html", PG.full(*PG.page_sources(site, P)).encode("utf-8"))
        w("feed.xml", PG.feed(site, P).encode("utf-8"))
        w("art-spec.json", dump(site["art"]))
        if want_images:
            import images
            images.render_all(stage, site, P)
        elif not args.no_images:
            print("images skipped: Playwright is not installed (optional: python3 -m pip install --user playwright && python3 -m playwright install chromium)")
        rows = manifest_rows(stage, exclude={"verify.html"})
        w("verify.html", PG.full(*PG.page_verify(site, P, rows)).encode("utf-8"))
        write_manifest(stage, site, P, key)
        pats = never_patterns(args.forbidden)
        if L["meta"].get("firewall"):   # the firewall sentence itself must never ship
            pats.append((re.compile(re.escape(L["meta"]["firewall"][:60]), re.I), "the firewall text"))
        hits = scan(stage, pats)
        if hits:
            raise BuildError("never-print scan hit {} time(s): ".format(len(hits)) + "; ".join("{} ({})".format(f, l) for f, l in hits[:12]))
        if os.path.exists(out):
            shutil.rmtree(out)
        os.replace(stage, out)
    finally:
        if os.path.exists(stage):
            shutil.rmtree(stage, ignore_errors=True)
    n = sum(len(fs) for _, _, fs in os.walk(out))
    print("built {} ({} files) · theme {} · public ledger sha256 {} · {}".format(out, n, theme["name"], digest,
          "signed" if site["signed"] else "unsigned"))
    print("  findings shown: {} published, {} questions · held back: {}".format(
        sum(1 for f in P["findings"] if f["publication"] == PUBLISH), sum(1 for f in P["findings"] if f["publication"] == QUESTION), P["held"]))
    return 0


def _write(root, rel, data):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as fh:
        fh.write(data)


SKIP = {"manifest.json", "manifest.sig", "SHA256SUMS", "publisher.json"}


def manifest_rows(root, exclude=()):
    rows = []
    for d, _, files in os.walk(root):
        for fn in files:
            rel = os.path.relpath(os.path.join(d, fn), root).replace(os.sep, "/")
            if rel in SKIP or rel in exclude:
                continue
            b = open(os.path.join(d, fn), "rb").read()
            rows.append((rel, len(b), sha256_bytes(b)))
    return sorted(rows)


def write_manifest(root, site, P, key):
    rows = manifest_rows(root)
    man = {"schema": "tsr.site-manifest/1", "tool": VERSION, "built": site["built"], "entry": "index.html",
           "public_ledger_sha256": site["digest"], "desk_ledger_sha256": P["commitments"]["desk_ledger_sha256"],
           "signed": bool(key), "publisher_fingerprint": fingerprint(key[1]) if key else None,
           "files": [{"path": p, "bytes": n, "sha256": h} for p, n, h in rows]}
    mb = dump(man)
    _write(root, "manifest.json", mb)
    sums = "".join("{}  {}\n".format(h, p) for p, _, h in rows) + "{}  manifest.json\n".format(sha256_bytes(mb))
    _write(root, "SHA256SUMS", sums.encode())
    if key:
        P_ = primitives()
        sig = P_.ed25519_sign(key[0], mb)
        _write(root, "manifest.sig", (sig.hex() + "\n").encode())
        _write(root, "publisher.json", dump({"algorithm": "Ed25519", "public_key": key[1].hex(), "fingerprint": fingerprint(key[1]),
                                              "signs": "the exact bytes of manifest.json"}))


# ------------------------------------------------------------------------------------------ keys
def key_path():
    return os.environ.get("SENTINEL_STATION_KEY") or os.path.join(KEY_DIR, "publisher.key")


def fingerprint(pk):
    h = sha256_bytes(pk)[:20].upper()
    return " ".join(h[i:i + 4] for i in range(0, 20, 4))


def keygen(args):
    import secrets
    p = key_path()
    os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
    try:
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print("a publishing key already exists at {}; not overwritten".format(p), file=sys.stderr)
        return 3
    seed = secrets.token_bytes(32)
    with os.fdopen(fd, "w") as fh:
        fh.write(seed.hex() + "\n")
    pk = primitives().ed25519_public_key(seed)
    print("publishing key created: {} (mode 600; back it up offline; it is never printed)".format(p))
    print("public key  {}".format(pk.hex()))
    print("fingerprint {}".format(fingerprint(pk)))
    return 0


def load_key():
    p = key_path()
    if not os.path.isfile(p):
        raise BuildError("no publishing key at {} — run `station keygen` on your own machine first".format(p))
    if os.stat(p).st_mode & 0o077:
        raise BuildError("{} is readable by other users; chmod 600 it".format(p))
    seed = bytes.fromhex(open(p).read().strip())
    return seed, primitives().ed25519_public_key(seed)


def verify(args):
    root = args.dir
    mb = open(os.path.join(root, "manifest.json"), "rb").read()
    man = json.loads(mb)
    bad, missing = [], []
    for f in man["files"]:
        p = os.path.join(root, f["path"])
        if not os.path.exists(p):
            missing.append(f["path"])
        elif sha256_bytes(open(p, "rb").read()) != f["sha256"]:
            bad.append(f["path"])
    extra = [p for p, _, _ in manifest_rows(root) if p not in {f["path"] for f in man["files"]}]
    print("{} files in manifest · {} match · {} changed · {} missing · {} not in manifest".format(
        len(man["files"]), len(man["files"]) - len(bad) - len(missing), len(bad), len(missing), len(extra)))
    for p in bad:
        print("  CHANGED  " + p)
    for p in missing:
        print("  MISSING  " + p)
    for p in extra:
        print("  EXTRA    " + p)
    ok = not bad and not missing
    if man.get("signed"):
        pubj = json.load(open(os.path.join(root, "publisher.json")))
        sig = bytes.fromhex(open(os.path.join(root, "manifest.sig")).read().strip())
        good = primitives().ed25519_verify(bytes.fromhex(pubj["public_key"]), mb, sig)
        print("signature: {} (Ed25519, fingerprint {})".format("VALID" if good else "INVALID", pubj["fingerprint"]))
        ok = ok and good
    else:
        print("signature: none (unsigned build)")
    print("public ledger sha256 {} ({})".format(man["public_ledger_sha256"],
          "matches data/public-ledger.json" if sha256_bytes(open(os.path.join(root, "data", "public-ledger.json"), "rb").read()) == man["public_ledger_sha256"] else "DOES NOT MATCH"))
    return 0 if ok else 1


# ------------------------------------------------------------------------------------------ artifact re-pack
def artifact(args):
    """Hosts such as Claude artifacts wrap the entry page in their own document skeleton. This writes
    OUT/entry.html (head and body wrappers removed, everything else identical) next to a full copy of
    the site, so every other file is served byte for byte and still matches the manifest."""
    src, out = args.dir, args.out
    if os.path.exists(out):
        shutil.rmtree(out)
    shutil.copytree(src, out)
    html_ = open(os.path.join(src, "index.html"), encoding="utf-8").read()
    head = re.search(r"<head>(.*?)</head>", html_, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", html_, re.S).group(1)
    head = re.sub(r'<meta charset="utf-8">\s*|<meta name="viewport"[^>]*>\s*', "", head)
    open(os.path.join(out, "entry.html"), "w", encoding="utf-8").write(head.strip() + "\n" + body.strip() + "\n")
    print("wrote {}/entry.html (publish it as the page; every other file as-is)".format(out))
    return 0


def viewer(args):
    """The ledger signature as a standalone generative-art viewer (p5.js page from the algorithmic-art template)."""
    spec = json.load(open(os.path.join(args.dir, "art-spec.json"), encoding="utf-8"))
    tpl = open(os.path.join(HERE, "art", "viewer_template.html"), encoding="utf-8").read()
    art = open(os.path.join(HERE, "assets", "art.js"), encoding="utf-8").read()
    out = tpl.replace("/*__ART_JS__*/", art).replace("/*__SPEC__*/", json.dumps(spec).replace("</", "<\\/"))
    open(args.out, "w", encoding="utf-8").write(out)
    print("wrote {} (seed {} = this ledger)".format(args.out, int(spec["digest"][:6], 16)))
    return 0


def themes_cmd(args):
    for k in TH.THEMES:
        t = TH.tokens(k)
        worst = min(r[2] for r in TH.report(t) if not r[1].startswith("accent"))
        print("{:<18} {:<18} fonts {} / {}   lowest text contrast {:.1f}:1".format(k, t["name"], t["fonts"]["head"], t["fonts"]["body"], worst))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="station", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", action="version", version=VERSION)
    sub = p.add_subparsers(dest="cmd")
    b = sub.add_parser("build")
    b.add_argument("--ledger", default=None); b.add_argument("--out", default="site"); b.add_argument("--theme", default="ocean-depths", choices=sorted(TH.THEMES))
    b.add_argument("--approve", metavar="NAME"); b.add_argument("--sign", action="store_true"); b.add_argument("--base-url")
    b.add_argument("--built"); b.add_argument("--no-images", action="store_true"); b.add_argument("--forbidden", action="append")
    b.add_argument("--allow-ungated", action="store_true")
    s = sub.add_parser("images"); s.add_argument("dir")
    sub.add_parser("keygen")
    s = sub.add_parser("verify"); s.add_argument("dir")
    s = sub.add_parser("artifact"); s.add_argument("dir"); s.add_argument("out")
    s = sub.add_parser("viewer"); s.add_argument("dir"); s.add_argument("out")
    sub.add_parser("themes")
    sub.add_parser("selftest")
    a = p.parse_args(argv)
    if not a.cmd:
        p.print_help()
        return 0
    try:
        if a.cmd == "build":
            if not a.ledger:
                lib = ledger_tools()[0]
                a.ledger = lib.find_ledger(None)
            return build(a)
        if a.cmd == "images":
            import images
            site = json.load(open(os.path.join(a.dir, "art-spec.json")))
            P = json.load(open(os.path.join(a.dir, "data", "public-ledger.json")))
            return images.render_all(a.dir, {"art": site, "digest": site["digest"]}, P) or 0
        if a.cmd == "keygen":
            return keygen(a)
        if a.cmd == "verify":
            return verify(a)
        if a.cmd == "artifact":
            return artifact(a)
        if a.cmd == "viewer":
            return viewer(a)
        if a.cmd == "themes":
            return themes_cmd(a)
        if a.cmd == "selftest":
            import station_selftest
            return station_selftest.main()
    except BuildError as e:
        print("station: " + str(e), file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    sys.exit(main())
