# Contributing

This is a working investigative desk, not a general-purpose OSINT toolkit. The
constraints below are not style preferences — most of them exist because the
alternative once shipped and did damage.

Read [`docs/WORKFLOW.md`](docs/WORKFLOW.md) for what the system does, and
[`docs/ARCHITECTURE_MAP.md`](docs/ARCHITECTURE_MAP.md) before adding a module,
so you do not build a second version of something that already exists under a
different name.

---

## The four laws

### 1. Say what a thing is, at the point it is produced

Every output belongs to exactly one of these, and must be labelled as such
where a person will read it:

| | supports |
|---|---|
| a **capture** — bytes a source returned for a query | a lead |
| a **co-occurrence** — a name under two subjects | a place to look |
| an **asserted relationship** — a sworn filing, a docket, a registration | a cited relationship |
| a **primary document** — fetched, hashed, read | a claim |

A name match is not an identification. A shared registrant is not a
conspiracy. `AWS PUBLIC POLICY LLC` in Oklahoma matches a search for AWS and
is almost certainly not Amazon.

If a new command cannot state which row it produces, it is not ready.

### 2. Fail closed

A connector that returns non-2xx writes no capture, no ledger line, and does
not advance `last_run_at`. A watch that could not run must not look like a
watch that ran and found nothing.

The general form: **an unasked question and an answered-empty question must
never be printed the same way.** Most of the subtle bugs in this repo have
been variants of that.

### 3. Nothing overrides the publish gate

There is no `--force`, no `publish_anyway`, no `skip_gate`. CI greps for them.
If a case cannot be published, the fix is to resolve the blocker or to state
publicly that it is unresolved.

### 4. Evidence never enters git

See [`SECURITY.md`](SECURITY.md). CI enforces it. If you need a fixture, build
it in the test with `mkdtemp` — every existing suite does.

---

## Working on it

```bash
bin/sentinel test          # every module. Must be green before you push.
node modules/connectors/test_recency.js    # or one suite directly
```

The suites run on a **bare checkout** with nothing installed, and CI asserts
that property. If a change needs a dependency to be tested, that is a design
question to raise in the PR, not something to `npm install` past.

No network in tests. Ever. A test that reaches a public API is a test that
fails on a plane, rate-limits a source that has been generous, and passes for
the wrong reason on a bad day.

## Comment style

Long comments, and they explain **why**, not what.

The convention in this repo is that a non-obvious decision carries the reason
it was made, and where something was once wrong, the comment says what broke
and how it presented. That is why `crosslink.js` opens with three paragraphs on
why co-occurrence is not a relationship, and why `cli.js` records that
`--into data center` once searched for `vadata center`.

This is not decoration. Six months on, the comment is the only thing standing
between a future reader and re-introducing the bug, because the code will look
fine.

When you fix something subtle, leave the tombstone.

## Guards that match code, not prose

Several CI steps grep for forbidden patterns. Because the files being guarded
*explain at length* what they forbid, a naive grep matches the explanation and
fails on every clean run — and a guard that cries wolf gets deleted within a
week.

So guards match quoted literals and assignment shapes, and strip comment lines
first. If you add a guard, do that, and add a test proving it does not fire on
a clean tree.

## Tests

Every suite in this repo is written against the failure that matters, not
against the happy path. `test_crosslink.js` says it out loud: the risk is not
that it misses a connection, it is that it *asserts* one.

Ask what the worst wrong output of your change is, and test that first.

New suite? Register it in `bin/sentinel test` in the same style, or it will
never run again.

## Pull requests

- One change per PR. The commit messages here read as sentences about what
  changed and why (`Stop shipping commands that zsh cannot run, and guard it`).
  Match that.
- Fill in the PR template. The evidence checklist is the point of it.
- `bin/sentinel test` green before you push, not after review asks.

## Adding a connector

Add an entry to `CONNECTORS` in `modules/connectors/registry.js`:

| field | what it does |
|---|---|
| `label`, `keyVar`, `keyRequired` | identity and credentials |
| `describe(q)` | the announce line — must state the **real** call |
| `probe(key)` | a cheap call for `sentinel connect test` |
| `run(q, key)` | the actual request |
| `parse(json)` | response → array of result objects |
| `identify(r)` | the stable id used for new-vs-seen |

Both the CLI and the watch runner read this one registry, so the run procedure
cannot drift between them. `identify` is required rather than inferred because
getting it wrong makes a watch either silent or a firehose.

If the source returns document titles rather than parties, set
`entityNames: false` — otherwise a notice matching four subjects appears in
`crosslink` as a four-way connection, which is a search artifact wearing the
costume of a finding.
