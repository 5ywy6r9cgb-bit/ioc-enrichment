# Security

This repository is the source for an investigative desk. Most of what it
protects is not code.

## What this repo must never contain

Three classes of thing, in descending order of how bad it is when they leak:

1. **Case material.** Received records, captures, documents, provenance
   ledgers, drafts. The entire `evidence/` tree, plus `Received_Records/`,
   `watchlist.json`, and any `*.jsonl`. Some of it is about named private
   individuals who are not public figures and have done nothing.
2. **Subjects of interest.** `watchlist.json` is gitignored on purpose: the
   list of names a desk is asking questions about is itself sensitive, before
   any answer comes back. Named subject *sets* in
   `modules/connectors/subjects.json` are tracked because they are research
   scope for a published project; a watchlist is not.
3. **Credentials.** `.env`, API keys, PACER logins, ntfy topic names. An ntfy
   topic is effectively a password — anyone who guesses it reads the desk's
   notifications.

Three mechanisms enforce this, and they are independent on purpose:

- `.gitignore` — stops the ordinary mistake.
- **CI (`.github/workflows/test.yml`, `secrets` job)** — fails the build if any
  `.env` is tracked, if anything under `evidence/` other than `README.md` and
  `.gitkeep` is tracked, or if any tracked file contains a credential-shaped
  string (`sk-`/`pk-`, `AIza…`, `ghp_…`, `AKIA…`, a PEM private key header).
- `guard.py` — refuses to write credential-shaped text into the desk's
  append-only audit chain, which cannot be edited afterwards.

If CI catches one of these on a branch, do not amend and force-push and move
on. A key that reached a remote is a key that must be **rotated**, because
`git rm` does not remove it from history and the branch may already be fetched.

## Reporting a vulnerability

Report privately, not in a public issue:

- GitHub → **Security** → **Report a vulnerability** (private advisory), or
- the repository owner directly.

Please include what you can reproduce and what you think the impact is. There
is no bounty; there is a fast reply.

**Do not open a public issue for**: anything involving a real key, a real
subject name, or real case material. If a report needs to quote evidence,
say so and it can be handled privately.

## What counts as a vulnerability here

The usual ones, plus some specific to what this system does:

- **An evidence-integrity break.** Anything that lets a capture's bytes change
  without `prov verify` noticing, or lets a ledger line be written that does
  not match the artifact it names.
- **A gate bypass.** Anything that lets a claim reach publishable state
  without a citation to a fetched primary document — including a `--force`,
  a skip flag, or a code path that writes GREEN from a search result. CI
  asserts no override exists in the publish gate. That assertion is load
  bearing.
- **Notification leakage.** The watch notifier is allowed to send a count, a
  label, and a watch id — never a name, a quote, or anything from a capture.
  A path that gets subject content into a notification body is a real bug: it
  puts an unverified allegation about a named person onto a third party's
  server and a lock screen.
- **Key exfiltration.** Any path that writes a resolved key to disk, to a log,
  to a capture, or into a request other than the intended `Authorization`
  header.
- **Connector SSRF / redirect abuse.** A connector that follows a redirect to
  an attacker-chosen host with auth headers attached. `registry.js` strips
  auth across redirects and caps them; a bypass is a vulnerability.

## Things that are not vulnerabilities

- Missing pinned dependencies in test suites that install nothing. The suites
  run on a bare checkout by design, and CI asserts it.
- The absence of authentication on `modules/pra/server/`. It binds locally and
  is documented as a local service; running it on a public interface is a
  deployment choice, not a defect. If you do that, put it behind something.
- A connector returning results about the wrong entity. That is a name match,
  not a security issue, and the whole desk is built on the premise that a name
  match is not an identification.

## Supply chain

The test suites deliberately install nothing — CI fails if `node_modules`
appears in a fresh checkout. Runtime dependencies exist for the PRA local
service and the browser shell only. Dependabot watches GitHub Actions and the
declared npm manifests; Action versions are pinned by major tag.

Keep it that way. A desk that holds evidence should not be pulling a hundred
transitive packages to run its own tests.
