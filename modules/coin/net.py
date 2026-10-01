# -*- coding: utf-8 -*-
"""Network access for the coin desk. This is the one place a request leaves the machine.

Rules enforced here, not left to callers:
  * TLS is always verified. Plain http:// is refused except for a node on this machine
    (localhost / 127.0.0.1 / ::1), which is how a local Bitcoin or EVM node is usually reached.
  * Credentials come from environment variables only. They are sent in the request and never
    returned to the caller: every URL, query and error string a caller can store has passed
    through redact() first. Request headers are never recorded anywhere.
  * One polite client: a user agent that says what it is, a minimum gap between requests to
    the same host, and a bounded retry on 429 / 5xx.
"""
import base64
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "SentinelCoin/1.0 (evidence retrieval; one request at a time)"
SENSITIVE_KEYS = {"key", "apikey", "api_key", "api-key", "token", "access_token", "auth", "secret",
                  "password", "pass", "sig", "signature", "x-api-key", "client_secret"}
SECRET_SUFFIXES = ("_KEY", "_TOKEN", "_SECRET", "_PASS", "_PASSWORD", "_AUTH", "_COOKIE")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}
_TOKENISH = re.compile(r"^[A-Za-z0-9_\-]{20,}$")


class NetError(Exception):
    """A request failed. The message is already redacted."""


def secret_values():
    """Every value that must never be written down: env vars that look like credentials, and the
    user/password part of any SENTINEL_* URL."""
    vals = set()
    for k, v in os.environ.items():
        if not v:
            continue
        ku = k.upper()
        if ku.endswith(SECRET_SUFFIXES) or ku in ("BITCOIN_API_KEY", "STABLECOIN_API_KEY"):
            if len(v) >= 4:
                vals.add(v)
        if ku.startswith("SENTINEL_") and "://" in v:
            p = urllib.parse.urlsplit(v)
            for part in (p.username, p.password):
                if part and len(part) >= 4:
                    vals.add(urllib.parse.unquote(part))
            for seg in p.path.split("/"):
                if _TOKENISH.match(seg):
                    vals.add(seg)
            for _, qv in urllib.parse.parse_qsl(p.query):
                if len(qv) >= 8:
                    vals.add(qv)
    return vals


def redact(text):
    """Remove every known secret value from a string (longest first)."""
    if text is None:
        return None
    s = str(text)
    for v in sorted(secret_values(), key=len, reverse=True):
        s = s.replace(v, "‹redacted›")
    return s


def is_public_identifier(seg):
    """Transaction ids, block hashes and addresses are evidence, not secrets: keep them readable.
    A Bitcoin address is recognised by its own checksum, so an API key cannot pass for one."""
    import primitives as P
    if re.fullmatch(r"[0-9a-fA-F]{64}", seg) or re.fullmatch(r"0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64}", seg) or seg.isdigit():
        return True
    low = seg.lower()
    for hrp in ("bc", "tb", "bcrt"):
        if low.startswith(hrp + "1"):
            try:
                P.segwit_decode(hrp, seg)
                return True
            except ValueError:
                pass
    try:
        return len(P.b58check_decode(seg)) == 21
    except ValueError:
        return False


def redact_url(url):
    """A URL that is safe to store: no userinfo, sensitive query values masked, token-like path
    segments masked, then every known secret value removed."""
    p = urllib.parse.urlsplit(url)
    host = p.hostname or ""
    if p.port:
        host = "{}:{}".format(host, p.port)
    path = "/".join("‹redacted›" if _TOKENISH.match(seg) and not is_public_identifier(seg) else seg
                    for seg in p.path.split("/"))
    q = urllib.parse.urlencode([(k, "‹redacted›" if k.lower() in SENSITIVE_KEYS else v)
                                for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)])
    return redact(urllib.parse.urlunsplit((p.scheme, host, path, q, "")))


def redact_obj(obj):
    """Deep-redact a JSON-like object (used for queries before they are stored)."""
    if isinstance(obj, dict):
        return {k: ("‹redacted›" if str(k).lower() in SENSITIVE_KEYS else redact_obj(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_obj(v) for v in obj]
    if isinstance(obj, str):
        return redact(obj)
    return obj


def _check_scheme(url, allow_http=False):
    p = urllib.parse.urlsplit(url)
    if p.scheme == "https":
        return
    if p.scheme == "http" and ((p.hostname or "") in LOCAL_HOSTS or allow_http):
        return
    raise NetError("refused: {} is not https (plain http is allowed only for a node on this machine)".format(redact_url(url)))


class Transport(object):
    """Interface: request(method, url, body=None, headers=None) -> (status, content_type, bytes)."""

    def request(self, method, url, body=None, headers=None):
        raise NotImplementedError


class HttpTransport(Transport):
    def __init__(self, min_interval=None, retries=3, timeout=30, cafile=None, allow_http=False):
        self.min_interval = float(os.environ.get("SENTINEL_COIN_MIN_INTERVAL", min_interval if min_interval is not None else 1.0))
        self.retries = retries
        self.timeout = timeout
        self.allow_http = allow_http
        cafile = cafile or os.environ.get("SENTINEL_CAFILE") or None
        self.ctx = ssl.create_default_context(cafile=cafile)
        self._last = {}

    def _pace(self, host):
        gap = time.time() - self._last.get(host, 0)
        if gap < self.min_interval:
            time.sleep(self.min_interval - gap)
        self._last[host] = time.time()

    def request(self, method, url, body=None, headers=None):
        _check_scheme(url, self.allow_http)
        p = urllib.parse.urlsplit(url)
        hdrs = {"User-Agent": UA, "Accept": "application/json, text/plain;q=0.9, */*;q=0.5"}
        if p.username or p.password:  # credentials in the URL become a header and leave the URL
            cred = "{}:{}".format(urllib.parse.unquote(p.username or ""), urllib.parse.unquote(p.password or ""))
            hdrs["Authorization"] = "Basic " + base64.b64encode(cred.encode()).decode()
            url = urllib.parse.urlunsplit((p.scheme, p.hostname + (":{}".format(p.port) if p.port else ""), p.path, p.query, p.fragment))
        hdrs.update(headers or {})
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        delay = 2.0
        for attempt in range(self.retries + 1):
            self._pace(p.hostname or "")
            req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout, context=self.ctx) as r:
                    return r.status, r.headers.get("Content-Type", ""), r.read()
            except urllib.error.HTTPError as e:
                raw = e.read() if hasattr(e, "read") else b""
                if e.code in (429, 500, 502, 503, 504) and attempt < self.retries:
                    ra = e.headers.get("Retry-After") if e.headers else None
                    time.sleep(float(ra) if ra and ra.isdigit() else delay)
                    delay *= 2
                    continue
                if e.code == 500 and raw[:1] in (b"{", b"["):
                    return e.code, e.headers.get("Content-Type", ""), raw  # JSON-RPC errors often ride on 500
                raise NetError("HTTP {} from {}".format(e.code, redact_url(url)))
            except (urllib.error.URLError, OSError) as e:
                if attempt < self.retries:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise NetError("could not reach {}: {}".format(redact_url(url), redact(getattr(e, "reason", e))))
        raise NetError("gave up on {}".format(redact_url(url)))


class FixtureTransport(Transport):
    """Offline transport for tests and air-gapped replays: answers from a dict
    {(method, url_or_rpc_method): (status, content_type, bytes)}. JSON-RPC calls are keyed by
    ("RPC", method, json.dumps(params, sort_keys=True))."""

    def __init__(self, table):
        self.table = table
        self.calls = []

    def request(self, method, url, body=None, headers=None):
        self.calls.append((method, url, headers or {}))
        if body is not None:
            b = body if isinstance(body, dict) else json.loads(body)
            key = ("RPC", b.get("method"), json.dumps(b.get("params"), sort_keys=True))
            if key in self.table:
                st, ct, raw = self.table[key]
                if not isinstance(raw, bytes):
                    raw = json.dumps({"jsonrpc": "2.0", "id": b.get("id"), "result": raw}).encode()
                return st, ct, raw
        key = (method, url)
        if key in self.table:
            return self.table[key]
        raise NetError("fixture has no answer for {} {}".format(method, redact_url(url)))


def auth_headers(source):
    """Headers carrying a credential, built from the environment at call time and never stored."""
    h = {}
    if source.key_env and source.key_header:
        v = os.environ.get(source.key_env)
        if not v:
            raise NetError("{} is not configured (set it in your shell or .env; it is never written to disk)".format(source.key_env))
        h[source.key_header] = (source.key_prefix or "") + v
    return h
