# THE SENTINEL GROUP — SYSTEM ARCHITECTURE
**Version 1.0 · 2026-08-04 · Mark, operator**
**Standard: Named Sources. Public Documents. Verified Facts.**

---

## 0. WHAT THIS DOCUMENT IS

You asked for one program. Right now you have four things that do not talk to each other: **AtlasOS** (the public-record intake), **the TSR Research Desk** (the archive and the GlassMark tiering), **the Command Center** (being built), and **the front end** (not built). This document pins how they become one, and every decision in it is a decision — not a menu. Where I could not build something honestly, I say so in plain words rather than shipping a thing that looks finished and isn't.

You said: *"I don't want any surprises. I catch different bugs over and over again or silly mistakes that could've been fixed through proper engineering, so the first try, we're going to do this the right way."*

The three engineering decisions that honor that, and the reasons, up front:

1. **The public site builds with no database attached.** Every public page is generated from a typed, schema-validated content layer that lives in the repo. If Postgres is down, unreachable, or not installed, the public site still builds, still runs, still deploys. A newsroom site that goes dark because a database connection dropped is a bug you would hit at the worst possible moment.
2. **There are no hand-written links anywhere in the site.** Every route is a constant in one file (`src/content/site.ts`). Components import the constant. A link cannot rot because there is nothing to mistype. A build-time script then re-proves it — see §9.
3. **The desk and the public site are one codebase with two doors.** Same repo, same types, same fonts. `PUBLIC_ONLY=1` closes the desk door at the edge, so the copy that eventually sits on your domain physically cannot serve `/desk`.

---

## 1. THE TWO DEPLOYMENT TARGETS

There is one codebase. It ships to two places, and confusing them is how investigative material leaks.

### Target A — THE DESK (local, offline, your Mac)

This is the one you already have a startup sequence for. It is now the canonical one.

```
brew services start postgresql@16
cd ~/SentinelGroup
npm start
open http://127.0.0.1:4317
```

- Binds to **127.0.0.1**, not `0.0.0.0`. It is not on your network. It is not on the Internet. It is on your machine.
- Requires **no internet connection**. Fonts are self-hosted files in the repo, not Google Fonts. There is no CDN, no analytics script, no third-party call anywhere in the runtime. You can run this on a plane.
- Requires **no Claude**. Claude wrote it. Claude is not in it.
- Full access: cases, evidence, claims, findings, verification gates, the Publication Gate, the security desk, exports.
- This is where unpublished material lives. Nothing here is public until it passes the gate in §6.

### Target B — THE PUBLIC RECORD (the domain you have not bought yet)

- Contains **only** what the Publication Gate has released, and only in the form it was released in.
- Built as a normal Next.js production build with `PUBLIC_ONLY=1`. The desk routes return 404 at the edge before any handler runs.
- Domain-ready today. When you buy the domain, you set `SITE_URL` in one environment variable and the canonical URLs, `robots.txt`, and `sitemap.xml` follow it. Nothing else changes. Nothing is hardcoded to a hostname.
- Subdomain-ready. `sentinelgroup.org`, `desk.` (never public), `records.`, `evidence.` — the route tree is already namespaced so a subdomain split later is a routing change, not a rewrite.

**The rule that keeps them separate:** the desk writes to `content/published/`. The public build reads `content/published/`. There is no live database connection from the public site to your desk, ever. Not because it would be hard — because a read-only replica of an investigative case store on a public host is a subpoena target and a breach target, and you get zero benefit from it.

---

## 2. THE VISUAL SYSTEM

You said: pale, egg-shell, not pitch black. Washington Post or Bloomberg readability. Institutional demand. **Not DejaVu.**

DejaVu is gone from the web tier. It stays in the video/graphics tier only because that pipeline runs on a Linux box with those fonts installed and re-cutting it is a separate job.

### Type

| Role | Family | Why |
|---|---|---|
| Headlines, standfirsts, body | **Source Serif 4** (variable) | A text serif drawn by Adobe for long-form reading on screen. Sits in the same register as the Post's body face — high x-height, sturdy serifs, holds up at 19px. It reads as a publication, not a blog. |
| Labels, navigation, data, tables, badges | **Inter** (variable) | A neutral grotesque in the Bloomberg/FT UI register. Its tabular figures are what make evidence tables line up. |
| Hashes, case IDs, parcel numbers, PO numbers, ordinance numbers | **IBM Plex Mono** | Anything that is an identifier renders in mono so a transposed digit is visible. `610-207094-00` and `SFPN_2022_494809-NA` are not prose. |

All three are **self-hosted woff2 files inside the repo** (`@fontsource`). No network request. No FOUT. No Google.

Body copy is **19px / 1.62 line-height / 68ch measure**. That is the readability decision, and it matters more than the font choice does.

### Color — the paper

```
--paper          #F7F4EC   egg shell. The page.
--paper-raised   #FFFDF7   cards, drawers, table headers.
--paper-sunk     #EFEADD   wells, code blocks, quiet rows.
--rule           #DDD6C4   hairlines. 1px, never a shadow where a rule will do.
--ink            #14181F   body text. Near-black, never #000.
--ink-muted      #575F6D   captions, timestamps, source lines.
--navy           #0C1426   masthead, footer, section marks. Your NAVY (12,20,38).
--gold           #B08D3E   the single accent. Your GOLD, darkened for AA contrast on egg shell.
```

Your original gold `(196,160,82)` fails contrast on a pale background. It is kept exactly as-is for video and social cards, where it sits on navy. On paper it is `#B08D3E`. That is not a change to the brand; it is the same brand rendered for a different substrate.

### Color — the tiers

The GlassMark tier is a **color and a shape**, never color alone. Color-blind readers and grayscale printouts both have to survive it.

| Tier | Swatch | Mark | On air |
|---|---|---|---|
| GREEN — documented | `#1F6B45` | ✅ | State as fact, cite the document |
| ARITH — derived | `#4A5568` | 🧮 | Auto-labeled as our arithmetic |
| REPORTED — attributed | `#16457E` | 📰 | Name the outlet, we do not hold the doc |
| RED APPLE — open question | `#B4611E` | 🍎 | Only as a question already formally asked |
| VERIFY — cite not pulled | `#7A5C1E` | ⧗ | Do not broadcast. Pull the cite first. |
| DEAD — killed | `#8A2E2E` | ⬜ | **Never.** Retained, not deleted. |

Blue = verified/attributed. Orange = open question. That is your existing graphics convention and the web tier now matches it.

---

## 3. THE ROUTE TREE

Every route below exists as a real file. There are no "coming soon" pages and no `href="#"` anywhere in the codebase.

### Public

```
/                          The front page — current investigations, latest correction, the standard
/investigations            Index of the four
/investigations/the-money       Abatements, exemptions, the $2.5B/$5.2B question
/investigations/the-airspace    Dublin DFR, Paladin, 477 flights
/investigations/the-cameras     Flock ALPR, PO483191, the blank Exhibit A
/investigations/the-water       Cooling, LOT, the utility lane
/corrections               The corrections ledger. Runs first, always. Permanent, dated, never quietly edited.
/records                   Every records request filed: date, office, statute, status, response
/evidence                  The public evidence ledger — document title, custodian, SHA-256, page count
/standard                  GlassMark. The six tiers and the rules for moving between them.
/methodology               How the desk works. Three shelves. Eight gates. Conflict adjudication.
/security                  What this site collects, what it does not, and what happens to hostile traffic
/about                     Who the Sentinel Group is
/contact                   Tips, corrections, records-request cooperation
/legal                     Terms, corrections policy, the no-allegation-implied notice
```

### Desk (local only — 404 when `PUBLIC_ONLY=1`)

```
/desk                      Command Center — case status, gate queue, open blocks
/desk/cases                Investigations, sources, evidence, claims, findings
/desk/evidence             Ingest register — hash, custodian, container type, shelf assignment
/desk/claims               Every claim with its tier, its citation, and its gate results
/desk/gate                 THE PUBLICATION GATE — the approval surface. §6.
/desk/soc                  Security desk — assets, exposure, events, software inventory
/desk/exports              Build a package: dossier, records packet, script, card set
/desk/learning             The learning log — corrections, root causes, rule changes
```

### API

```
GET  /api/health           Liveness + DB reachability + build mode. Used by `npm run doctor`.
POST /api/gate/approve     Human approval event. Requires an operator token. Writes to the audit chain.
POST /api/security/report  CSP violation + abuse report sink.
```

### Navigation and drawers

The header carries five top-level items. Three of them open **drawers** — a panel that slides down under the masthead showing the child routes with a one-line description each, so a reader can see the shape of the desk without clicking blind.

- **Investigations** → drawer, four investigations with their current status line
- **The Record** → drawer: Corrections · Records Requests · Evidence Ledger
- **The Standard** → drawer: GlassMark · Methodology · Security & Privacy
- **About** → direct link
- **Contact** → direct link

Drawers are keyboard-operable (Enter/Space to open, Escape to close, focus returns to the trigger), close on outside click and on route change, and — this is the part that usually breaks — **every drawer item is a real `<Link>` to a real route, not a `<div onClick>`.** Middle-click opens in a new tab. Right-click gives "copy link address." Screen readers announce them as links because they are links. On mobile the same tree renders as an accordion inside a full-height panel; there is no second, divergent mobile nav to maintain.

---

## 4. THE DATA MODEL

PostgreSQL 16 or 17, via Prisma. The schema is in `prisma/schema.prisma`. Four groups.

### 4.1 The case store

`Investigation` → `Source` → `Document` → `Claim` → `Finding`, plus `Entity` and `Relationship`.

The load-bearing column is `Document.shelf`, an enum of exactly three values:

- **PRIMARY** — someone else's document, in our custody, hashed. **The only shelf that can support a GREEN claim.**
- **DERIVED** — our own analysis, our own briefs, our own spreadsheets. Labeled. Never a source for itself.
- **PRODUCT** — output. Scripts, cards, dossiers. **Never evidence.**

This column exists because of the $880,000 error. `flock_intel_brief.pdf` sat in the evidence register next to `PO483191.pdf`, with its own SHA-256, looking exactly as authoritative. It was a PRODUCT wearing a PRIMARY badge. The database now refuses to let that happen: a `Claim` with `tier = GREEN` has a required foreign key to a `Document` whose `shelf = PRIMARY`, enforced by a check constraint, not by discipline.

`Document.receivedRecordId` is the single field linking the case store to AtlasOS. Exactly one field. That is the seam.

### 4.2 The audit chain

Table `AuditEvent`, append-only. There is no `UPDATE` path and no `DELETE` path in the application — the Prisma client is wrapped so those methods throw on this model.

Each row carries `prevHash` and `hash`, where `hash = SHA256(prevHash || canonicalJson(payload))`. `verifyChain()` walks the table and returns the sequence number of the first break, or `null`.

Event types: `case_open · ingest · ingest_failed · claim_assert · claim_derive · verify · conflict_resolved · finding · card_build · card_refused · card_render · render_refused · gate_submit · gate_approve · gate_reject · publish · security_incident`

Mirrored to `audit.jsonl` on disk so the chain survives a database restore and can be diffed against it.

### 4.3 The security desk

Your tables, as you specified them: `assets`, `network_inventory`, `external_exposure`, `software_inventory`, `security_events`, `backups`, `change_log`.

Doctrine unchanged and written into the app's own copy: **Nmap is the inside view — what you think is exposed. Shodan is the outside view — what the Internet actually sees. Both are defensive visibility only.** No anonymous scanning, no aggressive recon, no mass enumeration, no random IP scanning. The desk has fields to *record* what those tools told you about your own assets. It does not run them and it will never point them outward.

### 4.4 Entity resolution

Table `entity_matches`, four stages — Exact → Normalized → Fuzzy → Graph Context — with your weighting preserved verbatim:

```
final_score = fuzzy_score*0.40 + address_score*0.20 + graph_score*0.20 + semantic_score*0.20
```

Normalization strips `officer `/`ofc ` prefixes and non-alphanumerics. A match **never auto-merges.** It lands as `status = 'proposed'` and a human promotes it. This is the "connects other dots quietly on the backend" you asked for — the connecting is automatic, the *asserting* is not. An entity resolver that silently merges two people named M. Smith will eventually put the wrong person in a published document, and that is a defamation exposure, not a bug report.

### 4.5 Search

Phase 1 is **PostgreSQL full-text search** — a generated `tsvector` column with a GIN index over document title, custodian, OCR text, and claim text. It is fast enough for tens of thousands of documents, it needs no extra service, and it works offline. That covers you now.

Phase 2, when the archive outgrows it, is OpenSearch as a sidecar. The interface (`lib/search.ts`) is written so the swap is one file. Qdrant and Neo4j attach at the same seam when you want semantic and graph search. **The leap you identified is correct and the schema is built for it:** every document, transcript, entity, timeline event, finding, and video package references the same `Document.id`. That shared key is what makes the other three engines additive instead of a second source of truth.

---

## 5. THE PIPELINE — HOW A DOCUMENT BECOMES A PAGE

```
  INTAKE            ANALYSIS           GATES              APPROVAL          PUBLIC
  ──────            ────────           ─────              ────────          ──────
  AtlasOS      →    container      →   8 verification →   YOU        →      content/
  records          detection by       gates             (a human)          published/
  intake           MAGIC BYTES        block or warn      approve            → static
                   not extension                        or reject            build
       │                │                  │                 │                 │
       └────────────────┴──────────────────┴─────────────────┴─────────────────┘
                          every step writes to the audit chain
```

**Container detection is by magic bytes, never by file extension.** This is not a preference; it is the single most expensive lesson in your archive. Much of the TSR archive stores files named `*.pdf` whose first four bytes are `PK\x03\x04` — they are page bundles, ZIPs of per-page JPEGs, not PDFs. Standard PDF tooling bounces off them with *"No /Root object"* and an operator concludes the file is corrupt. It is not corrupt. The Paladin contract was read exactly this way: `zipfile.ZipFile(...)`, `z.read(f'{i}.jpeg')`, `pytesseract`. The ingest path now sniffs:

| Magic | Handler |
|---|---|
| `%PDF` | pdfplumber |
| `PK\x03\x04` + `N.txt` or `manifest.json` | TSR page archive — zip page reader |
| `PK\x03\x04` + `word/`, `xl/`, `ppt/` | OpenXML |
| `\x89PNG`, `\xff\xd8` | image — flagged for visual review, never silently OCR'd into a claim |

### The eight gates

| Gate | Severity | What it stops |
|---|---|---|
| `UNCITED` | **block** | A claim with no document |
| `CONFLICT` | **block** | Two sources, two numbers — blocks **both**, refuses every card touching either |
| `ORPHAN_ASSERTION` | **block** | An assertion in output that traces to no claim record |
| `DUPLICATE` | warn | Same hash, two register entries |
| `UNLABELED_ARITH` | warn | Our arithmetic presented as documented |
| `REPORTED_AS_DOC` | warn | An outlet's reporting cited as a document we hold |
| `STALE_GATE` | info | Gate result older than the document's last revision |
| `ABSENCE_OVERREACH` | info | "No records exist" claimed from one office's non-response |

**CONFLICT is the gate that matters.** It does not pick a winner. It blocks both figures, writes a conflict record naming each figure and its source, refuses every card touching either claim, and holds the case at `REVIEW_REQUIRED` until a human runs `resolveConflict(concept, winnerKey, rationale)`. The loser is tiered **DEAD and RETAINED** — kept forever, publishable never — so a retired number cannot quietly reappear in a later case. That procedure is what produced the $228,000 adjudication, and it is now code rather than a memory.

**Never add a claim to make a build pass.** That inverts the tool. The build failing is the tool working.

---

## 6. THE PUBLICATION GATE — YOUR SIGN-OFF, IN CODE

You said: *"if that does go to automation I will need to approve it."*

Here is exactly what is automatic and exactly what is not.

**Automatic (no human in the loop):**
- Ingest, hashing, container detection, OCR
- Claim extraction into `proposed` status
- All eight verification gates
- Entity match proposals
- Building the *candidate* publication package — HTML, tier badges, source lines, the whole page, rendered and previewable

**Not automatic, and not automatable — a hard stop in the code path:**
- Anything moving from `candidate` to `published`

The gate is a real route at `/desk/gate`. A candidate arrives with a diff view: what will appear on the public site, every claim in it with its tier and its citation, and every gate result. You approve or you reject. Approval requires the operator token — a secret in your local `.env`, not a session cookie, so an XSS on the desk cannot publish for you. Approval writes a `gate_approve` event to the audit chain carrying the package hash, and *only then* does the publisher write into `content/published/`.

There is no `--force`. There is no auto-approve flag, not even one that defaults off, because a flag that exists is a flag that gets set at 1 a.m. If you want to publish, you look at it and you press the button. The most that automation gets is a notification that something is waiting for you.

**A GREEN claim never auto-promotes.** Tier movement from RED APPLE to GREEN happens only when a new primary document is in hand — *not when it becomes more plausible, not when a second outlet reports it, not when the person doing the investigation is more confident.* The gate enforces that as a code path: promotion requires a `Document` foreign key that did not exist before.

---

## 7. SECURITY

### 7.1 The site's own posture

- **CSP with no `unsafe-inline` and no `unsafe-eval`** — script nonces per request. This is the control that actually stops injected script, and it is also why there is no third-party analytics: adding one would force the policy open.
- HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a `Permissions-Policy` that denies camera, microphone, geolocation, and USB outright.
- **Rate limiting at the edge**, per-IP token bucket: 120 requests/minute general, 10/minute on any POST, 5/minute on `/api/gate/*`. Over the limit returns `429` with `Retry-After` — it does not drop the connection, because a silent drop is indistinguishable from an outage to a legitimate reader on bad hotel wifi.
- **Anti-flood note, stated plainly:** application-layer rate limiting stops a script. It does not stop a real distributed flood. Nothing running on your origin server can. That is stopped upstream, at the CDN/edge provider, before packets reach you — Cloudflare or equivalent, configured when you buy the domain. Any design that claims otherwise is selling you something.
- No file uploads on the public site. No comments. No user accounts. No search box that reaches the database. The public site's attack surface is: read static HTML. That is a deliberate architectural choice, and it removes whole categories of malware and injection risk rather than filtering them.
- The desk binds to loopback. It is not reachable from your network, so it does not need to be defended from your network.

### 7.2 Abuse forensics — and the honest limits

You said: *"if anyone comes onto my website and it's trying to break things then we deserve to know about it"* — and, critically, *"this is only for malicious actors. I don't want to do that to anyone who doesn't deserve it."*

That second sentence is the design constraint, and it is the correct instinct both ethically and legally. Here is how it is built.

**Nothing is recorded for ordinary visitors.** No cookie, no analytics, no fingerprint, no log line tying a person to a page. A reader who arrives, reads, and leaves is invisible to this system, permanently. That is not a limitation — it is the feature that makes the incident log defensible if you ever have to explain it.

**A trigger is required before anything is written.** A request is only recorded when it does something a reader does not do: a path traversal attempt, a SQL injection string, a known scanner signature or User-Agent, a request to `/wp-admin` or `.env` or `.git/config`, a POST to an endpoint that takes no POST, an auth attempt against the gate, a CSP violation report, or sustained rate-limit violation after a `429`. **The attack itself is the consent.**

**What is actually collectable, server-side, and is recorded on a trigger:**

| Field | Note |
|---|---|
| IP address | plus ASN and country from a local geo-IP database — no third-party lookup |
| Timestamp, UTC | |
| The full request | method, path, query, headers, and the payload of the attack |
| User-Agent | self-reported, trivially forged, logged as claimed not as fact |
| TLS fingerprint | JA3/JA4 — this is the good one; it survives IP rotation and User-Agent spoofing |
| Request timing and sequence | the shape of an automated scan is distinctive |
| Which rule fired, and the raw evidence | |

Each incident becomes a report at `/desk/soc` with a severity, the full raw request, and an exportable packet suitable for handing to counsel or an ISP abuse desk.

**What is NOT collectable, and why I am not going to pretend otherwise.** You asked to capture "all their physical information about their computer or device." A web server cannot get that, and I would rather tell you now than have you find out when you need it. A browser will not surrender a MAC address, a hardware serial, a device ID, a machine name, or a logged-in user. Those are not exposed to any website, by any technique, on any modern browser. What *is* technically possible — aggressive canvas/WebGL/audio fingerprinting, invisible tracking pixels, evercookies — has three problems: it only works if you run script in the attacker's browser, and attackers use `curl` and scanners that never execute your JavaScript, so it catches your readers and misses your adversaries; it is what the GDPR and CCPA were written about, and running it site-wide would create real liability for a publication whose entire authority rests on its ethics; and it would violate your own instruction not to do this to people who don't deserve it, because it is applied before you know who anyone is.

The JA3/JA4 TLS fingerprint does the job you actually wanted — it identifies the *tool* across IP changes, works against scanners and `curl`, requires no script execution, and touches nothing about an innocent reader. That is the honest version of "capture who they are," and it is the one that is built.

**One more thing, since it is your own material:** this site publishes on surveillance. The privacy posture is not overhead. It is the story's credibility. A publication that fingerprints its readers while investigating ALPR has handed its subjects the only defense they need.

---

## 8. THE OFFLINE MAC INSTALL

```bash
git clone <your-private-repo> ~/SentinelGroup
cd ~/SentinelGroup
./scripts/install-mac.sh     # checks node + postgres, installs deps, generates client,
                             # pushes schema, seeds, writes .env, verifies
npm start                    # → http://127.0.0.1:4317
```

`install-mac.sh` is idempotent — run it twice, nothing breaks. It checks for Node 20+, checks whether `postgresql@16` is installed and running, starts it if not, creates the `sentinel` database only if absent, generates a random operator token into `.env` if one is not already there, and finishes by running `npm run verify`. If any precondition fails it says which one and what to type, rather than failing three steps later with a stack trace.

`npm run doctor` answers "why isn't it working" in one command: Node version, Postgres reachability, schema drift, missing env vars, port 4317 occupancy, audit chain integrity.

**Offline guarantees:** after the first `npm install`, the app makes zero outbound network requests. Fonts are files in `node_modules` compiled into the build. There is no CDN, no telemetry (`NEXT_TELEMETRY_DISABLED=1` is set in `.env`), no analytics, no external API. Ollama or a local Llama/Mistral attaches later at `lib/ai.ts` as an optional local endpoint — the app runs fully without it and will never require it.

**Turning it into a Mac app:** `npm start` plus a `.command` launcher gets you a double-clickable icon today. A real `.app` bundle — Tauri or Electron wrapping the same local server — is a later step and does not change one line of the application. It is deliberately last, because a wrapper adds a whole update-and-signing problem and buys you an icon.

**Scaling to co-workers:** the design is single-operator today, and I have not pretended otherwise. Multi-investigator means three additions, in this order: real authentication with per-user identity on every audit event; row-level access so a case can be restricted; and a shared Postgres instance on a host you control with mTLS or a private network. The schema already carries `actor` on every audit row, so the audit chain is multi-user-ready before the auth is. That is the correct order — you never want to add identity to a log after the log has been running.

---

## 9. HOW "ALL THE LINKS WORK" IS PROVEN, NOT PROMISED

Three mechanisms, in order of strength.

1. **Links cannot be typed.** Every route is a constant in `src/content/site.ts`. Components import `ROUTES.investigations.theMoney`. A typo is a TypeScript error at compile time, in your editor, before you ever run anything.
2. **`npm run verify:links` walks the whole tree.** It enumerates every real route from the App Router file structure, expands every dynamic segment against the actual content slugs, then scans every `.tsx`, `.ts`, `.mdx`, and content file for every href literal — including ones inside prose — and asserts each internal one resolves. It also fails on `href="#"`, on empty hrefs, and on any external link missing `rel="noopener noreferrer"`. It exits non-zero with a file-and-line list.
3. **`npm run verify` is the gate before anything ships:** `typecheck → verify:links → build`. If any stage fails, nothing ships.

That is the answer to *"I don't want any surprises."* The links are not verified by clicking around. They are verified by a script that fails the build.

---

## 10. WHAT IS BUILT NOW vs. WHAT IS NEXT

**Built and running in this delivery:** the full public front end with every route real and every link proven; the drawer navigation; the type and color system; the content layer with the four investigations, the corrections ledger, and the records tracker populated from the verified archive; the Prisma schema for all four table groups; the audit chain with `verifyChain()`; the Publication Gate route and approval path; the security middleware, rate limiter, and abuse-incident recorder; the Mac install and doctor scripts; the verification harness.

**Next, in the order I would do it:**

1. **Wire AtlasOS intake into `Document.receivedRecordId`.** The seam exists; the importer does not. This is the highest-value next step because it is what stops manual re-entry.
2. **The ingest worker** — magic-byte detection, the zip page reader, OCR, hashing, and shelf assignment as a background job rather than a manual script.
3. **Postgres full-text search** over the ingested corpus.
4. **The six unanalyzed Flock CSVs (~35 MB)**, including the pre/post-December-2025 reason-category split and the `XXX ×172,389` redaction-artifact question, which is still unresolved and still unpublishable.
5. **Auth**, when the second person needs a login — not before.
6. **The `.app` wrapper.**

**Two things you have to decide, that I cannot decide for you:**

- **The byline.** Griswold or your legal name. It is on the records pages, the contact page, and every request in the packet. Under ORC 149.43 a requester need not identify themselves at all, so a pen name is lawful — but the name on the request is the name with standing in the Court of Claims under ORC 2743.75. Requests you may need to enforce should carry your legal name. The site currently ships with the byline as a single configuration value in `src/content/site.ts` so it is one edit, not forty.
- **The domain.** Nothing is blocked on it. When you buy it, `SITE_URL` is the only thing that changes.

---

*The Sentinel Group · We Watch the Code · Corrections run first, always.*
