"""
The Sentinel Desk — a local, offline public-records research desk.

    store    SQLite case store (metadata only; evidence stays on disk)
    ingest   hash + magic-byte classification + vault
    gates    GlassMark verification, enforced in code
    export   dossier + findings deck
    server   read-mostly dashboard bound to 127.0.0.1
    guard    the surveillance-input boundary
    audit    append-only SHA-256 hash chain

No third-party dependency. No network call. Ever.
"""
__version__ = "1.0.0"
