# The evidence store

Raw files live here. The database never does.

This directory is gitignored on purpose. Everything in it is either a public
record you received, a capture from an authorized connector run, or a working
artifact — and none of it belongs in a git remote, where it would be replicated
to a third-party host outside your custody.

## What goes where

```
evidence/
  received/       raw files as they arrived from an agency, unmodified
  captures/       verbatim connector responses, hashed before any DB write
  manifests/      provenance ledgers (.jsonl) — append-only
  working/        analysis intermediates; safe to delete and regenerate
```

## The rule

A file in here is referenced from the database by a RELATIVE path and a SHA-256.
That is the whole contract:

- the database says *what* a file is and *that it is intact*
- this directory holds *the bytes*
- `sentinel prov verify` proves the two still agree

If you move this directory, the relative paths still resolve. That is why the
schema refuses to store an absolute path — `sources_relative_path_only` and the
provenance spine's `relativize()` both enforce it.
