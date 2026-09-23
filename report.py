#!/usr/bin/env python3
"""
report.py — turn the desk into a dossier and a dashboard.

WHAT IT MAKES
  ~/sentinel/reports/DOSSIER-<date>.md     the written record, every anomaly
  ~/sentinel/reports/dashboard-<date>.html one page, self-contained, charts

WHY BOTH
  The markdown is what you hand a person — an editor, a lawyer, an agency.
  The dashboard is what you look at yourself and what a reader clicks. They
  are generated from the SAME numbers in one pass, so they cannot drift.

THE ONE RULE THE CHARTS OBEY
  Document count is charted as document count and labelled as document count.
  It is not money, not contacts with officials, not audience reach, and not
  wrongdoing. Every chart of it carries that sentence on the chart, not in a
  footnote, because footnotes do not survive a screenshot.

USAGE
  python3 report.py                 # both files
  python3 report.py --top 12        # rows per chart
  python3 report.py --open          # and open the dashboard

EXIT  0 written · 4 nothing to report on
"""
import argparse, html, json, os, subprocess, sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import hunt  # single source of truth for loading + normalising

OK, CANNOT = 0, 4
OUT = Path(os.environ.get("HUNT_REPORTS",
                          os.path.expanduser("~/sentinel/reports")))

# Validated 2026-09-21 with the dataviz validator, both modes:
#   light  worst adjacent CVD ΔE 9.1 · normal-vision 19.6 · ALL PASS
#   dark   worst adjacent CVD ΔE 8.4 · normal-vision 19.3 · ALL PASS
# Light mode WARNs on contrast for three slots, so the relief rule applies:
# every stacked segment carries a direct label and every chart has a table view.
CAT_L = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"]
CAT_D = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"]
SEQ_L, SEQ_D = "#2a78d6", "#3987e5"

SEV_FACTORS = ["duty", "concealment", "scale", "repeatability", "corroboration"]


# ── data ──────────────────────────────────────────────────────────────────
def library():
    have = hunt.load()
    return [(k, len(d["rows"])) for k, d in sorted(have.items(),
                                                   key=lambda kv: -len(kv[1]["rows"]))], have


def by_country(have, top):
    if "fara_docs" not in have:
        return []
    D = have["fara_docs"]; C = hunt.docs_cols(D)
    if C["ctry"] is None or C["fp"] is None:
        return []
    docs, prins = defaultdict(int), defaultdict(set)
    for row in D["rows"]:
        ct = hunt.cell(row, C["ctry"]).strip().upper()
        fp = hunt.cell(row, C["fp"])
        if not ct:
            continue
        docs[ct] += 1
        if fp:
            prins[ct].add(fp)
    rows = [(c, docs[c], len(prins[c])) for c in docs]
    return sorted(rows, key=lambda r: -r[1])[:top]


def by_registrant(have, top):
    """Canonicalised — registration numbers folded into the filer's name."""
    if "fara_docs" not in have:
        return [], 0
    D = have["fara_docs"]; C = hunt.docs_cols(D)
    cmap = hunt.canon_map(D, C)
    cnt, merged = defaultdict(int), 0
    for row in D["rows"]:
        v = hunt.cell(row, C["reg"])
        if not v:
            continue
        name, was_id = hunt.canon(v, cmap)
        cnt[name] += 1
        merged += 1 if was_id else 0
    return sorted(cnt.items(), key=lambda kv: -kv[1])[:top], merged


def conflicts_count(have):
    if "fara_docs" not in have:
        return 0, 0
    D = have["fara_docs"]; C = hunt.docs_cols(D)
    if C["fp"] is None or C["ctry"] is None:
        return 0, 0
    pairs, docs = set(), 0
    for row in D["rows"]:
        fp, ct = hunt.cell(row, C["fp"]), hunt.cell(row, C["ctry"]).strip().upper()
        if not fp or not ct:
            continue
        low = " " + hunt.norm(fp) + " "
        named = {v for k, v in hunt.COUNTRY_WORDS.items() if f" {k} " in low}
        if named and ct not in named:
            pairs.add((fp[:70], ct)); docs += 1
    return len(pairs), docs


def anomalies():
    return [json.loads((d / "record.json").read_text()) for d in hunt.anom_dirs()]


# ── svg helpers ───────────────────────────────────────────────────────────
def esc(s):
    return html.escape(str(s), quote=True)


def hbar(rows, unit, cls="s1", w=760, rowh=30, pad_l=250):
    """Horizontal bars, single series. 4px rounded data-end, 2px gaps, direct
    labels on every bar (the relief rule — three light slots are under 3:1)."""
    if not rows:
        return "<p class='muted'>no data</p>"
    mx = max(v for _, v in rows) or 1
    h = len(rows) * rowh + 8
    inner = w - pad_l - 90
    p = [f'<svg viewBox="0 0 {w} {h}" role="img" class="chart">']
    for i, (label, v) in enumerate(rows):
        y = i * rowh + 4
        bw = max(2, inner * v / mx)
        p.append(
            f'<text x="{pad_l-10}" y="{y+16}" text-anchor="end" class="lbl">'
            f'{esc(label)[:38]}</text>'
            f'<rect x="{pad_l}" y="{y+4}" width="{bw:.1f}" height="{rowh-12}" '
            f'rx="4" class="{cls}"><title>{esc(label)}: {v:,} {esc(unit)}</title></rect>'
            f'<text x="{pad_l+bw+8}" y="{y+16}" class="val">{v:,}</text>')
    p.append("</svg>")
    return "".join(p)


def stacked(records, w=760, rowh=34, pad_l=250):
    """Severity by factor. 5 categorical slots, 2px surface gap between
    segments, a direct label in every segment wide enough to hold one."""
    if not records:
        return "<p class='muted'>nothing scored yet</p>"
    h = len(records) * rowh + 8
    inner = w - pad_l - 90
    p = [f'<svg viewBox="0 0 {w} {h}" role="img" class="chart">']
    for i, r in enumerate(records):
        y = i * rowh + 4
        x = pad_l
        total = sum(int(r["severity"].get(f) or 0) for f in SEV_FACTORS)
        p.append(f'<text x="{pad_l-10}" y="{y+19}" text-anchor="end" class="lbl">'
                 f'{esc(r["title"])[:34]}<title>{esc(r["id"])}</title></text>')
        for si, f in enumerate(SEV_FACTORS):
            v = int(r["severity"].get(f) or 0)
            if v <= 0:
                continue
            seg = inner * v / 15
            p.append(
                f'<rect x="{x:.1f}" y="{y+5}" width="{max(2,seg-2):.1f}" '
                f'height="{rowh-14}" rx="4" class="c{si+1}">'
                f'<title>{esc(r["id"])} — {f}: {v}/3</title></rect>')
            if seg > 26:
                p.append(f'<text x="{x+seg/2-4:.1f}" y="{y+19}" '
                         f'class="seg">{v}</text>')
            x += seg
        p.append(f'<text x="{x+8:.1f}" y="{y+19}" class="val">{total}/15</text>')
    p.append("</svg>")
    return "".join(p)


def table(headers, rows):
    th = "".join(f"<th>{esc(h)}</th>" for h in headers)
    tr = "".join("<tr>" + "".join(f"<td>{esc(c)}</td>" for c in r) + "</tr>"
                 for r in rows)
    return (f"<details><summary>Table view</summary><table><thead><tr>{th}"
            f"</tr></thead><tbody>{tr}</tbody></table></details>")


def tile(big, label, note=""):
    return (f'<div class="tile"><div class="big">{esc(big)}</div>'
            f'<div class="tlab">{esc(label)}</div>'
            f'<div class="tnote">{esc(note)}</div></div>')


# ── build ─────────────────────────────────────────────────────────────────
def build(top, do_open):
    OUT.mkdir(parents=True, exist_ok=True)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    lib, have = library()
    anoms = anomalies()
    if not lib and not anoms:
        print("  CANNOT — no library and no anomalies. Nothing to report on.")
        return CANNOT

    ctry = by_country(have, top)
    regs, merged = by_registrant(have, top)
    n_conf_pairs, n_conf_docs = conflicts_count(have)
    total_rows = sum(v for _, v in lib)
    scored = [a for a in anoms if all(a["severity"].get(f) is not None
                                      for f in SEV_FACTORS)]
    scored.sort(key=lambda a: -sum(int(a["severity"][f]) for f in SEV_FACTORS))
    by_status = defaultdict(int)
    for a in anoms:
        by_status[a["status"]] += 1

    # ── DOSSIER.md ────────────────────────────────────────────────────────
    M = [f"# THE SENTINEL REPORT — DESK DOSSIER\n",
         f"Generated {stamp}  ·  {hunt.VERSION}\n",
         "## What this document is\n",
         "A record of what the desk holds, what it has flagged, and what each "
         "flag does and does not establish. Every number below is computed "
         "from bulk files on disk, not from a summary. Nothing here is a "
         "conclusion.\n",
         "**Document count is document count.** It is not money, not contacts "
         "with officials, not audience reach, and not wrongdoing. Money is in "
         "the supplemental statements; scope is in the Exhibit AB contracts. "
         "Neither is in a count.\n",
         "## The library\n",
         f"{len(lib)} corpus{'es' if len(lib) != 1 else ''} · "
         f"{total_rows:,} rows\n",
         "| corpus | rows | what it answers |", "|---|---:|---|"]
    for k, v in lib:
        M.append(f"| {k} | {v:,} | {hunt.CORPORA.get(k, {}).get('q', '—')} |")

    if merged:
        M.append(f"\n**Identity note.** {merged:,} row(s) carried a FARA "
                 f"registration number in the registrant-name column instead of "
                 f"a name. They are folded into the filer's real name above. "
                 f"Un-folded, those rows read as separate organisations and "
                 f"inflate any count of how many firms represent a principal.\n")
    if n_conf_pairs:
        M.append(f"**Country-field note.** {n_conf_pairs} distinct "
                 f"principal/country pairs disagree with the country named in "
                 f"the principal's own title, across {n_conf_docs:,} filed "
                 f"documents. Any count by country is wrong by at least that "
                 f"much. This is a data-quality conflict, not evidence that "
                 f"anyone concealed anything.\n")

    M.append(f"\n## The anomaly shelf — {len(anoms)} record(s)\n")
    if by_status:
        M.append("| status | count |")
        M.append("|---|---:|")
        for s in hunt.STATUSES:
            if by_status.get(s):
                M.append(f"| {s} | {by_status[s]} |")
    M.append("")
    for a in sorted(anoms, key=lambda x: x["id"]):
        M.append("\n---\n")
        M.append(hunt.render_md(a))

    md_path = OUT / f"DOSSIER-{day}.md"
    md_path.write_text("\n".join(M))

    # ── dashboard.html ────────────────────────────────────────────────────
    cap = ("DOCUMENT COUNT. Not money, not contacts with officials, not "
           "audience reach, not wrongdoing.")
    parts = []
    parts.append('<div class="tiles">' +
                 tile(f"{total_rows:,}", "rows in the library",
                      f"{len(lib)} corpus" + ("es" if len(lib) != 1 else "")) +
                 tile(f"{len(anoms)}", "anomaly records",
                      " · ".join(f"{v} {k}" for k, v in sorted(by_status.items()))) +
                 tile(f"{n_conf_pairs}", "country-field conflicts",
                      f"across {n_conf_docs:,} documents") +
                 tile(f"{merged:,}", "rows folded by identifier",
                      "registration numbers in the name column") +
                 '</div>')

    parts.append(f'<section><h2>The library</h2>'
                 f'<p class="sub">What the desk can see. A register not on this '
                 f'list is a question it cannot answer.</p>'
                 f'{hbar([(k, v) for k, v in lib], "rows")}'
                 f'{table(["corpus", "rows"], [(k, f"{v:,}") for k, v in lib])}'
                 f'</section>')

    if ctry:
        parts.append(
            f'<section><h2>Filed documents by country</h2>'
            f'<p class="sub">{esc(cap)}</p>'
            f'{hbar([(c, d) for c, d, _ in ctry], "documents")}'
            f'{table(["country", "documents"], [(c, f"{d:,}") for c, d, _ in ctry])}'
            f'</section>')
        parts.append(
            f'<section><h2>Distinct foreign principals by country</h2>'
            f'<p class="sub">A separate chart on purpose. Documents and '
            f'principals are different measures and never share an axis — one '
            f'filer filing often is not many filers.</p>'
            f'{hbar([(c, p) for c, _, p in sorted(ctry, key=lambda r: -r[2])], "principals", "s2")}'
            f'{table(["country", "principals"], [(c, p) for c, _, p in sorted(ctry, key=lambda r: -r[2])])}'
            f'</section>')

    if regs:
        parts.append(
            f'<section><h2>Registrants by filed documents</h2>'
            f'<p class="sub">{esc(cap)} Registration numbers are folded into '
            f'the filer\'s real name.</p>'
            f'{hbar(regs, "documents")}'
            f'{table(["registrant", "documents"], [(k, f"{v:,}") for k, v in regs])}'
            f'</section>')

    legend = "".join(
        f'<span class="lg"><i class="c{i+1}"></i>{esc(f)}</span>'
        for i, f in enumerate(SEV_FACTORS))
    parts.append(
        f'<section><h2>Severity, by factor</h2>'
        f'<p class="sub">Each factor scores 0–3, total out of 15. '
        f'<strong>Nothing scores for how shocking it is.</strong> A dull '
        f'structural finding with documents from both sides outranks a lurid '
        f'one-off.</p>'
        f'<div class="legend">{legend}</div>'
        f'{stacked(scored)}'
        f'{table(["id", "title"] + SEV_FACTORS + ["total"], [[a["id"], a["title"][:52]] + [a["severity"][f] for f in SEV_FACTORS] + [sum(int(a["severity"][f]) for f in SEV_FACTORS)] for a in scored])}'
        f'</section>')

    rows_a = [[a["id"], a["status"], a.get("level", 0), a["title"][:60]]
              for a in sorted(anoms, key=lambda x: x["id"])]
    parts.append(f'<section><h2>The docket</h2>'
                 f'<p class="sub">A record is not a finding. DRAFT asserts '
                 f'nothing at all.</p>'
                 f'{table(["id", "status", "level", "title"], rows_a)}</section>')

    page = TEMPLATE.format(
        day=day, stamp=esc(stamp), ver=esc(hunt.VERSION),
        cat_l=";".join(f"--c{i+1}:{c}" for i, c in enumerate(CAT_L)),
        cat_d=";".join(f"--c{i+1}:{c}" for i, c in enumerate(CAT_D)),
        seq_l=SEQ_L, seq_d=SEQ_D, body="".join(parts))
    html_path = OUT / f"dashboard-{day}.html"
    html_path.write_text(page)

    print(f"  {md_path}")
    print(f"  {html_path}")
    print(f"\n  {total_rows:,} rows · {len(anoms)} anomaly record(s) · "
          f"{n_conf_pairs} country conflict(s)")
    if do_open:
        subprocess.run(["open", str(html_path)], check=False)
    return OK


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel Desk — {day}</title>
<style>
:root{{color-scheme:light dark}}
.viz-root{{--surface-1:#fcfcfb;--surface-2:#f3f3f1;--ink:#0b0b0b;
  --ink-2:#52514e;--ink-3:#77766f;--line:#dedcd6;--s1:{seq_l};--s2:#eb6834;{cat_l}}}
@media (prefers-color-scheme:dark){{:root:where(:not([data-theme="light"])) .viz-root{{
  --surface-1:#1a1a19;--surface-2:#242422;--ink:#fff;--ink-2:#c3c2b7;
  --ink-3:#8e8d85;--line:#3a3a37;--s1:{seq_d};--s2:#d95926;{cat_d}}}}}
:root[data-theme="dark"] .viz-root{{--surface-1:#1a1a19;--surface-2:#242422;
  --ink:#fff;--ink-2:#c3c2b7;--ink-3:#8e8d85;--line:#3a3a37;--s1:{seq_d};
  --s2:#d95926;{cat_d}}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--surface-1);color:var(--ink);
  font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}}
.wrap{{max-width:960px;margin:0 auto;padding:40px 16px 80px}}
h1{{font-size:clamp(26px,4vw,38px);margin:0 0 4px;letter-spacing:-.02em}}
h2{{font-size:20px;margin:0 0 4px;letter-spacing:-.01em}}
.meta{{color:var(--ink-3);font:13px ui-monospace,SFMono-Regular,Menlo,monospace;
  margin-bottom:32px}}
section{{margin:40px 0;padding-top:28px;border-top:1px solid var(--line)}}
.sub{{color:var(--ink-2);font-size:14px;margin:0 0 18px;max-width:64ch}}
.muted{{color:var(--ink-3)}}
.chart{{width:100%;height:auto;display:block}}
.lbl{{fill:var(--ink-2);font-size:12.5px}}
.val{{fill:var(--ink);font-size:12.5px;font-weight:600}}
.seg{{fill:#fff;font-size:11px;font-weight:700;text-anchor:middle}}
rect.s1{{fill:var(--s1)}} rect.s2{{fill:var(--s2)}}
rect.c1{{fill:var(--c1)}} rect.c2{{fill:var(--c2)}} rect.c3{{fill:var(--c3)}}
rect.c4{{fill:var(--c4)}} rect.c5{{fill:var(--c5)}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
  gap:12px;margin:28px 0}}
.tile{{background:var(--surface-2);border:1px solid var(--line);
  border-radius:12px;padding:16px}}
.big{{font-size:30px;font-weight:700;letter-spacing:-.02em}}
.tlab{{font-size:13px;color:var(--ink-2);margin-top:2px}}
.tnote{{font-size:12px;color:var(--ink-3);margin-top:6px}}
.legend{{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:12px}}
.lg{{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-2)}}
.lg i{{width:11px;height:11px;border-radius:3px;display:inline-block}}
i.c1{{background:var(--c1)}} i.c2{{background:var(--c2)}} i.c3{{background:var(--c3)}}
i.c4{{background:var(--c4)}} i.c5{{background:var(--c5)}}
details{{margin-top:14px}}
summary{{cursor:pointer;font-size:13px;color:var(--ink-2)}}
table{{border-collapse:collapse;width:100%;margin-top:10px;font-size:13px}}
th,td{{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}}
th{{color:var(--ink-3);font-weight:600}}
td:nth-child(n+2){{font-variant-numeric:tabular-nums}}
.rule{{margin-top:48px;padding:18px;border:1px solid var(--line);
  border-radius:12px;background:var(--surface-2);font-size:14px;
  color:var(--ink-2);max-width:64ch}}
</style></head>
<body class="viz-root"><div class="wrap">
<h1>Sentinel Desk</h1>
<div class="meta">{stamp} · {ver}</div>
{body}
<div class="rule"><strong>The rule this desk runs on.</strong> Do not report
what is hidden. Report what the observable evidence implies should exist,
whether it actually exists, and precisely what record would distinguish the
competing explanations. A record that could not be found is a gap in this
collection — never evidence that anyone concealed anything.</div>
</div></body></html>"""


def main():
    p = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--top", type=int, default=14)
    p.add_argument("--open", action="store_true")
    a = p.parse_args()
    return build(a.top, a.open)


if __name__ == "__main__":
    sys.exit(main())
