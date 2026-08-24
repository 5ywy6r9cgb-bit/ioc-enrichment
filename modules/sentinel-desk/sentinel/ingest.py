"""
ingest.py — how a document enters the desk.

Three things happen and none of them are optional:

  1. The bytes are hashed. SHA-256, streamed, so a 2GB file does not need
     2GB of memory. The hash is the document's identity from then on. If the
     file changes, that is a NEW document, not an edit to this one.

  2. The container is detected from MAGIC BYTES, never from the extension.
     This matters concretely: agencies routinely hand out files named .pdf
     that are ZIP archives of page images. `pdftotext` returns nothing on
     those and a careless pipeline records "no text found" instead of
     "this needs OCR." The register should say which it is.

  3. The file is copied into the vault under its hash, and the original is
     left where it was. The vault becomes the thing you back up.

Nothing is parsed, summarised, or OCR'd here. Extraction is a separate step
with its own record, because "what the document says" is a claim about the
document, and claims need citations.
"""

from __future__ import annotations
import hashlib
import shutil
import sqlite3
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from . import audit, guard

CHUNK = 1 << 20  # 1 MiB


def sha256_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    n = 0
    with Path(path).open("rb") as fh:
        while chunk := fh.read(CHUNK):
            h.update(chunk)
            n += len(chunk)
    return h.hexdigest(), n


def detect_container(path: Path) -> tuple[str, int | None, str]:
    """
    Return (container, pages_or_None, note).

    Containers:
      PDF               a real PDF (starts %PDF-)
      ZIP_PAGE_ARCHIVE  a .zip of page images wearing a .pdf name — needs OCR
      OPENXML           .docx/.xlsx/.pptx
      ZIP               some other archive
      IMAGE / PLAINTEXT / UNKNOWN
    """
    path = Path(path)
    with path.open("rb") as fh:
        head = fh.read(8)

    if head.startswith(b"%PDF-"):
        return "PDF", None, ""

    if head.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(path) as z:
                names = z.namelist()
        except zipfile.BadZipFile:
            return "ZIP", None, "declares ZIP magic but will not open"

        if any(n == "[Content_Types].xml" for n in names):
            return "OPENXML", None, ""

        img = [n for n in names if n.lower().endswith(
            (".jpg", ".jpeg", ".png", ".tif", ".tiff", ".gif", ".bmp"))]
        if img and len(img) >= max(1, len(names) // 2):
            return (
                "ZIP_PAGE_ARCHIVE",
                len(img),
                f"named '{path.suffix or 'no extension'}' but is a ZIP of "
                f"{len(img)} page images — text extraction requires OCR, "
                f"pdftotext will return nothing",
            )
        return "ZIP", None, ""

    if head.startswith(b"\xff\xd8\xff"):
        return "IMAGE", 1, ""
    if head.startswith(b"\x89PNG"):
        return "IMAGE", 1, ""

    try:
        path.read_text(encoding="utf-8")
        return "PLAINTEXT", None, ""
    except (UnicodeDecodeError, ValueError):
        return "UNKNOWN", None, ""


def ingest(
    conn: sqlite3.Connection,
    root: Path,
    case_slug: str,
    src: Path,
    *,
    title: str,
    custodian: str,
    shelf: str = "PRIMARY",
    request_ref: str | None = None,
    note: str = "",
    actor: str = "operator",
) -> dict:
    """Hash, classify, vault and register one file. Idempotent on the hash."""
    src = Path(src).expanduser()
    if not src.is_file():
        raise FileNotFoundError(f"No such file: {src}")

    guard.assert_clean(
        {"title": title, "custodian": custodian, "note": note, "filename": src.name},
        "document",
    )

    case = conn.execute("SELECT * FROM cases WHERE slug=?", (case_slug,)).fetchone()
    if case is None:
        raise KeyError(
            f"No case with slug '{case_slug}'. Create it first: "
            f"sentinel case new <slug> \"<title>\""
        )

    digest, size = sha256_file(src)
    existing = conn.execute("SELECT * FROM documents WHERE sha256=?", (digest,)).fetchone()
    if existing is not None:
        return {
            "status": "already-held",
            "id": existing["id"],
            "sha256": digest,
            "title": existing["title"],
            "container": existing["container"],
            "detail": "These exact bytes are already in the register. Not re-ingested.",
        }

    container, pages, detect_note = detect_container(src)

    vault = Path(root).expanduser() / "vault" / digest[:2] / digest
    vault.parent.mkdir(parents=True, exist_ok=True)
    if not vault.exists():
        shutil.copy2(src, vault)

    full_note = "; ".join(x for x in (note, detect_note) if x)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    cur = conn.execute(
        "INSERT INTO documents (case_id,title,custodian,shelf,sha256,bytes,container,"
        "filename,path,pages,received,request_ref,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (case["id"], title, custodian, shelf, digest, size, container,
         src.name, str(vault), pages, now, request_ref, full_note),
    )
    conn.execute("UPDATE cases SET updated=? WHERE id=?", (now, case["id"]))

    audit.record(
        conn, "document.ingest", actor, digest,
        {"case": case_slug, "title": title, "custodian": custodian, "shelf": shelf,
         "bytes": size, "container": container, "pages": pages,
         "source_filename": src.name},
        mirror=Path(root).expanduser() / "audit.jsonl",
    )

    return {
        "status": "ingested",
        "id": cur.lastrowid,
        "sha256": digest,
        "title": title,
        "bytes": size,
        "container": container,
        "pages": pages,
        "detail": detect_note or "",
        "vault": str(vault),
    }


def verify_vault(conn: sqlite3.Connection) -> list[dict]:
    """Re-hash every vaulted file and report anything that moved or changed."""
    out = []
    for row in conn.execute("SELECT id,title,sha256,path FROM documents ORDER BY id"):
        p = Path(row["path"])
        if not p.exists():
            out.append({"id": row["id"], "title": row["title"],
                        "problem": "MISSING", "detail": str(p)})
            continue
        actual, _ = sha256_file(p)
        if actual != row["sha256"]:
            out.append({"id": row["id"], "title": row["title"],
                        "problem": "ALTERED",
                        "detail": f"registered {row['sha256'][:16]}… now {actual[:16]}…"})
    return out
