---
id: evaluate-a-tool-before-you-run-it
level: 2
minutes: 120
prerequisites: [verify-a-file-is-what-it-claims]
tools: [git, python3, shasum]
nist_csf: [ID.RA-09, GV.SC-04, GV.SC-07, PR.PS-01]
attack_context: [T1195.001, T1195.002, T1059]
teaches_offense: false
scope: static inspection only — nothing is executed
---

# Lesson 3 — Evaluate a tool before you run it

## Why this matters

The most likely way a defender gets compromised is not an exploit. It is
installing something.

Security people install more untrusted code than almost any other profession,
from more marginal sources, with less scrutiny, and often with elevated
privileges — because the thing they are installing is *a security tool*, and
the category launders the trust.

The command `npx skills add some-user/some-repo` executes code from a stranger,
on your machine, right now. So does `pip install`, `brew install`, and every
curl-pipe-to-shell in every quickstart. This lesson is the habit that makes
that survivable.

**This is the lesson the field needs most and teaches least.**

## What you need

- A real candidate tool. Bring one you actually want to install — the exercise
  is worthless on a fictional example.
- A terminal. **You will not execute the candidate at any point in this lesson.**

## Workflow

**1. Separate the claim from the evidence.**

Write down, from the project's own README, exactly what it claims: how many
components, what frameworks, who contributed, what it integrates with.

Now mark each claim: **can I check this from here, or am I taking their word?**

Most project READMEs are marketing. That is not an accusation — it is what a
README is for. The error is reading it as documentation.

**2. Check the checkable claims.**

If the README says "817 skills across 29 domains," count them:

```bash
git clone --depth 1 <repo> /tmp/candidate    # clone ≠ execute
find /tmp/candidate -name 'SKILL.md' | wc -l
```

If the count matches, that is a small deposit of trust — they were accurate
where accuracy was verifiable. If it doesn't, that is a large withdrawal.

**3. Find what actually runs.**

This is the core of the lesson. Documentation cannot hurt you; code can.

```bash
find /tmp/candidate -type f \( -name '*.py' -o -name '*.sh' -o -name '*.js' \
  -o -name '*.rb' -o -name 'Makefile' \) | wc -l

# Anything that runs at install time is the highest-risk surface
find /tmp/candidate -name 'package.json' -exec grep -l 'postinstall\|preinstall' {} \;
find /tmp/candidate -name 'setup.py' -o -name 'pyproject.toml'
```

A repo that is genuinely "just Markdown" should have almost nothing here. If a
documentation project ships install hooks, ask why — out loud, in your notes.

**4. Grep for the behaviours that matter.**

```bash
cd /tmp/candidate
grep -rn "curl\|wget\|urllib\|requests.get\|fetch(" --include='*.py' \
  --include='*.sh' --include='*.js' . | head -30      # phones home?
grep -rn "eval\|exec(\|subprocess\|os.system\|child_process" \
  --include='*.py' --include='*.js' . | head -30      # runs things?
grep -rniE "api[_-]?key|token|secret|password|\.ssh|\.aws|keychain" \
  --include='*.py' --include='*.sh' --include='*.js' . | head -30  # reads secrets?
grep -rn "sudo\|chmod \+x\|launchctl\|crontab\|systemctl" \
  --include='*.sh' . | head -20                       # persists or escalates?
```

Every hit is a question, not a verdict. Legitimate tools do all of these. What
you are building is a list of things you must be able to explain before you
run it.

**5. Weigh the provenance.**

- How old is the repo? A project claiming years of maturity with three months
  of commits is describing an aspiration.
- How many contributors? A single-maintainer project is not disqualifying —
  most good tools start there — but it means one compromised account is the
  whole threat model.
- Does it have a commercial funnel? A survey, a token, a hosted playground, a
  waitlist. Not sinister. But a project with a growth incentive has a reason
  to inflate its numbers, so weight its unverifiable claims lower.
- Who vouches for it? "Featured in awesome-lists" is close to meaningless —
  most awesome-lists merge on request. A named practitioner with a reputation
  at stake is worth more than a hundred list inclusions.

**6. Decide, in writing, with a scope.**

Three outcomes, and "no" is not the safe default — never installing anything
is its own failure mode:

| Decision | Means |
|---|---|
| **Run it** | You explained everything from step 4, and the risk fits the value. |
| **Run it, contained** | VM, container, or a throwaway account. No repo access, no keychain, no credentials. |
| **Don't run it** | Take the ideas, leave the code. You can read a skill file and write your own. |

For a documentation-shaped project, option 3 is often correct and is not a
snub: you can read what it teaches without granting it execution.

## Verification

You have completed this lesson when you can produce, for a real tool:

1. A table of README claims marked verified / unverifiable.
2. A count of files that execute, and what each does.
3. Every network call, secret access, and persistence mechanism it contains.
4. A written decision with a scope and a reason.

## Where students get it wrong

- **Confusing popularity with safety.** Star counts are purchasable and, more
  importantly, measure interest rather than review. Nobody read it either.
- **Confusing "open source" with "audited."** You can read it. Did you?
- **Binary thinking.** Students land on "safe" or "malicious." Almost
  everything is "fine for this, not for that." The scope is the answer.
- **Cloning into a directory with credentials in it.** Clone somewhere empty.
- **Running it "just to see."** The entire lesson, undone in one command.
- **Paranoia as a substitute for judgement.** A student who refuses everything
  has not learned to evaluate; they have learned to avoid. That is the same
  failure wearing a safer-looking hat.

## Write it up

Standard template, with one addition: **a decision, with a scope and an expiry.**

> "Run contained. Approved for use in a throwaway VM with no credentials and
> no repo access, until 2026-11-01. Not approved on the desk machine. Re-review
> if it gains an install hook. Reason: 41 executable files, three of which make
> outbound calls I could explain (telemetry, update check, model fetch) and one
> I could not (`scripts/report.sh` posts to a hostname not mentioned anywhere
> in the docs)."

That last clause — the thing you could not explain, named — is the whole skill.

## Instructor notes

- **Bring a real, current candidate.** Ideally one you are genuinely undecided
  about. Students can tell when the answer is pre-baked, and the value here is
  watching an expert reason under real uncertainty.
- Have two students evaluate the same tool independently and compare decisions.
  They will often reach different, both-defensible conclusions with different
  scopes. That is the correct outcome and worth saying so explicitly.
- **The discussion to have out loud:** security tooling is the softest supply
  chain in the industry, because scrutiny is suspended by the category. Ask
  them when they last read the source of a security tool they installed.
- Resist letting this become a lesson in suspicion. The goal is calibration.
  A defender who cannot adopt new tools is as ineffective as one who adopts
  everything — just less visibly.

## Framework mapping

| Framework | ID | Relationship |
|---|---|---|
| NIST CSF 2.0 | `GV.SC-04` | Suppliers are known and prioritised by criticality |
| NIST CSF 2.0 | `GV.SC-07` | Risks posed by a supplier are understood and monitored |
| NIST CSF 2.0 | `ID.RA-09` | Authenticity and integrity of hardware and software assessed before acquisition and use |
| NIST CSF 2.0 | `PR.PS-01` | Configuration management practices established |
| MITRE ATT&CK | `T1195.001` | Compromise Software Dependencies and Development Tools |
| MITRE ATT&CK | `T1195.002` | Compromise Software Supply Chain |

> **On framework versions.** Verify these IDs against the current ATT&CK and
> CSF releases before using them in assessed work.
