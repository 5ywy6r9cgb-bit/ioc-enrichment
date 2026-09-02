"""
ui.py -- the HTML the local dashboard is made of.

WHY HAND-WRITTEN HTML AND NOT A TEMPLATE ENGINE
    The package promises no third-party dependency and no network call. A
    template engine would break the first; a CDN stylesheet would break the
    second. Everything here is inline, so the dashboard renders identically on
    a laptop with the wifi off, which is where this desk is meant to be used.

THE ESCAPING RULE
    `e()` is the only way operator text reaches a page. Case titles, claim
    text, agency names, and note bodies are all typed by a person and some of
    them are quoted from documents written by other people. A claim that reads
    `<script>` is a claim someone might genuinely need to record about a
    document, and it must render as those nine characters rather than execute.

    Everything in this module that interpolates content either calls e() itself
    or documents that its caller must. The functions taking pre-built HTML --
    page(), table() rows, note() -- say so in their docstrings, because that is
    where an escaping mistake would actually land.

COLOUR CARRIES MEANING, NOT DECORATION
    GREEN is documented. RED APPLE is an open question. DEAD END is a line of
    inquiry that closed. The badge colours match the language used in the
    gates, so the screen and the vocabulary agree.
"""

from __future__ import annotations

import html

# GlassMark tiers as they appear on screen. The internal vocabulary is terser
# than what a reader should see: RED means "open question", not "wrong".
TIER_DISPLAY = {
    "GREEN": ("GREEN", "#1f6f43"),
    "ARITH": ("ARITHMETIC", "#3a5f8a"),
    "REPORTED": ("REPORTED", "#6b5b95"),
    "RED": ("RED APPLE", "#8a2e2e"),
    "VERIFY": ("VERIFY", "#8a6a1f"),
    "DEAD": ("DEAD END", "#5a5a5a"),
}

CSS = """
:root{--ink:#1a1a1a;--mut:#6b6b6b;--line:#e0ddd6;--bg:#faf8f4;--panel:#fff;
      --accent:#8a6a1f;--alarm:#8a2e2e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
     font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:28px 20px 64px}
nav{border-bottom:1px solid var(--line);background:var(--panel)}
nav .inner{max-width:1040px;margin:0 auto;padding:0 20px;display:flex;gap:22px;
           align-items:center;flex-wrap:wrap}
nav a{color:var(--mut);text-decoration:none;padding:14px 0;font-size:14px}
nav a:hover{color:var(--ink)}
nav a.on{color:var(--ink);box-shadow:inset 0 -2px 0 var(--accent)}
nav .brand{font-weight:700;color:var(--ink);letter-spacing:.5px;margin-right:8px}
h1{font-size:24px;margin:22px 0 6px;letter-spacing:-.2px}
h2{font-size:17px;margin:30px 0 10px}
.lede{color:var(--mut);margin:0 0 20px;max-width:64ch}
.muted{color:var(--mut)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));
       gap:12px;margin:18px 0 6px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:14px}
.stat .n{font-size:25px;font-weight:700;line-height:1.1}
.stat.alarm .n{color:var(--alarm)}
.stat .l{font-size:12px;color:var(--mut);margin-top:5px}
.stat .s{font-size:11px;color:var(--mut);margin-top:2px}
table{width:100%;border-collapse:collapse;background:var(--panel);
      border:1px solid var(--line);border-radius:9px;overflow:hidden;margin:10px 0 4px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;
   color:var(--mut);font-weight:600;padding:10px 12px;border-bottom:1px solid var(--line)}
td{padding:10px 12px;border-bottom:1px solid #f0eee9;vertical-align:top;font-size:14px}
tr:last-child td{border-bottom:none}
td a{color:#2a4d7a}
.empty{padding:18px 12px;color:var(--mut);font-size:14px}
.badge{display:inline-block;padding:2px 8px;border-radius:11px;font-size:11px;
       font-weight:700;letter-spacing:.4px;color:#fff;white-space:nowrap}
.note{border:1px solid var(--line);border-left-width:3px;background:var(--panel);
      border-radius:7px;padding:12px 14px;margin:14px 0}
.note h3{margin:0 0 5px;font-size:14px}
.note.block{border-left-color:var(--alarm)}
.note.warn{border-left-color:var(--accent)}
.note.ok{border-left-color:#1f6f43}
.note.info{border-left-color:#3a5f8a}
.foot{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);
      color:var(--mut);font-size:12px;line-height:1.7}
@media(prefers-color-scheme:dark){
  :root{--ink:#e8e5df;--mut:#9a968e;--line:#2c2a26;--bg:#141311;--panel:#1c1b18;
        --accent:#c8a54a;--alarm:#d1655e}
  td{border-bottom-color:#242220}
  td a{color:#8ab0dd}
}
"""

NAV = [("/", "Dashboard"), ("/cases", "Cases"), ("/requests", "Requests"),
       ("/corrections", "Corrections"), ("/audit", "Audit")]


def e(value) -> str:
    """Escape operator text for HTML. The only safe way text reaches a page."""
    return html.escape("" if value is None else str(value), quote=True)


def tier_badge(tier: str) -> str:
    label, colour = TIER_DISPLAY.get(str(tier).upper(), (str(tier), "#5a5a5a"))
    return f'<span class="badge" style="background:{colour}">{e(label)}</span>'


def stat(label: str, number, sub: str = "", alarm: bool = False) -> str:
    """One figure. `label` and `sub` are escaped here; pass plain text."""
    cls = "stat alarm" if alarm else "stat"
    return (f'<div class="{cls}"><div class="n">{e(number)}</div>'
            f'<div class="l">{e(label)}</div>'
            + (f'<div class="s">{e(sub)}</div>' if sub else "")
            + "</div>")


def stats(cards: list[str]) -> str:
    return f'<div class="stats">{"".join(cards)}</div>'


def table(headers: list[str], rows: list[list[str]], empty: str = "Nothing here.") -> str:
    """A table.

    CALLER ESCAPES THE CELLS. Rows arrive as HTML because most cells are links
    or badges built from e() already; escaping again here would render the
    markup as text. Headers and the empty message ARE escaped, since those are
    always plain strings.
    """
    if not rows:
        return f'<div class="empty">{e(empty)}</div>'
    head = "".join(f"<th>{e(h)}</th>" for h in headers)
    body = "".join(
        "<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows)
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def note(kind: str, title: str, body_html: str = "") -> str:
    """A callout. `title` is escaped; `body_html` is NOT — it is HTML by design,
    so the caller must have escaped any operator text inside it."""
    k = kind if kind in ("block", "warn", "ok", "info") else "info"
    return (f'<div class="note {k}"><h3>{e(title)}</h3>'
            + (f"<div>{body_html}</div>" if body_html else "") + "</div>")


def page(title: str, active: str, body_html: str) -> str:
    """A whole document. `body_html` is HTML by design; `title` is escaped."""
    links = "".join(
        f'<a href="{href}" class="{"on" if href == active else ""}">{e(label)}</a>'
        for href, label in NAV)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)} · Sentinel Desk</title>
<style>{CSS}</style></head>
<body>
<nav><div class="inner"><span class="brand">SENTINEL</span>{links}</div></nav>
<div class="wrap">
{body_html}
<div class="foot">
Local only — bound to 127.0.0.1, no network call, no third-party dependency.<br>
Nothing shown here is published. Publication is a separate, deliberate act.
</div>
</div></body></html>"""
