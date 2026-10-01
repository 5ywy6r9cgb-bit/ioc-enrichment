"""scrub.py - keep secrets and never-print strings out of every file the cycle writes.

Every byte a step prints passes through Scrubber before it reaches disk.
Nothing unscrubbed is ever written, so a log can be pasted anywhere.

What it removes, in this order:
  1. the VALUE of every credential the desk knows about - environment
     variables whose names say KEY/TOKEN/SECRET/PASS/COOKIE/AUTH, the
     SENTINEL_*RPC*/*_URL endpoints (they often carry a key in the path),
     and the same names in modules/pra/.env, modules/connectors/.env, .env
  2. credential shapes: Authorization headers, api_key=..., user:pass@host
  3. every line of ~/.sentinel/ledger/forbidden.txt (your never-print list)
  4. identity: your home path -> ~, user@host prompts, the machine name
  5. terminal colour codes

Values are held in memory only and never printed, logged or returned.
Standard library only.
"""
import getpass
import os
import re
import socket

SECRET_NAME = re.compile(r"(KEY|TOKEN|SECRET|PASS|PASSWD|PASSWORD|COOKIE|AUTH|CREDENTIAL)", re.I)
URLISH_NAME = re.compile(r"^SENTINEL_.*(RPC|_URL$)", re.I)
ENV_FILES = ("modules/pra/.env", "modules/connectors/.env", ".env")
MIN_SECRET = 6

PATTERNS = [
    (re.compile(r"(?i)\b((?:proxy-)?authorization)\s*:\s*[^\r\n]+"), r"\1: [REDACTED]"),
    (re.compile(r"(?i)\b(x-api-key|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|"
                r"bearer[_-]?token|client[_-]?secret|password|passwd)\b(\s*[:=]\s*)(\"?)[^\s\"&,;]+"),
     r"\1\2\3[REDACTED]"),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{6,}"), "Bearer [REDACTED]"),
    (re.compile(r"(?i)([?&](?:api_key|apikey|key|token|access_token|auth)=)[^&\s\"'<>]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)\b(https?://)[^/\s:@]+:[^/\s@]+@"), r"\1[REDACTED]@"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
     "[REDACTED PRIVATE KEY]"),
]
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")


def parse_env_file(path):
    """KEY=VALUE lines -> dict. Comments, blanks and `export ` are handled."""
    out = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                if s.startswith("export "):
                    s = s[7:].strip()
                if "=" not in s:
                    continue
                k, v = s.split("=", 1)
                k, v = k.strip(), v.strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                out[k] = v
    except OSError:
        pass
    return out


def secret_values(root, environ=None):
    """value -> NAME for every credential-looking setting. Never printed."""
    environ = os.environ if environ is None else environ
    vals = {}

    def consider(name, value):
        if not value or len(value) < MIN_SECRET:
            return
        if SECRET_NAME.search(name) or URLISH_NAME.search(name):
            vals.setdefault(value, name)

    for k, v in environ.items():
        consider(k, v)
    for rel in ENV_FILES:
        for k, v in parse_env_file(os.path.join(root, rel)).items():
            consider(k, v)
    return vals


def forbidden_path(home=None):
    home = home or os.path.expanduser("~")
    return os.path.join(home, ".sentinel", "ledger", "forbidden.txt")


def never_print_items(home=None):
    items = []
    try:
        with open(forbidden_path(home), "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                s = line.strip()
                if len(s) >= 3 and not s.startswith("#"):
                    items.append(s)
    except OSError:
        pass
    return items


def identity(home=None):
    home = home or os.path.expanduser("~")
    try:
        user = getpass.getuser()
    except Exception:
        user = ""
    host = socket.gethostname() or ""
    short = host.split(".")[0]
    return home, user, host, short


class Scrubber(object):
    def __init__(self, root, environ=None, home=None, extra_never=None):
        self._secrets = sorted(secret_values(root, environ).items(), key=lambda kv: -len(kv[0]))
        never = never_print_items(home) + list(extra_never or [])
        never = sorted(set(never), key=lambda s: -len(s))
        self._never = [re.compile(re.escape(s), re.I) for s in never]
        home, user, host, short = identity(home)
        rules = []
        if home and len(home) > 1:
            rules.append((re.compile(re.escape(home.rstrip("/")) + r"(?=/|\b|$)"), "~"))
        if user and host:
            rules.append((re.compile(re.escape(user) + "@" + re.escape(short) + r"[\w.-]*"), "[user]@[host]"))
        for h in sorted({host, short}, key=len, reverse=True):
            if h and len(h) >= 6:
                rules.append((re.compile(r"(?<![\w-])" + re.escape(h) + r"(?![\w-])", re.I), "[host]"))
        self._identity = rules

    @property
    def counts(self):
        """How many values each layer knows about (numbers only, never values)."""
        return {"secrets": len(self._secrets), "never_print": len(self._never),
                "identity_rules": len(self._identity)}

    def __call__(self, text):
        if not text:
            return text
        text = ANSI.sub("", text)
        for value, name in self._secrets:
            if value in text:
                text = text.replace(value, "[REDACTED:%s]" % name)
        for rx, rep in PATTERNS:
            text = rx.sub(rep, text)
        for rx in self._never:
            text = rx.sub("[WITHHELD]", text)
        for rx, rep in self._identity:
            text = rx.sub(rep, text)
        return text
