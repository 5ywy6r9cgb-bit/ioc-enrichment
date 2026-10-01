# -*- coding: utf-8 -*-
"""Share cards, the 10-slide carousel and the social image, rendered from the built site's own CSS,
fonts and art engine, so an image can never say anything the site does not.

Needs Playwright with Chromium (optional):  python3 -m pip install playwright && python3 -m playwright install chromium
Every word placed on an image comes from the public ledger, which the build has already run through the
number gate and the epistemic rule.
"""
import html
import json
import os

E = lambda s: html.escape("" if s is None else str(s), quote=True)
CARD = (1200, 630)
SLIDE = (1080, 1350)


def _doc(site_dir, body, size, spec, salt):
    css = open(os.path.join(site_dir, "assets", "site.css"), encoding="utf-8").read()
    art = open(os.path.join(site_dir, "assets", "art.js"), encoding="utf-8").read()
    w, h = size
    return """<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><style>{css}
html,body{{margin:0;width:{w}px;height:{h}px;overflow:hidden;background:var(--bg)}}
.frame{{position:relative;width:{w}px;height:{h}px;box-sizing:border-box;color:var(--ink);font-family:var(--font-body)}}
.brand-s{{font-family:var(--font-head);font-weight:700;letter-spacing:.16em;text-transform:uppercase;font-size:20px}}
.brand-s b{{color:var(--link)}}
.k{{font-family:var(--font-mono);font-size:17px;color:var(--muted);letter-spacing:.04em}}
.big{{font-family:var(--font-head);font-weight:700;line-height:1.08;letter-spacing:-.01em}}
.pill{{font-size:15px;padding:2px 9px}}
canvas{{display:block}}
</style></head><body>{body}
<script>{art}</script>
<script>
(function(){{var s={spec};var st=getComputedStyle(document.documentElement);var t=function(n){{return st.getPropertyValue('--'+n).trim()}};
s.palette={{bg:t('art-bg'),ink:t('art-ink'),wire:t('art-wire'),counter:t('art-counter'),families:{{}}}};
['contracts','electoral','lobbying','spending','settlements','alleged','onchain'].forEach(function(f){{s.palette.families[f]=t('f-'+f)}});
document.querySelectorAll('canvas[data-art]').forEach(function(c){{var w=+c.getAttribute('width'),h=+c.getAttribute('height');
LedgerArt.draw(c,s,{{animate:false,salt:{salt},fixed:[w,h,1],density:+(c.getAttribute('data-density')||30)}})}});
document.body.setAttribute('data-ready','1');}})();
</script></body></html>""".format(css=css, w=w, h=h, body=body, art=art, spec=json.dumps(spec), salt=json.dumps(salt))


def _clip(s, n):
    s = s or ""
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


def card_html(P, f, site):
    pp = f.get("proof_profile") or {}
    c = f.get("causal") or {}
    q = f["publication"] == "PUBLISH_AS_QUESTION"
    title = f["question"] if q else f["title"]
    sub = ("What would answer it: " + _clip(f.get("discriminator"), 150)) if q else _clip(f.get("headline"), 170)
    foot = "Open question · {} record(s) would answer it".format(len(f.get("missing_records") or [])) if q else \
        "{}/{} figures verified · {}/{} quotes word for word · {} {}".format(pp.get("numbers_verified", 0), pp.get("numbers_linked", 0),
                                                                          pp.get("anchor_quotes_verified", 0), pp.get("anchor_quotes", 0),
                                                                          c.get("rung_code", "C0"), (c.get("rung_name") or "").title())
    tier = "arith" if q else {"GREEN": "green", "ARITH": "arith", "REPORTED": "reported", "RED": "red"}.get(f["glassmark"], "dead")
    return """<div class="frame" style="display:grid;grid-template-columns:720px 480px">
<div style="padding:52px 44px 44px 56px;display:flex;flex-direction:column;gap:22px">
  <div class="brand-s">The Sentinel <b>Report</b></div>
  <div style="display:flex;gap:14px;align-items:center"><span class="k">{id}</span><span class="pill {tier}">{label}</span></div>
  <div class="big" style="font-size:{ts}px">{title}</div>
  <div style="font-size:23px;line-height:1.4;color:var(--muted)">{sub}</div>
  <div class="k" style="margin-top:auto;font-size:15px">{foot}</div>
</div>
<div style="position:relative;border-left:1px solid var(--line)"><canvas data-art width="480" height="630" data-density="22"></canvas>
<div class="k" style="position:absolute;left:18px;bottom:16px;font-size:13px">ledger sha256 {dg}…</div></div></div>""".format(
        id=E(f["id"]), tier=tier, label="Open question" if q else "Published with attribution", ts=46 if len(title) > 70 else 54,
        title=E(_clip(title, 120)), sub=E(sub), foot=E(foot), dg=E(site["digest"][:16]))


def slides(P, site):
    V = P["verification"]
    held = sum(P["held"].values())
    pubs = [f for f in P["findings"] if f["publication"] == "PUBLISH_WITH_ATTRIBUTION"]

    def score(f):
        pp = f.get("proof_profile") or {}
        return (f["glassmark"] == "GREEN", pp.get("numbers_verified", 0) + pp.get("anchor_quotes_verified", 0), f["id"])
    top = sorted(pubs, key=score, reverse=True)[:7]
    qs = [f for f in P["findings"] if f["publication"] == "PUBLISH_AS_QUESTION"][:3]
    out = []
    out.append("""<div class="frame"><canvas data-art width="1080" height="760" data-density="34"></canvas>
<div style="padding:40px 64px;display:flex;flex-direction:column;gap:22px"><div class="brand-s">The Sentinel <b>Report</b></div>
<div class="big" style="font-size:78px">What the records show</div>
<div style="font-size:30px;line-height:1.4;color:var(--muted)">{n} findings, each traced to its record. {q} open questions. {h} more held until they check out.</div>
<div class="k">01 / 10 · as of {asof}</div></div></div>""".format(n=len(pubs), q=sum(1 for f in P["findings"] if f["publication"] == "PUBLISH_AS_QUESTION"),
                                                                 h=held, asof=E(P["meta"]["as_of"])))
    for i, f in enumerate(top, start=2):
        pp = f.get("proof_profile") or {}
        limit = (f.get("does_not_show") or [""])[0]
        out.append("""<div class="frame" style="padding:64px;display:flex;flex-direction:column;gap:28px">
<div style="display:flex;justify-content:space-between;align-items:center"><div class="brand-s">The Sentinel <b>Report</b></div><span class="k">{i:02d} / 10</span></div>
<div style="display:flex;gap:14px;align-items:center"><span class="k">{id}</span><span class="pill green">Published with attribution</span></div>
<div class="big" style="font-size:{ts}px">{title}</div>
<div style="font-size:31px;line-height:1.42">{head}</div>
<div style="border-left:3px solid var(--t-red);padding-left:20px;font-size:25px;line-height:1.45;color:var(--muted)"><b style="color:var(--ink)">What it does not show:</b> {limit}</div>
<div style="margin-top:auto;display:flex;justify-content:space-between;align-items:end;gap:20px">
<div class="k" style="font-size:18px;line-height:1.6">{nv}/{nl} figures verified · {qv}/{qa} quotes word for word<br>Full record: f/{id}.html</div>
<canvas data-art width="220" height="220" data-density="12"></canvas></div></div>""".format(
            i=i, id=E(f["id"]), ts=64 if len(f["title"]) < 60 else 54, title=E(_clip(f["title"], 110)), head=E(_clip(f["headline"], 230)),
            limit=E(_clip(limit, 170)), nv=pp.get("numbers_verified", 0), nl=pp.get("numbers_linked", 0), qv=pp.get("anchor_quotes_verified", 0),
            qa=pp.get("anchor_quotes", 0)))
    items = "".join('<li style="margin-bottom:30px"><span class="k">{}</span><div style="font-size:30px;line-height:1.38;margin-top:6px">{}</div></li>'.format(
        E(f["id"]), E(_clip(f["question"], 190))) for f in qs)
    out.append("""<div class="frame" style="padding:64px;display:flex;flex-direction:column;gap:30px">
<div style="display:flex;justify-content:space-between"><div class="brand-s">The Sentinel <b>Report</b></div><span class="k">09 / 10</span></div>
<div class="big" style="font-size:66px">What we are still asking</div>
<ol style="list-style:none;padding:0;margin:0">{items}</ol>
<div class="k" style="margin-top:auto">Published as questions because the record that would answer them is not in hand.</div></div>""".format(items=items))
    out.append("""<div class="frame" style="padding:64px;display:flex;flex-direction:column;gap:26px">
<div style="display:flex;justify-content:space-between"><div class="brand-s">The Sentinel <b>Report</b></div><span class="k">10 / 10</span></div>
<div class="big" style="font-size:66px">How we check</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:26px 40px;font-size:27px;line-height:1.35">
<div><div class="big" style="font-size:60px">{nv}/{nt}</div>figures traced to their exact line, cell or page</div>
<div><div class="big" style="font-size:60px">{qp}</div>quotes found word for word</div>
<div><div class="big" style="font-size:60px">{cx}</div>corrections on the record, including our own</div>
<div><div class="big" style="font-size:60px">{held}</div>findings held until they check out</div></div>
<div style="font-size:26px;line-height:1.45;color:var(--muted)">Every verb is checked against what its record can carry. Every file of the site is hashed; the verify page re-checks them in your browser.</div>
<div class="k" style="margin-top:auto;font-size:17px">public ledger sha256 {dg}</div></div>""".format(
        nv=V["numbers_machine_verified"], nt=V["numbers_total"], qp=V["quotes_word_for_word"], cx=P["corrections_total"], held=held, dg=E(site["digest"])))
    return out


def render_all(site_dir, site, P):
    from playwright.sync_api import sync_playwright
    spec = site["art"]
    os.makedirs(os.path.join(site_dir, "img", "cards"), exist_ok=True)
    os.makedirs(os.path.join(site_dir, "img", "carousel"), exist_ok=True)
    jobs = []
    for f in P["findings"]:
        jobs.append((os.path.join("img", "cards", f["id"] + ".jpg"), CARD, card_html(P, f, site), f["id"]))
    og = """<div class="frame" style="display:grid;grid-template-columns:560px 640px"><div style="padding:56px;display:flex;flex-direction:column;gap:22px">
<div class="brand-s">The Sentinel <b>Report</b></div><div class="big" style="font-size:52px">Named sources. Public documents. Verified facts.</div>
<div class="k" style="margin-top:auto">public ledger sha256 {}…</div></div><canvas data-art width="640" height="630" data-density="30"></canvas></div>""".format(E(site["digest"][:24]))
    jobs.append((os.path.join("img", "og.jpg"), CARD, og, "og"))
    for i, body in enumerate(slides(P, site), start=1):
        jobs.append((os.path.join("img", "carousel", "slide-{:02d}.jpg".format(i)), SLIDE, body, "slide-{}".format(i)))
    with sync_playwright() as p:
        b = p.chromium.launch()
        for rel, size, body, salt in jobs:
            pg = b.new_page(viewport={"width": size[0], "height": size[1]}, device_scale_factor=1)
            pg.set_content(_doc(site_dir, body, size, spec, salt), wait_until="load")
            pg.wait_for_selector("body[data-ready='1']", timeout=20000)
            pg.screenshot(path=os.path.join(site_dir, rel), type="jpeg", quality=88, clip={"x": 0, "y": 0, "width": size[0], "height": size[1]})
            pg.close()
        b.close()
    print("images: {} share cards, 1 social image, {} carousel slides".format(len(P["findings"]), len(jobs) - len(P["findings"]) - 1))
    return 0
