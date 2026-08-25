#!/usr/bin/env python3
"""
SENTINEL DASHBOARD -- static HTML, reads the case files directly.

Why static instead of Flask/FastAPI/Streamlit: this desk is a solo operator
on one Mac. A server that has to stay running is one more thing that can be
"down" when you go to check it. This script reads the real case files and
writes one self-contained HTML file. Re-run it whenever the cases change.
Open the file in a browser. No port, no process, nothing to forget to start.

WHEN TO REPLACE THIS WITH A REAL SERVICE
    If Sentinel PRA gets frozen and becomes the live path, and if
    exhibits/questions/contradictions get their own tables alongside
    requests/received_records, THEN a FastAPI layer reading Postgres is the
    right upgrade -- not before. Until that freeze record exists, this script
    is the honest tool.

ONE CHANGE FROM THE ORIGINAL DRAFT: the publish gate is not computed here.
    It lives in case.py and this file imports it. Two copies of a rule that
    decides whether something can be published is one copy too many -- they
    drift, and the one that drifts is always the one you were reading.

USAGE
    sentinel dash              writes and opens it
    python3 dashboard.py       writes the HTML
"""

import datetime as dt
import html
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from case import load_all, compute, cases_dir  # noqa: E402

OUT = os.environ.get("SENTINEL_DASHBOARD_OUT") or str(
    Path(__file__).resolve().parents[2] / "evidence" / "sentinel_dashboard.html")

INK = "#f4f2ec"; MUT = "#9a9ea8"; GOLD = "#d6ac42"; RED = "#d6413a"; GREEN = "#7abf8f"
BG = "#0a0a0d"; PANEL = "#111319"


def esc(s):
    return html.escape(str(s))


def case_card(d, s):
    cid = d["case_id"]
    status_color = GREEN if s["publishable"] else RED
    status_label = "PUBLISHABLE" if s["publishable"] else "BLOCKED"

    blockers = ""
    if s["blockers"]:
        rows = []
        for code, text in s["blockers"]:
            cls = "crit" if code in ("R-00", "R-01", "R-02", "R-04") else \
                  ("med" if code == "R-03" else "high")
            label = f'{esc(code)} &middot; ' if code != "--" else ""
            rows.append(f'<div class="blk {cls}">{label}{esc(text)}</div>')
        if s["open_q"]:
            items = "".join(
                f'<li>{esc(q.get("id", "?"))} &mdash; {esc(q["text"][:110])}</li>'
                for q in s["open_q"][:6])
            rows.append(f'<div class="blk med">open questions:<ul>{items}</ul></div>')
        if s["open_x"]:
            items = "".join(
                f'<li>{esc(x.get("id", "?"))} &mdash; {esc(x["text"][:110])}</li>'
                for x in s["open_x"][:6])
            rows.append(f'<div class="blk crit">contradictions:<ul>{items}</ul></div>')
        blockers = f'<div class="blockers">{"".join(rows)}</div>'

    exhibits_rows = "".join(
        f'<tr><td>{esc(e["id"])}</td><td>{esc(e["file"])}</td>'
        f'<td>{esc(e["kind"])}</td>'
        f'<td class="num">{e["pages_read"]}/{e["pages_total"]}</td>'
        f'<td>{"&#9888; " + esc(e["broken"]) if e.get("broken") else ("&#10003;" if e["pages_read"] == e["pages_total"] else "&mdash;")}</td></tr>'
        for e in d.get("exhibits", {}).values()
    ) or '<tr><td colspan="5" class="none">no exhibits yet</td></tr>'

    return f'''
    <div class="card">
      <div class="cardhead">
        <div>
          <div class="caseid">{esc(cid)}</div>
          <div class="subject">{esc(d.get("subject", ""))}</div>
        </div>
        <div class="pill" style="background:{status_color}22;color:{status_color};border-color:{status_color}66">
          {status_label}
        </div>
      </div>
      <div class="barwrap"><div class="bar" style="width:{s["pct"]}%;background:{status_color}"></div></div>
      <div class="pct">{s['pct']}% complete &middot; {s['n_ex']} exhibit(s) &middot; {s['read']}/{s['total']} pages read</div>
      {blockers}
      <table class="exhibits">
        <tr><th>ID</th><th>File</th><th>Kind</th><th>Pages</th><th></th></tr>
        {exhibits_rows}
      </table>
    </div>'''


def build(out=OUT):
    cases = [(d, compute(d)) for d in load_all()]
    n = len(cases)
    pub = sum(1 for _, s in cases if s["publishable"])
    blocked = n - pub
    r01 = sum(1 for _, s in cases if s["unread_fin"])
    r02 = sum(1 for _, s in cases if s["broken"])
    r04 = sum(1 for _, s in cases if s["open_x"])
    total_unread_pages = sum(s["total"] - s["read"] for _, s in cases)
    total_open_q = sum(len(s["open_q"]) for _, s in cases)

    cards = "\n".join(case_card(d, s) for d, s in cases) if cases else \
        ('<div class="empty">No cases on disk.<br><br>'
         '<code>sentinel case new CASE-ID "what it is about"</code></div>')

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    doc = f'''<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel Dashboard</title>
<style>
  * {{ box-sizing:border-box; }}
  body {{ background:{BG}; color:{INK}; font-family:'SF Mono',ui-monospace,Menlo,monospace;
         margin:0; padding:40px 24px; }}
  .wrap {{ max-width:920px; margin:0 auto; }}
  h1 {{ font-size:22px; letter-spacing:1px; margin:0 0 2px; }}
  .sub {{ color:{MUT}; font-size:13px; }}
  .stampline {{ color:{MUT}; font-size:11px; margin:6px 0 28px; }}
  .stats, .blockrow {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }}
  .stats {{ margin-bottom:12px; }}
  .blockrow {{ margin-bottom:32px; }}
  .stat {{ background:{PANEL}; border:1px solid #23262f; border-radius:10px; padding:16px; }}
  .stat .n {{ font-size:26px; font-weight:bold; }}
  .stat .l {{ color:{MUT}; font-size:11px; text-transform:uppercase; letter-spacing:.5px; margin-top:4px; }}
  .blockrow .stat .n {{ color:{GOLD}; font-size:20px; }}
  .card {{ background:{PANEL}; border:1px solid #23262f; border-radius:12px;
           padding:20px; margin-bottom:18px; }}
  .cardhead {{ display:flex; justify-content:space-between; align-items:flex-start;
               gap:16px; margin-bottom:12px; }}
  .caseid {{ font-size:16px; font-weight:bold; }}
  .subject {{ color:{MUT}; font-size:12px; margin-top:3px; }}
  .pill {{ font-size:11px; padding:4px 10px; border-radius:20px; border:1px solid;
           letter-spacing:.5px; white-space:nowrap; }}
  .barwrap {{ background:#1b1e27; border-radius:6px; height:8px; overflow:hidden; margin-bottom:8px; }}
  .bar {{ height:100%; }}
  .pct {{ color:{MUT}; font-size:12px; margin-bottom:12px; }}
  .blockers {{ margin:10px 0 16px; }}
  .blk {{ font-size:12px; padding:8px 10px; border-radius:6px; margin-bottom:6px; }}
  .blk.crit {{ background:{RED}18; color:#ff8a83; border:1px solid {RED}44; }}
  .blk.high {{ background:{GOLD}18; color:{GOLD}; border:1px solid {GOLD}44; }}
  .blk.med  {{ background:#ffffff0d; color:{MUT}; border:1px solid #ffffff22; }}
  .blk ul {{ margin:6px 0 0 16px; padding:0; }}
  .exhibits {{ width:100%; border-collapse:collapse; font-size:12px; margin-top:8px; }}
  .exhibits th {{ text-align:left; color:{MUT}; font-weight:normal; padding:6px 8px;
                  border-bottom:1px solid #23262f; }}
  .exhibits td {{ padding:6px 8px; border-bottom:1px solid #1a1c22; }}
  .exhibits td.num {{ text-align:right; }}
  .exhibits td.none {{ color:{MUT}; text-align:center; padding:14px; }}
  .empty {{ color:{MUT}; padding:40px; text-align:center; border:1px dashed #333;
            border-radius:12px; line-height:1.6; }}
  .empty code {{ color:{GOLD}; }}
  .foot {{ color:{MUT}; font-size:11px; margin-top:24px; text-align:center; line-height:1.7; }}
  @media (max-width:640px) {{
    body {{ padding:24px 14px; }}
    .stats, .blockrow {{ grid-template-columns:repeat(2,1fr); }}
  }}
</style></head>
<body><div class="wrap">
  <h1>SENTINEL DASHBOARD</h1>
  <div class="sub">Named Sources &middot; Public Documents &middot; Verified Facts</div>
  <div class="stampline">generated {stamp} &middot; static snapshot, re-run to refresh</div>

  <div class="stats">
    <div class="stat"><div class="n">{n}</div><div class="l">Cases</div></div>
    <div class="stat"><div class="n" style="color:{GREEN}">{pub}</div><div class="l">Publishable</div></div>
    <div class="stat"><div class="n" style="color:{RED}">{blocked}</div><div class="l">Blocked</div></div>
    <div class="stat"><div class="n">{total_unread_pages}</div><div class="l">Pages Unread</div></div>
  </div>

  <div class="blockrow">
    <div class="stat"><div class="n">{r01}</div><div class="l">R-01 Unread Financial</div></div>
    <div class="stat"><div class="n">{r02}</div><div class="l">R-02 Broken Evidence</div></div>
    <div class="stat"><div class="n">{total_open_q}</div><div class="l">R-03 Open Questions</div></div>
    <div class="stat"><div class="n">{r04}</div><div class="l">R-04 Contradictions</div></div>
  </div>

  {cards}

  <div class="foot">
    dashboard.py &middot; reads {esc(cases_dir())} directly &middot; no server, no database<br>
    The gate lives in case.py. This page renders it; it does not decide it.<br>
    The Sentinel Report
  </div>
</div></body></html>'''

    p = Path(out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(doc)
    os.chmod(p, 0o600)
    return p, n, pub, blocked


if __name__ == "__main__":
    p, n, pub, blocked = build()
    print(f"wrote {p} ({n} case(s): {pub} publishable, {blocked} blocked)")
