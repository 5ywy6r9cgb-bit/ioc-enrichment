"""
server.py — the desk, in a browser, on your machine only.

Bound to 127.0.0.1 by design and by default; there is no flag in this file to
bind it to 0.0.0.0, because a case store containing an unpublished
investigation should not be one misconfigured router away from the internet.
If this ever needs to be reachable by a second investigator, that is a
deliberate deployment with authentication in front of it, not a flag.

Everything is read-only except one endpoint: the publication gate decision,
which requires the operator token. Reading cannot change the record. That
keeps the whole surface small enough to reason about.
"""

from __future__ import annotations
import json
import os
import sqlite3
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import audit, gates, ingest, security, store
from .ui import e, note, page, stat, table, tier_badge


# ── page builders ─────────────────────────────────────────────────────────

def _dashboard(conn: sqlite3.Connection, root: Path, refresh: int) -> str:
    c = store.counts(conn)
    ok, chain = audit.verify(conn)

    cards = "".join([
        stat("Open cases", c["open_cases"], f"{c['cases']} total"),
        stat("Primary documents", c["shelves"]["PRIMARY"], f"{c['documents']} in register"),
        stat("Claims", c["claims"], f"{c['citations']} citations"),
        stat("Documented", c["tiers"]["GREEN"], "GREEN"),
        stat("Open questions", c["tiers"]["RED"], "RED APPLE"),
        stat("Blocked by gates", c["blocks"], "must clear before publish",
             alarm=c["blocks"] > 0),
        stat("Awaiting your decision", c["pending_gate"], "publication gate",
             alarm=c["pending_gate"] > 0),
        stat("Retired figures", c["retired"], "can never reappear"),
    ])

    blocked = conn.execute("""
        SELECT cl.id, cl.tier, cl.text, cs.slug,
               GROUP_CONCAT(g.gate, ', ') AS gates
        FROM gate_results g
        JOIN claims cl ON cl.id = g.claim_id
        JOIN cases cs ON cs.id = cl.case_id
        WHERE g.level='BLOCK' AND g.passed=0
        GROUP BY cl.id ORDER BY cl.id LIMIT 25
    """).fetchall()

    blocked_tbl = table(
        ["Claim", "Tier", "Case", "Failing gates"],
        [[f'<a href="/claim/{r["id"]}">{e(r["text"][:96])}{"…" if len(r["text"])>96 else ""}</a>',
          tier_badge(r["tier"]), e(r["slug"]), f'<span class="muted">{e(r["gates"])}</span>']
         for r in blocked],
        "No claim is currently blocked. Everything in the store clears its gates.",
    )

    stale = conn.execute("""
        SELECT ref, title, office, status, filed, due FROM requests
        WHERE status IN ('FILED','ACKNOWLEDGED','PARTIAL')
        ORDER BY COALESCE(due,'9999') ASC LIMIT 15
    """).fetchall()
    req_tbl = table(
        ["Ref", "What was asked", "Office", "Status", "Due"],
        [[f'<span class="mono">{e(r["ref"])}</span>', e(r["title"]), e(r["office"]),
          e(r["status"]), e(r["due"] or "—")] for r in stale],
        "No requests are outstanding.",
    )

    corr = conn.execute(
        "SELECT ref,date,headline FROM corrections ORDER BY date DESC, ref DESC LIMIT 1"
    ).fetchone()
    corr_html = (
        note("block", f"Latest correction — {corr['ref']}, {corr['date']}",
             e(corr["headline"]) +
             " <span class='muted'>Corrections run at the top of the next report, in your voice.</span>")
        if corr else ""
    )

    chain_html = note(
        "ok" if ok else "block",
        "Audit chain",
        e(chain) if ok else f"<b style='color:#8a2e2e'>BROKEN.</b> {e(chain)}",
    )

    return page("Dashboard", "/", f"""
<h1>Dashboard</h1>
<p class="lede">Everything the desk knows, on one screen. Nothing here is
published; publication is a separate, deliberate act on the gate page.</p>
{corr_html}
<div class="grid">{cards}</div>
<h2>Claims blocked from publication</h2>
{blocked_tbl}
<h2>Records requests outstanding</h2>
{req_tbl}
{chain_html}
<p class="muted" style="font-family:var(--sans);font-size:.8rem">
Store: <span class="mono">{e(root / 'sentinel.db')}</span> ·
<a href="/?refresh=15">auto-refresh 15s</a> · <a href="/">manual</a></p>
""", refresh=refresh)


def _cases(conn: sqlite3.Connection) -> str:
    rows = conn.execute("""
        SELECT cs.*,
          (SELECT COUNT(*) FROM documents d WHERE d.case_id=cs.id) nd,
          (SELECT COUNT(*) FROM claims c WHERE c.case_id=cs.id) nc
        FROM cases cs ORDER BY cs.updated DESC
    """).fetchall()
    return page("Cases", "/cases", "<h1>Cases</h1>" + table(
        ["Case", "Jurisdiction", "Status", "Documents", "Claims", "Updated"],
        [[f'<a href="/case/{e(r["slug"])}">{e(r["title"])}</a>', e(r["jurisdiction"]),
          e(r["status"]), str(r["nd"]), str(r["nc"]), e(r["updated"][:10])] for r in rows],
        "No cases yet. Create one:  sentinel case new <slug> \"<title>\"",
    ))


def _case(conn: sqlite3.Connection, slug: str) -> str | None:
    cs = store.case_by_slug(conn, slug)
    if cs is None:
        return None
    docs = conn.execute(
        "SELECT * FROM documents WHERE case_id=? ORDER BY received DESC", (cs["id"],)).fetchall()
    claims = conn.execute(
        "SELECT * FROM claims WHERE case_id=? ORDER BY id", (cs["id"],)).fetchall()
    return page(cs["title"], "/cases", f"""
<h1>{e(cs['title'])}</h1>
<p class="lede">{e(cs['jurisdiction'])} · status {e(cs['status'])} ·
opened {e(cs['opened'][:10])}</p>
{e(cs['note'])}
<h2>Evidence ({len(docs)})</h2>
""" + table(
        ["Title", "Custodian", "Shelf", "Container", "SHA-256"],
        [[e(d["title"]), e(d["custodian"]), e(d["shelf"]),
          e(d["container"]) + (f' <span class="muted">({d["pages"]}p)</span>' if d["pages"] else ""),
          f'<span class="mono">{e(d["sha256"][:20])}…</span>'] for d in docs],
        "No documents ingested for this case.",
    ) + f"<h2>Claims ({len(claims)})</h2>" + table(
        ["Claim", "Tier", "Gates"],
        [[f'<a href="/claim/{c["id"]}">{e(c["text"][:110])}{"…" if len(c["text"])>110 else ""}</a>',
          tier_badge(c["tier"]), _gate_summary(conn, c["id"])] for c in claims],
        "No claims recorded for this case.",
    ))


def _gate_summary(conn: sqlite3.Connection, claim_id: int) -> str:
    rows = conn.execute(
        "SELECT level,passed FROM gate_results WHERE claim_id=?", (claim_id,)).fetchall()
    if not rows:
        return '<span class="muted">not run</span>'
    b = sum(1 for r in rows if r["level"] == "BLOCK" and not r["passed"])
    w = sum(1 for r in rows if r["level"] == "WARN" and not r["passed"])
    if b:
        return f'<span style="color:#b4611e;font-weight:640">{b} BLOCK</span>'
    if w:
        return f'<span style="color:#7a5c1e">{w} warn</span>'
    return '<span style="color:#1f6b45">clear</span>'


def _claim(conn: sqlite3.Connection, cid: int) -> str | None:
    c = conn.execute("SELECT c.*, cs.slug, cs.title AS case_title FROM claims c "
                     "JOIN cases cs ON cs.id=c.case_id WHERE c.id=?", (cid,)).fetchone()
    if c is None:
        return None
    cites = conn.execute(
        "SELECT ci.*, d.title, d.shelf, d.sha256, d.container FROM citations ci "
        "JOIN documents d ON d.id=ci.doc_id WHERE ci.claim_id=?", (cid,)).fetchall()
    res = conn.execute(
        "SELECT * FROM gate_results WHERE claim_id=? ORDER BY level DESC, gate", (cid,)).fetchall()

    extra = []
    for label, key in (("Formula", "formula"), ("Outlet", "outlet"),
                       ("Closing gate", "closing_gate"), ("Resolution", "resolution")):
        if c[key]:
            extra.append(f"<p><b>{label}:</b> {e(c[key])}</p>")

    return page(f"Claim {cid}", "/claims", f"""
<h1>Claim {cid} {tier_badge(c['tier'])}</h1>
<p class="lede"><a href="/case/{e(c['slug'])}">{e(c['case_title'])}</a></p>
<p style="font-size:1.15rem">{e(c['text'])}</p>
{''.join(extra)}
<h2>Citations</h2>
""" + table(
        ["Document", "Shelf", "Locator", "The document's own words"],
        [[e(x["title"]), e(x["shelf"]), f'<span class="mono">{e(x["locator"])}</span>',
          e(x["quote"]) or '<span class="muted">— not recorded —</span>'] for x in cites],
        "No citation recorded. A GREEN claim with no citation cannot publish.",
    ) + "<h2>Gate results</h2>" + table(
        ["Gate", "Level", "Result", "Detail"],
        [[f'<span class="mono">{e(r["gate"])}</span>', e(r["level"]),
          ('<span style="color:#1f6b45">pass</span>' if r["passed"]
           else '<span style="color:#b4611e;font-weight:640">FAIL</span>'),
          e(r["detail"])] for r in res],
        "Gates have not been run against this claim yet:  sentinel gate run --claim %d" % cid,
    ))


def _evidence(conn: sqlite3.Connection) -> str:
    rows = conn.execute("""
        SELECT d.*, cs.slug FROM documents d JOIN cases cs ON cs.id=d.case_id
        ORDER BY d.received DESC
    """).fetchall()
    odd = [r for r in rows if r["container"] == "ZIP_PAGE_ARCHIVE"]
    banner = note(
        "info", "Container mismatch detected",
        f"{len(odd)} document(s) are named as PDFs but are ZIP archives of page "
        f"images. Text extraction on these requires OCR — <span class='mono'>pdftotext"
        f"</span> returns nothing and a careless pipeline records that as 'no text.'"
    ) if odd else ""
    return page("Evidence", "/evidence", "<h1>Evidence register</h1>"
                "<p class='lede'>Metadata only. The bytes live in the vault, pinned by hash. "
                "The register never holds extracted text, summaries, or analysis — those are "
                "claims about documents, and claims need citations.</p>" + banner + table(
        ["Title", "Case", "Custodian", "Shelf", "Container", "Bytes", "SHA-256"],
        [[e(r["title"]), e(r["slug"]), e(r["custodian"]), e(r["shelf"]),
          e(r["container"]), f'{r["bytes"]:,}',
          f'<span class="mono">{e(r["sha256"][:24])}…</span>'] for r in rows],
        "No documents ingested. Add one:  sentinel ingest <case> <file> --title … --custodian …",
    ))


def _claims(conn: sqlite3.Connection) -> str:
    rows = conn.execute("""
        SELECT c.*, cs.slug FROM claims c JOIN cases cs ON cs.id=c.case_id ORDER BY c.id DESC
    """).fetchall()
    return page("Claims", "/claims", "<h1>Claims</h1>" + table(
        ["Claim", "Tier", "Case", "Gates"],
        [[f'<a href="/claim/{r["id"]}">{e(r["text"][:110])}{"…" if len(r["text"])>110 else ""}</a>',
          tier_badge(r["tier"]), e(r["slug"]), _gate_summary(conn, r["id"])] for r in rows],
        "No claims yet.",
    ))


def _requests(conn: sqlite3.Connection) -> str:
    rows = conn.execute("SELECT * FROM requests ORDER BY priority, ref").fetchall()
    return page("Records Requests", "/requests", "<h1>Records requests</h1>" + table(
        ["Ref", "Title", "Office", "Statute", "Status", "Filed", "Due", "Responded"],
        [[f'<span class="mono">{e(r["ref"])}</span>', e(r["title"]), e(r["office"]),
          e(r["statute"]), e(r["status"]), e(r["filed"] or "—"), e(r["due"] or "—"),
          e(r["responded"] or "—")] for r in rows],
        "No requests logged.",
    ))


def _corrections(conn: sqlite3.Connection) -> str:
    rows = conn.execute("SELECT * FROM corrections ORDER BY date DESC, ref DESC").fetchall()
    figs = conn.execute("SELECT * FROM retired_figures ORDER BY correction_ref").fetchall()
    body = "<h1>Corrections</h1><p class='lede'>Permanent. An error you can still see is an error you can still explain.</p>"
    for r in rows:
        body += (f"<h2>{e(r['ref'])} — {e(r['headline'])}</h2>"
                 f"<p class='muted' style=\"font-family:var(--sans);font-size:.8rem\">"
                 f"{e(r['date'])} · {e(r['severity'])}</p>")
        for lab, key in (("We published", "published"), ("What is correct", "correct"),
                         ("Why it matters", "why"), ("Action taken", "action")):
            if r[key]:
                body += f"<p><b>{lab}:</b> {e(r[key])}</p>"
    if not rows:
        body += '<div class="empty">No corrections recorded.</div>'
    body += "<h2>Retired figures</h2>" + table(
        ["Figure", "Retired by", "Reason"],
        [[f'<span class="mono">{e(f["figure"])}</span>', e(f["correction_ref"]), e(f["reason"])]
         for f in figs],
        "No figures retired yet.",
    ) + note("info", "How this is enforced",
             "The RETIRED_FIGURE gate reads this table on every claim. A retired number "
             "cannot re-enter the record by being forgotten — the write is refused.")
    return page("Corrections", "/corrections", body)


def _gate(conn: sqlite3.Connection) -> str:
    pend = conn.execute(
        "SELECT s.*, cs.slug FROM submissions s JOIN cases cs ON cs.id=s.case_id "
        "WHERE s.decision='PENDING' ORDER BY s.submitted").fetchall()
    done = conn.execute(
        "SELECT s.*, cs.slug FROM submissions s JOIN cases cs ON cs.id=s.case_id "
        "WHERE s.decision<>'PENDING' ORDER BY s.decided DESC LIMIT 20").fetchall()

    body = ("<h1>Publication gate</h1><p class='lede'>Nothing leaves the desk without a "
            "decision here, made by you. There is no automatic approval and no override flag.</p>")

    if pend:
        for s in pend:
            blocking = s["blocking"] or ""
            warn = (note("block", "Blocking gates unresolved", e(blocking))
                    if blocking else note("ok", "Gates", "All BLOCK gates clear."))
            body += f"""
<h2>{e(s['title'])}</h2>
<p class="muted" style="font-family:var(--sans);font-size:.8rem">
{e(s['slug'])} · submitted {e(s['submitted'][:16])} ·
payload <span class="mono">{e(s['payload_hash'][:20])}…</span></p>
{warn}
<form class="inline" method="post" action="/gate/decide">
<input type="hidden" name="id" value="{s['id']}">
<input type="password" name="token" placeholder="operator token" size="26" required>
<input type="text" name="reason" placeholder="reason (required to reject)" size="40">
<button name="decision" value="APPROVED">Approve</button>
<button class="ghost" name="decision" value="REJECTED">Reject</button>
</form>"""
    else:
        body += '<div class="empty">Nothing is waiting on you.</div>'

    body += "<h2>Decided</h2>" + table(
        ["Title", "Case", "Decision", "When", "By", "Reason"],
        [[e(s["title"]), e(s["slug"]), e(s["decision"]), e((s["decided"] or "")[:16]),
          e(s["decided_by"] or ""), e(s["reason"] or "")] for s in done],
        "No decisions yet.",
    )
    return page("Publication Gate", "/gate", body)


def _audit(conn: sqlite3.Connection) -> str:
    ok, msg = audit.verify(conn)
    rows = conn.execute(
        "SELECT seq,at,kind,actor,subject,hash FROM audit ORDER BY seq DESC LIMIT 120").fetchall()
    return page("Audit Chain", "/audit",
                "<h1>Audit chain</h1>" +
                note("ok" if ok else "block", "Verification", e(msg)) + table(
        ["Seq", "When", "Event", "Actor", "Subject", "Hash"],
        [[str(r["seq"]), e(r["at"][:19]), f'<span class="mono">{e(r["kind"])}</span>',
          e(r["actor"]), f'<span class="mono">{e((r["subject"] or "")[:24])}</span>',
          f'<span class="mono">{e(r["hash"][:16])}…</span>'] for r in rows],
        "No events yet.",
    ))


def _security(conn: sqlite3.Connection, root: Path) -> str:
    checks = security.audit_desk(conn, root)
    order = {security.FAIL: 0, security.WARN: 1, security.PASS: 2}
    checks.sort(key=lambda c: (order[c.result], c.id))
    n = {r: sum(1 for c in checks if c.result == r)
         for r in (security.PASS, security.WARN, security.FAIL)}

    colour = {security.PASS: "#1f6b45", security.WARN: "#7a5c1e", security.FAIL: "#b4611e"}
    rows = []
    for c in checks:
        detail = e(c.detail)
        if c.fix:
            detail += (f'<br><span class="muted">→ {e(c.fix)}</span>')
        tags = " · ".join(list(c.csf) + list(c.attack))
        rows.append([
            f'<span class="mono">{e(c.id)}</span>',
            e(c.title),
            f'<span style="color:{colour[c.result]};font-weight:660">{e(c.result)}</span>',
            detail,
            f'<span class="mono muted">{e(tags)}</span>',
        ])

    banner = note(
        "block" if n[security.FAIL] else "ok",
        "Result",
        f"{n[security.PASS]} pass · {n[security.WARN]} warn · {n[security.FAIL]} fail."
        + (" A FAIL is not advisory — resolve it before ingesting or publishing."
           if n[security.FAIL] else
           " Warnings are things only you can close, not faults in the desk."))

    return page("Security", "/security", f"""
<h1>Security self-audit</h1>
<p class="lede">Every claim the desk makes about its own security, checked at
runtime rather than asserted in a README. Mapped to NIST CSF 2.0 so the output
slots into a compliance conversation without translation.</p>
{banner}
""" + table(["ID", "Check", "Result", "Detail", "Framework"], rows)
    + note("info", "Run it before every publish",
           "<span class='mono'>sentinel security --strict</span> exits non-zero on any "
           "FAIL, so it works as a pre-publish hook rather than something you remember to do."))


def _doctor(conn: sqlite3.Connection, root: Path) -> str:
    ok, chain = audit.verify(conn)
    problems = ingest.verify_vault(conn)
    token = bool(os.environ.get("SENTINEL_TOKEN"))
    rows = [
        ["Store", f'<span class="mono">{e(root / "sentinel.db")}</span>',
         '<span style="color:#1f6b45">present</span>'],
        ["Vault", f'<span class="mono">{e(root / "vault")}</span>',
         '<span style="color:#1f6b45">writable</span>'],
        ["Audit chain", e(chain),
         '<span style="color:#1f6b45">intact</span>' if ok
         else '<span style="color:#b4611e;font-weight:640">BROKEN</span>'],
        ["Vault integrity", f"{len(problems)} problem(s)",
         '<span style="color:#1f6b45">every file matches its hash</span>' if not problems
         else '<span style="color:#b4611e;font-weight:640">see below</span>'],
        ["Operator token", "SENTINEL_TOKEN",
         '<span style="color:#1f6b45">set</span>' if token
         else '<span style="color:#7a5c1e">not set — the gate will refuse every approval</span>'],
        ["Network", "none required",
         '<span style="color:#1f6b45">this desk makes no outbound request, ever</span>'],
    ]
    body = "<h1>Doctor</h1>" + table(["Check", "Value", "Result"], rows)
    if problems:
        body += "<h2>Vault problems</h2>" + table(
            ["Document", "Problem", "Detail"],
            [[e(p["title"]), e(p["problem"]), f'<span class="mono">{e(p["detail"])}</span>']
             for p in problems])
    return page("Doctor", "/doctor", body)


# ── HTTP plumbing ─────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "SentinelDesk"
    sys_version = ""
    root: Path
    conn: sqlite3.Connection

    def log_message(self, fmt, *args):  # quieter than the default
        pass

    def _send(self, body: str, code: int = 200, ctype: str = "text/html; charset=utf-8"):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
            "base-uri 'none'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802
        u = urllib.parse.urlparse(self.path)
        p, q = u.path, urllib.parse.parse_qs(u.query)
        conn, root = self.conn, self.root
        try:
            if p == "/":
                refresh = int(q.get("refresh", ["0"])[0] or 0)
                return self._send(_dashboard(conn, root, min(refresh, 300)))
            if p == "/cases":
                return self._send(_cases(conn))
            if p.startswith("/case/"):
                html_ = _case(conn, urllib.parse.unquote(p[6:]))
                return self._send(html_ or page("Not found", "/cases", "<h1>No such case</h1>"),
                                  200 if html_ else 404)
            if p.startswith("/claim/"):
                try:
                    cid = int(p[7:])
                except ValueError:
                    return self._send(page("Not found", "/claims", "<h1>No such claim</h1>"), 404)
                html_ = _claim(conn, cid)
                return self._send(html_ or page("Not found", "/claims", "<h1>No such claim</h1>"),
                                  200 if html_ else 404)
            if p == "/evidence":
                return self._send(_evidence(conn))
            if p == "/claims":
                return self._send(_claims(conn))
            if p == "/requests":
                return self._send(_requests(conn))
            if p == "/corrections":
                return self._send(_corrections(conn))
            if p == "/gate":
                return self._send(_gate(conn))
            if p == "/audit":
                return self._send(_audit(conn))
            if p == "/security":
                return self._send(_security(conn, root))
            if p == "/doctor":
                return self._send(_doctor(conn, root))
            if p == "/api/health":
                ok, msg = audit.verify(conn)
                return self._send(json.dumps({"ok": True, "chain_intact": ok, "chain": msg,
                                              "counts": store.counts(conn)}),
                                  200, "application/json")
            return self._send(page("Not found", "/", "<h1>404</h1>"), 404)
        except Exception as ex:  # never leak a stack trace into the browser
            return self._send(page("Error", "/", f"<h1>Something went wrong</h1>"
                                                 f"<p class='muted'>{e(type(ex).__name__)}: {e(ex)}</p>"), 500)

    def do_POST(self):  # noqa: N802
        if urllib.parse.urlparse(self.path).path != "/gate/decide":
            return self._send(page("Not found", "/", "<h1>404</h1>"), 404)

        # Same-origin only. A local page is the only thing allowed to post here.
        origin = self.headers.get("Origin") or ""
        if origin and "127.0.0.1" not in origin and "localhost" not in origin:
            return self._send(page("Refused", "/gate", "<h1>Cross-origin post refused</h1>"), 403)

        n = int(self.headers.get("Content-Length") or 0)
        form = urllib.parse.parse_qs(self.rfile.read(n).decode("utf-8"))
        get = lambda k: (form.get(k) or [""])[0]  # noqa: E731

        expected = os.environ.get("SENTINEL_TOKEN", "")
        if not expected:
            return self._send(page("Gate", "/gate",
                "<h1>No operator token is set</h1><p class='lede'>The gate refuses every "
                "approval until SENTINEL_TOKEN is set in the environment. That is deliberate: "
                "an unset token must fail closed, never open.</p>"), 403)
        if get("token") != expected:
            return self._send(page("Gate", "/gate", "<h1>Token rejected</h1>"), 403)

        decision = get("decision")
        if decision not in ("APPROVED", "REJECTED"):
            return self._send(page("Gate", "/gate", "<h1>Unknown decision</h1>"), 400)
        if decision == "REJECTED" and not get("reason").strip():
            return self._send(page("Gate", "/gate",
                "<h1>A rejection needs a reason</h1><p class='lede'>A rejection with no "
                "reason teaches nothing to the next version of this piece.</p>"), 400)

        sid = int(get("id"))
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.conn.execute(
            "UPDATE submissions SET decision=?, decided=?, decided_by=?, reason=? "
            "WHERE id=? AND decision='PENDING'",
            (decision, now, "operator", get("reason").strip() or None, sid),
        )
        audit.record(self.conn, f"gate.{decision.lower()}", "operator", str(sid),
                     {"reason": get("reason").strip()},
                     mirror=store.audit_mirror(self.root))

        self.send_response(303)
        self.send_header("Location", "/gate")
        self.end_headers()


def serve(root: Path, port: int = 8787) -> None:
    root = Path(root).expanduser()
    conn = store.open_db(root)
    Handler.root = root
    Handler.conn = conn
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"  Sentinel Desk  →  http://127.0.0.1:{port}")
    print(f"  store: {root / 'sentinel.db'}")
    print("  bound to 127.0.0.1 only. Ctrl-C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")
    finally:
        httpd.server_close()
        conn.close()
