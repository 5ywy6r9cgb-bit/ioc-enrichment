"""selftest.py - the cycle proves itself on a throwaway repo made of stub commands.

No network. Nothing outside a temporary directory is read or written: HOME is
pointed at the temporary directory for every child process. Run it with
`bin/sentinel-cycle selftest`.
"""
import datetime
import getpass
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cycle    # noqa: E402
import library  # noqa: E402
import scrub    # noqa: E402

SECRET = "sk_test_SECRET_9f8e7d6c5b4a"
NEVER = "Never Print Me 42"
HEAD = "4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c"

STUB_SENTINEL = r"""#!/bin/bash
echo "bin/sentinel $*" >> "$STUB_CALLS"
case "$1 $2" in
  "watch run") echo "watch: 3 saved searches due, 3 ran"; exit 0 ;;
  "watch status") echo "ratepayers   daily   last ran 2026-09-30"; echo "bot_economy  weekly  last ran 2026-09-28"; exit 0 ;;
  "connect test")
    echo "FEC_API_KEY present (26 chars)"
    echo "debug token=$STUB_S1"
    echo "raw $STUB_S1 end"
    echo "Authorization: Bearer abcdef123456"
    echo "home $HOME/sentinel/evidence"
    echo "prompt $STUB_USER@$STUB_HOST sentinel %"
    echo "machine $STUB_HOST"
    echo "never $STUB_NEVER"
    printf '\033[32mgreen\033[0m\n'
    exit 0 ;;
  "connect crosslink")
    if [ -n "$STUB_BIG" ]; then python3 -c "print('x' * 3000000)"; fi
    echo "CROSS-REFERENCE 10 capture(s), no network call"; exit 0 ;;
  "connect matrix") echo "wrote library/matrix.csv"; exit 0 ;;
  "connect sweep") echo "Sweep - $3 (stub)"; exit 0 ;;
  "pra foia") echo "2 records requests need you"; echo "RQ-37 follow-up due in 3 days"; exit 0 ;;
esac
echo "stub: $*"
exit 0
"""

STUB_LEDGER = r"""#!/bin/bash
echo "bin/sentinel-ledger $*" >> "$STUB_CALLS"
case "$1" in
  check)
    if [ -n "$STUB_LEDGER_FAIL" ]; then echo "numbers 315/316"; echo "FAIL F-OH-06 number not found at its locator"; exit 1; fi
    echo "numbers 316/316 verified"; exit 0 ;;
  chain)
    case "$2" in
      verify) if [ -n "$STUB_SLEEP" ]; then sleep "$STUB_SLEEP"; fi; echo "chain ok: 3 versions"; exit 0 ;;
      anchor) echo "anchor  $STUB_HEAD"; echo "$STUB_HEAD" >> evidence/ledger/anchors.txt; exit 0 ;;
    esac ;;
  seal) echo "seal ok"; exit 0 ;;
  verify-sources) echo "117 sources checked"; exit 0 ;;
  selftest) echo "55/55 passed"; exit 0 ;;
esac
echo "stub: $*"
exit 0
"""

STUB_OTHER = r"""#!/bin/bash
echo "$(basename "$0") $*" >> "$STUB_CALLS"
echo "ok"
exit 0
"""


class T(object):
    def __init__(self):
        self.n = 0
        self.fail = []

    def ok(self, cond, label):
        self.n += 1
        if not cond:
            self.fail.append(label)


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(path, mode)


def make_repo(base):
    root = os.path.join(base, "home", "sentinel")
    homed = os.path.join(base, "home")
    write(os.path.join(root, "bin", "sentinel"), STUB_SENTINEL, 0o755)
    write(os.path.join(root, "bin", "sentinel-ledger"), STUB_LEDGER, 0o755)
    for m in ("sentinel-coin", "sentinel-station"):
        write(os.path.join(root, "bin", m), STUB_OTHER, 0o755)
    write(os.path.join(root, "bin", "sentinel-cycle"),
          '#!/bin/bash\nexec "%s" "%s" --root "%s" "$@"\n' % (sys.executable, os.path.join(HERE, "cycle.py"), root), 0o755)
    write(os.path.join(root, "modules", "pra", ".env"), "FEC_API_KEY=%s\nPLAIN=value-not-secret\n" % SECRET, 0o600)
    for rel, text in (("evidence/ledger/current.json", '{"schema":"tsr.master/1"}\n'),
                      ("evidence/ledger/chain.jsonl", '{"v":1}\n'),
                      ("evidence/ledger/seals.jsonl", '{"s":1}\n'),
                      ("evidence/ledger/anchors.txt", "0" * 64 + "\n"),
                      ("site/manifest.json", '{"files":[]}\n'),
                      ("README.md", "fake repo\n")):
        write(os.path.join(root, rel), text)
    write(os.path.join(homed, ".sentinel", "keys", "ledger_seal.key"), "k" * 32, 0o600)
    write(os.path.join(homed, ".sentinel", "ledger", "forbidden.txt"), "# never print\n%s\n" % NEVER, 0o600)
    # the self-test plan never recurses into itself and never touches the network
    write(os.path.join(root, "evidence", "cycle", "plan.json"),
          json.dumps({"disable": ["library", "selftest-cycle"]}), 0o600)
    return root, homed


def env_for(homed, calls, **extra):
    env = dict(os.environ)
    env.update({"HOME": homed, "STUB_CALLS": calls, "STUB_S1": SECRET, "STUB_NEVER": NEVER, "STUB_HEAD": HEAD,
                "STUB_USER": getpass.getuser(), "STUB_HOST": socket.gethostname(),
                "SENTINEL_CYCLE_SELFTEST": "1"})
    for k in ("STUB_LEDGER_FAIL", "STUB_SLEEP", "STUB_BIG", "SENTINEL_ROOT"):
        env.pop(k, None)
    env.update(extra)
    return env


def cyc(root, homed, calls, *args, **extra):
    p = subprocess.run([sys.executable, os.path.join(HERE, "cycle.py"), "--root", root] + list(args),
                       env=env_for(homed, calls, **extra), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       universal_newlines=True, timeout=300)
    return p.returncode, p.stdout


def read_calls(calls):
    try:
        with open(calls) as fh:
            return fh.read().splitlines()
    except OSError:
        return []


def all_written(root):
    """Every file under evidence/ as one text blob (what the cycle wrote)."""
    blob = []
    for d, _dirs, files in os.walk(os.path.join(root, "evidence")):
        for f in files:
            with open(os.path.join(d, f), "rb") as fh:
                blob.append(fh.read().decode("utf-8", "replace"))
    return "\n".join(blob)


def snapshot_outside_evidence(root):
    snap = {}
    for d, dirs, files in os.walk(root):
        rel = os.path.relpath(d, root)
        if rel == "evidence" or rel.startswith("evidence" + os.sep):
            continue
        for f in files:
            p = os.path.join(d, f)
            snap[os.path.relpath(p, root)] = cycle.sha256_file(p)
    return snap


def unit_tests(t):
    # refusal
    for s in cycle.BUILTIN:
        t.ok(cycle.refusal(s["argv"]) is None, "built-in step %s passes its own refusal check" % s["id"])
    t.ok(cycle.refusal(["bin/sentinel", "watch", "run"]) is None, "watch run allowed")
    t.ok(cycle.refusal(["bin/sentinel-cycle", "run"]) is not None, "cycle cannot run itself")
    t.ok(cycle.refusal(["bin/sentinel-station", "build"]) is not None, "station build refused")
    t.ok(cycle.refusal(["bin/sentinel-station", "verify", "site"]) is None, "station verify allowed")
    t.ok(cycle.refusal(["bin/sentinel", "connect", "sweep", "x", "--go", "--new-only"]) is None, "--new-only is not 'new'")
    t.ok(cycle.refusal(["bin/sentinel", "pra", "mail", "send"]) is not None, "mail send refused")
    t.ok(cycle.refusal(["bin/sentinel-coin", "token", "verify", "K", "--by=X"]) is not None, "--by= refused")
    t.ok(cycle.refusal(["bin/sentinel-ledger", "seal", "sign"]) is not None, "seal sign refused")
    t.ok(cycle.refusal(["bin/sentinel-ledger", "install-data", "f"]) is not None, "install-data refused")
    t.ok(cycle.refusal(["bash", "-c", "true"]) is not None, "bash refused")
    t.ok(cycle.refusal(["bin/sentinel", "doc", "get", "u\nrm"]) is not None, "control characters refused")
    # cadence
    wed = datetime.date(2026, 9, 30)
    step = {"id": "w", "cadence": "weekly:sun"}
    st = {"last_ok": {}}
    t.ok(cycle.is_due(step, wed, st)[0], "weekly: never run is due")
    st = {"last_ok": {"w": "2026-09-27T12:00:00Z"}}
    t.ok(not cycle.is_due(step, wed, st)[0], "weekly: 3 days after a Sunday is not due")
    t.ok(cycle.is_due(step, datetime.date(2026, 10, 4), st)[0], "weekly: the next Sunday is due")
    t.ok(cycle.is_due(step, datetime.date(2026, 10, 6), {"last_ok": {"w": "2026-09-20T12:00:00Z"}})[0],
         "weekly: a missed Sunday catches up")
    m = {"id": "m", "cadence": "monthly:1"}
    t.ok(not cycle.is_due(m, wed, {"last_ok": {"m": "2026-09-01T12:00:00Z"}})[0], "monthly: mid-month not due")
    t.ok(cycle.is_due(m, datetime.date(2026, 10, 1), {"last_ok": {"m": "2026-09-01T12:00:00Z"}})[0], "monthly: day 1 due")
    t.ok(not cycle.is_due({"id": "x", "cadence": "manual"}, wed, {"last_ok": {}})[0], "manual never due")
    t.ok(cycle.valid_cadence("weekly:sun") and not cycle.valid_cadence("weekly:xyz") and not cycle.valid_cadence("monthly:31"),
         "cadence validation")
    # scrubber patterns
    sc = scrub.Scrubber("/nonexistent-root", environ={"MY_API_KEY": "zzSECRETzz99", "SENTINEL_EVM_RPC_ETH": "https://node.example/v3/abcdef99"},
                        home="/Users/example-home", extra_never=["Hidden Phrase"])
    out = sc("a zzSECRETzz99 b https://node.example/v3/abcdef99 c")
    t.ok("zzSECRETzz99" not in out and "abcdef99" not in out and "[REDACTED:MY_API_KEY]" in out, "env secrets redacted by value")
    t.ok("[REDACTED]" in sc("api_key=abc123def"), "api_key= redacted")
    t.ok("pw" not in sc("https://user:pw@host/x").replace("[REDACTED]", ""), "url credentials redacted")
    t.ok(sc("GET /x?apikey=XYZ123&page=2") == "GET /x?apikey=[REDACTED]&page=2", "query key redacted, rest kept")
    t.ok("abc.def" not in sc("Authorization: Bearer abc.def"), "authorization header redacted")
    t.ok("MIIB" not in sc("-----BEGIN PRIVATE KEY-----\nMIIBxyz\n-----END PRIVATE KEY-----"), "private key block redacted")
    t.ok(sc("key present, sent in Authorization header only") == "key present, sent in Authorization header only",
         "plain prose about keys is left alone")
    t.ok(sc("\x1b[32mgreen\x1b[0m") == "green", "terminal colours stripped")
    t.ok(sc("see /Users/example-home/sentinel/x") == "see ~/sentinel/x", "home path becomes ~")
    t.ok(sc("say Hidden Phrase now") == "say [WITHHELD] now", "never-print list honoured")
    # schedule helpers
    t.ok(cycle.valid_hour("#")[1] and "zsh" in cycle.valid_hour("#")[1], "hour '#' explains the zsh trap")
    t.ok(cycle.valid_hour("24")[1] is not None and cycle.valid_hour("7")[0] == 7, "hour range")
    t.ok(cycle.xml_escape('a&b<c>"') == "a&amp;b&lt;c&gt;&quot;", "xml escape")


def library_tests(t, base):
    root = os.path.join(base, "lib-root")
    os.makedirs(root)
    lib = library.load(HERE)
    t.ok(len(lib["sources"]) >= 20, "library loads")
    for s in lib["sources"]:
        t.ok(s["status"] in ("ACTIVE", "PROPOSED") and s.get("name") and s.get("publisher"), "library row %s complete" % s["id"])
        if s["status"] == "PROPOSED":
            t.ok(s.get("outside") is True and s.get("verified", {}).get("on"), "proposed %s says where it came from" % s["id"])
        if s.get("probe"):
            t.ok(s["probe"].startswith("https://"), "probe %s is https" % s["id"])
    buf = io.StringIO()
    t.ok(library.cmd_show(lib, root, "SRC-OFAC-SLS", out=buf) == 0 and "first use" in buf.getvalue(), "show a proposed source")
    t.ok(library.cmd_show(lib, root, "SRC-NOPE", out=io.StringIO()) == 2, "unknown source refused")
    t.ok(library.cmd_decide(lib, root, "SRC-OFAC-SLS", "APPROVED", "", out=io.StringIO()) == 2, "approve needs --by")
    t.ok(library.cmd_decide(lib, root, "SRC-OFAC-SLS", "APPROVED", "tester", out=io.StringIO()) == 0, "approve records")
    t.ok(library.cmd_decide(lib, root, "SRC-FEC", "APPROVED", "tester", out=io.StringIO()) == 0 and
         len(library.read_jsonl(library.decisions_path(root))) == 1, "approving an active connector records nothing")
    eff = dict((r[0]["id"], r[1]) for r in library.effective(lib, root))
    t.ok(eff["SRC-OFAC-SLS"] == "APPROVED", "effective status follows the decision")
    library.cmd_decide(lib, root, "SRC-OFAC-SLS", "REJECTED", "tester", note="not now", out=io.StringIO())
    eff = dict((r[0]["id"], r[1]) for r in library.effective(lib, root))
    t.ok(eff["SRC-OFAC-SLS"] == "REJECTED", "the last decision wins")
    t.ok(library.cmd_list(lib, root, status="REJECTED", out=io.StringIO()) == 0, "list by status")
    # check: dry run makes no calls
    calls = []

    def fake(url, cafile):
        calls.append(url)
        if url.endswith("/robots.txt"):
            host = url.split("/")[2]
            if "disallow" in host:
                return 200, url, b"User-agent: *\nDisallow: /\n", "text/plain", None
            if "down" in host:
                return 503, url, b"", "", None
            return 403, url, b"", "", None
        if "gone" in url:
            return 404, url, b"", "", None
        if "blocked" in url:
            return 403, url, b"", "", None
        return 200, url, ("page %d" % len(calls)).encode(), "text/html", None

    mini = {"as_of": "x", "sources": [
        {"id": "A", "status": "PROPOSED", "name": "a", "publisher": "p", "probe": "https://ok.example/a"},
        {"id": "B", "status": "PROPOSED", "name": "b", "publisher": "p", "probe": "https://disallow.example/b"},
        {"id": "C", "status": "PROPOSED", "name": "c", "publisher": "p", "probe": "https://down.example/c"},
        {"id": "D", "status": "PROPOSED", "name": "d", "publisher": "p", "probe": "https://ok.example/gone"},
        {"id": "E", "status": "PROPOSED", "name": "e", "publisher": "p", "probe": "https://ok.example/blocked"},
        {"id": "F", "status": "ACTIVE", "name": "f", "publisher": "p", "probe": None}]}
    r2 = os.path.join(base, "lib-root-2")
    os.makedirs(r2)
    buf = io.StringIO()
    t.ok(library.cmd_check(mini, r2, go=False, fetch=fake, out=buf) == 0 and not calls and "GET https://ok.example/a" in buf.getvalue(),
         "library check without --go makes no calls")
    rc = library.cmd_check(mini, r2, go=True, fetch=fake, out=io.StringIO(), sleep=lambda s: None)
    rows = dict((r["id"], r) for r in library.read_jsonl(library.checks_path(r2)))
    t.ok(rows["A"]["status"] == "OK" and rows["A"]["sha256"], "OK page hashed")
    t.ok(rows["B"]["status"] == "ROBOTS", "robots Disallow honoured")
    t.ok(rows["C"]["status"] == "ROBOTS_UNREACHABLE", "robots 5xx fails closed")
    t.ok(rows["D"]["status"] == "GONE", "404 is GONE")
    t.ok(rows["E"]["status"] == "BLOCKED", "403 is BLOCKED, not failed")
    t.ok("F" not in rows, "sources without a probe are not called")
    t.ok(rc == 1, "GONE or unreachable makes the check exit 1")
    library.cmd_check(mini, r2, go=True, only=["A"], fetch=fake, out=io.StringIO(), sleep=lambda s: None)
    last = library.read_jsonl(library.checks_path(r2))[-1]
    t.ok(last["id"] == "A" and last["changed"] is True, "a changed page is noticed")
    library.cmd_check(mini, r2, go=True, only=["C"], robots_unreachable_ok=True, fetch=fake, out=io.StringIO(),
                      sleep=lambda s: None)
    t.ok(library.read_jsonl(library.checks_path(r2))[-1]["status"] == "OK", "--robots-unreachable-ok lets it through")
    flaky = {"n": 0}

    def fake2(url, cafile):
        if url.endswith("/robots.txt"):
            return 404, url, b"", "", None
        flaky["n"] += 1
        if flaky["n"] == 1:
            return None, url, b"", "", "RemoteDisconnected: closed"
        return 200, url, b"ok", "text/plain", None

    r3 = os.path.join(base, "lib-root-3")
    os.makedirs(r3)
    one = {"as_of": "x", "sources": [{"id": "G", "status": "PROPOSED", "name": "g", "publisher": "p",
                                      "probe": "https://flaky.example/g"}]}
    library.cmd_check(one, r3, go=True, fetch=fake2, out=io.StringIO(), sleep=lambda s: None)
    row = library.read_jsonl(library.checks_path(r3))[-1]
    t.ok(row["status"] == "OK" and row.get("retried") and flaky["n"] == 2, "a dropped connection is retried exactly once")


def integration_tests(t, base):
    root, homed = make_repo(base)
    calls = os.path.join(base, "calls.log")
    before = snapshot_outside_evidence(root)

    rc, out = cyc(root, homed, calls, "plan")
    t.ok(rc == 0 and "needs --go" in out and "ledger-check" in out, "plan shows network steps needing --go")

    rc, out = cyc(root, homed, calls, "run")
    c = read_calls(calls)
    t.ok(rc == 0, "offline run exits 0 (%s)" % out[-300:].replace("\n", " | "))
    t.ok("bin/sentinel-ledger check" in c and "bin/sentinel-ledger chain anchor" in c, "offline run did the integrity steps")
    t.ok("bin/sentinel watch run" not in c and "bin/sentinel connect test" not in c and
         not any("verify-sources" in x for x in c), "offline run made no network calls")
    t.ok("bin/sentinel-ledger seal verify" in c, "seal checked when the key exists")

    os.remove(calls)
    rc, out = cyc(root, homed, calls, "run", "--go")
    c = read_calls(calls)
    t.ok(rc == 0, "network run exits 0")
    order = ["bin/sentinel-ledger check", "bin/sentinel watch run", "bin/sentinel connect crosslink",
             "bin/sentinel-ledger verify-sources --go --delay 3", "bin/sentinel pra foia", "bin/sentinel-ledger chain anchor"]
    idx = [c.index(x) if x in c else -1 for x in order]
    t.ok(-1 not in idx and idx == sorted(idx), "steps run in the fixed order (%s)" % idx)

    blob = all_written(root)
    t.ok(SECRET not in blob, "the key value never reaches disk")
    t.ok("[REDACTED:FEC_API_KEY]" in blob, "the key is named, not shown")
    t.ok("abcdef123456" not in blob, "bearer token scrubbed")
    t.ok(homed not in blob and "~/sentinel/evidence" in blob, "home path scrubbed")
    t.ok(NEVER not in blob and "[WITHHELD]" in blob, "never-print list scrubbed")
    t.ok("\x1b[" not in blob, "no terminal escape codes on disk")
    host = socket.gethostname()
    if len(host) >= 6:
        t.ok(host not in blob and "[host]" in blob, "machine name scrubbed")
    t.ok("%s@%s" % (getpass.getuser(), host.split(".")[0]) not in blob, "user@host prompt scrubbed")

    rc, out = cyc(root, homed, calls, "digest")
    t.ok(rc == 0 and "Needs you" in out and HEAD in out and "Records desk" in out, "digest has status, needs, chain head, records")
    rc, out = cyc(root, homed, calls, "digest", "--path")
    t.ok(rc == 0 and out.strip().endswith("digest.md"), "digest --path")

    # same day again: weekly steps are not repeated
    rc, out = cyc(root, homed, calls, "run", "--go")
    t.ok("already ran today" in out, "weekly steps do not repeat on the same day")

    rc, out = cyc(root, homed, calls, "verify")
    t.ok(rc == 0 and "INTACT" in out and "3 record(s)" in out, "record chain of 3 verifies (%s)" % out[-200:].replace("\n", " | "))

    # tamper with an old run's digest: only --deep sees it; the chain itself stays intact
    runs = sorted(os.listdir(os.path.join(root, "evidence", "cycle", "runs")))
    old = os.path.join(root, "evidence", "cycle", "runs", runs[0], "digest.md")
    with open(old) as fh:
        keep = fh.read()
    with open(old, "a") as fh:
        fh.write("tampered\n")
    rc, out = cyc(root, homed, calls, "verify", "--deep")
    t.ok(rc == 1 and "CHANGED" in out, "deep verify catches an altered old digest")
    with open(old, "w") as fh:
        fh.write(keep)
    # tamper with an old record: the chain breaks
    recs = sorted(n for n in os.listdir(os.path.join(root, "evidence", "ledger")) if n.startswith("cycle-"))
    oldrec = os.path.join(root, "evidence", "ledger", recs[0])
    with open(oldrec) as fh:
        keep = fh.read()
    with open(oldrec, "a") as fh:
        fh.write("0" * 64 + "  forged\n")
    rc, out = cyc(root, homed, calls, "verify")
    t.ok(rc == 1 and "BROKEN" in out, "an altered old record breaks the chain")
    with open(oldrec, "w") as fh:
        fh.write(keep)
    rc, out = cyc(root, homed, calls, "verify", "--deep")
    t.ok(rc == 0 and "INTACT" in out, "restored chain verifies deep")
    # append-only growth and a rebuilt ledger are expected, not failures
    with open(os.path.join(root, "evidence", "ledger", "anchors.txt"), "a") as fh:
        fh.write("1" * 64 + "\n")
    write(os.path.join(root, "evidence", "ledger", "current.json"), '{"schema":"tsr.master/1","v":2}\n')
    rc, out = cyc(root, homed, calls, "verify")
    t.ok(rc == 0 and "grew" in out and "rebuilt" in out, "append-only growth and a rebuilt ledger are reported, not failed")
    # an append-only file rewritten in the middle is caught
    write(os.path.join(root, "evidence", "ledger", "anchors.txt"), "f" * 64 + "\n" + "1" * 64 + "\n" + "2" * 64 + "\n")
    rc, out = cyc(root, homed, calls, "verify")
    t.ok(rc == 1 and "CHANGED" in out and "anchors.txt" in out, "rewriting history in an append-only file is caught")
    write(os.path.join(root, "evidence", "ledger", "anchors.txt"), "0" * 64 + "\n")

    # a fresh chain after the rewrite so later checks start clean
    rc, out = cyc(root, homed, calls, "run")

    # failure path
    rc, out = cyc(root, homed, calls, "run", "--only", "ledger-check", STUB_LEDGER_FAIL="1")
    t.ok(rc == 1 and "FAIL" in out, "a failing step makes the run exit 1")
    rc, out = cyc(root, homed, calls, "digest")
    t.ok("F-OH-06" in out and "failed (exit 1)" in out, "the digest shows the failing lines")

    # timeout
    write(os.path.join(root, "evidence", "cycle", "plan.json"),
          json.dumps({"disable": ["library", "selftest-cycle"], "timeout": {"chain-verify": 1}}))
    rc, out = cyc(root, homed, calls, "run", "--only", "chain-verify", STUB_SLEEP="6")
    t.ok(rc == 1 and "TIMEOUT" in out, "a hung step is stopped at its timeout")

    # refused and extra steps
    plan = {"disable": ["library", "selftest-cycle"], "extra": [
        {"id": "mail-out", "argv": ["bin/sentinel", "pra", "mail", "send"], "network": True},
        {"id": "curl-it", "argv": ["curl", "https://example.com"]},
        {"id": "publish-site", "argv": ["bin/sentinel-station", "build", "--approve", "X", "--sign"], "network": False},
        {"id": "verify-token", "argv": ["bin/sentinel-coin", "token", "verify", "K", "--by", "X"], "network": False},
        {"id": "sweep-ok", "argv": ["bin/sentinel", "connect", "sweep", "ratepayers", "--go", "--only", "courtlistener",
                                    "--new-only"], "network": True, "cadence": "daily"},
        {"id": "Bad Id!", "argv": ["bin/sentinel", "dash"]}]}
    write(os.path.join(root, "evidence", "cycle", "plan.json"), json.dumps(plan))
    os.remove(calls)
    rc, out = cyc(root, homed, calls, "run", "--go")
    c = read_calls(calls)
    t.ok(rc == 1 and out.count("REFUSED") >= 4, "human acts in plan.json are refused")
    t.ok(not any("mail send" in x or "build --approve" in x or "token verify" in x or x.startswith("curl") for x in c),
         "refused commands never ran")
    t.ok(any("connect sweep ratepayers" in x for x in c), "a read-only extra step runs")
    t.ok("malformed" in out, "a malformed extra id is reported")
    rc, out = cyc(root, homed, calls, "digest")
    t.ok("refused" in out and "(yours)" in out, "the digest names refused and extra steps")
    write(os.path.join(root, "evidence", "cycle", "plan.json"), "{not json")
    rc, out = cyc(root, homed, calls, "plan")
    t.ok(rc == 0 and "not valid JSON" in out, "a broken plan.json falls back to the built-in plan")
    write(os.path.join(root, "evidence", "cycle", "plan.json"), json.dumps({"disable": ["library", "selftest-cycle"]}))

    # lock
    lock = os.path.join(root, "evidence", "cycle", ".lock")
    write(lock, json.dumps({"pid": os.getpid(), "started": cycle.iso(cycle.utcnow())}))
    rc, out = cyc(root, homed, calls, "run")
    t.ok(rc == 3 and "another cycle is running" in out, "a live lock stops a second run")
    write(lock, json.dumps({"pid": 999999, "started": cycle.iso(cycle.utcnow())}))
    rc, out = cyc(root, homed, calls, "run", "--only", "ledger-check")
    t.ok(rc == 0 and "stale lock" in out and not os.path.exists(lock), "a dead lock is cleared and released")

    # watch job present: the cycle leaves watch run to it
    write(os.path.join(homed, "Library", "LaunchAgents", "com.sentinel.watch.plist"),
          "<plist><dict><key>Hour</key>\n<integer>8</integer></dict></plist>")
    os.remove(calls)
    rc, out = cyc(root, homed, calls, "run", "--go")
    c = read_calls(calls)
    t.ok("the watch job runs it at 08:00" in out and "bin/sentinel watch run" not in c, "no double watch run")
    rc, out = cyc(root, homed, calls, "run", "--go", "--only", "watch")
    t.ok("bin/sentinel watch run" in read_calls(calls), "--only watch still runs it")
    rc, out = cyc(root, homed, calls, "schedule", "show")
    t.ok(rc == 0 and "<integer>10</integer>" in out and "<integer>15</integer>" in out and "--scheduled" in out,
         "schedule defaults to two hours after the watch job")
    rc, out = cyc(root, homed, calls, "schedule", "show", "#")
    t.ok(rc == 2 and "zsh" in out, "schedule refuses '#' and explains")
    rc, out = cyc(root, homed, calls, "schedule", "show", "7")
    t.ok("<integer>7</integer>" in out, "schedule honours an hour")
    P = cycle.Paths(os.path.join(base, "a&b"))
    rendered = cycle.render_plist(P, 9, path_env="/usr/bin")
    t.ok("a&amp;b" in rendered and "__" not in rendered.replace("__pycache__", ""), "plist escapes the path and fills every slot")
    t.ok("<string>/usr/bin/env</string>" in rendered and "<string>python3</string>" in rendered, "plist finds python3 at run time")
    import plistlib
    try:
        pl = plistlib.loads(cycle.render_plist(cycle.Paths(root), 9).encode("utf-8"))
        parsed = (pl["Label"] == cycle.LABEL and pl["StartCalendarInterval"] == {"Hour": 9, "Minute": 15}
                  and pl["ProgramArguments"][-3:] == ["run", "--go", "--scheduled"] and pl["RunAtLoad"] is False)
    except Exception:
        parsed = False
    t.ok(parsed, "the plist parses as a real property list with the right schedule and arguments")

    # not installed, big output
    os.remove(os.path.join(root, "bin", "sentinel-coin"))
    rc, out = cyc(root, homed, calls, "run", "--all", "--only", "selftest-coin")
    t.ok("NOT_INSTALLED" in out, "a missing module is reported, not failed")
    rc, out = cyc(root, homed, calls, "run", "--only", "crosslink", STUB_BIG="1")
    runs = sorted(os.listdir(os.path.join(root, "evidence", "cycle", "runs")))
    lp = [os.path.join(root, "evidence", "cycle", "runs", runs[-1], f)
          for f in os.listdir(os.path.join(root, "evidence", "cycle", "runs", runs[-1])) if f.endswith("crosslink.log")]
    t.ok(lp and os.path.getsize(lp[0]) < cycle.MAX_LOG + 4096, "step logs are capped")

    # doctor and status and skills
    rc, out = cyc(root, homed, calls, "doctor")
    t.ok("publisher key" in out and "never-print list" in out, "doctor runs and reports")
    rc, out = cyc(root, homed, calls, "status")
    t.ok(rc == 0 and "record" in out, "status lists runs and records")
    rc, out = cyc(root, homed, calls, "skills", "library")
    t.ok(rc == 0 and "library approve" in out, "skills filters the card")
    rc, out = cyc(root, homed, calls, "library", "list")
    t.ok(rc == 0 and "SRC-CONGRESS" in out, "library list from the CLI")

    t.ok(snapshot_outside_evidence(root) == dict((k, v) for k, v in before.items() if k != "bin/sentinel-coin"),
         "the cycle wrote nothing outside evidence/")


def main():
    if os.environ.get("SENTINEL_CYCLE_SELFTEST_ACTIVE"):
        print("cycle selftest: nested run skipped")
        return 0
    os.environ["SENTINEL_CYCLE_SELFTEST_ACTIVE"] = "1"
    t = T()
    base = tempfile.mkdtemp(prefix="cycle-selftest-")
    saved_home = os.environ.get("HOME")
    try:
        os.environ["HOME"] = os.path.join(base, "home")
        os.makedirs(os.environ["HOME"], exist_ok=True)
        unit_tests(t)
        library_tests(t, base)
        integration_tests(t, base)
    except Exception as e:  # a crash is a failure, with its reason
        import traceback
        t.fail.append("crashed: %s\n%s" % (e, traceback.format_exc()))
    finally:
        if saved_home is not None:
            os.environ["HOME"] = saved_home
        os.environ.pop("SENTINEL_CYCLE_SELFTEST_ACTIVE", None)
        shutil.rmtree(base, ignore_errors=True)
    passed = t.n - len([f for f in t.fail if not f.startswith("crashed")])
    total = t.n
    if t.fail:
        print("cycle selftest: %d/%d passed" % (passed, total))
        for f in t.fail:
            print("  FAIL " + f)
        return 1
    print("cycle selftest: %d/%d passed" % (total, total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
