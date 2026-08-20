"""
security.py — the desk audits itself.

Every claim this system makes about its own security is checked here at
runtime rather than asserted in a README. "Zero third-party dependencies" is
proved by walking the imports. "The boundary is enforced" is proved by firing
a canary through it. "Bound to localhost" is proved by reading the source that
does the binding.

That distinction matters more than it sounds. A security control you have not
tested since you wrote it is a security control you are hoping still works.

Each check carries a NIST CSF 2.0 subcategory so the output slots into a
compliance conversation without translation. Where a mapping is approximate it
says so — a wrong framework citation is the same class of error as a wrong
document citation.
"""

from __future__ import annotations
import ast
import os
import sqlite3
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import audit, guard, ingest

PASS, WARN, FAIL = "PASS", "WARN", "FAIL"


@dataclass
class Check:
    id: str
    title: str
    result: str
    detail: str
    fix: str = ""
    csf: tuple[str, ...] = field(default_factory=tuple)
    attack: tuple[str, ...] = field(default_factory=tuple)


# Modules the desk is allowed to import. Everything here ships with CPython.
STDLIB_OK = {
    "__future__", "argparse", "ast", "collections", "dataclasses", "datetime",
    "decimal", "hashlib", "html", "http", "io", "json", "os", "pathlib", "re",
    "secrets", "shutil", "sqlite3", "stat", "string", "sys", "tempfile",
    "threading", "typing", "urllib", "zipfile", "socket", "textwrap", "time",
}


def _third_party_imports(pkg_dir: Path) -> list[str]:
    """Walk every module and list imports that are neither stdlib nor our own."""
    foreign: list[str] = []
    local = {p.stem for p in pkg_dir.glob("*.py")} | {pkg_dir.name}
    for py in sorted(pkg_dir.rglob("*.py")):
        try:
            tree = ast.parse(py.read_text(encoding="utf-8"))
        except (SyntaxError, UnicodeDecodeError):
            foreign.append(f"{py.name}: unparseable")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:          # relative import — ours by definition
                    continue
                names = [(node.module or "").split(".")[0]]
            else:
                continue
            for n in names:
                if n and n not in STDLIB_OK and n not in local:
                    foreign.append(f"{py.name}: {n}")
    return sorted(set(foreign))


def _mode(p: Path) -> str:
    return stat.filemode(p.stat().st_mode)


def _group_or_other_readable(p: Path) -> bool:
    m = p.stat().st_mode
    return bool(m & (stat.S_IRGRP | stat.S_IROTH))


def audit_desk(conn: sqlite3.Connection, root: Path) -> list[Check]:
    """Run every self-check. Pure inspection — changes nothing."""
    root = Path(root).expanduser()
    pkg = Path(__file__).parent
    out: list[Check] = []

    # ── SC-1  supply chain: prove the dependency claim ────────────────────
    foreign = _third_party_imports(pkg)
    out.append(Check(
        "SC-1", "Third-party code in the desk",
        PASS if not foreign else FAIL,
        "No import outside the Python standard library. Nothing in this tree "
        "was fetched from a package registry, so there is no registry account "
        "to compromise and no transitive dependency to audit."
        if not foreign else "Foreign imports found: " + ", ".join(foreign),
        fix="" if not foreign else
            "Remove the dependency or justify it in writing. Every added package "
            "is a party you are trusting with your unpublished investigations.",
        csf=("ID.RA-09", "PR.PS-01"), attack=("T1195.001", "T1195.002"),
    ))

    # ── SC-2  the boundary actually fires ─────────────────────────────────
    canary = {"case": "canary", "advertisingId": "aaaa-bbbb"}
    try:
        guard.assert_clean(canary)
        fired = False
    except guard.RefusedInput:
        fired = True
    out.append(Check(
        "SC-2", "Surveillance-input boundary",
        PASS if fired else FAIL,
        "A canary carrying an advertising ID was refused, so the boundary is "
        "live in this build — not merely present in the source."
        if fired else
        "THE BOUNDARY DID NOT FIRE. A payload with an advertising ID was "
        "accepted. Do not ingest anything until this is fixed.",
        fix="" if fired else "Restore sentinel/guard.py from a known-good copy.",
        csf=("GV.PO-01", "PR.DS-01"),
    ))

    # ── SC-3  listener binding ────────────────────────────────────────────
    src = (pkg / "server.py").read_text(encoding="utf-8")
    bound_local = '("127.0.0.1", port)' in src
    any_iface = '"0.0.0.0"' in src or "'0.0.0.0'" in src
    out.append(Check(
        "SC-3", "Dashboard network binding",
        PASS if (bound_local and not any_iface) else FAIL,
        "The server binds 127.0.0.1 and the source contains no 0.0.0.0 bind. "
        "The case store is not reachable from the network."
        if (bound_local and not any_iface) else
        "The server source no longer binds exclusively to localhost.",
        fix="" if bound_local and not any_iface else
            "Restore the bind to 127.0.0.1. Exposing this needs authentication "
            "in front of it, which is a different project.",
        csf=("PR.IR-01", "PR.AA-05"), attack=("T1190",),
    ))

    # ── SC-4  operator token ──────────────────────────────────────────────
    tok = os.environ.get("SENTINEL_TOKEN", "")
    if not tok:
        out.append(Check(
            "SC-4", "Operator token", WARN,
            "Not set. The publication gate fails closed — it will refuse every "
            "approval, which is the correct failure direction, but you cannot "
            "publish from the dashboard until it is set.",
            fix="Set SENTINEL_TOKEN in ~/Sentinel/env.sh (install-mac.sh generates one).",
            csf=("PR.AA-01",),
        ))
    else:
        weak = len(tok) < 32 or len(set(tok)) < 8
        out.append(Check(
            "SC-4", "Operator token",
            WARN if weak else PASS,
            f"{len(tok)} characters, {len(set(tok))} distinct." +
            ("  Short or low-variety tokens are guessable." if weak else
             "  Adequate for a local, rate-unbounded but non-networked gate."),
            fix="python3 -c 'import secrets;print(secrets.token_hex(32))'" if weak else "",
            csf=("PR.AA-01", "PR.AA-03"), attack=("T1078",),
        ))

    # ── SC-5  file permissions ────────────────────────────────────────────
    perm_problems, loose_paths = [], []
    for p in (root / "env.sh", root / "sentinel.db", root / "audit.jsonl",
              root / "sentinel.db-wal"):
        if p.exists() and _group_or_other_readable(p):
            perm_problems.append(f"{p.name} is {_mode(p)}")
            loose_paths.append(str(p))
    out.append(Check(
        "SC-5", "File permissions on the desk",
        PASS if not perm_problems else WARN,
        "The store, the audit mirror and the token file are readable only by you."
        if not perm_problems else
        "Readable beyond your own account: " + "; ".join(perm_problems) +
        ". On a single-user Mac this is low risk; on any shared machine it is not.",
        fix="" if not perm_problems else "chmod 600 " + " ".join(loose_paths),
        csf=("PR.AA-05", "PR.DS-01"), attack=("T1552.001",),
    ))

    # ── SC-6  evidence must not be in version control ─────────────────────
    in_git = []
    for p in (root, root / "vault"):
        cur = p.resolve()
        while cur != cur.parent:
            if (cur / ".git").exists():
                in_git.append(f"{p.name} sits inside the git repo at {cur}")
                break
            cur = cur.parent
    out.append(Check(
        "SC-6", "Evidence outside version control",
        PASS if not in_git else FAIL,
        "The vault is not inside a git working tree. Evidence cannot be pushed "
        "to a remote by accident."
        if not in_git else "; ".join(in_git) +
        ". A single `git push` would publish unreleased records.",
        fix="" if not in_git else
            "Move the desk outside the repository, or add it to .gitignore AND "
            "confirm nothing is already tracked: git ls-files | grep vault",
        csf=("PR.DS-01", "GV.PO-01"), attack=("T1567",),
    ))

    # ── SC-7  evidence integrity ──────────────────────────────────────────
    problems = ingest.verify_vault(conn)
    out.append(Check(
        "SC-7", "Evidence integrity",
        PASS if not problems else FAIL,
        f"Every vaulted file re-hashes to its registered SHA-256."
        if not problems else
        f"{len(problems)} file(s) missing or altered: " +
        "; ".join(f"{p['title']} [{p['problem']}]" for p in problems[:5]),
        fix="" if not problems else
            "Restore from backup. An altered evidence file invalidates every "
            "claim citing it — do not publish from this case until resolved.",
        csf=("PR.DS-01", "DE.CM-09"), attack=("T1565.001",),
    ))

    # ── SC-8  audit chain ─────────────────────────────────────────────────
    ok, msg = audit.verify(conn)
    out.append(Check(
        "SC-8", "Audit chain", PASS if ok else FAIL, msg,
        fix="" if ok else
            "Compare against audit.jsonl, which is append-only on disk and is "
            "the reason a broken table is recoverable rather than fatal.",
        csf=("PR.PS-04", "DE.AE-03"), attack=("T1070.001",),
    ))

    # ── SC-9  audit mirror in sync ────────────────────────────────────────
    mirror = root / "audit.jsonl"
    n_db = conn.execute("SELECT COUNT(*) FROM audit").fetchone()[0]
    n_disk = (len(mirror.read_text(encoding="utf-8").strip().splitlines())
              if mirror.exists() and mirror.stat().st_size else 0)
    out.append(Check(
        "SC-9", "Audit mirror",
        PASS if n_disk == n_db else WARN,
        f"{n_disk} lines on disk, {n_db} rows in the database — in sync."
        if n_disk == n_db else
        f"{n_disk} lines on disk vs {n_db} rows in the database. The mirror "
        f"exists so the chain survives losing the database; a drift means one "
        f"of the two has been edited outside the desk.",
        fix="" if n_disk == n_db else
            "Investigate before writing anything further. Do not 'fix' by "
            "regenerating the mirror — that destroys the evidence of the drift.",
        csf=("PR.PS-04", "RC.RP-01"),
    ))

    # ── SC-10  backup ─────────────────────────────────────────────────────
    out.append(Check(
        "SC-10", "Backup", WARN,
        "The desk cannot verify your backups; only you can. Copy the whole "
        f"{root.name}/ folder to a second physical device and confirm you can "
        "open sentinel.db from the copy.",
        fix="An untested backup is a hypothesis. Restore one before you need one.",
        csf=("PR.DS-11", "RC.RP-01"), attack=("T1486",),
    ))

    return out


def report(checks: list[Check]) -> str:
    """Plain-text report, for the CLI."""
    order = {FAIL: 0, WARN: 1, PASS: 2}
    checks = sorted(checks, key=lambda c: (order[c.result], c.id))
    n = {r: sum(1 for c in checks if c.result == r) for r in (PASS, WARN, FAIL)}

    L = ["", "  SENTINEL DESK — SECURITY SELF-AUDIT", ""]
    for c in checks:
        mark = {PASS: "ok  ", WARN: "warn", FAIL: "FAIL"}[c.result]
        L.append(f"  [{mark}] {c.id}  {c.title}")
        for line in _wrap(c.detail, 74):
            L.append(f"           {line}")
        if c.fix:
            for line in _wrap("→ " + c.fix, 74):
                L.append(f"           {line}")
        tags = list(c.csf) + list(c.attack)
        if tags:
            L.append(f"           {' · '.join(tags)}")
        L.append("")
    L.append(f"  {n[PASS]} pass · {n[WARN]} warn · {n[FAIL]} fail")
    if n[FAIL]:
        L.append("  A FAIL is not advisory. Resolve it before ingesting or publishing.")
    L.append("")
    return "\n".join(L)


def _wrap(text: str, width: int) -> list[str]:
    import textwrap
    return textwrap.wrap(text, width) or [""]
