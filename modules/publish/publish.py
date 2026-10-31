#!/usr/bin/env python3
"""
publish.py -- Publication Station, static half.

Turns the desk's case store into one self-contained static folder per
investigation. Each folder uses only relative links, so it can be served at
  https://<slug>.<your-domain>/     (one site per folder, sub-domain style)
or at
  https://<your-domain>/<slug>/     (one site, path style)
without changing a byte.

Rules this builder enforces (they are the point, not decoration):
  1. Only claims that clear every BLOCK gate are rendered. Withheld claims are
     listed by tier and reason only -- their text is not published.
  2. Accusatory wording is held back by default. A claim that says "fraud" or
     "stole" states a conclusion; the records usually show something narrower.
     Rewrite it as what the document says, attributed, or the claim stays held.
     ("Alleged" is not a legal shield: attribution to a named document, what
     the record does and does not show, right of reply and prompt correction
     are what actually protect a publisher.)
  3. Every claim shows its sources, the custodian, the document's SHA-256, and
     how many INDEPENDENT custodians back it. One custodian is shown as single-source.
  4. Lead cards are questions, never findings. They build only with --leads,
     into /leads/<id>/ with noindex and a banner, and are never in the index.
  5. No JavaScript, no external requests, restrictive CSP. Everything escaped.

Stdlib only. Never contacts anyone; writes files under --out.
"""
from __future__ import annotations
import argparse, hashlib, html, json, os, re, sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DESK = HERE.parent / "sentinel-desk"
sys.path.insert(0, str(DESK))
from sentinel import export, gates, store, audit  # noqa: E402

SLUG_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")
DOMAIN_RE = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")

# Conclusion words. A hit does not mean the claim is false; it means the sentence
# states a conclusion about a person's conduct that a record may not support.
ACCUSATORY = [
    "fraud", "fraudulent", "corrupt", "corruption", "stole", "stolen", "theft", "embezzle",
    "bribe", "bribery", "kickback", "illegal", "illegally", "criminal", "crime", "cover-up",
    "cover up", "covered up", "liar", "lied", "perjur", "launder", "conspir", "extort",
    "scam", "crook", "guilty", "unlawful", "unlawfully",
]
_ACC_RE = re.compile(r"\b(" + "|".join(re.escape(w) for w in ACCUSATORY) + r")", re.I)

CSS = """
:root{--bg:#fafaf7;--fg:#1c1c1a;--mut:#5d5d57;--line:#d9d8d0;--card:#fff;--green:#1d6b3a;--red:#a4312a;--grey:#6a6a64;--amber:#8a5a00}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe4;--mut:#a3a29a;--line:#3a3a36;--card:#1e1e1b;--green:#6cc58b;--red:#ee8b84;--grey:#a3a29a;--amber:#e8b45a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.55 Georgia,'Times New Roman',serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 4rem}
h1{font-size:1.7rem;line-height:1.2;margin:.2rem 0 .6rem}h2{font-size:1.2rem;margin:2rem 0 .6rem;border-bottom:1px solid var(--line);padding-bottom:.25rem}
.meta,.small{color:var(--mut);font:.85rem/1.4 system-ui,sans-serif}
.box{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.8rem 1rem;margin:.8rem 0}
.claim{border-left:4px solid var(--grey)}.claim.g{border-left-color:var(--green)}.claim.r{border-left-color:var(--red)}
.tag{display:inline-block;font:700 .7rem system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;padding:.1rem .4rem;border:1px solid currentColor;border-radius:3px;margin-right:.4rem}
.g .tag{color:var(--green)}.r .tag{color:var(--red)}.d .tag{color:var(--grey)}.warn{color:var(--amber)}
table{width:100%;border-collapse:collapse;font:.85rem/1.4 system-ui,sans-serif}th,td{text-align:left;padding:.35rem .4rem;border-bottom:1px solid var(--line);vertical-align:top}
code{font:.8rem ui-monospace,Menlo,monospace;word-break:break-all}
a{color:inherit}.banner{background:#fff3cd;color:#4a3800;border:1px solid #d9b84a;border-radius:6px;padding:.7rem 1rem;font:.9rem system-ui,sans-serif}
@media(prefers-color-scheme:dark){.banner{background:#3a3000;color:#f3dd8a;border-color:#8a7420}}
"""


def esc(x) -> str:
    return html.escape("" if x is None else str(x), quote=True)


def page(title: str, body: str, *, noindex: bool = False, desc: str = "") -> str:
    robots = '<meta name="robots" content="noindex,nofollow">' if noindex else ""
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'\">"
        f"<meta name=\"referrer\" content=\"no-referrer\">{robots}"
        f"<title>{esc(title)}</title><meta name=\"description\" content=\"{esc(desc)}\">"
        f"<style>{CSS}</style></head><body><main>{body}</main></body></html>\n")


def language_flags(text: str) -> list[str]:
    return sorted({m.group(1).lower() for m in _ACC_RE.finditer(text or "")})


def _independent_custodians(cites) -> int:
    return len({(c["custodian"] or "").strip().lower() for c in cites if (c["custodian"] or "").strip()})


def load_denominators(root: Path, slug: str) -> tuple[list[dict], list[str]]:
    """Optional <root>/publish/<slug>/denominators.json:
       [{"label","numerator","denominator","unit","source","note"}]
       Rates are computed here, from the two figures shown, so a reader can redo them."""
    p = Path(root).expanduser() / "publish" / slug / "denominators.json"
    if not p.exists():
        return [], []
    errs, rows = [], []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return [], [f"{p}: unreadable ({e})"]
    for i, r in enumerate(raw if isinstance(raw, list) else []):
        try:
            n, d = float(r["numerator"]), float(r["denominator"])
        except (KeyError, TypeError, ValueError):
            errs.append(f"row {i}: numerator and denominator must be numbers"); continue
        if d <= 0:
            errs.append(f"row {i}: denominator must be > 0"); continue
        if not str(r.get("source", "")).strip() or not str(r.get("label", "")).strip():
            errs.append(f"row {i}: label and source are required (a denominator with no source is a guess)"); continue
        rows.append({**r, "rate": n / d})
    return rows, errs


def build_case(conn, root: Path, out: Path, slug: str, domain: str | None, now: str) -> dict:
    if not SLUG_RE.match(slug):
        raise ValueError(f"case slug {slug!r} is not a valid sub-domain label (a-z, 0-9, hyphen, max 40)")
    cs = store.case_by_slug(conn, slug)
    ok, held = export._publishable(conn, cs["id"])
    shown, lang_held = [], []
    for c in ok:
        flags = language_flags(c["text"])
        if flags:
            lang_held.append((c, [f"accusatory wording ({', '.join(flags)}): restate as what the document says, "
                                  "attributed, or cite the court/agency finding"]))
        else:
            shown.append(c)
    held_all = list(held) + lang_held

    findings = export.findings(conn, slug)
    findings["findings"] = [f for f in findings["findings"]
                            if int(f["id"][1:]) in {c["id"] for c in shown}]
    findings["_withheld"] = [{"tier": c["tier"], "reasons": r} for c, r in held_all]  # no claim text

    docs = conn.execute("SELECT * FROM documents WHERE case_id=? ORDER BY received", (cs["id"],)).fetchall()
    reqs = conn.execute("SELECT * FROM requests WHERE case_id=? ORDER BY priority", (cs["id"],)).fetchall()
    corr = conn.execute("SELECT * FROM corrections WHERE ref=? ORDER BY date DESC", (slug,)).fetchall()
    dens, den_errs = load_denominators(root, slug)
    chain_ok, chain_msg = audit.verify(conn)

    B: list[str] = [
        f"<p class=\"meta\"><a href=\"../\">All investigations</a> · {esc(cs['jurisdiction'])} · status {esc(cs['status'])}</p>",
        f"<h1>{esc(cs['title'])}</h1>",
        "<div class=\"box small\"><b>How to read this page.</b> Each statement below is tied to a public record "
        "you can request yourself. This page reports what the records <i>show</i>. It does not report why anyone "
        "acted, and it does not say anyone broke a law. Where a record has an innocent explanation, we say so. "
        "Open questions are marked as questions. Anyone named may reply; a reply is published alongside the page, "
        "and errors are corrected at the top, with the date.</div>",
    ]
    if corr:
        B.append("<h2>Corrections</h2>")
        for k in corr:
            B.append(f"<div class=\"box\"><b>{esc(k['date'])}</b> · {esc(k['severity'])}<br>"
                     f"Published: {esc(k['published'])}<br>Correct: {esc(k['correct'])}<br>"
                     f"<span class=\"small\">{esc(k['why'])}</span></div>")

    def claim_block(c):
        cites = export._cites(conn, c["id"])
        cls = {"GREEN": "g", "ARITH": "g", "REPORTED": "g", "RED": "r"}.get(c["tier"], "d")
        label = {"GREEN": "Documented", "ARITH": "Our arithmetic", "REPORTED": "Reported",
                 "RED": "Open question", "DEAD": "Chased and closed"}[c["tier"]]
        parts = [f"<div class=\"box claim {cls}\" id=\"c{c['id']}\"><span class=\"tag\">{label}</span>{esc(c['text'])}"]
        if c["tier"] == "ARITH" and c["formula"]:
            parts.append(f"<div class=\"small\">Our arithmetic, not the document's: <code>{esc(c['formula'])}</code></div>")
        if c["tier"] == "REPORTED":
            parts.append(f"<div class=\"small\">Reported by {esc(c['outlet'])}. Reporting, not a filing.</div>")
        if c["tier"] == "RED" and c["closing_gate"]:
            parts.append(f"<div class=\"small\">What would settle it: {esc(c['closing_gate'])}</div>")
        if c["tier"] == "DEAD" and c["resolution"]:
            parts.append(f"<div class=\"small\">What closed it: {esc(c['resolution'])}</div>")
        n = _independent_custodians(cites)
        if cites:
            for x in cites:
                q = f" — “{esc(x['quote'])}”" if x["quote"] else ""
                parts.append(f"<div class=\"small\">Source: {esc(x['title'])}, {esc(x['locator'])} "
                             f"({esc(x['custodian'])}) · SHA-256 <code>{esc(x['sha256'][:16])}…</code>{q}</div>")
            parts.append("<div class=\"small " + ("" if n >= 2 else "warn") + f"\">Independent custodians: {n}"
                         + ("" if n >= 2 else " — single-source; treat as unconfirmed by a second record") + "</div>")
        parts.append("</div>")
        return "".join(parts)

    for title, tiers in (("What the records show", ("GREEN", "ARITH", "REPORTED")),
                         ("Open questions", ("RED",)),
                         ("Chased and closed — reported, not buried", ("DEAD",))):
        rows = [c for c in shown if c["tier"] in tiers]
        if rows:
            B.append(f"<h2>{title}</h2>")
            B += [claim_block(c) for c in rows]

    if dens:
        B += ["<h2>Context: rates and denominators</h2>",
              "<p class=\"small\">Counts alone mislead. Each rate below is numerator ÷ denominator, computed from "
              "the two figures shown, so you can redo it.</p>",
              "<table><tr><th>Measure</th><th>Numerator</th><th>Denominator</th><th>Rate</th><th>Source</th></tr>"]
        for r in dens:
            B.append(f"<tr><td>{esc(r['label'])}</td><td>{esc(r['numerator'])}</td><td>{esc(r['denominator'])} "
                     f"{esc(r.get('unit',''))}</td><td>{r['rate']:.4g}</td><td>{esc(r['source'])}</td></tr>")
        B.append("</table>")
    for e in den_errs:
        B.append(f"<p class=\"small warn\">Denominator file skipped a row: {esc(e)}</p>")

    B += ["<h2>Evidence register</h2>",
          "<table><tr><th>Document</th><th>Custodian</th><th>SHA-256</th></tr>"]
    for d in docs:
        B.append(f"<tr><td>{esc(d['title'])}</td><td>{esc(d['custodian'])}</td><td><code>{esc(d['sha256'])}</code></td></tr>")
    B.append("</table><p class=\"small\">Anyone can hash a copy of the same record and compare.</p>")

    if reqs:
        B += ["<h2>Records requests</h2><table><tr><th>Ref</th><th>Asked of</th><th>Status</th><th>Filed</th><th>Answered</th></tr>"]
        for r in reqs:
            B.append(f"<tr><td>{esc(r['ref'])}</td><td>{esc(r['office'])}</td><td>{esc(r['status'])}</td>"
                     f"<td>{esc(r['filed'] or '—')}</td><td>{esc(r['responded'] or '—')}</td></tr>")
        B.append("</table>")

    if held_all:
        B += ["<h2>Withheld from this page</h2>",
              f"<p class=\"small\">{len(held_all)} item(s) did not clear our gates and are not published. "
              "Their text is not shown. The reason is.</p><ul class=\"small\">"]
        for c, rs in held_all:
            B.append(f"<li>[{esc(c['tier'])}] {esc('; '.join(rs))}</li>")
        B.append("</ul>")

    fj = json.dumps(findings, indent=2, sort_keys=True)
    fh = hashlib.sha256(fj.encode()).hexdigest()
    B.append(f"<hr><p class=\"small\">Built {esc(now)} · audit chain "
             f"{'intact' if chain_ok else 'BROKEN'} · findings.json SHA-256 <code>{fh}</code> · "
             "<a href=\"findings.json\">findings.json</a></p>")

    d = out / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "index.html").write_text(page(cs["title"], "\n".join(B), desc=f"{len(shown)} gated finding(s)."), encoding="utf-8")
    (d / "findings.json").write_text(fj, encoding="utf-8")
    if domain:
        (d / "CNAME").write_text(f"{slug}.{domain}\n", encoding="utf-8")
    return {"slug": slug, "title": cs["title"], "path": f"{slug}/", "published": len(shown),
            "withheld": len(held_all), "host": f"{slug}.{domain}" if domain else None,
            "findings_sha256": fh, "audit_chain_intact": bool(chain_ok), "denominator_errors": den_errs}


def build_leads(cards: list[dict], out: Path, now: str) -> list[dict]:
    done = []
    for c in cards:
        cid = c["id"]
        if not SLUG_RE.match(cid):
            raise ValueError(f"lead id {cid!r} is not a valid slug")
        recs = "".join(f"<li>{esc(r['what'])} — {esc(r['custodian'])} ({esc(r['route'])})</li>" for r in c.get("records", []))
        B = ["<div class=\"banner\"><b>HYPOTHESIS — not a finding.</b> This is a question with a named record that "
             "would settle it. Nothing here is alleged. Not for publication until the document is in hand "
             "and a right-of-reply request has been sent.</div>",
             f"<h1>{esc(c['title'])}</h1><p class=\"meta\">Status {esc(c['status'])}</p>",
             f"<h2>The question</h2><p>{esc(c['question'])}</p>",
             f"<h2>Basis</h2><p>{esc(c.get('basis',''))}</p>",
             f"<h2>Records that would settle it</h2><ul>{recs}</ul>",
             f"<h2>Settling document</h2><p>{esc(c['settling_document'])}</p>",
             f"<h2>The innocent explanation</h2><p>{esc(c['innocent_explanation'])}</p>",
             f"<h2>What kills this lead</h2><p>{esc(c['kill_condition'])}</p>",
             f"<h2>Before anything is published</h2><p>{esc(c['publication_gate'])}</p>"]
        d = out / "leads" / cid
        d.mkdir(parents=True, exist_ok=True)
        (d / "index.html").write_text(page(c["title"], "\n".join(B), noindex=True), encoding="utf-8")
        done.append({"id": cid, "path": f"leads/{cid}/", "status": c["status"], "indexed": False})
    return done


def build(root, out, *, domain=None, only=None, with_leads=False, cards_path=None) -> dict:
    root, out = Path(root).expanduser(), Path(out)
    if domain and not DOMAIN_RE.match(domain):
        raise ValueError(f"{domain!r} is not a valid domain name")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn = store.open_db(root)
    slugs = [r["slug"] for r in conn.execute("SELECT slug FROM cases ORDER BY slug")]
    if only:
        missing = [s for s in only if s not in slugs]
        if missing:
            raise KeyError(f"no such case: {', '.join(missing)}")
        slugs = list(only)
    out.mkdir(parents=True, exist_ok=True)
    sites = [build_case(conn, root, out, s, domain, now) for s in slugs]
    leads = []
    if with_leads:
        sys.path.insert(0, str(HERE.parent / "leads"))
        import leads as L
        cards = L.load() if not cards_path else json.loads(Path(cards_path).read_text())["cards"]
        errs = L.validate(cards)
        if errs:
            raise ValueError("lead cards invalid: " + "; ".join(errs))
        leads = build_leads(cards, out, now)
    li = "".join(f"<li><a href=\"{esc(s['path'])}\">{esc(s['title'])}</a> "
                 f"<span class=\"small\">{s['published']} gated finding(s)</span></li>" for s in sites)
    idx = ("<h1>Investigations</h1><p class=\"small\">Named sources. Public documents. Verified facts. "
           "Each page shows what the records show, what they do not, and what we are still asking.</p>"
           f"<ul>{li or '<li>None published yet.</li>'}</ul>")
    (out / "index.html").write_text(page("Investigations", idx), encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nDisallow: /leads/\n", encoding="utf-8")
    routes = {"schema": "routes/1", "built": now, "domain": domain, "sites": sites, "leads": leads}
    (out / "routes.json").write_text(json.dumps(routes, indent=2), encoding="utf-8")
    return routes


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="sentinel publish", description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=str(store.default_root()))
    ap.add_argument("--out", default=None, help="default: <root>/site")
    ap.add_argument("--domain", help="your domain, for routes.json and per-folder CNAME files (slug.domain)")
    ap.add_argument("--case", action="append", help="build only this case (repeatable)")
    ap.add_argument("--leads", action="store_true", help="also build lead-card pages (noindex, banner)")
    a = ap.parse_args(argv)
    try:
        r = build(a.root, a.out or Path(a.root).expanduser() / "site",
                  domain=a.domain, only=a.case, with_leads=a.leads)
    except (KeyError, ValueError) as e:
        print(f"publish: {e}", file=sys.stderr); return 2
    for s in r["sites"]:
        print(f"  {s['path']:<28} {s['published']} published, {s['withheld']} withheld"
              + (f"  -> https://{s['host']}/" if s["host"] else ""))
    for l in r["leads"]:
        print(f"  {l['path']:<28} lead (noindex)")
    if not r["sites"]:
        print("  no cases yet — nothing to publish")
    return 0


if __name__ == "__main__":
    sys.exit(main())
