# -*- coding: utf-8 -*-
"""HTML for every page of the station site. Pure functions: public ledger in, strings out.
Every value is escaped at the point of use; nothing from the ledger is trusted as markup."""
import datetime
import html
import json
import math
import re
from collections import Counter, defaultdict
from decimal import Decimal

E = lambda s: html.escape("" if s is None else str(s), quote=True)
NAV = [("findings.html", "Findings"), ("money.html", "Money"), ("map.html", "Map"), ("timeline.html", "Timeline"),
       ("method.html", "Method"), ("corrections.html", "Corrections"), ("sources.html", "Sources"), ("verify.html", "Verify")]
TIER = {"GREEN": "green", "ARITH": "arith", "REPORTED": "reported", "RED": "red", "DEAD END": "dead"}
PUB_TEXT = {"PUBLISH_WITH_ATTRIBUTION": "Published with attribution", "PUBLISH_AS_QUESTION": "Open question",
            "PUBLISH_AFTER_VERIFY": "Awaiting re-pull", "HOLD": "On hold", "INTERNAL": "Internal", "CORRECTION": "Correction"}
FAMILY = {"CONTRACT_SCHEDULE": "contracts", "CONTRACT_TERMS": "contracts", "AWARD_VALUE": "contracts", "AWARD_AGGREGATE": "contracts",
          "APPROPRIATION": "contracts", "APPROPRIATION_ACTUAL": "contracts", "BUDGET_REQUEST": "contracts",
          "IE_SUPPORT": "electoral", "IE_OPPOSE": "electoral", "IE_VENDOR_PAYMENT": "electoral", "DIRECT_CONTRIBUTION": "electoral",
          "CONDUIT_FORWARDED": "electoral", "MIXED_OWN_FORWARDED": "electoral", "COMMITTEE_TRANSFER": "electoral", "JFC_PROCEEDS": "electoral",
          "RECEIPT": "electoral", "REFUND": "electoral", "LOBBYING_INCOME": "lobbying", "AGENT_EXPENDITURE": "lobbying",
          "AGENT_EXPENDITURE_AGGREGATE": "lobbying", "OPERATING_DISBURSEMENT": "spending", "DISBURSEMENT_UNCLASSIFIED": "spending",
          "REPORTED_SPEND": "spending", "SETTLEMENT": "settlements", "ALLEGED_TRANSFER": "alleged", "ON_CHAIN_TRANSFER": "onchain"}
FAMILY_NAME = {"contracts": "Contracts and awards", "electoral": "Election spending", "lobbying": "Lobbying and agents",
               "spending": "Spending and disbursements", "settlements": "Settlements", "alleged": "Alleged (charging documents)",
               "onchain": "On-chain"}
REL_COLOR = {"REPRESENTATION": "lobbying", "CONTRACTUAL": "contracts", "MEDIATION": "contracts", "FINANCIAL": "spending",
             "ORGANIZATIONAL": "settlements", "AUTHORITY": "settlements", "DIRECTION": "alleged", "DEPENDENCY": "alleged",
             "INFORMATIONAL": "electoral", "ADVOCACY": "electoral"}


def money(v):
    if v is None:
        return "—"
    d = Decimal(str(v))
    if d == d.to_integral_value():
        return "${:,.0f}".format(d)
    return "${:,.2f}".format(d)


def short_money(v):
    d = float(v)
    for n, s in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(d) >= n:
            x = d / n
            return "${}{}".format(("{:.1f}".format(x)).rstrip("0").rstrip("."), s)
    return "${:,.0f}".format(d)


def fmt_date(s):
    try:
        d = datetime.date.fromisoformat(s[:10])
        return "{} {} {}".format(d.day, d.strftime("%B"), d.year)
    except (ValueError, TypeError):
        return s or ""


def pill(tier):
    return '<span class="pill {}">{}</span>'.format(TIER.get(tier, "quiet"), E(tier.title() if tier != "DEAD END" else "Dead end"))


def pub_pill(pub):
    cls = {"PUBLISH_WITH_ATTRIBUTION": "green", "PUBLISH_AS_QUESTION": "arith"}.get(pub, "quiet")
    return '<span class="pill {}">{}</span>'.format(cls, E(PUB_TEXT.get(pub, pub)))


def ents(P):
    return {e["id"]: e for e in P["entities"]}


def name(P, eid):
    e = ents(P).get(eid)
    return e["name"] if e else eid


# ------------------------------------------------------------------------------------------ shell
def shell(site, *, title, body, depth=0, active=None, desc=None, og=None, kind="page", art=None, extra_head=""):
    r = "../" * depth
    nav = "".join('<li><a href="{}{}"{}>{}</a></li>'.format(r, href, ' aria-current="page"' if active == href else "", E(lbl)) for href, lbl in NAV)
    status = site["status"]
    bar = '<div class="preview-bar{}" role="status">{}</div>'.format(" approved" if status["approved"] else "", E(status["line"]))
    art_json = '<script type="application/json" id="art-data">{}</script>'.format(json.dumps(art).replace("</", "<\\/")) if art else ""
    og_img = (site["base_url"] or "") + (og or "img/og.jpg") if site.get("images", True) else ""
    head = """<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta property="og:type" content="article"><meta property="og:title" content="{title}"><meta property="og:description" content="{desc}">
{ogtag}
<meta name="generator" content="TSR station {ver}"><meta name="tsr:public-ledger-sha256" content="{digest}">
<link rel="alternate" type="application/atom+xml" title="The Sentinel Report" href="{r}feed.xml">
<link rel="stylesheet" href="{r}assets/site.css">{extra}""".format(title=E(title), desc=E(desc or site["desc"]), ver=E(site["version"]),
                                                                  ogtag=('<meta property="og:image" content="{}"><meta name="twitter:card" content="summary_large_image">'.format(E(og_img)) if og_img else '<meta name="twitter:card" content="summary">'),
                                                                  digest=E(site["digest"]), r=r, extra=extra_head)
    bodyhtml = """<a class="skip" href="#main">Skip to content</a>
{bar}
<header class="top"><div class="wrap">
<a class="brand" href="{r}index.html">The Sentinel <b>Report</b></a>
<nav aria-label="Sections"><ul class="nav">{nav}</ul></nav>
<button class="theme-btn" type="button" aria-label="Color theme">Auto</button>
</div></header>
<main id="main">
{body}
</main>
<footer class="foot"><div class="wrap">
<div class="stack">
<p><b>The Sentinel Report.</b> Named sources, public documents, verified facts. Built {built} from ledger schema {schema}.</p>
<p>Public ledger SHA-256 <span class="hash">{digest}</span></p>
<p>Prepared with AI research assistance. The desk reviews every item before publication. Private individuals are counted, never named.</p>
</div>
<div class="stack">
<p><a href="{r}verify.html">Check this site</a> · <a href="{r}feed.xml">Feed</a> · <a href="{r}data/public-ledger.json">Data</a> · <a href="{r}method.html">Method</a></p>
<p>Theme: {theme}. Fonts are embedded; this site loads nothing from another host.</p>
</div>
</div></footer>
{art_json}
<script src="{r}assets/art.js" defer></script>
<script src="{r}assets/site.js" defer></script>""".format(bar=bar, r=r, nav=nav, body=body, built=E(fmt_date(site["built"])), schema=E(site["schema"]),
                                                         digest=E(site["digest"]), theme=E(site["theme_name"]), art_json=art_json)
    return head, bodyhtml


def full(head, body):
    return '<!doctype html>\n<html lang="en">\n<head>\n' + head + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n'


# ------------------------------------------------------------------------------------------ pieces
def finding_card(P, f, depth=0):
    r = "../" * depth
    if f["publication"] == "PUBLISH_AS_QUESTION":
        return """<article class="card q-card" data-lane="{lane}" data-tier="{tierk}" data-pub="{pub}">
<div class="meta"><span class="mono">{id}</span>{pp}<span class="lane">{lane}</span></div>
<h3><a href="{r}f/{id}.html">{q}</a></h3>
<div class="foot"><span>{rq} record{s} would answer it</span></div></article>""".format(
            id=E(f["id"]), lane=E(f["lane"]), tierk=E(f["glassmark"]), pub=E(f["publication"]), pp=pub_pill(f["publication"]), r=r,
            q=E(f["question"]), rq=len(f.get("missing_records") or []), s="" if len(f.get("missing_records") or []) == 1 else "s")
    pp = f.get("proof_profile") or {}
    return """<article class="card" data-lane="{lane}" data-tier="{tierk}" data-pub="{pub}">
<div class="meta"><span class="mono">{id}</span>{tier}<span class="lane">{lane}</span></div>
<h3><a href="{r}f/{id}.html">{title}</a></h3>
<p>{headline}</p>
<div class="foot"><span>{nv}/{nl} figures verified</span><span>{qv}/{qa} quotes</span><span>{rung}</span></div></article>""".format(
        id=E(f["id"]), lane=E(f["lane"]), tierk=E(f["glassmark"]), pub=E(f["publication"]), tier=pill(f["glassmark"]), r=r,
        title=E(f["title"]), headline=E(f["headline"]), nv=pp.get("numbers_verified", 0), nl=pp.get("numbers_linked", 0),
        qv=pp.get("anchor_quotes_verified", 0), qa=pp.get("anchor_quotes", 0), rung=E((f.get("causal") or {}).get("rung_code", "C0")))


def gate_svg(counts, public_ids):
    """51 marks, one per finding, sorted into the four outcomes of the gate. Complete at rest."""
    order = [("published", "Published", "green"), ("questions", "Questions", "arith"), ("repull", "Awaiting re-pull", "reported"), ("held", "Held", "dead")]
    W, H = 640, 300
    out = ['<svg viewBox="0 0 {} {}" role="img" aria-label="{} findings pass through the gate: {} published, {} questions, {} awaiting re-pull, {} held">'.format(
        W, H, sum(counts.values()), counts["published"], counts["questions"], counts["repull"], counts["held"])]
    gx, gy = 150, 150
    total = sum(counts.values())
    cols = 7
    k = 0
    for key, _, cls in order:
        for _ in range(counts[key]):
            cx, cy = 26 + (k % cols) * 14, 44 + (k // cols) * 14
            out.append('<circle cx="{}" cy="{}" r="4.2" style="fill:var(--t-{})"/>'.format(cx, cy, cls))
            k += 1
    out.append('<rect x="{}" y="40" width="12" height="220" rx="2" style="fill:var(--panel-2);stroke:var(--accent)"/>'.format(gx))
    y0 = [52, 118, 184, 250]
    for i, (key, label, cls) in enumerate(order):
        y = y0[i]
        out.append('<path class="flowline move" d="M{} {} C {} {}, {} {}, {} {}" style="stroke:var(--t-{});stroke-width:{:.1f}"/>'.format(
            gx + 12, 150, gx + 90, 150, gx + 90, y, gx + 170, y, cls, 1.2 + 4 * counts[key] / max(1, total)))
        n = counts[key]
        per = 13
        for j in range(n):
            cx, cy = gx + 184 + (j % per) * 12, y - 8 + (j // per) * 12
            out.append('<circle cx="{}" cy="{}" r="3.8" style="fill:var(--t-{})"/>'.format(cx, cy, cls))
    out.append("</svg>")
    return "".join(out)


def ladder_html(P, rung, alleged=False):
    lad = P["vocabularies"]["causal_ladder"]
    items = []
    for i, (code, nm, desc) in enumerate(lad):
        cls = "here" if i == rung else ("on" if i < rung else "above")
        items.append('<li class="{}"><b>{}</b><span>{}{}</span></li>'.format(cls, E(code), E(nm.title()),
                                                                           " (alleged)" if alleged and i == rung else ""))
    return '<ol class="ladder" aria-label="Causal ladder, C0 to C7; this finding reaches {}">{}</ol>'.format(E(lad[rung][0]), "".join(items))


def period_key(p):
    m = re.match(r"([A-Z][a-z]{2}) (\d{4})", p or "")
    if m:
        try:
            return datetime.datetime.strptime(m.group(0), "%b %Y").date()
        except ValueError:
            return None
    return None


def kind_chart(P, rows, asof):
    """Bars for one kind of money only; the scale never spans two kinds. HTML, so text keeps its size on a phone."""
    fam = FAMILY.get(rows[0]["kind"], "spending")
    alleged = rows[0]["kind"] == "ALLEGED_TRANSFER"
    groups = defaultdict(list)
    for m in rows:
        groups[(m["from"], m["to"])].append(m)
    months = [period_key(m.get("period")) for m in rows]
    if len(rows) >= 3 and all(months) and len(groups) == 1:
        pts = sorted(zip(months, rows), key=lambda t: t[0])
        mx = max(float(m["amount_usd"] or 0) for _, m in pts) or 1
        asof_d = datetime.date.fromisoformat(asof).replace(day=1)
        cols = []
        for d, m in pts:
            fut = d > asof_d
            cols.append('<div class="col{}"><span class="v">{}</span><i style="height:{:.1f}%"></i><span class="m">{}</span></div>'.format(
                " future" if fut else "", E(short_money(m["amount_usd"] or 0)), 72 * float(m["amount_usd"] or 0) / mx, E(d.strftime("%b"))))
        idx = sum(1 for d, _ in pts if d <= asof_d)
        return ('<div class="cols" style="--n:{n};--c:var(--f-{fam})" role="img" aria-label="{kind} by month; months after {asof} are future">{cols}'
                '<div class="asof{flip}" style="left:calc({idx} * (100% + 10px) / {n} - 5px)"><span>as of {asofp}</span></div></div>'
                '<p class="muted" style="font-size:var(--fs-xs);margin-top:6px">Dashed columns are months that had not ended on the ledger date.</p>').format(
            n=len(pts), fam=fam, kind=E(rows[0]["kind"]), asof=E(asof), cols="".join(cols), idx=idx, asofp=E(fmt_date(asof)),
            flip=" flip" if idx > len(pts) / 2 else "")
    items = sorted(((k, sum(Decimal(str(m["amount_usd"] or 0)) for m in ms), ms) for k, ms in groups.items()), key=lambda t: -t[1])
    mx = float(items[0][1]) or 1
    out = ['<div class="hbars" style="--c:var(--f-{})">'.format(fam)]
    for (a, b), tot, ms in items:
        label = ("at least " if any(m.get("is_floor") for m in ms) else "") + (money(tot) if tot else (ms[0].get("amount_text") or "amount not stated"))
        pct = max(0.6, 100 * float(tot) / mx) if tot else 0
        out.append('<div class="hbar"><div class="hbar-label">{} → {}</div><div class="hbar-track"><i class="{}" style="width:{:.1f}%"></i><span>{}{}</span></div></div>'.format(
            E(name(P, a)), E(name(P, b)), "alleged" if alleged else "", pct * 0.82, E(label), " · {} rows".format(len(ms)) if len(ms) > 1 else ""))
    out.append("</div>")
    return "".join(out)


def flow_strip(P, rows):
    """The path this kind of money takes, and where the record stops following it."""
    fam = FAMILY.get(rows[0]["kind"], "spending")
    payers = sorted(set(m["from"] for m in rows))
    payees = sorted(set(m["to"] for m in rows))
    outs = set(m["from"] for m in P["money_flows"])
    left = E(name(P, payers[0])) if len(payers) == 1 else "{} payers".format(len(payers))
    right = E(name(P, payees[0])) if len(payees) == 1 else "{} recipients".format(len(payees))
    kind = rows[0]["kind"].replace("_", " ").lower()
    parts = ['<div class="flow" style="--c:var(--f-{})">'.format(fam), '<span class="node">{}</span>'.format(left),
             '<span class="pipe{}"><em>{} · {} row{}</em></span>'.format(" alleged" if rows[0]["kind"] == "ALLEGED_TRANSFER" else "", E(kind), len(rows), "" if len(rows) == 1 else "s"),
             '<span class="node">{}</span>'.format(right)]
    if len(payees) == 1 and payees[0] not in outs:
        parts.append('<span class="pipe end"><em>no outflow on record</em></span><span class="node q" title="The record does not say where this money went next">?</span>')
    parts.append("</div>")
    return "".join(parts)


# ------------------------------------------------------------------------------------------ network layout
def _fr(ids, edges, rnd, W, H, iters=400):
    pos = {n: [rnd.uniform(0.25, 0.75) * W, rnd.uniform(0.25, 0.75) * H] for n in ids}
    if len(ids) == 1:
        return {ids[0]: [W / 2, H / 2]}
    k = math.sqrt(W * H / len(ids)) * 0.75
    t = W / 6
    for _ in range(iters):
        disp = {n: [0.0, 0.0] for n in ids}
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                dx, dy = pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]
                d = math.hypot(dx, dy) or 0.01
                f = k * k / d
                disp[a][0] += dx / d * f; disp[a][1] += dy / d * f
                disp[b][0] -= dx / d * f; disp[b][1] -= dy / d * f
        for a, b in edges:
            dx, dy = pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]
            d = math.hypot(dx, dy) or 0.01
            f = d * d / k
            disp[a][0] -= dx / d * f; disp[a][1] -= dy / d * f
            disp[b][0] += dx / d * f; disp[b][1] += dy / d * f
        for n in ids:
            disp[n][0] += (W / 2 - pos[n][0]) * 0.05
            disp[n][1] += (H / 2 - pos[n][1]) * 0.05
            dx, dy = disp[n]
            d = math.hypot(dx, dy) or 0.01
            pos[n][0] += dx / d * min(d, t)
            pos[n][1] += dy / d * min(d, t)
        t = max(0.5, t * 0.98)
    xs = [p[0] for p in pos.values()]; ys = [p[1] for p in pos.values()]
    sx = (W - 20) / max(1, max(xs) - min(xs)); sy = (H - 20) / max(1, max(ys) - min(ys))
    sc = min(sx, sy, 1.6)
    return {n: [10 + (p[0] - min(xs)) * sc, 10 + (p[1] - min(ys)) * sc] for n, p in pos.items()}


def layout(nodes, edges, seed_hex, W=900):
    """Each connected group of parties gets its own box; boxes are shelf-packed left to right. Unrelated
    groups never sit on top of each other, so an accidental overlap cannot read as a link."""
    import random
    rnd = random.Random(int(seed_hex[:16], 16))
    parent = {n: n for n in nodes}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b in edges:
        if a in parent and b in parent:
            parent[find(a)] = find(b)
    comps = defaultdict(list)
    for n in sorted(nodes):
        comps[find(n)].append(n)
    groups = sorted(comps.values(), key=lambda g: (-len(g), g[0]))
    pos, x, y, row_h = {}, 0, 0, 0
    for g in groups:
        n = len(g)
        bw = min(W, 230 + 120 * math.sqrt(n))
        bh = 70 + 62 * math.sqrt(n)
        if x + bw > W and x > 0:
            x, y, row_h = 0, y + row_h + 26, 0
        ge = [(a, b) for a, b in edges if a in g and b in g and a != b]
        inner = _fr(g, ge, rnd, bw - 190, bh - 30)
        for nid, (px, py) in inner.items():
            pos[nid] = [x + 20 + px, y + 20 + py]
        x += bw + 24
        row_h = max(row_h, bh)
    return pos, y + row_h + 30


def place_labels(pos, names, W):
    """Put each label beside its node where it collides with no other label or node."""
    boxes, out = [], {}
    pts = [(p[0] - 7, p[1] - 7, p[0] + 7, p[1] + 7) for p in pos.values()]

    def clash(b):
        return any(not (b[2] < o[0] or b[0] > o[2] or b[3] < o[1] or b[1] > o[3]) for o in boxes + pts)
    for nid in sorted(pos, key=lambda n: (pos[n][1], pos[n][0])):
        x, y = pos[nid]
        txt = names[nid]
        w = 6.3 * len(txt) + 4
        cands = ((10, 4, "start"), (-10, 4, "end"), (10, -10, "start"), (10, 18, "start"), (-10, -10, "end"), (-10, 18, "end"))
        chosen = None
        for dx, dy, anchor in cands:
            bx0 = x + dx if anchor == "start" else x + dx - w
            b = (bx0, y + dy - 10, bx0 + w, y + dy + 3)
            if not clash(b) and 0 <= b[0] and b[2] <= W + 60:
                chosen = (dx, dy, anchor, b)
                break
        if chosen is None:
            dx, dy, anchor = cands[0]
            b = (x + dx, y + dy - 10, x + dx + w, y + dy + 3)
        else:
            dx, dy, anchor, b = chosen
        boxes.append(b)
        out[nid] = (x + dx, y + dy, anchor)
    return out


def node_shape(kind, x, y, fam):
    if kind == "government":
        return '<rect x="{:.1f}" y="{:.1f}" width="12" height="12" rx="1" style="fill:var(--f-{})"/>'.format(x - 6, y - 6, fam)
    if kind == "operation":
        return '<path d="M{:.1f} {:.1f} l7 12 h-14 z" style="fill:var(--f-{})"/>'.format(x, y - 7, fam)
    if kind == "committee":
        return '<path d="M{:.1f} {:.1f} l7 7 l-7 7 l-7 -7 z" style="fill:var(--f-{})"/>'.format(x, y - 7, fam)
    if kind == "person":
        return '<circle cx="{:.1f}" cy="{:.1f}" r="5.5" style="fill:var(--art-bg);stroke:var(--f-{}) !important;stroke-width:2.2"/>'.format(x, y, fam)
    return '<circle cx="{:.1f}" cy="{:.1f}" r="6" style="fill:var(--f-{})"/>'.format(x, y, fam)


# ================================================================================================= pages
def page_home(site, P):
    F = P["findings"]
    pubs = [f for f in F if f["publication"] == "PUBLISH_WITH_ATTRIBUTION"]
    qs = [f for f in F if f["publication"] == "PUBLISH_AS_QUESTION"]
    V = P["verification"]
    held = P["held"]
    counts = {"published": len(pubs), "questions": len(qs), "repull": held["awaiting_repull"], "held": held["on_hold"] + held["internal"]}
    fam_used = sorted(set(fl["family"] for fl in site["art"]["flows"]))
    legend = "".join('<li><i style="background:var(--f-{})"></i>{}</li>'.format(f, E(FAMILY_NAME[f])) for f in fam_used)
    legend += '<li><i class="dash" style="color:var(--muted)"></i>alleged or not machine-checked</li>'
    latest = sorted(pubs, key=lambda f: (f.get("snapshot") or "", f["id"]), reverse=True)[:6]
    body = """
<section class="hero"><div class="wrap">
  <div>
    <p class="eyebrow">Evidence ledger · as of {asof}</p>
    <h1>Named sources. Public documents. Verified facts.</h1>
    <p class="lede">Every figure here traces to a line, a cell or a page in a record. Every sentence was checked against what its evidence can carry.</p>
    <p>What could not be verified is labelled. What the desk is still holding is counted below, with the reason.</p>
    <div class="cta"><a class="btn" href="findings.html">Read the findings</a><a class="btn btn-quiet" href="verify.html">Check our work</a></div>
  </div>
  <figure class="sig">
    <canvas id="sig-canvas" width="880" height="660" role="img" aria-label="Ledger signature: a generative drawing of the public ledger's money flows and relationships, seeded by its SHA-256 digest"></canvas>
    <figcaption><span>Ledger signature, drawn from the SHA-256 of the public ledger. Change one fact and every current bends differently. <a href="verify.html#signature">How to check</a></span><span class="hash">{digest}</span></figcaption>
    <ul class="legend">{legend}</ul>
  </figure>
</div></section>

<section class="proof" aria-label="What was checked"><div class="wrap"><ul>
  <li><b>{np}</b><span>findings published with attribution</span></li>
  <li><b>{nq}</b><span>open questions, published only as questions</span></li>
  <li><b>{nv}/{nt}</b><span>figures traced to their exact line, cell or page (whole ledger)</span></li>
  <li><b>{qp}</b><span>quotes found word for word in their sources</span></li>
  <li><b>{cx}</b><span>corrections logged, including the desk's own mistakes</span></li>
  <li><b>{nh}</b><span>findings held back, counted here and not shown</span></li>
</ul></div></section>

<section class="section"><div class="wrap">
  <div class="section-head"><div><p class="eyebrow">The gate</p><h2>What we publish, and what we hold</h2>
  <p>Every finding passes one gate. A figure must trace to its record. A verb must not claim more than the record shows. Findings still waiting on a fresh copy of their source, or on a record not yet seen, stay on the desk.</p></div></div>
  <div class="gate">
    {gate}
    <ul class="buckets">
      <li><b style="color:var(--t-green)">{np}</b><span><strong>Published with attribution.</strong> The record says this, and the page names the record.</span></li>
      <li><b style="color:var(--t-arith)">{nq}</b><span><strong>Open questions.</strong> Published only as questions, each with the record that would answer it.</span></li>
      <li><b style="color:var(--t-reported)">{nr}</b><span><strong>Awaiting re-pull.</strong> The source must be fetched again and match before publication.</span></li>
      <li><b style="color:var(--t-dead)">{nh2}</b><span><strong>On hold or internal.</strong> Held for verification, or kept for the desk's method.</span></li>
    </ul>
  </div>
</div></section>

<section class="section"><div class="wrap">
  <div class="section-head"><div><p class="eyebrow">Findings</p><h2>Latest published</h2></div><a class="btn btn-quiet" href="findings.html">All {np} findings</a></div>
  <div class="grid">{cards}</div>
</div></section>

<section class="section"><div class="wrap">
  <div class="section-head"><div><p class="eyebrow">Open questions</p><h2>What we are still asking</h2>
  <p>These are published as questions because the record that would answer them is not in hand.</p></div></div>
  <div class="grid">{qcards}</div>
</div></section>

<section class="section"><div class="wrap cols-2">
  <div class="stack"><p class="eyebrow">Corrections</p><h2>What we got wrong</h2>
  <p class="muted">Every correction stays on the record: what was wrong, what is right, and why it matters.</p>{corr}
  <p><a href="corrections.html">All corrections</a></p></div>
  <div class="stack"><p class="eyebrow">Check our work</p><h2>Don't take our word for it</h2>
  <p>This site is a set of files, and each file's SHA-256 is listed in <a href="manifest.json">manifest.json</a>. The data behind every page is in <a href="data/public-ledger.json">public-ledger.json</a>. <a href="verify.html">The verify page</a> re-hashes every file in your browser.</p>
  <p class="muted">Subscribe to <a href="feed.xml">the feed</a>. It carries new findings and new corrections.</p></div>
</div></section>
""".format(asof=E(fmt_date(P["meta"]["as_of"])), digest=E(site["digest"]), legend=legend, np=len(pubs), nq=len(qs),
           nv=V["numbers_machine_verified"], nt=V["numbers_total"], qp=V["quotes_word_for_word"], cx=P["corrections_total"],
           nh=held["awaiting_repull"] + held["on_hold"] + held["internal"], gate=gate_svg(counts, set()),
           nr=held["awaiting_repull"], nh2=held["on_hold"] + held["internal"],
           cards="".join(finding_card(P, f) for f in latest), qcards="".join(finding_card(P, f) for f in qs[:3]),
           corr="".join('<div><p><span class="mono">{}</span> <strong>{}</strong></p><p class="muted">{}</p></div>'.format(
               E(c["id"]), E(c["title"]), E(c["what_is_right"])) for c in sorted(P["corrections"], key=lambda c: c["id"], reverse=True)[:3]))
    return shell(site, title="The Sentinel Report", body=body, depth=0, active=None, art=site["art"], kind="home")


def page_findings(site, P):
    F = P["findings"]
    pubs = [f for f in F if f["publication"] == "PUBLISH_WITH_ATTRIBUTION"]
    qs = [f for f in F if f["publication"] == "PUBLISH_AS_QUESTION"]
    lanes = sorted(set(f["lane"] for f in F))
    lane_names = P["vocabularies"]["lanes"]
    btns = ['<button type="button" data-filter="all" aria-pressed="true">All ({})</button>'.format(len(F))]
    btns += ['<button type="button" data-filter="{}" aria-pressed="false">{} ({})</button>'.format(E(l), E(lane_names.get(l, {}).get("name", l)),
             sum(1 for f in F if f["lane"] == l)) for l in lanes]
    btns += ['<button type="button" data-filter="PUBLISH_AS_QUESTION" aria-pressed="false">Questions only ({})</button>'.format(len(qs))]
    body = """<section class="section"><div class="wrap">
<div class="section-head"><div><p class="eyebrow">Findings</p><h1>What the records show</h1>
<p><span id="shown-count">{n}</span> shown. Each finding names its record, says what the record does not show, and gives the ordinary explanation first.</p></div></div>
<div class="filters" role="group" aria-label="Filter findings">{btns}</div>
<div class="grid">{cards}</div>
<p class="muted" style="margin-top:22px">{held} more findings are on the desk: {rp} awaiting a fresh copy of their source, {oh} on hold, {it} internal. They are counted, not shown.</p>
</div></section>""".format(n=len(F), btns="".join(btns), cards="".join(finding_card(P, f) for f in pubs + qs),
                          held=sum(P["held"].values()), rp=P["held"]["awaiting_repull"], oh=P["held"]["on_hold"], it=P["held"]["internal"])
    return shell(site, title="Findings · The Sentinel Report", body=body, active="findings.html", desc="Published findings and open questions, each with its record.")


def _sources_list(P, ids, r):
    S = {s["id"]: s for s in P["sources"]}
    out = []
    for sid in ids:
        s = S.get(sid)
        if not s:
            continue
        link = '<a href="{}" rel="noopener">{}</a>'.format(E(s["url"]), E(s["title"])) if s.get("url") else E(s["title"])
        extra = []
        if s.get("publisher"):
            extra.append(E(s["publisher"]))
        if s.get("date"):
            extra.append(E(s["date"]))
        if s.get("sha256"):
            extra.append('in custody, SHA-256 <span class="mono">{}…</span>'.format(E(s["sha256"][:16])))
        out.append('<li><span class="mono">{}</span> {}<span class="where">{}</span></li>'.format(E(sid), link, " · ".join(extra)))
    return '<ul class="quotes">{}</ul>'.format("".join(out))


def page_finding(site, P, f):
    r = "../"
    lane_names = P["vocabularies"]["lanes"]
    c = f.get("causal") or {"rung": 0, "rung_code": "C0", "rung_name": "OBSERVED", "competing": []}
    rq = {x["id"]: x for x in P["records_queue"]}
    recs = [rq[x] for x in f.get("missing_records", []) if x in rq]
    rec_html = "".join('<li><strong>{id}</strong> {q} <span class="where">{t} · {st}{auth}</span></li>'.format(
        id=E(x["id"]), q=E(x["question"]), t=E(x["record_target"]), st=E(x["status"]),
        auth=" · needs separate authorization" if x.get("action_type") in ("records_request", "voluntary_request") else "") for x in recs)
    card_img = "{}img/cards/{}.jpg".format(r, f["id"])
    cite = "The Sentinel Report, {} ({}), {}. Public ledger SHA-256 {}.".format(f["id"], f["title"], fmt_date(f.get("snapshot") or P["meta"]["as_of"]), site["digest"][:16])
    rail = """<aside class="rail" aria-label="Provenance"><dl>
<dt>Finding</dt><dd>{id}</dd><dt>Lane</dt><dd>{lane}</dd><dt>Status</dt><dd>{pp}</dd><dt>Evidence tier</dt><dd>{tier}</dd>
<dt>Evidence class</dt><dd>{cls}</dd><dt>Causal rung</dt><dd>{rung} {rn}</dd><dt>Snapshot</dt><dd>{snap}</dd>
<dt>Figures verified</dt><dd>{nv} of {nl}</dd><dt>Quotes verified</dt><dd>{qv} of {qa}</dd><dt>Sources</dt><dd>{ns}</dd>
</dl></aside>""".format(id=E(f["id"]), lane=E(lane_names.get(f["lane"], {}).get("name", f["lane"])), pp=pub_pill(f["publication"]),
                        tier=pill(f["glassmark"]), cls=E(f["evidence_class"].replace("_", " ").lower()), rung=E(c["rung_code"]),
                        rn=E(c["rung_name"].title()), snap=E(f.get("snapshot") or ""), nv=(f.get("proof_profile") or {}).get("numbers_verified", 0),
                        nl=(f.get("proof_profile") or {}).get("numbers_linked", 0), qv=(f.get("proof_profile") or {}).get("anchor_quotes_verified", 0),
                        qa=(f.get("proof_profile") or {}).get("anchor_quotes", 0), ns=len(f.get("sources") or []))
    if f["publication"] == "PUBLISH_AS_QUESTION":
        pi = f.get("public_interest") or {}
        main = """<div class="stack-l">
<nav class="crumbs"><a href="{r}findings.html">Findings</a><span>/</span><span>{lane}</span><span>/</span><span class="mono">{id}</span></nav>
<div class="stack"><p class="eyebrow">Open question</p><h1 class="question-big">{q}</h1>
<p class="muted">This is published as a question, not a finding. The desk does not yet hold the record that would answer it.</p></div>
<div class="block"><h2>Why we are asking</h2><p>{why}</p></div>
<div class="block"><h2>What would answer it</h2><p>{disc}</p><ul class="quotes">{recs}</ul></div>
<div class="block"><h2>Sources consulted</h2>{src}</div>
<div class="block"><h2>Share</h2><p><button class="btn btn-quiet" type="button" data-copy="@url">Copy link</button></p></div>
</div>""".format(r=r, lane=E(f["lane"]), id=E(f["id"]), q=E(f["question"]), why=E(pi.get("what_changes_if_known") or f.get("discriminator")),
                 disc=E(f.get("discriminator")), recs=rec_html, src=_sources_list(P, f.get("sources") or [], r))
        body = '<div class="wrap docket">{}<div>{}</div></div>'.format(rail, main)
        return shell(site, title="{} · The Sentinel Report".format(f["question"][:70]), body=body, depth=1, active="findings.html",
                     desc=f["question"], og="img/cards/{}.jpg".format(f["id"]))
    def _anchor(a):
        return '<li><q>{q}</q><span class="where">{src}{desk} · {loc} · <span class="{cls}">{st}</span></span></li>'.format(
            q=E(a["quote"]), src=E(a["src"]), desk=" (desk record)" if a.get("desk") else "", loc=E(a.get("where") or a.get("loc") or ""),
            cls="ok" if a["status"] == "PASS" else "warn", st="found word for word" if a["status"] == "PASS" else E(a["status"].lower()))
    prim = [a for a in (f.get("anchors") or []) if a.get("quote") and not a.get("desk")]
    desk_a = [a for a in (f.get("anchors") or []) if a.get("quote") and a.get("desk")]
    anchors = "".join(_anchor(a) for a in prim)
    if desk_a:
        anchors += '<li class="muted" style="border:0;padding:0;margin-top:6px">From the desk\'s own working file, checked word for word against it:</li>' + "".join(_anchor(a) for a in desk_a)
    limits = "".join("<li>{}</li>".format(E(x)) for x in f.get("does_not_show") or [])
    rivals = "".join('<li><b>{}</b><div><strong>{}</strong>{}</div></li>'.format(E(h["id"]), E(h["label"]), E(h["text"])) for h in c.get("competing", []))
    rels = [x for x in P["relationships"] if f["id"] in (x.get("findings") or [])]
    rel_rows = "".join('<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td class="num">B{}</td><td class="num">C{}{}</td><td>{}</td></tr>'.format(
        E(name(P, x["from"])), E(x["rel_class"].replace("_", " ").lower()), E(name(P, x["to"])), E(x["evidence_class"].replace("_", " ").lower()),
        x.get("level"), x.get("rung"), ' <span class="pill alleged">alleged</span>' if x.get("alleged") else "", E(x.get("limitation") or "")) for x in rels)
    rows = [m for m in P["money_flows"] if f["id"] in m.get("findings", [])]
    by_kind = defaultdict(list)
    for m in rows:
        by_kind[m["kind"]].append(m)
    money_html = ""
    for k, ms in by_kind.items():
        money_html += '<div class="kind-panel"><header><h3>{}</h3><p>{}</p></header>{}</div>'.format(
            E(k.replace("_", " ").title()), E(P["vocabularies"]["money_kinds"].get(k, "")), kind_chart(P, ms, P["meta"]["as_of"]))
    figs = [x for x in P["figures"] if f["id"] in x.get("findings", [])]
    fig_rows = "".join('<tr><td>{}</td><td class="num">{}</td><td>{}</td><td><span class="mono">{}</span></td><td class="{}">{}</td></tr>'.format(
        E(x["label"]), E(money(x["value"]) if x.get("unit") == "USD" else ("{:.1%}".format(x["value"]) if x.get("unit") == "share" else x["value"])),
        E(x["kind"].replace("_", " ").lower()), E(x.get("locator") or ""), "ok" if x.get("verification") == "PASS" else "warn",
        "verified at locator" if x.get("verification") == "PASS" else E((x.get("verification") or "").lower())) for x in figs)
    disputes = "".join('<dt>{}</dt><dd>{}</dd>'.format(E(d["objection"]), E(d["answer"])) for d in f.get("dispute_log") or [])
    pi = f.get("public_interest") or {}
    pi_rows = "".join("<tr><th scope=\"row\">{}</th><td>{}</td></tr>".format(E(lbl), E(pi.get(k))) for k, lbl in (
        ("who_bears_the_cost", "Who bears the cost"), ("duty_owed", "Duty owed"), ("was_it_visible", "Was it visible"),
        ("structural_or_one_off", "Structural or one-off"), ("what_changes_if_known", "What changes if known")) if pi.get(k))
    corr = [x for x in P["corrections"] if f["id"] in x.get("findings", [])]
    corr_html = "".join('<li><span class="mono">{}</span> <strong>{}</strong> {}</li>'.format(E(x["id"]), E(x["title"]), E(x["what_is_right"])) for x in corr)
    main = """<div class="stack-l">
<nav class="crumbs"><a href="{r}findings.html">Findings</a><span>/</span><span>{lane}</span><span>/</span><span class="mono">{id}</span></nav>
<div class="stack"><h1>{title}</h1><p class="statement">{statement}</p>
<p class="muted">{attrib}</p>
<p><button class="btn btn-quiet" type="button" data-copy="@url">Copy link</button> <button class="btn btn-quiet" type="button" data-copy="{cite}">Copy citation</button>{card}</p></div>

<div class="block"><h2>What the record says, word for word</h2><ul class="quotes">{anchors}</ul></div>
<div class="block"><h2>What this does not show</h2><ul class="limits">{limits}</ul></div>

<div class="block"><h2>The reasoning</h2>
<div class="reasoning">{ladder}
<div><p>This finding reaches <strong>{rc} {rn}</strong>{alleged}. {ceil}</p>
<h3 style="font-size:var(--fs-m);margin:16px 0 10px">Competing explanations, ordinary first</h3><ol class="rivals">{rivals}</ol>
<div class="change"><h3>What would change our mind</h3><p>{disc}</p></div></div></div></div>

{money_block}
{fig_block}
{rel_block}
<div class="block"><h2>Objections we answered</h2><dl class="qa">{disputes}</dl></div>
<div class="block"><h2>Why it matters</h2><div class="tbl-wrap"><table>{pi_rows}</table></div></div>
<div class="block"><h2>Open records<span class="count">{nrec}</span></h2><ul class="quotes">{recs}</ul></div>
<div class="block"><h2>Sources</h2>{src}</div>
{corr_block}
</div>""".format(r=r, lane=E(f["lane"]), id=E(f["id"]), title=E(f["title"]), statement=E(f["statement"]),
                 attrib="Published with attribution. The bracketed reference names the record and the page or line.",
                 cite=E(cite), card=(' <a class="btn btn-quiet" href="{}">Share card</a>'.format(E(card_img)) if site.get("images", True) else ""), anchors=anchors or '<li class="muted">No verbatim anchor recorded.</li>', limits=limits,
                 ladder=ladder_html(P, c["rung"], c.get("alleged")), rc=E(c["rung_code"]), rn=E(c["rung_name"].title()),
                 alleged=" as an allegation, attributed to its document" if c.get("alleged") else "", ceil=E(c.get("ceiling_note", "")),
                 rivals=rivals, disc=E(f.get("discriminator") or ""),
                 money_block='<div class="block"><h2>Money in this finding</h2><p class="muted" style="margin-bottom:12px">One panel per kind of money. Kinds are never added together.</p>{}</div>'.format(money_html) if money_html else "",
                 fig_block='<div class="block"><h2>Figures</h2><div class="tbl-wrap"><table><tr><th>Figure</th><th class="num">Value</th><th>Kind</th><th>Where</th><th>Check</th></tr>{}</table></div></div>'.format(fig_rows) if fig_rows else "",
                 rel_block='<div class="block"><h2>Relationships on the record</h2><div class="tbl-wrap"><table><tr><th>From</th><th>Class</th><th>To</th><th>Evidence</th><th class="num">Link</th><th class="num">Rung</th><th>Limitation</th></tr>{}</table></div></div>'.format(rel_rows) if rel_rows else "",
                 disputes=disputes, pi_rows=pi_rows, nrec=len(recs), recs=rec_html or '<li class="muted">None open.</li>',
                 src=_sources_list(P, f.get("sources") or [], r),
                 corr_block='<div class="block"><h2>Corrections to this finding</h2><ul class="quotes">{}</ul></div>'.format(corr_html) if corr_html else "")
    body = '<div class="wrap docket">{}<div>{}</div></div>'.format(rail, main)
    return shell(site, title="{} · The Sentinel Report".format(f["title"]), body=body, depth=1, active="findings.html",
                 desc=f["headline"], og="img/cards/{}.jpg".format(f["id"]))


def page_money(site, P, traces):
    rows = P["money_flows"]
    by_kind = defaultdict(list)
    for m in rows:
        by_kind[m["kind"]].append(m)
    panels = []
    for k in sorted(by_kind, key=lambda k: (FAMILY.get(k, "z"), k)):
        ms = by_kind[k]
        fids = sorted(set(x for m in ms for x in m.get("findings", [])))
        tbl = "".join('<tr><td class="mono">{}</td><td>{}</td><td>{}</td><td class="num">{}</td><td>{}</td><td class="mono">{}</td><td class="{}">{}</td></tr>'.format(
            E(m["id"]), E(name(P, m["from"])), E(name(P, m["to"])), E(("at least " if m.get("is_floor") else "") + (money(m["amount_usd"]) if m.get("amount_usd") is not None else (m.get("amount_text") or "—"))),
            E(m.get("period") or ""), E(m.get("locator") or ""), "ok" if m.get("verification") == "PASS" else "warn",
            "verified" if m.get("verification") == "PASS" else E((m.get("verification") or "").lower())) for m in ms)
        strip = flow_strip(P, ms)
        panels.append("""<article class="kind-panel" id="{k}"><header><div><p class="eyebrow">{fam}</p><h3>{kname}</h3></div><p>{n} row{s} · findings {f}</p></header>
<p class="muted" style="margin-bottom:12px">{defn}</p>{strip}{chart}
<details style="margin-top:12px"><summary>Rows and where each one is recorded</summary><div class="tbl-wrap" style="margin-top:10px"><table>
<tr><th>Row</th><th>From</th><th>To</th><th class="num">Amount</th><th>Period</th><th>Locator</th><th>Check</th></tr>{tbl}</table></div></details>
</article>""".format(k=E(k), fam=E(FAMILY_NAME.get(FAMILY.get(k, "spending"))), kname=E(k.replace("_", " ").title()), n=len(ms), s="" if len(ms) == 1 else "s",
                             f=", ".join('<a href="f/{0}.html">{0}</a>'.format(E(x)) for x in fids), defn=E(P["vocabularies"]["money_kinds"].get(k, "")),
                             strip=strip, chart=kind_chart(P, ms, P["meta"]["as_of"]), tbl=tbl))
    body = """<section class="section"><div class="wrap stack-l">
<div class="section-head"><div><p class="eyebrow">Follow the money</p><h1>Money, one kind at a time</h1>
<p>A contract schedule is not a payment. An award ceiling is not cash. A forwarded earmark is not the forwarding committee's own money. An alleged wire is an allegation. Each kind of money has its own panel and its own scale.</p></div></div>
<div class="rule-box"><p><strong>No grand total.</strong> {rule}</p></div>
{panels}
<p class="muted">Only money rows behind published findings appear here. Rows behind questions and held findings stay on the desk.</p>
</div></section>""".format(rule=E(P["meta"]["no_grand_total_rule"]), panels="".join(panels))
    return shell(site, title="Money · The Sentinel Report", body=body, active="money.html", desc="Money behind the published findings, one kind at a time.")


def page_map(site, P):
    rels = P["relationships"]
    en = ents(P)
    nodes = sorted(set([x["from"] for x in rels] + [x["to"] for x in rels]))
    pos, Hh = layout(nodes, [(x["from"], x["to"]) for x in rels], site["digest"])
    names = {}
    for n in nodes:
        lbl = en.get(n, {}).get("name", n)
        names[n] = lbl if len(lbl) <= 34 else lbl[:33] + "…"
    labels = place_labels(pos, names, 900)
    svg = ['<svg viewBox="0 0 960 {:.0f}" role="img" aria-label="Relationships behind the published findings: {} parties, {} records">'.format(Hh, len(nodes), len(rels))]
    for x in rels:
        a, b = pos[x["from"]], pos[x["to"]]
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        dx, dy = b[0] - a[0], b[1] - a[1]
        fam = REL_COLOR.get(x["rel_class"], "onchain")
        cls = "edge" + (" alleged" if x.get("alleged") else "") + (" weak" if x.get("rung", 0) < 2 else "")
        svg.append('<path class="{}" data-from="{}" data-to="{}" d="M{:.1f} {:.1f} Q {:.1f} {:.1f} {:.1f} {:.1f}" style="stroke:var(--f-{})"><title>{}</title></path>'.format(
            cls, E(x["from"]), E(x["to"]), a[0], a[1], mx - dy * 0.12, my + dx * 0.12, b[0], b[1], fam,
            E("{} → {}: {} (C{}{})".format(name(P, x["from"]), name(P, x["to"]), x["rel_class"].lower(), x.get("rung"), ", alleged" if x.get("alleged") else ""))))
    for n in nodes:
        x, y = pos[n]
        e = en.get(n, {})
        tx, ty, anchor = labels[n]
        svg.append('<g class="node" data-id="{}" tabindex="0" role="button" aria-label="{}">{}<text x="{:.1f}" y="{:.1f}" text-anchor="{}">{}</text></g>'.format(
            E(n), E(e.get("name", n)), node_shape(e.get("type"), x, y, "onchain"), tx, ty, anchor, E(names[n])))
    svg.append("</svg>")
    classes = sorted(set(x["rel_class"] for x in rels))
    legend = "".join('<li><i style="background:var(--f-{})"></i>{}</li>'.format(REL_COLOR.get(c, "onchain"), E(c.replace("_", " ").lower())) for c in classes)
    legend += '<li><i class="dash" style="color:var(--f-alleged)"></i>alleged (sworn document)</li>'
    data = {"nodes": {n: {"name": en.get(n, {}).get("name", n), "type": en.get(n, {}).get("type", "")} for n in nodes},
            "edges": [{"from": x["from"], "to": x["to"], "label": "{} · C{} {} · {}{}".format(x["rel_class"].replace("_", " ").lower(), x.get("rung"),
                       P["vocabularies"]["causal_ladder"][x.get("rung", 0)][1].lower(), x["evidence_class"].replace("_", " ").lower(),
                       " · alleged" if x.get("alleged") else "")} for x in rels]}
    body = """<section class="section"><div class="wrap stack-l">
<div class="section-head"><div><p class="eyebrow">Topology</p><h1>Who is on the record with whom</h1>
<p>Each line is a documented record between two parties, typed by what the record shows: representation, contract, payment, organization, direction, authority. A line is not coordination unless a document says so.</p></div></div>
<div class="net-wrap"><div class="net">{svg}</div>
<aside class="inspector" id="inspector" aria-live="polite"><h3>Select a party</h3><p class="muted">Hover to trace its records; click to list them. Shapes: square, government; triangle, operation; diamond, committee; ring, person; dot, company or firm.</p></aside></div>
<ul class="legend">{legend}</ul>
<div class="cols-2">
<div class="stack"><h2>Four maps of the same evidence</h2><p>This page is the topology: who touches whom. <a href="money.html">Money</a> is the flow: who paid what to whom. <a href="timeline.html">Timeline</a> is the sequence: what happened before what. Each finding carries the causal map: the rung its evidence reaches and the explanations that compete for it.</p></div>
<div class="stack"><h2>And one more: incentives</h2><p>An incentive is a reason someone might act. It is not evidence that they did. The desk uses incentives to decide what to look for, never as a finding.</p></div>
</div>
</div></section>
<script type="application/json" id="net-data">{data}</script>""".format(svg="".join(svg), legend=legend, data=json.dumps(data).replace("</", "<\\/"))
    return shell(site, title="Map · The Sentinel Report", body=body, active="map.html", desc="Relationships behind the published findings, typed by what the record shows.")


def page_timeline(site, P):
    tl = sorted(P["timeline"], key=lambda t: t["date"])
    items, year = [], None
    for t in tl:
        y = t["date"][:4]
        if y != year:
            items.append('<li class="year-row" aria-hidden="true">{}</li>'.format(E(y)))
            year = y
        prec = t.get("precision", "day")
        items.append('<li><time datetime="{d}">{dd}</time><span class="dot {p}" aria-hidden="true"></span><div class="ev"><p>{ev}</p><div class="meta">{g}<span>{prec}</span>{links}</div></div></li>'.format(
            d=E(t["date"]), dd=E(t["date"]), p=E(prec), ev=E(t["event"]), g=pill(t.get("grade", "REPORTED")), prec=E("dated to the " + prec),
            links="".join('<a class="mono" href="f/{0}.html">{0}</a>'.format(E(x)) for x in t.get("findings", []) if x in site["page_ids"])))
    body = """<section class="section"><div class="wrap stack-l">
<div class="section-head"><div><p class="eyebrow">Sequence</p><h1>What happened, in order</h1>
<p>Order is not cause. An event that comes first may have nothing to do with the one after it; the causal rung on each finding says how far the evidence goes. A hollow mark is dated to the month, a dashed one to the year.</p></div></div>
<ol class="tl">{items}</ol></div></section>""".format(items="".join(items))
    return shell(site, title="Timeline · The Sentinel Report", body=body, active="timeline.html", desc="Dated events behind the published findings.")


def page_method(site, P):
    V = P["vocabularies"]
    tiers = "".join("<tr><td>{}</td><td>{}</td></tr>".format(pill(k), E(v)) for k, v in V["glassmark"].items())
    classes = "".join("<tr><td class=\"mono\">{}</td><td>{}</td></tr>".format(E(k), E(v)) for k, v in V["evidence_class"].items())
    levels = "".join("<tr><td class=\"mono\">B{}</td><td>{}</td></tr>".format(E(k), E(v)) for k, v in V["level_ladder"].items())
    rungs_used = Counter(x.get("rung", 0) for x in P["relationships"])
    rungs = "".join("<tr><td class=\"mono\">{}</td><td><strong>{}</strong> {}</td><td class=\"num\">{}</td></tr>".format(
        E(c), E(n.title()), E(d), rungs_used.get(i, 0)) for i, (c, n, d) in enumerate(V["causal_ladder"]))
    rule = V["epistemic_rule"]
    promos = "".join("<li>{}</li>".format(E(t)) for _, t in rule["never_silently_promote"])
    models = "".join("<li><b>{}</b><div><strong>{}</strong>{}</div></li>".format(E(i), E(n), E(d)) for i, n, d in V["competing_models"])
    rels = "".join("<tr><td class=\"mono\">{}</td><td>{}</td></tr>".format(E(k.replace("_", " ").lower()), E(v)) for k, v in V["relationship_classes"].items())
    kinds_used = sorted(set(m["kind"] for m in P["money_flows"]))
    kinds = "".join("<tr><td class=\"mono\">{}</td><td>{}</td></tr>".format(E(k), E(V["money_kinds"].get(k, ""))) for k in kinds_used)
    prec = "".join('<li><q>{q}</q><span class="where">{src} · {loc} · <span class="{c}">{st}</span></span><p class="muted" style="margin-top:6px">{use}</p></li>'.format(
        q=E(p["quote"]), src=E(p["src"]), loc=E(p["loc"]), c="ok" if p.get("verification") == "PASS" else "warn",
        st="found word for word" if p.get("verification") == "PASS" else E(p.get("verification")), use=E(p["use"])) for p in P["meta"].get("method_precedents", []))
    pubs = "".join("<tr><td>{}</td><td>{}</td></tr>".format(pub_pill(k), E(v)) for k, v in V["publication"].items())
    body = """<section class="section"><div class="wrap stack-l">
<div class="section-head"><div><p class="eyebrow">Method</p><h1>How the desk decides what it can say</h1>
<p>{standard} The rules below are enforced by software on every build, and the software's own test suite runs before anything is published.</p></div></div>

<div class="block"><h2>The Sentinel Epistemic Rule</h2>
<p>The system may find patterns, propose relationships and generate hypotheses on its own. It must also search for evidence against them. And it must never silently promote:</p>
<ul class="limits" style="margin-top:12px">{promos}</ul>
<p class="muted" style="margin-top:12px">A draft is checked for these before publication. Each promoting word is looked up against the typed record between the parties it names. If the record does not reach the claim, the sentence fails, and the check prints what the record does support.</p></div>

<div class="block"><h2>Two ladders, kept apart</h2>
<p>A record can show a strong link without showing that one thing caused another. A filed contract is a strong link and still only a documented interaction.</p>
<div class="cols-2" style="margin-top:16px">
<div><h3 style="font-size:var(--fs-m);margin-bottom:8px">Link level: how strong the documented link is</h3><div class="tbl-wrap"><table>{levels}</table></div></div>
<div><h3 style="font-size:var(--fs-m);margin-bottom:8px">Causal rung: how far the evidence goes toward cause</h3><div class="tbl-wrap"><table><tr><th>Rung</th><th>Meaning</th><th class="num">Records here</th></tr>{rungs}</table></div></div>
</div><p class="muted" style="margin-top:12px">Most findings stop between C2 and C5. "Unknown" is an answer.</p></div>

<div class="block"><h2>Competing explanations</h2><p>For any sequence of events, the desk writes out the rival models before choosing among them, and writes the ordinary explanation first.</p>
<ol class="rivals" style="margin-top:12px">{models}</ol></div>

<div class="block"><h2>Relationship classes</h2><div class="tbl-wrap"><table>{rels}</table></div></div>
<div class="block"><h2>Evidence tiers</h2><div class="tbl-wrap"><table>{tiers}</table></div></div>
<div class="block"><h2>Evidence classes</h2><div class="tbl-wrap"><table>{classes}</table></div></div>
<div class="block"><h2>Publication statuses</h2><div class="tbl-wrap"><table>{pubs}</table></div></div>
<div class="block"><h2>Kinds of money on this site</h2><p class="muted" style="margin-bottom:10px">{rule}</p><div class="tbl-wrap"><table>{kinds}</table></div></div>
<div class="block"><h2>Private individuals</h2><p>{privacy}</p></div>
<div class="block"><h2>Precedents in the record</h2><p>Two documents in the desk's custody bear on how this method works. Their words are quoted exactly and checked by the build.</p><ul class="quotes" style="margin-top:12px">{prec}</ul></div>
</div></section>""".format(standard=E(P["meta"].get("standard", "")), promos=promos, levels=levels, rungs=rungs, models=models, rels=rels, tiers=tiers,
                          classes=classes, pubs=pubs, rule=E(P["meta"]["no_grand_total_rule"]), kinds=kinds,
                          privacy=E(P["meta"]["private_individuals_policy"]), prec=prec)
    return shell(site, title="Method · The Sentinel Report", body=body, active="method.html", desc="The rules that decide what the desk can say, enforced on every build.")


def page_corrections(site, P):
    items = "".join("""<article class="card"><div class="meta"><span class="mono">{id}</span><span class="lane">{lane}</span><span class="pill quiet">{st}</span></div>
<h3>{title}</h3><p><strong>Was:</strong> {wrong}</p><p><strong>Now:</strong> {right}</p><p class="muted">{why}</p>
<div class="foot">{links}</div></article>""".format(id=E(c["id"]), lane=E(c.get("lane", "")), st=E(c.get("status", "")), title=E(c["title"]),
                                                    wrong=E(c["what_was_wrong"]), right=E(c["what_is_right"]), why=E(c.get("why_it_matters") or ""),
                                                    links=" ".join('<a href="f/{0}.html">{0}</a>'.format(E(x)) for x in c.get("findings", []) if x in site["page_ids"]))
                    for c in sorted(P["corrections"], key=lambda c: c["id"], reverse=True))
    body = """<section class="section"><div class="wrap stack-l">
<div class="section-head"><div><p class="eyebrow">Corrections</p><h1>What we got wrong, and what is right</h1>
<p>{n} corrections are shown here. {m} more concern findings that are not yet published; they will appear when those findings do. Many were caught by the desk's own checks before anything went out.</p></div></div>
<div class="grid">{items}</div></div></section>""".format(n=len(P["corrections"]), m=P["corrections_total"] - len(P["corrections"]), items=items)
    return shell(site, title="Corrections · The Sentinel Report", body=body, active="corrections.html", desc="Every correction on the record.")


def page_sources(site, P):
    rows = "".join('<tr><td class="mono">{id}</td><td>{title}</td><td>{pub}</td><td>{date}</td><td>{kind}</td><td class="mono">{sha}</td></tr>'.format(
        id=E(s["id"]), title='<a href="{}" rel="noopener">{}</a>'.format(E(s["url"]), E(s["title"])) if s.get("url") else E(s["title"]),
        pub=E(s.get("publisher") or ""), date=E(s.get("date") or ""), kind=E(s.get("kind") or ""), sha=E((s.get("sha256") or "")[:16]))
        for s in sorted(P["sources"], key=lambda s: s["id"]))
    body = """<section class="section"><div class="wrap stack-l">
<div class="section-head"><div><p class="eyebrow">Sources</p><h1>Every record cited on this site</h1>
<p>{n} sources. Where the desk holds a copy, its SHA-256 is shown, so anyone holding the same file can confirm it is identical.</p></div></div>
<div class="tbl-wrap"><table><tr><th>ID</th><th>Record</th><th>Publisher</th><th>Date</th><th>Kind</th><th>SHA-256 (first 16)</th></tr>{rows}</table></div>
</div></section>""".format(n=len(P["sources"]), rows=rows)
    return shell(site, title="Sources · The Sentinel Report", body=body, active="sources.html", desc="Every record cited on this site.")


def page_verify(site, P, manifest_rows):
    signed = site.get("signed")
    rows = "".join('<tr><td class="mono">{}</td><td class="num">{:,}</td><td class="mono">{}</td></tr>'.format(E(p), n, E(h)) for p, n, h in manifest_rows)
    body = """<section class="section"><div class="wrap stack-l">
<div class="section-head"><div><p class="eyebrow">Verify</p><h1>Check this site yourself</h1>
<p>This site is a set of files. The manifest lists every file with its SHA-256, and the check below fetches each one, hashes it in your browser and compares. A copy on a mirror or an archive can be checked the same way.</p></div></div>
<div class="kind-panel"><p><button class="btn" type="button" id="verify-run" data-root="">Check every file now</button></p><div class="bar"><i></i></div><pre class="check-out" id="verify-out" aria-live="polite">Not run yet.</pre></div>
<div class="cols-2">
<div class="stack"><h2>From a terminal</h2>
<pre class="cmd">shasum -a 256 -c SHA256SUMS
python3 modules/station/station.py verify ./site</pre>
<p class="muted">The second command also checks the publisher's signature when the build is signed.</p></div>
<div class="stack"><h2>Signature</h2>
<p>{sigtext}</p></div></div>
<div class="block" id="signature"><h2>The ledger signature</h2>
<p>The drawing on the front page is computed from the SHA-256 of <a href="data/public-ledger.json">data/public-ledger.json</a>: <span class="mono">{digest}</span>. Its seven field harmonics are that digest's own bytes. Run <span class="mono">assets/art.js</span> on the same file and you get the same picture. Change one fact in the ledger and every current bends differently.</p></div>
<div class="block"><h2>What the desk holds but does not publish</h2>
<p>The desk's full ledger, including findings still held, hashes to <span class="mono">{desk}</span>. Publishing the hash commits the desk to that exact file without revealing it. When held findings are published, anyone can confirm they came from the ledger that existed on {built}.</p></div>
<div class="block"><h2>Manifest</h2><details><summary>{n} files</summary><div class="tbl-wrap" style="margin-top:10px"><table><tr><th>File</th><th class="num">Bytes</th><th>SHA-256</th></tr>{rows}</table></div></details></div>
</div></section>""".format(sigtext=("Signed with the publisher's Ed25519 key, fingerprint <span class=\"mono\">{}</span>. Your browser checks it after the file hashes.".format(E(site["signature_fp"]))
                                   if signed else "This build is not signed yet. The publisher signs on their own machine with a key that never leaves it, and the signed build then publishes its public key here."),
                          digest=E(site["digest"]), desk=E(P["commitments"]["desk_ledger_sha256"]), built=E(fmt_date(site["built"])), n=len(manifest_rows), rows=rows)
    return shell(site, title="Verify · The Sentinel Report", body=body, active="verify.html", desc="Re-hash every file of this site in your browser.")


def feed(site, P):
    base = site["base_url"] or ""
    entries = []
    for f in P["findings"]:
        title = f["question"] if f["publication"] == "PUBLISH_AS_QUESTION" else f["title"]
        summ = f["question"] if f["publication"] == "PUBLISH_AS_QUESTION" else f["headline"]
        entries.append((f.get("snapshot") or P["meta"]["as_of"], "f/{}.html".format(f["id"]), title, summ, f["id"]))
    for c in P["corrections"]:
        entries.append((P["meta"]["as_of"], "corrections.html#" + c["id"], "Correction {}: {}".format(c["id"], c["title"]), c["what_is_right"], c["id"]))
    entries.sort(key=lambda e: (e[0], e[4]), reverse=True)
    x = ['<?xml version="1.0" encoding="utf-8"?>', '<feed xmlns="http://www.w3.org/2005/Atom">', "<title>The Sentinel Report</title>",
         "<subtitle>Named sources. Public documents. Verified facts.</subtitle>",
         '<link href="{}"/>'.format(E(base or "index.html")), "<id>urn:tsr:ledger:{}</id>".format(E(site["digest"][:32])),
         "<updated>{}T00:00:00Z</updated>".format(E(site["built"]))]
    for d, href, title, summ, i in entries:
        x.append("<entry><title>{}</title><link href=\"{}{}\"/><id>urn:tsr:{}:{}</id><updated>{}T00:00:00Z</updated><summary>{}</summary></entry>".format(
            E(title), E(base), E(href), E(i), E(site["digest"][:12]), E(d[:10]), E(summ)))
    x.append("</feed>")
    return "\n".join(x) + "\n"
