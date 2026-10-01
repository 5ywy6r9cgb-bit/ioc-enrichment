#!/usr/bin/env python3
"""sentinel-cycle - the desk's daily research-and-integrity cycle.

    bin/sentinel-cycle plan                 what runs today, and why
    bin/sentinel-cycle run                  offline steps only
    bin/sentinel-cycle run --go             everything due, network included
    bin/sentinel-cycle digest               the last run on one page
    bin/sentinel-cycle verify [--deep]      re-hash the last record, walk the record chain
    bin/sentinel-cycle status               schedule, lock, last runs
    bin/sentinel-cycle doctor               is everything the cycle needs in place
    bin/sentinel-cycle skills [WORD]        the desk's command card
    bin/sentinel-cycle library list|show|check|approve|reject
    bin/sentinel-cycle schedule show|install|status|uninstall [HOUR]
    bin/sentinel-cycle selftest

It runs YOUR commands, in a fixed order, and records what happened. It only
runs read-and-verify commands of this desk: anything that sends, signs,
approves, publishes, commits, pushes, generates keys or changes ledger data
is refused, even if you add it to the plan. Network steps run only with
--go. Every byte a step prints is scrubbed of credentials, your never-print
list and your machine identity before it is written. Each run ends with a
hash record in evidence/ledger/ that includes the previous record's hash, so
the runs form a chain that `verify` can walk.

Standard library only. Python 3.8+.
"""
import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import library  # noqa: E402
import scrub    # noqa: E402

VERSION = "cycle/1.0.1"
LABEL = "com.sentinel.cycle"
WATCH_LABEL = "com.sentinel.watch"
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
MAX_LOG = 2 * 1024 * 1024
STALE_LOCK_SECONDS = 6 * 3600

# Heads the cycle may execute. Nothing else, ever: no shell, no pipes.
ALLOWED_HEADS = ("bin/sentinel", "bin/sentinel-ledger", "bin/sentinel-coin", "bin/sentinel-station",
                 "bin/sentinel-cycle", "bin/sentinel-routes", "sentinel-hunt", "sentinel-fds")
# A token (leading dashes and any =value removed) that makes a command a human act.
REFUSED = frozenset("""send sent approve sign push publish submit mail commit keygen install-data append
import add new delete remove rm install uninstall draft apply link force reset setup init correct
ingest by""".split())
REFUSED_BY_HEAD = {"bin/sentinel-station": frozenset(["build", "artifact", "viewer", "images"]),
                   "bin/sentinel-cycle": frozenset(["run", "schedule"])}

# Files whose state each record captures. Append-only ones are checked by prefix later.
INTEGRITY = ("evidence/ledger/current.json", "evidence/ledger/routes.json", "evidence/ledger/chain.jsonl", "evidence/ledger/seals.jsonl",
             "evidence/ledger/anchors.txt", "evidence/ledger/verify_sources.jsonl",
             "evidence/cycle/library_decisions.jsonl", "evidence/cycle/library_checks.jsonl",
             "site/manifest.json", "site/SHA256SUMS")
APPEND_ONLY = frozenset(["evidence/ledger/chain.jsonl", "evidence/ledger/seals.jsonl",
                         "evidence/ledger/anchors.txt", "evidence/ledger/verify_sources.jsonl",
                         "evidence/cycle/library_decisions.jsonl", "evidence/cycle/library_checks.jsonl"])
REBUILT = frozenset(["evidence/ledger/current.json", "evidence/ledger/routes.json", "site/manifest.json", "site/SHA256SUMS"])


def S(i, what, argv, network, cadence, timeout=1800, needs=None, unless=None, show=0):
    return {"id": i, "what": what, "argv": argv, "network": network, "cadence": cadence,
            "timeout": timeout, "needs": needs if needs is not None else [argv[0]],
            "unless": unless, "show": show}


BUILTIN = [
    S("ledger-check", "every number, quote and hash in the ledger re-verified",
      ["bin/sentinel-ledger", "check"], False, "daily"),
    S("chain-verify", "the ledger's version chain is unbroken",
      ["bin/sentinel-ledger", "chain", "verify"], False, "daily", 600),
    S("seal-verify", "the ledger's seal still matches",
      ["bin/sentinel-ledger", "seal", "verify"], False, "daily", 600,
      needs=["bin/sentinel-ledger", "~/.sentinel/keys/ledger_seal.key"]),
    S("site-verify", "the built site still matches its signed manifest",
      ["bin/sentinel-station", "verify", "site"], False, "daily", 600,
      needs=["bin/sentinel-station", "site/manifest.json"]),
    S("routes", "every number traced to its findings, marked IS / WAS / OPEN",
      ["bin/sentinel-routes", "build"], False, "daily", 900),
    S("watch", "saved searches that are due",
      ["bin/sentinel", "watch", "run"], True, "daily", 7200, unless="watch_scheduled"),
    S("keys", "connector keys set and reachable (presence and length only)",
      ["bin/sentinel", "connect", "test"], True, "weekly:mon", 900),
    S("watch-status", "what the saved searches ran, and when",
      ["bin/sentinel", "watch", "status"], False, "daily", 300, show=12),
    S("crosslink", "names that appear under more than one subject (no network)",
      ["bin/sentinel", "connect", "crosslink"], False, "daily"),
    S("matrix", "the library as CSVs, plus a ranked worklist",
      ["bin/sentinel", "connect", "matrix"], False, "weekly:mon"),
    S("sources", "every cited public URL re-fetched and compared",
      ["bin/sentinel-ledger", "verify-sources", "--go", "--delay", "3"], True, "weekly:sun", 7200),
    S("library", "each source page in the library still answers",
      ["bin/sentinel-cycle", "library", "check", "--go"], True, "monthly:1", 1800),
    S("selftest-ledger", "ledger module proves itself", ["bin/sentinel-ledger", "selftest"], False, "weekly:sun"),
    S("selftest-coin", "coin module proves itself", ["bin/sentinel-coin", "selftest"], False, "weekly:sun"),
    S("selftest-station", "station module proves itself", ["bin/sentinel-station", "selftest"], False, "weekly:sun"),
    S("selftest-routes", "route ledger proves itself", ["bin/sentinel-routes", "selftest"], False, "weekly:sun"),
    S("selftest-cycle", "this cycle proves itself", ["bin/sentinel-cycle", "selftest"], False, "weekly:sun"),
    S("records", "records requests that need you, most urgent first",
      ["bin/sentinel", "pra", "foia"], False, "daily", 600, show=15),
    S("anchor", "record the ledger chain head", ["bin/sentinel-ledger", "chain", "anchor"], False, "daily", 300),
]


# ---- small helpers ----------------------------------------------------------

def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    try:
        return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    except (TypeError, ValueError):
        return None


def sha256_file(path, limit=None):
    h = hashlib.sha256()
    left = limit
    with open(path, "rb") as fh:
        while True:
            n = 1 << 20 if left is None else min(1 << 20, left)
            if n == 0:
                break
            b = fh.read(n)
            if not b:
                break
            h.update(b)
            if left is not None:
                left -= len(b)
    return h.hexdigest()


def home():
    return os.path.expanduser("~")


def expand(root, p):
    if p.startswith("~/"):
        return os.path.join(home(), p[2:])
    if os.path.isabs(p):
        return p
    return os.path.join(root, p)


def pretty(root, p):
    """A path as a person should see it: relative to the repo, or ~-relative."""
    ap = os.path.abspath(p)
    r = os.path.abspath(root)
    if ap == r:
        return "~/" + os.path.relpath(r, home()) if r.startswith(home() + os.sep) else r
    if ap.startswith(r + os.sep):
        return os.path.relpath(ap, r)
    if ap.startswith(home() + os.sep):
        return "~/" + os.path.relpath(ap, home())
    return ap


def write_atomic(path, text, mode=0o600):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp-%d" % os.getpid()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


class Paths(object):
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.cyc = os.path.join(self.root, "evidence", "cycle")
        self.runs = os.path.join(self.cyc, "runs")
        self.lock = os.path.join(self.cyc, ".lock")
        self.state = os.path.join(self.cyc, "state.json")
        self.plan = os.path.join(self.cyc, "plan.json")
        self.ledger = os.path.join(self.root, "evidence", "ledger")

    def rel(self, p):
        return os.path.relpath(p, self.root)


def load_state(P):
    try:
        with open(P.state, "r", encoding="utf-8") as fh:
            st = json.load(fh)
    except (OSError, ValueError):
        st = {}
    st.setdefault("last_ok", {})
    st.setdefault("last_attempt", {})
    return st


def save_state(P, st):
    write_atomic(P.state, json.dumps(st, indent=2, sort_keys=True) + "\n")


# ---- plan -------------------------------------------------------------------

def token_core(tok):
    t = tok.strip().lower()
    while t.startswith("-"):
        t = t[1:]
    return t.split("=", 1)[0]


def refusal(argv):
    """None if the cycle may run argv, else the reason it will not."""
    if not argv or not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
        return "not a command list"
    head = argv[0]
    if head not in ALLOWED_HEADS:
        return "%s is not one of this desk's commands (%s)" % (head, ", ".join(ALLOWED_HEADS))
    for tok in argv[1:]:
        core = token_core(tok)
        if core in REFUSED or core in REFUSED_BY_HEAD.get(head, ()):
            return "'%s' is a human act (send, sign, approve, publish, commit, push, keys, ledger edits)" % tok
    if any(c in tok for tok in argv for c in ("\n", "\r", "\x00")):
        return "control characters in the command"
    return None


def valid_cadence(c):
    if c in ("daily", "manual"):
        return True
    kind, _, arg = c.partition(":")
    if kind == "weekly":
        return arg in DAYS
    if kind == "monthly":
        return arg.isdigit() and 1 <= int(arg) <= 28
    return False


def load_plan(P):
    """Built-in steps plus evidence/cycle/plan.json overrides. -> (steps, problems)"""
    steps = [dict(s) for s in BUILTIN]
    problems = []
    try:
        with open(P.plan, "r", encoding="utf-8") as fh:
            user = json.load(fh)
    except OSError:
        return steps, problems
    except ValueError as e:
        return steps, ["plan.json is not valid JSON (%s); built-in plan used" % e]
    ids = set(s["id"] for s in steps)
    for i in user.get("disable", []):
        if i in ids:
            for s in steps:
                if s["id"] == i:
                    s["cadence"] = "manual"
        else:
            problems.append("disable: no step %r" % i)
    for i, c in (user.get("cadence") or {}).items():
        if i not in ids:
            problems.append("cadence: no step %r" % i)
        elif not valid_cadence(c):
            problems.append("cadence %r for %s: use daily, weekly:mon..sun, monthly:1..28 or manual" % (c, i))
        else:
            for s in steps:
                if s["id"] == i:
                    s["cadence"] = c
    for i, t in (user.get("timeout") or {}).items():
        for s in steps:
            if s["id"] == i and isinstance(t, (int, float)) and 1 <= t <= 6 * 3600:
                s["timeout"] = int(t)
    for x in user.get("extra", []):
        sid = str(x.get("id", "")).strip()
        if not re.match(r"^[a-z0-9][a-z0-9-]{1,39}$", sid) or sid in ids:
            problems.append("extra step id %r is missing, malformed or taken" % sid)
            continue
        cad = x.get("cadence", "daily")
        if not valid_cadence(cad):
            problems.append("extra %s: bad cadence %r" % (sid, cad))
            continue
        argv = x.get("argv")
        st = S(sid, str(x.get("what", "your step"))[:80], argv if isinstance(argv, list) and argv else ["?"],
               x.get("network", True) is not False, cad, int(x.get("timeout", 1800)))
        st["extra"] = True
        steps.insert(len(steps) - 2, st)   # before records + anchor
        ids.add(sid)
    return steps, problems


def watch_plist(h=None):
    return os.path.join(h or home(), "Library", "LaunchAgents", WATCH_LABEL + ".plist")


def cycle_plist(h=None):
    return os.path.join(h or home(), "Library", "LaunchAgents", LABEL + ".plist")


def plist_hour(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            m = re.search(r"<key>Hour</key>\s*<integer>(\d+)</integer>", fh.read())
        return int(m.group(1)) if m else None
    except OSError:
        return None


def missing_needs(root, step):
    miss = []
    for n in step["needs"]:
        if n in ("sentinel-hunt", "sentinel-fds"):
            if not shutil.which(n):
                miss.append(n)
        elif not os.path.exists(expand(root, n)):
            miss.append(n)
    return miss


def decide(P, step, today, st, go, force_all, only, skip):
    """-> (action, note). action: RUN | SKIP | NOT_DUE | NOT_INSTALLED | REFUSED"""
    why = refusal(step["argv"])
    if why:
        return "REFUSED", why
    if skip and step["id"] in skip:
        return "SKIP", "--skip"
    if only is not None and step["id"] not in only:
        return "SKIP", "not in --only"
    miss = missing_needs(P.root, step)
    if miss:
        return "NOT_INSTALLED", "missing " + ", ".join(miss)
    explicit = only is not None and step["id"] in only
    if step.get("unless") == "watch_scheduled" and not explicit and os.path.exists(watch_plist()):
        hr = plist_hour(watch_plist())
        return "SKIP", "the watch job runs it%s" % (" at %02d:00" % hr if hr is not None else "")
    if not (explicit or force_all):
        ok, why = is_due(step, today, st)
        if not ok:
            return "NOT_DUE", why
    if step["network"] and not go:
        return "SKIP", "network step: needs --go"
    return "RUN", "due" if not explicit else "--only"


def is_due(step, today, st):
    cad = step["cadence"]
    last = parse_iso(st["last_ok"].get(step["id"]))
    last_d = last.astimezone().date() if last else None
    if cad == "daily":
        return True, "daily"
    if cad == "manual":
        return False, "manual: run it with --only %s" % step["id"]
    kind, _, arg = cad.partition(":")
    if last_d == today:
        return False, "%s, already ran today" % cad
    age = (today - last_d).days if last_d else None
    if kind == "weekly":
        if DAYS[today.weekday()] == arg:
            return True, "weekly on %s" % arg
        if age is None:
            return True, "weekly, never run here"
        if age >= 7:
            return True, "weekly, last ok %d days ago" % age
        return False, "weekly on %s, last ok %s" % (arg, last_d.isoformat())
    if kind == "monthly":
        if today.day == int(arg):
            return True, "monthly on day %s" % arg
        if age is None:
            return True, "monthly, never run here"
        if age >= 31:
            return True, "monthly, last ok %d days ago" % age
        return False, "monthly on day %s, last ok %s" % (arg, last_d.isoformat())
    return False, "unknown cadence %r" % cad


# ---- running ----------------------------------------------------------------

class Locked(Exception):
    pass


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def acquire_lock(P, out):
    os.makedirs(P.cyc, exist_ok=True)
    for attempt in (1, 2):
        try:
            fd = os.open(P.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as fh:
                json.dump({"pid": os.getpid(), "started": iso(utcnow())}, fh)
            return
        except FileExistsError:
            try:
                with open(P.lock, "r") as fh:
                    info = json.load(fh)
            except (OSError, ValueError):
                info = {}
            pid = info.get("pid")
            started = parse_iso(info.get("started"))
            age = (utcnow() - started).total_seconds() if started else STALE_LOCK_SECONDS + 1
            if isinstance(pid, int) and pid_alive(pid) and age < STALE_LOCK_SECONDS:
                raise Locked("another cycle is running (pid %s, since %s)" % (pid, info.get("started")))
            out.write("  stale lock from pid %s removed\n" % pid)
            try:
                os.remove(P.lock)
            except OSError:
                pass
    raise Locked("could not take the lock at %s" % P.rel(P.lock))


def release_lock(P):
    try:
        with open(P.lock, "r") as fh:
            if json.load(fh).get("pid") == os.getpid():
                os.remove(P.lock)
    except (OSError, ValueError):
        pass


def step_env():
    env = dict(os.environ)
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p]
    for extra in ("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"):
        if os.path.isdir(extra) and extra not in parts:
            parts.append(extra)
    env["PATH"] = os.pathsep.join(parts)
    env.update({"SENTINEL_CYCLE": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "TERM": "dumb",
                "PYTHONUNBUFFERED": "1"})
    return env


def cap(text):
    b = text.encode("utf-8", "replace")
    if len(b) <= MAX_LOG:
        return text
    half = MAX_LOG // 2
    head = b[:half].decode("utf-8", "ignore")
    tail = b[-half:].decode("utf-8", "ignore")
    return head + "\n\n[... %d bytes cut from the middle; the cycle keeps 2 MB per step ...]\n\n" % (len(b) - MAX_LOG) + tail


def execute(P, step, env):
    argv = list(step["argv"])
    if argv[0].startswith("bin/"):
        argv[0] = os.path.join(P.root, argv[0])
    else:
        argv[0] = shutil.which(argv[0]) or argv[0]
    t0 = time.time()
    rc, status, raw = None, "FAIL", b""
    try:
        p = subprocess.Popen(argv, cwd=P.root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, start_new_session=True)
        try:
            raw, _ = p.communicate(timeout=step["timeout"])
            rc = p.returncode
            status = "OK" if rc == 0 else "FAIL"
        except subprocess.TimeoutExpired:
            status = "TIMEOUT"
            for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 10)):
                try:
                    os.killpg(p.pid, sig)
                except OSError:
                    pass
                try:
                    raw, _ = p.communicate(timeout=wait)
                    break
                except subprocess.TimeoutExpired:
                    continue
            rc = p.returncode
    except OSError as e:
        raw = ("could not start: %s" % e).encode()
    return status, rc, round(time.time() - t0, 2), raw.decode("utf-8", "replace")


def tail_lines(text, n):
    lines = [l for l in text.splitlines() if l.strip()]
    return lines[-n:]


def head_lines(text, n):
    lines = [l for l in text.splitlines() if l.strip()]
    return lines[:n]


HEX64 = re.compile(r"\b[0-9a-f]{64}\b")


def integrity_snapshot(P):
    snap = {}
    for rel in INTEGRITY:
        p = os.path.join(P.root, rel)
        if os.path.isfile(p):
            snap[rel] = {"sha256": sha256_file(p), "bytes": os.path.getsize(p)}
    return snap


def cmd_run(P, args, out=sys.stdout):
    steps, problems = load_plan(P)
    st = load_state(P)
    today = datetime.date.fromisoformat(args.today) if args.today else datetime.date.today()
    only = set(args.only.split(",")) if args.only else None
    skip = set(args.skip.split(",")) if args.skip else set()
    try:
        acquire_lock(P, out)
    except Locked as e:
        out.write("SENTINEL CYCLE - not started: %s\n" % e)
        return 3
    try:
        return _run(P, args, steps, problems, st, today, only, skip, out)
    finally:
        release_lock(P)


def _run(P, args, steps, problems, st, today, only, skip, out):
    started = utcnow()
    stamp = started.strftime("%Y%m%dT%H%M%SZ")
    run_dir = os.path.join(P.runs, stamp)
    n = 0
    while os.path.exists(run_dir):
        n += 1
        run_dir = os.path.join(P.runs, "%s-%d" % (stamp, n))
    stamp = os.path.basename(run_dir)
    os.makedirs(run_dir, mode=0o700)
    scrubber = scrub.Scrubber(P.root)
    env = step_env()
    w = out.write
    w("SENTINEL CYCLE  %s  run %s\n" % (VERSION, stamp))
    w("repo      %s\n" % pretty(P.root, P.root))
    w("network   %s\n" % ("ON (--go): public GETs through your own connectors" if args.go
                          else "OFF: offline steps only (add --go for the network steps)"))
    w("never     sends, signs, approves, publishes, commits, pushes, keys, ledger edits\n")
    for pr in problems:
        w("plan      %s\n" % pr)
    w("\n")
    results = []
    for i, step in enumerate(steps, 1):
        action, note = decide(P, step, today, st, args.go, args.all, only, skip)
        r = {"n": i, "id": step["id"], "what": step["what"], "argv": step["argv"], "network": step["network"],
             "cadence": step["cadence"], "status": action if action != "RUN" else None, "note": note,
             "extra": bool(step.get("extra"))}
        if action == "RUN":
            st["last_attempt"][step["id"]] = iso(utcnow())
            status, rc, secs, text = execute(P, step, env)
            clean = cap(scrubber(text))
            logname = "%02d-%s.log" % (i, step["id"])
            header = "# %s  %s\n# %s\n# status %s  rc %s  %.2fs\n\n" % (
                step["id"], step["what"], " ".join(step["argv"]), status, rc, secs)
            write_atomic(os.path.join(run_dir, logname), header + clean)
            r.update({"status": status, "rc": rc, "seconds": secs, "log": logname,
                      "log_sha256": sha256_file(os.path.join(run_dir, logname))})
            if status == "OK":
                st["last_ok"][step["id"]] = iso(utcnow())
            if step.get("show"):
                r["excerpt"] = head_lines(clean, step["show"])
            if status != "OK":
                r["tail"] = tail_lines(clean, 8)
            if step["id"] == "anchor" and status == "OK":
                m = HEX64.search(clean)
                r["chain_head"] = m.group(0) if m else None
        results.append(r)
        shown = step["what"] if r["status"] in ("OK", "FAIL", "TIMEOUT") else r["note"]
        w("[%02d/%02d] %-17s %-13s %8s  %s\n" % (i, len(steps), step["id"], r["status"],
                                               ("%.1fs" % r["seconds"]) if "seconds" in r else "", shown))
    ended = utcnow()
    counts = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    head = next((r.get("chain_head") for r in results if r["id"] == "anchor" and r.get("chain_head")), None)
    prev_rel, prev_sha = st.get("last_record"), st.get("last_record_sha256")
    prev_ok = None
    if prev_rel:
        pp = os.path.join(P.root, prev_rel)
        prev_ok = os.path.isfile(pp) and sha256_file(pp) == prev_sha
    rec_rel = "evidence/ledger/cycle-%s.sha256" % stamp
    run = {"schema": "sentinel.cycle.run/1", "version": VERSION, "run": stamp,
           "started": iso(started), "ended": iso(ended),
           "mode": {"go": bool(args.go), "scheduled": bool(args.scheduled), "all": bool(args.all),
                    "only": sorted(only) if only is not None else None, "skip": sorted(skip),
                    "today": today.isoformat()},
           "plan_problems": problems, "steps": results, "counts": counts,
           "integrity": {"files": integrity_snapshot(P), "chain_head": head,
                         "prev_record": prev_rel, "prev_record_sha256": prev_sha, "prev_record_intact": prev_ok},
           "record": rec_rel, "scrubber": scrubber.counts}
    write_atomic(os.path.join(run_dir, "run.json"), json.dumps(run, indent=2, sort_keys=True) + "\n")
    digest = render_digest(P, run, scrubber)
    write_atomic(os.path.join(run_dir, "digest.md"), digest)
    # the record: this run's files, the integrity files, and the previous record
    entries = [os.path.join(run_dir, "run.json"), os.path.join(run_dir, "digest.md")]
    entries += [os.path.join(run_dir, r["log"]) for r in results if r.get("log")]
    entries += [os.path.join(P.root, rel) for rel in sorted(run["integrity"]["files"])]
    if prev_rel and os.path.isfile(os.path.join(P.root, prev_rel)):
        entries.append(os.path.join(P.root, prev_rel))
    lines = ["%s  %s\n" % (sha256_file(p), P.rel(p)) for p in entries]
    rec_path = os.path.join(P.root, rec_rel)
    os.makedirs(os.path.dirname(rec_path), exist_ok=True)
    write_atomic(rec_path, "".join(lines), mode=0o644)
    rec_sha = sha256_file(rec_path)
    st["last_run"] = stamp
    st["last_record"] = rec_rel
    st["last_record_sha256"] = rec_sha
    st.setdefault("records", []).append({"run": stamp, "record": rec_rel, "sha256": rec_sha})
    st["records"] = st["records"][-400:]
    save_state(P, st)
    bad = sum(counts.get(k, 0) for k in ("FAIL", "TIMEOUT", "REFUSED"))
    w("\n%s\n" % summary_line(counts))
    if head:
        w("chain head  %s   copy it somewhere off this machine\n" % head)
    if prev_ok is False:
        w("WARNING     the previous cycle record changed since it was written: bin/sentinel-cycle verify\n")
    w("digest      %s\n" % P.rel(os.path.join(run_dir, "digest.md")))
    w("record      %s\n            sha256 %s\n" % (rec_rel, rec_sha))
    return 1 if bad else 0


def summary_line(counts):
    order = ["OK", "FAIL", "TIMEOUT", "REFUSED", "SKIP", "NOT_DUE", "NOT_INSTALLED"]
    names = {"OK": "ok", "FAIL": "failed", "TIMEOUT": "timed out", "REFUSED": "refused", "SKIP": "skipped",
             "NOT_DUE": "not due", "NOT_INSTALLED": "not installed"}
    return " · ".join("%d %s" % (counts[k], names[k]) for k in order if counts.get(k))


def render_digest(P, run, scrubber):
    local = parse_iso(run["started"]).astimezone()
    L = []
    a = L.append
    a("# Desk cycle · %s · run %s\n" % (local.strftime("%a %Y-%m-%d %H:%M %Z"), run["run"]))
    mode = "network on (--go)" if run["mode"]["go"] else "offline (no --go)"
    if run["mode"]["scheduled"]:
        mode += ", scheduled"
    a("%s · %s. Everything below is status. None of it is a finding.\n" % (VERSION, mode))
    a("**%s**\n" % summary_line(run["counts"]))
    a("| # | Step | Status | Seconds | What it checks |")
    a("|---|---|---|---|---|")
    for r in run["steps"]:
        what = r["what"] if r["status"] in ("OK", "FAIL", "TIMEOUT") else r["note"]
        a("| %d | %s%s | %s | %s | %s |" % (r["n"], r["id"], " (yours)" if r.get("extra") else "", r["status"],
                                            ("%.1f" % r["seconds"]) if "seconds" in r else "", what.replace("|", "/")))
    a("")
    needs = []
    for r in run["steps"]:
        if r["status"] in ("FAIL", "TIMEOUT"):
            item = "- **%s** %s. Last lines:\n\n```\n%s\n```\n  Full log: `evidence/cycle/runs/%s/%s`" % (
                r["id"], "failed (exit %s)" % r.get("rc") if r["status"] == "FAIL" else "timed out",
                "\n".join(r.get("tail") or ["(no output)"]), run["run"], r.get("log"))
            needs.append(item)
        elif r["status"] == "REFUSED":
            needs.append("- **%s** refused: %s. The cycle only runs this desk's read-and-verify commands." % (r["id"], r["note"]))
    due_offline = [r["id"] for r in run["steps"] if r["status"] == "SKIP" and r["note"] == "network step: needs --go"]
    if due_offline:
        needs.append("- Network steps were due but did not run (no --go): %s. Run `bin/sentinel-cycle run --go`." % ", ".join(due_offline))
    for r in run["steps"]:
        if r["id"] == "seal-verify" and r["status"] == "NOT_INSTALLED":
            needs.append("- The ledger seal was not checked: no seal key yet. Create it once with `bin/sentinel-ledger seal keygen`, then `bin/sentinel-ledger seal sign`.")
    if run["integrity"].get("prev_record_intact") is False:
        needs.append("- **The previous cycle record changed after it was written.** Run `bin/sentinel-cycle verify` before anything else.")
    if not os.path.exists(cycle_plist()):
        needs.append("- The cycle is not scheduled. `bin/sentinel-cycle schedule install` runs it every morning.")
    for pr in run.get("plan_problems") or []:
        needs.append("- plan.json: %s" % pr)
    a("## Needs you\n")
    a("\n".join(needs) if needs else "Nothing failed. Nothing was refused.")
    a("")
    for r in run["steps"]:
        if r.get("excerpt"):
            a("## %s\n" % ("Records desk" if r["id"] == "records" else "Saved searches" if r["id"] == "watch-status" else r["id"]))
            a("From `%s` (first lines):\n" % " ".join(r["argv"]))
            a("```\n%s\n```\n" % "\n".join(r["excerpt"]))
    a("## Integrity\n")
    head = run["integrity"].get("chain_head")
    a("- Ledger chain head: %s" % ("`%s`. Copy it somewhere off this machine (paper, or a second device)." % head if head
                                   else "none this run (the anchor step did not produce one)."))
    pi = run["integrity"].get("prev_record_intact")
    a("- Previous cycle record: %s" % ("intact." if pi else "none (this is the first run)." if pi is None else "CHANGED since it was written."))
    a("- This run's record: `%s`. Its SHA-256 is printed at the end of the run and kept by `bin/sentinel-cycle status`." % run["record"])
    a("- Check it any time: `bin/sentinel-cycle verify`.\n")
    a("## What the cycle never does\n")
    a("It never sends, signs, approves, publishes, commits, pushes, generates keys or changes ledger data. "
      "A signal is a lead, never a finding. Those calls stay yours.\n")
    return scrubber("\n".join(L) + "\n")


# ---- plan / digest / status / verify ---------------------------------------

def cmd_plan(P, args, out=sys.stdout):
    steps, problems = load_plan(P)
    st = load_state(P)
    today = datetime.date.fromisoformat(args.today) if args.today else datetime.date.today()
    only = set(args.only.split(",")) if args.only else None
    skip = set(args.skip.split(",")) if args.skip else set()
    w = out.write
    w("SENTINEL CYCLE - plan for %s %s   %s\n" % (DAYS[today.weekday()], today.isoformat(), VERSION))
    w("repo      %s\n" % pretty(P.root, P.root))
    w("network   %s\n" % ("ON (--go)" if args.go else "OFF - shown as 'needs --go'"))
    if os.path.exists(watch_plist()):
        hr = plist_hour(watch_plist())
        w("watch job scheduled%s: the cycle leaves `watch run` to it\n" % (" at %02d:00" % hr if hr is not None else ""))
    for pr in problems:
        w("plan      %s\n" % pr)
    w("\n  %-3s %-17s %-11s %-14s %s\n" % ("#", "STEP", "CADENCE", "TODAY", "COMMAND"))
    for i, s in enumerate(steps, 1):
        action, note = decide(P, s, today, st, args.go, args.all, only, skip)
        label = "runs" if action == "RUN" else action.lower().replace("_", " ")
        w("  %-3d %-17s %-11s %-14s %s%s\n" % (i, s["id"], s["cadence"], label, " ".join(s["argv"]),
                                              "" if action == "RUN" else "   (%s)" % note))
    w("\n  never   send · sign · approve · publish · commit · push · keygen · ledger edits\n")
    w("  change it in evidence/cycle/plan.json  (see modules/cycle/README.md)\n")
    return 0


def run_dirs(P):
    try:
        names = sorted(n for n in os.listdir(P.runs) if os.path.isfile(os.path.join(P.runs, n, "run.json")))
    except OSError:
        names = []
    return names


def cmd_digest(P, args, out=sys.stdout):
    names = run_dirs(P)
    if not names:
        out.write("no cycle has run yet: bin/sentinel-cycle run\n")
        return 1
    name = args.run if args.run and args.run != "latest" else names[-1]
    path = os.path.join(P.runs, name, "digest.md")
    if not os.path.isfile(path):
        out.write("no digest for run %s\n" % name)
        return 1
    if args.path:
        out.write(path + "\n")
        return 0
    with open(path, "r", encoding="utf-8") as fh:
        out.write(fh.read())
    return 0


def parse_record(path):
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"^([0-9a-f]{64})  (.+)$", line.rstrip("\n"))
            if m:
                rows.append((m.group(1), m.group(2)))
    return rows


def check_file(P, sha, rel, sizes):
    p = os.path.join(P.root, rel)
    if not os.path.isfile(p):
        return "MISSING"
    if sha256_file(p) == sha:
        return "OK"
    if rel in APPEND_ONLY and rel in sizes:
        size = sizes[rel]
        if os.path.getsize(p) >= size and sha256_file(p, limit=size) == sha:
            return "GREW"
        return "CHANGED"
    if rel in REBUILT:
        return "REBUILT"
    return "CHANGED"


def record_sizes(P, rows):
    for sha, rel in rows:
        if rel.endswith("/run.json"):
            try:
                with open(os.path.join(P.root, rel), "r", encoding="utf-8") as fh:
                    files = json.load(fh).get("integrity", {}).get("files", {})
                return dict((k, v.get("bytes")) for k, v in files.items())
            except (OSError, ValueError):
                return {}
    return {}


def is_record(rel):
    return re.match(r"^evidence/ledger/cycle-.+\.sha256$", rel) is not None


def newest_record(P):
    try:
        recs = sorted(n for n in os.listdir(P.ledger) if n.startswith("cycle-") and n.endswith(".sha256"))
    except OSError:
        recs = []
    return "evidence/ledger/" + recs[-1] if recs else None


def cmd_verify(P, args, out=sys.stdout):
    st = load_state(P)
    rec = args.record or st.get("last_record") or newest_record(P)
    if not rec or not os.path.isfile(os.path.join(P.root, rec)):
        out.write("no cycle record to verify yet: bin/sentinel-cycle run\n")
        return 1
    w = out.write
    w("SENTINEL CYCLE - verify%s\n" % ("  (deep: every run in the chain)" if args.deep else ""))
    bad = 0
    if rec == st.get("last_record") and st.get("last_record_sha256"):
        same = sha256_file(os.path.join(P.root, rec)) == st["last_record_sha256"]
        w("  record   %s %s\n" % (rec, "matches the hash kept when it was written" if same
                                   else "DOES NOT MATCH the hash kept when it was written"))
        bad += 0 if same else 1
    depth, cur, latest = 0, rec, {}
    while cur:
        depth += 1
        rows = parse_record(os.path.join(P.root, cur))
        sizes = record_sizes(P, rows)
        prev = None
        for sha, rel in rows:
            if is_record(rel):
                prev = (sha, rel)
                continue
            if depth > 1 and not args.deep:
                continue
            res = check_file(P, sha, rel, sizes)
            if depth == 1:
                latest[res] = latest.get(res, 0) + 1
            if res in ("MISSING", "CHANGED"):
                bad += 1
                w("  %-8s %s   (listed in %s)\n" % (res, rel, os.path.basename(cur)))
            elif depth == 1 and res in ("GREW", "REBUILT"):
                w("  %-8s %s\n" % (res.lower(), rel))
        if not prev:
            break
        psha, prel = prev
        pp = os.path.join(P.root, prel)
        if not os.path.isfile(pp):
            w("  BROKEN   %s names %s, which is missing\n" % (os.path.basename(cur), prel))
            bad += 1
            break
        if sha256_file(pp) != psha:
            w("  BROKEN   %s changed after %s recorded it\n" % (os.path.basename(prel), os.path.basename(cur)))
            bad += 1
            break
        cur = prel
        if depth > 100000:
            break
    w("  chain    %d record(s), newest to oldest, each holding the hash of the one before\n" % depth)
    w("  latest   %s\n" % " · ".join("%d %s" % (v, k.lower()) for k, v in sorted(latest.items())))
    w("  legend   ok = byte-identical · grew = append-only file, every recorded byte still there\n"
      "           rebuilt = ledger or site replaced since (expected after install-data or a rebuild;\n"
      "           the ledger's own chain covers that: bin/sentinel-ledger chain verify)\n")
    w("  result   %s\n" % ("INTACT" if not bad else "%d PROBLEM(S): read the lines above" % bad))
    return 0 if not bad else 1


def cmd_status(P, args, out=sys.stdout):
    st = load_state(P)
    w = out.write
    w("SENTINEL CYCLE - status   %s\n" % VERSION)
    cp = cycle_plist()
    if os.path.exists(cp):
        hr = plist_hour(cp)
        w("schedule   every day at %s (%s)\n" % ("%02d:15" % hr if hr is not None else "?", pretty(P.root, cp)))
    else:
        w("schedule   not installed   bin/sentinel-cycle schedule install\n")
    wp = watch_plist()
    if os.path.exists(wp):
        hr = plist_hour(wp)
        w("watch job  every day at %s\n" % ("%02d:00" % hr if hr is not None else "?"))
    else:
        w("watch job  not installed   (the cycle runs `watch run` itself when --go is given)\n")
    if os.path.exists(P.lock):
        try:
            with open(P.lock) as fh:
                info = json.load(fh)
        except (OSError, ValueError):
            info = {}
        w("lock       held by pid %s since %s%s\n" % (info.get("pid"), info.get("started"),
                                                    "" if pid_alive(info.get("pid") or -1) else " (stale; the next run clears it)"))
    else:
        w("lock       free\n")
    names = run_dirs(P)
    w("runs       %d kept in evidence/cycle/runs/\n" % len(names))
    recs = dict((r["run"], r) for r in st.get("records", []))
    for name in names[-args.n:]:
        try:
            with open(os.path.join(P.runs, name, "run.json")) as fh:
                run = json.load(fh)
        except (OSError, ValueError):
            continue
        rs = recs.get(name, {}).get("sha256", "")
        w("  %s  %-8s %s%s\n" % (name, "network" if run["mode"]["go"] else "offline", summary_line(run["counts"]),
                                 ("   record %s…%s" % (rs[:8], rs[-8:])) if rs else ""))
    if st.get("last_record_sha256"):
        w("last record %s\n            sha256 %s\n" % (st["last_record"], st["last_record_sha256"]))
    return 0


# ---- doctor -----------------------------------------------------------------

def git(P, *a):
    try:
        p = subprocess.run(["git", "-C", P.root] + list(a), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=20)
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return None, ""


def mode_of(path):
    return os.stat(path).st_mode & 0o777


def cmd_doctor(P, args, out=sys.stdout):
    w = out.write
    probs = [0]

    def line(ok, text, fix=None):
        mark = {True: "ok ", False: "NO ", None: " - "}[ok]
        w("  %s %s%s\n" % (mark, text, ("\n        -> " + fix) if fix and ok is False else ""))
        if ok is False:
            probs[0] += 1

    w("SENTINEL CYCLE - doctor   %s\n" % VERSION)
    v = sys.version_info
    line(v >= (3, 8), "python %d.%d.%d" % (v[0], v[1], v[2]), "python 3.8 or newer")
    line(os.path.isfile(os.path.join(P.root, "bin", "sentinel")), "repo %s (bin/sentinel)" % pretty(P.root, P.root),
         "run this from your sentinel repo")
    line(bool(shutil.which("node", path=step_env()["PATH"])), "node on PATH (the connectors need it)", "brew install node")
    for m in ("ledger", "coin", "station"):
        line(os.path.isfile(os.path.join(P.root, "bin", "sentinel-" + m)), "bin/sentinel-%s" % m,
             "install the 2026-09-30 desk kit (install.sh)")
    envf = os.path.join(P.root, "modules", "pra", ".env")
    if os.path.isfile(envf):
        names = [k for k, val in scrub.parse_env_file(envf).items() if val and scrub.SECRET_NAME.search(k)]
        md = mode_of(envf)
        line(md & 0o077 == 0, "keys file modules/pra/.env, mode %o, %d key name(s) set (values never read out)" % (md, len(names)),
             "chmod 600 modules/pra/.env")
    else:
        line(False, "keys file modules/pra/.env", "bin/sentinel pra setup, then docs/API_KEYS.md")
    for label, rel, fix in (("seal key", "~/.sentinel/keys/ledger_seal.key", "bin/sentinel-ledger seal keygen"),
                            ("publisher key", "~/.sentinel/station/publisher.key", "bin/sentinel-station keygen")):
        p = expand(P.root, rel)
        if os.path.isfile(p):
            line(mode_of(p) & 0o077 == 0, "%s %s, mode %o" % (label, rel, mode_of(p)), "chmod 600 " + rel)
        else:
            line(False, "%s %s" % (label, rel), fix)
    fp = scrub.forbidden_path()
    items = scrub.never_print_items()
    line(bool(items), "never-print list ~/.sentinel/ledger/forbidden.txt: %d line(s)" % len(items),
         "add one line per string that must never appear in output (your name, email, home path, machine name)")
    rc, _ = git(P, "rev-parse", "--is-inside-work-tree")
    if rc == 0:
        for probe in (".env", "modules/pra/.env", "evidence/raw/x", "secrets/x", "evidence/cycle/x"):
            r, _ = git(P, "check-ignore", "-q", probe)
            line(r == 0, ".gitignore covers %s" % probe.replace("/x", "/"), "add it to .gitignore")
        r, _ = git(P, "check-ignore", "-q", "site/index.html")
        line(None, "site/ is %s" % ("gitignored" if r == 0 else "NOT gitignored: fine if you mean to commit the public site"))
    else:
        line(None, "not a git repository: .gitignore checks skipped")
    wp = watch_plist()
    line(None if not os.path.exists(wp) else True, "watch job %s" % ("scheduled" if os.path.exists(wp) else "not scheduled (the cycle runs `watch run` itself with --go)"))
    cp = cycle_plist()
    line(os.path.exists(cp), "cycle job %s" % ("scheduled" if os.path.exists(cp) else "not scheduled"),
         "bin/sentinel-cycle schedule install")
    st = load_state(P)
    last = None
    if st.get("last_run"):
        last = datetime.datetime.strptime(st["last_run"][:15], "%Y%m%dT%H%M%S").replace(tzinfo=datetime.timezone.utc)
    if last:
        hours = (utcnow() - last).total_seconds() / 3600
        line(hours < 36 or not os.path.exists(cp), "last cycle %s (%.0f h ago)" % (st["last_run"], hours),
             "the schedule should have run: bin/sentinel-cycle schedule status")
    else:
        line(None, "no cycle has run yet")
    try:
        du = shutil.disk_usage(P.root)
        gb = du.free / 1e9
        line(gb > 2, "disk: %.0f GB free" % gb, "free some space: evidence and library grow")
    except OSError:
        pass
    w("\n  %s\n" % ("everything the cycle needs is in place" if not probs[0] else "%d thing(s) to fix above" % probs[0]))
    return 0 if not probs[0] else 1


# ---- skills -----------------------------------------------------------------

def cmd_skills(P, args, out=sys.stdout):
    with open(os.path.join(HERE, "skills.md"), "r", encoding="utf-8") as fh:
        text = fh.read()
    if not args.word:
        out.write(text)
        return 0
    word = args.word.lower()
    section, printed = None, set()
    for line in text.splitlines():
        if line and line == line.upper() and not line.startswith(" "):
            section = line
            continue
        if word in line.lower():
            if section and section not in printed:
                out.write("\n" + section + "\n")
                printed.add(section)
            out.write(line + "\n")
    if not printed:
        out.write("nothing on the card mentions %r\n" % args.word)
    return 0


# ---- schedule ---------------------------------------------------------------

def xml_escape(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def valid_hour(s):
    if s is None:
        return None, None
    if not re.match(r"^\d{1,2}$", s):
        msg = ("Not an hour: %r. Use 0-23.\n"
               "If you pasted a command with a trailing # comment: zsh (the macOS default) does not treat #\n"
               "as a comment in an interactive shell, so everything after it arrived as arguments.\n"
               "Retype the command without the comment.\n" % s)
        return None, msg
    h = int(s)
    if h > 23:
        return None, "Not an hour: %d. Use 0-23.\n" % h
    return h, None


def default_hour():
    wh = plist_hour(watch_plist()) if os.path.exists(watch_plist()) else None
    return (wh + 2) % 24 if wh is not None else 9


def render_plist(P, hour, minute=15, path_env=None):
    """python3 is found through PATH when the job runs, so a Homebrew upgrade does not break it."""
    with open(os.path.join(HERE, "com.sentinel.cycle.plist.template"), "r", encoding="utf-8") as fh:
        t = fh.read()
    path_env = path_env or step_env()["PATH"]
    rep = {"__ROOT__": P.root, "__HOUR__": str(int(hour)),
           "__MINUTE__": str(int(minute)), "__PATH__": path_env, "__LABEL__": LABEL}
    for k, v in rep.items():
        t = t.replace(k, xml_escape(v))
    return t


def cmd_schedule(P, args, out=sys.stdout):
    w = out.write
    act = args.action
    if act in ("show", "install"):
        h, err = valid_hour(args.hour)
        if err:
            w(err)
            return 2
        if h is None:
            h = default_hour()
        text = render_plist(P, h)
        if act == "show":
            w(text)
            return 0
        if platform.system() != "Darwin":
            w("'schedule install' uses launchd, which is macOS-only. On Linux add this to your crontab:\n")
            w("  15 %d * * * cd %s && bin/sentinel-cycle run --go --scheduled\n" % (h, P.root))
            return 1
        path = cycle_plist()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.makedirs(P.cyc, exist_ok=True)
        write_atomic(path, text, mode=0o644)
        subprocess.run(["launchctl", "unload", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        r = subprocess.run(["launchctl", "load", path], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           universal_newlines=True)
        if r.returncode != 0:
            w("launchctl could not load the job:\n%s\n" % r.stdout)
            return 1
        w("scheduled  every day at %02d:15 (a Mac that was asleep runs it when it wakes)\n" % h)
        w("runs       bin/sentinel-cycle run --go --scheduled\n")
        w("plist      %s\n" % pretty(P.root, path))
        w("log        evidence/cycle/launchd.log\n")
        if os.path.exists(watch_plist()):
            w("watch job  stays as it is; the cycle leaves `watch run` to it\n")
        w("\nRun it once now to confirm: bin/sentinel-cycle run --go\n")
        return 0
    if act == "status":
        path = cycle_plist()
        if not os.path.exists(path):
            w("not scheduled   bin/sentinel-cycle schedule install\n")
            return 1
        hr = plist_hour(path)
        loaded = None
        if platform.system() == "Darwin":
            r = subprocess.run(["launchctl", "list"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               universal_newlines=True)
            loaded = LABEL in r.stdout
        w("scheduled  every day at %s\n" % ("%02d:15" % hr if hr is not None else "?"))
        w("loaded     %s\n" % {True: "yes", False: "NO: bin/sentinel-cycle schedule install", None: "?"}[loaded])
        st = load_state(P)
        w("last run   %s\n" % (st.get("last_run") or "never"))
        return 0
    if act == "uninstall":
        path = cycle_plist()
        if not os.path.exists(path):
            w("not scheduled (nothing to remove)\n")
            return 0
        if platform.system() == "Darwin":
            subprocess.run(["launchctl", "unload", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.remove(path)
        w("unscheduled; removed %s\n" % pretty(P.root, path))
        return 0
    w("schedule show|install|status|uninstall [HOUR]\n")
    return 2


# ---- library ----------------------------------------------------------------

def cmd_library(P, args, out=sys.stdout):
    lib = library.load(HERE)
    a = args.action
    if a == "list":
        return library.cmd_list(lib, P.root, status=args.status, topic=args.topic, out=out)
    if a == "show":
        if not args.id:
            out.write("library show ID\n")
            return 2
        return library.cmd_show(lib, P.root, args.id, out=out)
    if a in ("approve", "reject"):
        if not args.id:
            out.write("library %s ID --by NAME\n" % a)
            return 2
        return library.cmd_decide(lib, P.root, args.id, "APPROVED" if a == "approve" else "REJECTED",
                                  args.by, args.note or "", out=out)
    if a == "check":
        only = args.id.split(",") if args.id else None
        return library.cmd_check(lib, P.root, go=args.go, only=only, delay=args.delay,
                                 robots_unreachable_ok=args.robots_unreachable_ok, cafile=args.cafile, out=out)
    out.write("library list|show|check|approve|reject\n")
    return 2


# ---- cli --------------------------------------------------------------------

def find_root(given):
    if given:
        return os.path.abspath(given)
    if os.environ.get("SENTINEL_ROOT"):
        return os.path.abspath(os.environ["SENTINEL_ROOT"])
    return os.path.abspath(os.path.join(HERE, "..", ".."))


def build_parser():
    p = argparse.ArgumentParser(prog="sentinel-cycle", description="the desk's daily research-and-integrity cycle")
    p.add_argument("--root", help=argparse.SUPPRESS)
    sub = p.add_subparsers(dest="cmd")

    def common(sp):
        sp.add_argument("--go", action="store_true", help="allow the network steps")
        sp.add_argument("--all", action="store_true", help="ignore cadence")
        sp.add_argument("--only", help="comma-separated step ids")
        sp.add_argument("--skip", help="comma-separated step ids")
        sp.add_argument("--today", help=argparse.SUPPRESS)

    r = sub.add_parser("run")
    common(r)
    r.add_argument("--scheduled", action="store_true", help=argparse.SUPPRESS)
    common(sub.add_parser("plan"))
    d = sub.add_parser("digest")
    d.add_argument("run", nargs="?")
    d.add_argument("--path", action="store_true")
    v = sub.add_parser("verify")
    v.add_argument("record", nargs="?")
    v.add_argument("--deep", action="store_true")
    s = sub.add_parser("status")
    s.add_argument("-n", type=int, default=8)
    sub.add_parser("doctor")
    k = sub.add_parser("skills")
    k.add_argument("word", nargs="?")
    sc = sub.add_parser("schedule")
    sc.add_argument("action", nargs="?", default="status")
    sc.add_argument("hour", nargs="?")
    lb = sub.add_parser("library")
    lb.add_argument("action", nargs="?", default="list")
    lb.add_argument("id", nargs="?")
    lb.add_argument("--by")
    lb.add_argument("--note")
    lb.add_argument("--status")
    lb.add_argument("--topic")
    lb.add_argument("--go", action="store_true")
    lb.add_argument("--delay", type=float, default=2.0)
    lb.add_argument("--robots-unreachable-ok", action="store_true")
    lb.add_argument("--cafile")
    sub.add_parser("selftest")
    sub.add_parser("version")
    return p


def main(argv):
    p = build_parser()
    args = p.parse_args(argv)
    if not args.cmd:
        sys.stdout.write(__doc__)
        return 0
    if args.cmd == "version":
        print(VERSION)
        return 0
    if args.cmd == "selftest":
        import selftest
        return selftest.main()
    P = Paths(find_root(args.root))
    table = {"run": cmd_run, "plan": cmd_plan, "digest": cmd_digest, "verify": cmd_verify, "status": cmd_status,
             "doctor": cmd_doctor, "skills": cmd_skills, "schedule": cmd_schedule, "library": cmd_library}
    return table[args.cmd](P, args)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except Exception:
            pass
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(130)
