<!--
The checklists below are short because they only ask about the things that
have actually gone wrong here. Delete any section that genuinely does not
apply — but delete it deliberately, rather than leaving it unticked.
-->

## What changed, and why

<!-- A sentence or two. The "why" is the part that will still matter in a year. -->

## What this produces, if it produces anything new

<!--
Every output belongs to exactly one row. See CONTRIBUTING.md, law 1.
Tick one, or write N/A.
-->

- [ ] a **capture** — bytes a source returned (supports: a lead)
- [ ] a **co-occurrence** — a name under two subjects (supports: a place to look)
- [ ] an **asserted relationship** — a filing, docket, registration (supports: a cited relationship)
- [ ] a **primary document** — fetched, hashed (supports: a claim)
- [ ] N/A — this changes no output

## The desk's guarantees

- [ ] `bin/sentinel test` is green
- [ ] No test makes a network call
- [ ] No new dependency is required to run the suites
- [ ] Nothing under `evidence/`, no `.env`, no key, no real subject name is in the diff
- [ ] The publish gate still has no override
- [ ] Fails closed: an unasked question and an answered-empty question still print differently

## If this touches a connector

- [ ] `describe()` states the real call that `run()` makes
- [ ] `identify()` returns a stable id (getting this wrong makes a watch silent or a firehose)
- [ ] `entityNames: false` if the source returns document titles rather than parties

## If this touches notifications

- [ ] The body still carries only a count, a label, and a watch id — no name, no quote, nothing from a capture

## Anything a reviewer should push back on

<!--
Name it yourself. A PR that says "I am not sure the 24h window is the right
default" gets a better review than one that hopes nobody asks.
-->
