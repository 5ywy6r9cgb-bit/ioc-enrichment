# Start here — the terminal, step by step

Type one block at a time. After each, check you saw what it says you should.
If something differs, stop there and say what you saw.

**You do not need the bundle or the installer any more.** Those were for when
GitHub was blocked. It isn't now, so this is the shorter path.

---

## 1. Open Terminal

`⌘ + Space`, type `Terminal`, press Return.

A window opens with a line ending in `$` or `%`. That's the prompt.

---

## 2. Check what you have

```bash
git --version
python3 --version
node --version
```

**You should see** three version numbers.

If `git` or `python3` triggers a popup offering to install developer tools,
click **Install** and wait (5–15 min), then run these again. That popup is
Apple's, it's free, and it covers both.

If `node` says `command not found`, that's expected — most Macs don't have it.
Go to <https://nodejs.org>, click the green **LTS** button, open the downloaded
`.pkg`, click through it. Then **close Terminal and open a new one** (the new
window is what picks up the change) and check `node --version` again. You want
v18 or higher.

---

## 3. Download the code

```bash
cd ~
git clone https://github.com/5ywy6r9cgb-bit/ioc-enrichment.git sentinel
cd sentinel
git checkout claude/atlasos-public-records-3yhj5h
```

**You should see** `Cloning into 'sentinel'...` then
`Switched to a new branch 'claude/atlasos-public-records-3yhj5h'`.

That branch line matters — the work is on that branch, not on `main`.

---

## 4. Prove it works

```bash
bin/sentinel test
```

Takes a few seconds and prints a lot. **You should see, at the very bottom:**

```
All present suites passed.
```

610 checks. If you see that, the system works on your Mac and everything below
is just using it.

---

## 5. Your first real command

```bash
bin/sentinel pra foia
```

**You should see** `Nothing needs you right now. 0 request(s) tracked.`

Correct — this is a fresh copy and knows nothing yet.

---

## 6. Put your real requests in

One line each. Use your own IDs, agencies and dates:

```bash
bin/sentinel pra foia add PRR-2026-391 "City of Gahanna" \
    --on 2026-06-23 --via certified_mail \
    --about "Contract award file, Jan-Jun 2026"
```

`--via` matters more than it looks. Only `certified_mail`, `electronic`, and
`hand_delivery` satisfy the R.C. 149.43(C)(2) transmission predicate, and you
can't reconstruct that six months later. If you genuinely don't remember, leave
`--via` off — the desk will say it's missing rather than guess.

Then look:

```bash
bin/sentinel pra foia
```

**You should see** each overdue request, how many business days, and which rung
it's on.

---

## 7. Working a request

```bash
bin/sentinel pra foia draft PRR-2026-391
```

Prints a letter. **Read it.** Nothing is sent — the desk has no ability to send
anything. Copy it into your own email if you want it to go.

After you send it:

```bash
bin/sentinel pra foia sent PRR-2026-391 --via email --note "status enquiry"
```

**Do not skip this one.** Logging the letter is how the desk knows to stop
proposing it again tomorrow. Skip it and it'll nag you into sending three
letters in a week, which reads as harassment rather than diligence.

Other things:

```bash
bin/sentinel pra foia --all                   # including quiet ones
bin/sentinel pra foia history PRR-2026-391    # every letter and change
bin/sentinel pra foia heard PRR-2026-391 --note "acknowledged, no records yet"
bin/sentinel pra foia set PRR-2026-391 status denied
```

---

## 8. Your API keys

```bash
touch modules/pra/.env
chmod 600 modules/pra/.env
open -e modules/pra/.env
```

TextEdit opens an empty file. One key per line, no quotes, no spaces around `=`:

```
OPENSANCTIONS_API_KEY=paste_it_here
COURTLISTENER_API_TOKEN=paste_it_here
FEC_API_KEY=paste_it_here
DATA_GOV_API_KEY=paste_it_here
```

Save (`⌘S`), close. `chmod 600` means your account only.

**Never paste a key into a chat window.** That includes this one. `.env` is
gitignored and CI fails if one is ever committed, but neither of those helps if
it goes into a message.

Then:

```bash
bin/sentinel connect test
```

**You should see** which keys are set and which hosts answer. It does not print
your keys. Send me that output — it's safe to share.

---

## 9. The overnight run

```bash
bin/sentinel watch install
```

Schedules it via launchd, not cron — launchd catches up a run missed while the
Mac was asleep, and a laptop is asleep at 3am.

Each morning:

```bash
open evidence/watch/MORNING_BRIEF.md
```

Every request that needs you, why, and the exact command to draft each one.

---

## The five commands that matter

```bash
bin/sentinel pra foia              what needs you today
bin/sentinel pra foia draft ID     the letter, unsent
bin/sentinel pra foia sent ID      tell it you sent one
bin/sentinel case list             your cases and what blocks them
bin/sentinel dash                  the dashboard
```

---

## If something goes wrong

- **`command not found: bin/sentinel`** — you're in the wrong folder. `cd ~/sentinel`
- **`permission denied`** — `chmod +x bin/sentinel`
- **anything else** — copy the whole error and send it. Don't paste your `.env`.

## Where your data lives

```
evidence/foia_requests.json      requests + correspondence log
evidence/sentinel_cases/*.json   case files
evidence/watch/MORNING_BRIEF.md  what needs you today
modules/pra/.env                 your keys
```

All mode 600, all gitignored, none of it ever leaves the machine. **Back up the
`evidence/` folder yourself** — nothing copies it anywhere, which is the point,
and also means nothing will save you if the disk dies.
