"""
guard.py -- the surveillance-input boundary.

WHAT THIS REFUSES, AND WHY IT IS A REFUSAL RATHER THAN A WARNING
    A public-records desk and a surveillance database are the same shape. Both
    hold documents about people, indexed and searchable. The difference is
    entirely in what goes in: one holds records a government produced in the
    course of public business, the other holds observations about private
    individuals who did not consent to being observed.

    Nothing about the storage layer enforces that difference. This file does.

    The refused categories are the load-bearing ones:

      ADVERTISING AND DEVICE IDENTIFIERS  (advertisingId, idfa, gaid, maid)
          The raw material of commercial surveillance. An advertising ID ties
          every observation of a device back to one person, permanently, and it
          exists for no other purpose.

      LOCATION TELEMETRY  (getLocationsFromAID, subject_location, pings)
          Where a specific person was, over time. This is the single most
          dangerous category to hold: it is the one that gets people hurt, it
          is almost never a public record, and holding it makes the desk a
          target rather than an archive.

      HASHED CONTACT LISTS  (hashedEmails, hashedPhones, sha256_email)
          Hashing an email does not anonymise it. The space of real email
          addresses is small enough to enumerate, so a hashed contact list is a
          contact list with an extra step. Data brokers use the hashing to make
          the trade sound acceptable.

      BIOMETRIC AND PERSISTENT-TRACKING KEYS  (faceprint, device_fingerprint)
          Identifiers a person cannot change and did not choose.

    A public record ABOUT surveillance -- a Flock contract, a purchase order,
    a policy memo, a council presentation -- is exactly what this desk is for
    and passes without objection. The boundary is on the telemetry, not on the
    subject matter. Refusing to hold the tracking data while investigating the
    tracking programme is the entire point.

WHY THE STRUCTURE IS WALKED, NOT JUST THE TOP LEVEL
    The leaked API client that prompted this had its identifiers three levels
    down inside a response envelope. A check that only looks at top-level keys
    is a check that passes the exact payload it was written for.

WHY IT RAISES INSTEAD OF STRIPPING
    Stripping produces a record that no longer matches what was handed over,
    with nobody informed. Refusing produces a decision the operator has to
    make consciously. If you genuinely need to describe surveillance data in a
    case, describe it in prose -- the boundary is on ingesting the machinery,
    not on writing about it.

IT ALSO REFUSES INPUT THAT WOULD CORRUPT THE DESK
    ANSI escapes, NUL bytes, bidi overrides, and credential-shaped strings.
    Different reason, same door: an ANSI sequence in a case title rewrites what
    your own terminal prints back to you, and a pasted API key in an
    append-only audit chain cannot be removed once recorded.
"""

from __future__ import annotations

import re
import unicodedata

MAX_LEN = 20_000
MAX_DEPTH = 40


class RefusedInput(ValueError):
    """Input the desk will not store.

    Named for what the operator needs to read. cli.py catches this to print
    the refusal cleanly.
    """


# Kept as an alias so `except GuardError` also works.
GuardError = RefusedInput


def _norm(key: str) -> str:
    """Fold a key for matching: lowercase, strip separators.

    'advertising_id', 'advertisingId', and 'ADVERTISING-ID' are one key wearing
    three coats, and a broker's JSON will use whichever one you did not check.
    """
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


# Exact keys (normalised) that are refused outright.
BANNED_KEYS = {
    # advertising / device identity
    "advertisingid", "adid", "idfa", "idfv", "gaid", "maid", "aaid",
    "deviceid", "devicefingerprint", "fingerprintid", "hardwareid",
    "androidid", "imei", "imsi", "iccid", "meid",
    # location telemetry
    "getlocationsfromaid", "subjectlocation", "locationhistory",
    "lastknownlocation", "geopings", "pings", "devicelocations",
    "gpspoints", "dwellpoints", "homelocation", "worklocation",
    # hashed contact lists
    "hashedemails", "hashedemail", "hashedphones", "hashedphone",
    "sha256email", "md5email", "emailhash", "phonehash",
    # biometrics
    "faceprint", "facevector", "faceembedding", "voiceprint",
    "irisscan", "fingerprintimage", "gaitsignature",
}

# Substrings that are refused wherever they appear in a key. Kept deliberately
# short: each entry can cause a false refusal, and a boundary that fires on
# ordinary records is one that gets switched off.
BANNED_FRAGMENTS = [
    "advertisingid", "getlocationsfrom", "subjectlocation",
    "hashedemail", "hashedphone", "faceprint", "voiceprint",
    "devicefingerprint", "locationhistory",
]

_ALLOWED_CONTROL = {"\t", "\n", "\r"}

_BIDI = {"‪", "‫", "‬", "‭", "‮",
         "⁦", "⁧", "⁨", "⁩"}

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

_SLUG_OK = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

_CREDENTIALS = [
    (re.compile(r"\b(sk|pk)-[A-Za-z0-9]{32,}\b"), "an API key"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"), "a Google API key"),
    (re.compile(r"\bghp_[A-Za-z0-9]{36}\b"), "a GitHub token"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "an AWS access key id"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "a private key"),
]


def _refuse_key(key: str, path: str) -> None:
    k = _norm(key)
    if k in BANNED_KEYS:
        raise RefusedInput(
            f"refused: {path or key} is surveillance telemetry, not a public "
            f"record. This desk does not hold advertising identifiers, device "
            f"location histories, hashed contact lists, or biometrics — "
            f"including while investigating the programmes that produce them. "
            f"Describe it in prose if the case needs it.")
    for frag in BANNED_FRAGMENTS:
        if frag in k:
            raise RefusedInput(
                f"refused: {path or key} matches the surveillance boundary "
                f"({frag!r}). See guard.py for what this refuses and why.")


def check_text(value: str, field: str = "text") -> None:
    """Raise RefusedInput if this string must not be stored."""
    if value is None:
        return
    if not isinstance(value, str):
        value = str(value)

    if len(value) > MAX_LEN:
        raise RefusedInput(
            f"{field} is {len(value):,} characters; the cap is {MAX_LEN:,}. "
            f"That is a document, not a note — ingest it so it gets a hash "
            f"and a shelf.")

    if "\x00" in value:
        raise RefusedInput(f"{field} contains a NUL byte, which truncates on export")

    if _ANSI.search(value):
        raise RefusedInput(
            f"{field} contains an ANSI escape sequence. Stored, it would "
            f"rewrite what your own terminal prints back to you.")

    bad = sorted(_BIDI & set(value))
    if bad:
        raise RefusedInput(
            f"{field} contains a bidirectional override "
            f"({', '.join('U+%04X' % ord(c) for c in bad)}). It makes the "
            f"displayed text differ from the stored text.")

    ctrl = sorted({c for c in value
                   if unicodedata.category(c) == "Cc" and c not in _ALLOWED_CONTROL})
    if ctrl:
        raise RefusedInput(
            f"{field} contains control character(s) "
            f"{', '.join('U+%04X' % ord(c) for c in ctrl)}")

    for pattern, what in _CREDENTIALS:
        if pattern.search(value):
            raise RefusedInput(
                f"{field} looks like it contains {what}. The audit chain is "
                f"append-only — once recorded you cannot remove it, and "
                f"rotating the credential becomes the only remedy.")


def check_slug(value: str, field: str = "slug") -> None:
    if value is None:
        return
    if not _SLUG_OK.match(str(value)):
        raise RefusedInput(
            f"{field} {value!r} is not a slug. Lowercase letters, digits, and "
            f"hyphens; must start with a letter or digit; 64 characters max. "
            f"Slugs become filenames, so 'a/../b' is refused here rather than "
            f"discovered later.")


def assert_clean(payload, what: str = "input", _path: str = "", _depth: int = 0) -> None:
    """Walk a structure and refuse anything the desk must not hold.

    Accepts a dict, list, or scalar. Recurses, because the payload that
    prompted this carried its identifiers three levels down and a top-level
    check would have passed it.
    """
    if _depth > MAX_DEPTH:
        raise RefusedInput(
            f"{what}: structure nested deeper than {MAX_DEPTH} levels. "
            f"Refusing rather than recursing — a structure that deep is not a "
            f"record, and following it is how a walker becomes a denial of "
            f"service against itself.")

    if isinstance(payload, dict):
        for key, value in payload.items():
            path = f"{_path}.{key}" if _path else str(key)
            _refuse_key(key, path)
            try:
                if _norm(key) in ("slug", "ref"):
                    check_slug(str(value), path)
                if isinstance(value, str):
                    check_text(value, path)
            except RefusedInput as e:
                raise RefusedInput(f"{what}: {e}") from None
            assert_clean(value, what, path, _depth + 1)

    elif isinstance(payload, (list, tuple)):
        for i, item in enumerate(payload):
            assert_clean(item, what, f"{_path}[{i}]", _depth + 1)

    elif isinstance(payload, str) and _depth == 0:
        # A bare string handed straight in still gets the hygiene checks.
        try:
            check_text(payload, _path or "text")
        except RefusedInput as e:
            raise RefusedInput(f"{what}: {e}") from None
