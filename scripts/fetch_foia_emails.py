#!/usr/bin/env python3
"""
fetch_foia_emails.py — reads a FOIA-related email folder via IMAP, matches
messages to request IDs (or agency, as a fallback), extracts attachments,
and writes SUGGESTED updates to a review file for you to approve in the
tracker dashboard.

It never writes directly to foia_requests.json and never marks anything
"accepted" on its own — that happens when you click Accept in
review_dashboard.html after reading each suggestion.

SETUP
-----
1. Use an app password, not your real password:
   - Gmail: myaccount.google.com/apppasswords (requires 2FA enabled)
   - Outlook/Office365: similar app-password setting
2. Set credentials as environment variables (never hardcode them):
     export FOIA_EMAIL="you@example.com"
     export FOIA_APP_PASSWORD="xxxx xxxx xxxx xxxx"
     export FOIA_IMAP_HOST="imap.gmail.com"   # or outlook.office365.com, etc.
3. Create a mail folder/label called "FOIA" (or change FOLDER below) and
   file/label the relevant agency emails into it as they arrive.

USAGE
-----
    python3 fetch_foia_emails.py

Outputs:
  - review_queue.json   — one entry per email, with suggestions to review
  - records/<REQUEST_ID>/<filename>  — any attachments found, saved for
    you to look at (saved regardless of whether a request ID was matched;
    unmatched ones go to records/_unsorted/)

─────────────────────────────────────────────────────────────────────────
2026-09-24 — FOUR DEFECTS FIXED. What they were, because the fix only makes
sense against the failure:

1. THE ATTACHMENT NAME WAS USED AS A PATH.
   `dest_dir / filename` with a filename taken from the email. The sender
   chooses that string. "../../.zshrc" wrote outside records/; an absolute
   name like "/Users/Mark/.ssh/authorized_keys" REPLACED dest_dir entirely,
   because pathlib discards the left side when the right side is absolute.
   Anyone who can email the FOIA folder could write a file anywhere this
   user can write. Now: the name is reduced to a bare basename, cleaned, and
   the final path is checked to be inside records/ before a byte is written.

2. NO SIZE LIMIT.
   One message could fill the disk. Now: a per-attachment and per-message
   ceiling. Anything over is NOT written, and the review entry says so and
   says why — a record the agency sent is never silently dropped.

3. EVERY RUN RE-SAVED EVERY ATTACHMENT.
   The script reads ALL messages in the folder each time, and the
   "don't overwrite" loop turned each re-run into report_1.pdf, report_2.pdf
   … Five runs, five copies of every record, none marked as duplicates.
   Now: attachments are identified by SHA-256. The same bytes are stored once
   and every later sighting points at the first copy.

4. SENDER-DOMAIN MATCHING READ THE DISPLAY NAME.
   `"columbus.gov" in sender.lower()` tested the whole From header, so
   `"columbus.gov" <anyone@anywhere.com>` matched Columbus Division of
   Police, and so did `someone@notcolumbus.gov`. Now: the actual address is
   parsed out, and its domain must equal the agency domain or be a subdomain
   of it.

And one that was quietly destructive: review_queue.json was rewritten from
scratch on every run, so anything the dashboard had marked accepted went back
to false. Now: entries are merged by message hash and a decision already made
is kept.
"""

import email
import email.utils
import hashlib
import imaplib
import json
import os
import re
import sys
import unicodedata
from email.header import decode_header
from pathlib import Path

FOLDER = "FOIA"  # change to match your mail folder/label name
REQUEST_ID_PATTERN = re.compile(r"\bRR-\d{4}-\d+\b")

# Domain-based fallback matching, used only when no request ID is found in
# the subject/body. Edit this to match your own tracked agencies.
AGENCY_MATCHES = {
    "City of Dublin": ["dublin.oh.us"],
    "PUCO": ["puco.ohio.gov"],
    "Columbus Division of Police": ["columbus.gov"],
}

# Keyword -> suggested status. SUGGESTIONS ONLY — never applied
# automatically. Boilerplate like "this is not a denial" will trip the
# "Denied" keyword; that's why you read the snippet before accepting.
STATUS_KEYWORDS = [
    ("Received", ["responsive records", "records attached", "please find attached"]),
    ("Denied", ["request is denied", "records are exempt", "unable to provide"]),
    ("Acknowledged", ["received your request", "confirming receipt", "request has been received"]),
    ("Partial", ["partial response", "additional records", "remaining records"]),
]

RECORDS_DIR = Path("records")
REVIEW_FILE = Path("review_queue.json")

# Generous for scanned records, small enough that one message cannot fill a
# laptop. Raise them if an agency legitimately sends larger productions —
# the review entry will tell you when one was held back.
MAX_ATTACHMENT_BYTES = int(os.environ.get("FOIA_MAX_ATTACHMENT_MB", "100")) * 1024 * 1024
MAX_MESSAGE_BYTES = int(os.environ.get("FOIA_MAX_MESSAGE_MB", "250")) * 1024 * 1024
MAX_NAME_LEN = 150

MANIFEST_NAME = "_manifest.json"


def decode_str(value):
    if not value:
        return ""
    parts = decode_header(value)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            try:
                out.append(text.decode(enc or "utf-8", errors="replace"))
            except LookupError:  # an encoding name Python does not know
                out.append(text.decode("utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def get_body_text(msg):
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and not part.get("Content-Disposition"):
                charset = part.get_content_charset() or "utf-8"
                try:
                    return part.get_payload(decode=True).decode(charset, errors="replace")
                except Exception:
                    continue
        return ""
    else:
        charset = msg.get_content_charset() or "utf-8"
        try:
            return msg.get_payload(decode=True).decode(charset, errors="replace")
        except Exception:
            return ""


def suggest_status(body_lower):
    for status, keywords in STATUS_KEYWORDS:
        for kw in keywords:
            if kw in body_lower:
                return status, kw
    return None, None


# ---------------------------------------------------------------- matching

def sender_domain(from_header):
    """The domain of the ADDRESS in a From header — never the display name.

    parseaddr('"columbus.gov" <x@evil.example>') returns ('columbus.gov',
    'x@evil.example'); only the second half says who sent it.
    """
    _, addr = email.utils.parseaddr(from_header or "")
    if "@" not in addr:
        return None
    domain = addr.rsplit("@", 1)[1].strip().lower().rstrip(".")
    return domain or None


def domain_matches(domain, agency_domain):
    """Exact, or a true subdomain. 'notcolumbus.gov' is not 'columbus.gov'."""
    agency_domain = agency_domain.lower().rstrip(".")
    return domain == agency_domain or domain.endswith("." + agency_domain)


def match_agency_by_domain(sender):
    domain = sender_domain(sender)
    if not domain:
        return None
    for agency, domains in AGENCY_MATCHES.items():
        if any(domain_matches(domain, d) for d in domains):
            return agency
    return None


# ---------------------------------------------------------------- filenames

_UNSAFE = re.compile(r"[\x00-\x1f\x7f/\\:*?\"<>|]")


def safe_filename(raw):
    """Reduce a sender-supplied attachment name to something that can only
    ever name a file inside the directory it is joined to.

    Takes the last path component under BOTH separators (a Windows mail
    client sends backslashes), removes control and reserved characters,
    refuses dot-only names, and caps the length while keeping the extension.
    Returns a non-empty string, always.
    """
    name = unicodedata.normalize("NFC", raw or "")
    name = re.split(r"[\\/]", name)[-1]
    name = _UNSAFE.sub("_", name).strip().strip(".")
    # A leading dot would make the file hidden in Finder. The operator should
    # be able to see every record an agency sent.
    name = name.lstrip(".")
    if not name or set(name) <= {".", "_", " "}:
        name = "attachment"
    if len(name) > MAX_NAME_LEN:
        stem, suffix = os.path.splitext(name)
        suffix = suffix[:16]
        name = stem[: MAX_NAME_LEN - len(suffix)] + suffix
    return name


def safe_folder_key(key):
    """Folder names come from our own config or a regex-matched id today.
    Clean them anyway: a future edit to AGENCY_MATCHES should not be able to
    reintroduce the traversal through the other half of the path."""
    return safe_filename(key).replace(" ", "_") or "_unsorted"


def inside(path, root):
    """True only if `path` resolves to somewhere under `root`."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------- manifest

def load_manifest(records_dir):
    p = records_dir / MANIFEST_NAME
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        # Refuse rather than start over: an empty manifest would re-save
        # every attachment, which is the duplication this file exists to stop.
        sys.exit(f"{p} is not valid JSON. It has not been modified. Fix or move it, then run again.")


def save_manifest(records_dir, manifest):
    records_dir.mkdir(parents=True, exist_ok=True)
    p = records_dir / MANIFEST_NAME
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    os.replace(tmp, p)


# ---------------------------------------------------------------- attachments

def save_attachments(msg, folder_key, records_dir=None, manifest=None):
    """Save attachments to records/<folder_key>/<safe name>.

    Returns a list of dicts. Every attachment in the message gets an entry,
    including ones that were NOT written — those carry `held_back` with the
    reason, so nothing an agency sent disappears without a trace.
    """
    records_dir = records_dir or RECORDS_DIR
    manifest = manifest if manifest is not None else {}
    dest_dir = records_dir / safe_folder_key(folder_key)
    saved = []
    message_total = 0

    for part in msg.walk():
        raw_name = part.get_filename()
        if not raw_name:
            continue
        original = decode_str(raw_name)
        payload = part.get_payload(decode=True)
        if payload is None:
            continue

        entry = {"filename": original, "size_bytes": len(payload)}
        name = safe_filename(original)
        if name != original:
            entry["renamed_to"] = name

        if len(payload) > MAX_ATTACHMENT_BYTES:
            entry["held_back"] = (f"larger than the {MAX_ATTACHMENT_BYTES // (1024*1024)} MB "
                                  f"per-attachment limit (FOIA_MAX_ATTACHMENT_MB) — not written. "
                                  f"Download it from the mail client directly.")
            saved.append(entry)
            continue
        if message_total + len(payload) > MAX_MESSAGE_BYTES:
            entry["held_back"] = (f"this message's attachments passed the "
                                  f"{MAX_MESSAGE_BYTES // (1024*1024)} MB per-message limit "
                                  f"(FOIA_MAX_MESSAGE_MB) — not written.")
            saved.append(entry)
            continue

        digest = hashlib.sha256(payload).hexdigest()
        entry["sha256"] = digest

        # Same bytes seen before: point at the first copy, write nothing.
        known = manifest.get(digest)
        if known and (records_dir / known).exists():
            entry["saved_path"] = str(records_dir / known)
            entry["duplicate_of_earlier_copy"] = True
            saved.append(entry)
            continue

        dest_dir.mkdir(parents=True, exist_ok=True)
        stem, suffix = os.path.splitext(name)
        candidate = dest_dir / name
        counter = 1
        while True:
            if not inside(candidate, records_dir):
                # Unreachable after safe_filename(); kept because the cost of
                # being wrong here is a write anywhere on the machine.
                entry["held_back"] = "resolved outside records/ — refused"
                break
            try:
                # 'xb' creates or fails: no check-then-write window in which
                # something else can appear at that path.
                with open(candidate, "xb") as f:
                    f.write(payload)
                break
            except FileExistsError:
                candidate = dest_dir / f"{stem}_{counter}{suffix}"
                counter += 1

        if "held_back" not in entry:
            rel = str(candidate.relative_to(records_dir))
            manifest[digest] = rel
            entry["saved_path"] = str(candidate)
            message_total += len(payload)
        saved.append(entry)

    return saved


# ---------------------------------------------------------------- review file

def merge_review(existing, fresh):
    """Keep every decision already made. A re-run adds new messages and
    refreshes machine-generated fields; it never resets `accepted` or any
    field the dashboard added."""
    by_hash = {e.get("message_hash"): e for e in existing if e.get("message_hash")}
    out = []
    seen = set()
    for item in fresh:
        h = item["message_hash"]
        seen.add(h)
        prior = by_hash.get(h)
        if prior:
            merged = dict(item)
            for k, v in prior.items():
                if k not in item or k == "accepted":
                    merged[k] = v
            out.append(merged)
        else:
            out.append(item)
    # A message moved out of the FOIA folder keeps its review history.
    for e in existing:
        if e.get("message_hash") not in seen:
            out.append(e)
    return out


def load_review(path):
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        sys.exit(f"{path} is not valid JSON. It has not been modified — it may hold "
                 f"decisions you made in the dashboard. Fix or move it, then run again.")
    return data if isinstance(data, list) else []


# ---------------------------------------------------------------- main

def main():
    email_addr = os.environ.get("FOIA_EMAIL")
    app_password = os.environ.get("FOIA_APP_PASSWORD")
    imap_host = os.environ.get("FOIA_IMAP_HOST", "imap.gmail.com")

    if not email_addr or not app_password:
        print("Missing FOIA_EMAIL or FOIA_APP_PASSWORD environment variables.")
        print("See the setup instructions at the top of this script.")
        sys.exit(1)

    print(f"Connecting to {imap_host} as {email_addr} ...")
    mail = imaplib.IMAP4_SSL(imap_host)
    mail.login(email_addr, app_password)
    status, _ = mail.select(FOLDER, readonly=True)  # readonly: never modifies your mailbox
    if status != "OK":
        print(f"Could not open folder '{FOLDER}'. Check the folder name and try again.")
        sys.exit(1)

    status, data = mail.search(None, "ALL")
    if status != "OK":
        print("Search failed.")
        sys.exit(1)

    message_nums = data[0].split()
    print(f"Found {len(message_nums)} message(s) in '{FOLDER}'.")

    manifest = load_manifest(RECORDS_DIR)
    review_items = []
    for num in message_nums:
        _, msg_data = mail.fetch(num, "(RFC822)")
        raw = msg_data[0][1]
        msg = email.message_from_bytes(raw)
        msg_hash = hashlib.sha256(raw).hexdigest()[:16]

        subject = decode_str(msg["Subject"])
        sender = decode_str(msg["From"])
        date_hdr = msg["Date"]

        body = get_body_text(msg)
        body_lower = body.lower()

        match = REQUEST_ID_PATTERN.search(subject) or REQUEST_ID_PATTERN.search(body)
        request_id = match.group() if match else None

        matched_agency = None
        if not request_id:
            matched_agency = match_agency_by_domain(sender)

        suggested_status, matched_keyword = suggest_status(body_lower)

        snippet = " ".join(body.split())[:300]

        folder_key = request_id or (matched_agency if matched_agency else "_unsorted")
        attachments = save_attachments(msg, folder_key, RECORDS_DIR, manifest)

        review_items.append({
            "message_hash": msg_hash,
            "request_id": request_id,          # None if no ID found
            "matched_agency": matched_agency,   # domain-based fallback guess, or None
            "sender_domain": sender_domain(sender),
            "subject": subject,
            "from": sender,
            "date": date_hdr,
            "snippet": snippet,
            "suggested_status": suggested_status,
            "matched_on": f'"{matched_keyword}"' if matched_keyword else None,
            "attachments": attachments,
            "accepted": False,   # set true only via the review dashboard, never by this script
        })

    mail.logout()
    save_manifest(RECORDS_DIR, manifest)

    merged = merge_review(load_review(REVIEW_FILE), review_items)
    tmp = REVIEW_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(merged, indent=2))
    os.replace(tmp, REVIEW_FILE)

    unmatched = sum(1 for r in review_items if not r["request_id"] and not r["matched_agency"])
    agency_guessed = sum(1 for r in review_items if not r["request_id"] and r["matched_agency"])
    suggested = sum(1 for r in review_items if r["suggested_status"])
    with_attachments = sum(1 for r in review_items if r["attachments"])
    new_files = sum(1 for r in review_items for a in r["attachments"]
                    if a.get("saved_path") and not a.get("duplicate_of_earlier_copy"))
    dupes = sum(1 for r in review_items for a in r["attachments"] if a.get("duplicate_of_earlier_copy"))
    held = [(r["subject"], a) for r in review_items for a in r["attachments"] if a.get("held_back")]
    renamed = sum(1 for r in review_items for a in r["attachments"] if a.get("renamed_to"))

    print(f"\nWrote {REVIEW_FILE} — {len(review_items)} message(s) this run, {len(merged)} total.")
    print(f"  {agency_guessed} matched to an agency by sender domain (no request ID in subject/body).")
    print(f"  {unmatched} completely unmatched — no request ID and no known agency domain.")
    print(f"  {suggested} with a suggested status change to review.")
    print(f"  {with_attachments} with attachments: {new_files} new file(s) written, "
          f"{dupes} already on disk from an earlier run.")
    if renamed:
        print(f"  {renamed} attachment name(s) were unsafe and saved under a cleaned name "
              f"(see 'renamed_to' in the review file).")
    if held:
        print(f"\n  {len(held)} attachment(s) NOT written — read these:")
        for subj, a in held:
            print(f"    {a['filename']!r} in {subj[:50]!r}: {a['held_back']}")
    print("\nNothing in foia_requests.json was touched. Open review_dashboard.html")
    print("to review and accept suggestions, or edit foia_requests.json yourself.")


if __name__ == "__main__":
    main()
