# Runbook — police accountability, Ohio

## Read this first, because it decides whether the work survives contact

The way to lose this story is to go looking for instances that prove a
conclusion you already hold. It feels productive and it produces the weakest
possible product: a pile of anecdotes, each individually explainable, that a
department's press officer dismantles in a paragraph. Everyone who has been
doing this a while has watched it happen.

The way to win it is boring and it is devastating: **request the same records
from many departments, in the same form, and publish the numbers.** Where the
numbers come back bad, the department has to explain its own data. Where they
come back clean, you have said something true and your next finding is
believed.

This is the same rule already written into this repo, applied to a subject
that is harder to stay disciplined about:

> A search result is a lead. A co-occurrence is a place to look. A filing is
> an asserted relationship. Only a document you fetched, hashed and read
> supports a claim.

Two more that matter specifically here:

- **A complaint is an allegation.** A sustained finding is a fact about a
  finding. A settlement is a fact about a payment, and most settlements
  explicitly deny liability. Keep those three apart in every sentence.
- **Officers are private people with public duties.** Name an officer when a
  public record names them in their official capacity — a court filing, a
  decertification record, a sustained finding. Do not build a dossier on a
  person because they were on a shift. The desk's own boundary refuses
  `private_individual` for a reason.

---

## The ten steps

### 1 · Finish the request you already have

`PRR-2026-391` (Gahanna) has been silent past your follow-up cadence. **An
agency that does not answer records requests is itself a documented
accountability fact** — and it is the one you can already prove.

```
bin/sentinel pra foia draft PRR-2026-391
bin/sentinel foia dash
```

Send the escalation by certified mail. R.C. 149.43 sets no day count, so the
clock is your cadence — but certified mail puts the R.C. 149.43(C)(2)
transmission predicate beyond argument if this ever becomes a mandamus.

### 2 · The policy manual, from every department at once

Ask each department for its current use-of-force policy, pursuit policy, and
body-worn camera policy including **retention schedule**. These are routinely
released; a refusal is itself the story.

The retention schedule is the sleeper. It tells you how long footage exists —
and therefore how long you have to ask for any given incident before it is
lawfully gone.

### 3 · The records-retention schedule itself

Every Ohio public office has an approved records retention schedule (RC-2 /
RC-3 forms filed with the Ohio History Connection's Local Government Records
Program). Request the department's. It is a public document that lists what
they keep and for how long, and it is the map for every later request.

### 4 · Complaint and discipline data, as counts

Not files — **counts**, by year: complaints received, complaints sustained,
by category, and the discipline imposed. Ohio agencies vary in what they
release, and the variation is itself comparable data.

A department that sustains 2% of complaints and one that sustains 30% are
describing either two very different departments or two very different
processes. Either is a story.

### 5 · The union contract

The FOP collective bargaining agreement is a public record. It contains the
disciplinary procedure: how long an officer has before an interview, what gets
purged from a file and when, what an arbitrator may overturn.

**This is the most under-reported document in police accountability and it is
sitting on a city clerk's website.** It is structural, provable, and it does
not require a single anonymous source.

### 6 · Settlements and judgments — follow the money

City councils authorize settlement payments by ordinance. Those ordinances
are public, indexed, and name the case.

```
bin/sentinel connect courtlistener "City of Gahanna"
bin/sentinel connect courtlistener "Gahanna Division of Police"
bin/sentinel doc get "<the S.D. Ohio docket PDF>"
```

Federal civil-rights suits (42 U.S.C. §1983) are in CourtListener/RECAP. Pair
each with the council ordinance that paid it. **What a city paid out, and for
what, is a number no press officer can reframe.**

### 7 · Surveillance procurement — the ALPR thread you already own

```
bin/sentinel connect sweep police_oversight --new-only --go
bin/sentinel connect federalgrants "City of Gahanna"
bin/sentinel connect usaspending "Flock Safety"
```

Then request from each department: the Flock/ALPR **contract**, the
**data-sharing agreements** (which outside agencies can query your cameras),
the **audit logs** of who ran searches and under what case number, and the
**hotlist policy**.

The audit log is the document that matters. A search run without a case
number is the finding, and it is a fact about a record rather than an opinion
about a department.

### 8 · State certification status

Ohio has two state-level records almost nobody asks for:

- **Ohio Collaborative Community-Police Advisory Board** certification — which
  agencies are certified as compliant with state standards on use of force and
  hiring, and which are not. Non-certification is public.
- **Ohio Peace Officer Training Commission** decertification records — officers
  who lost state certification, and why.

An officer who was decertified in one county and hired in another is a
documented fact with a paper trail at both ends. Small departments are where
that happens, and it is checkable without a single anonymous source.

### 9 · Federal money and military surplus

```
bin/sentinel connect usaspending "<department or city>"
bin/sentinel connect federalgrants "<department or city>"
```

Byrne JAG grants, COPS hiring grants, and 1033 program transfers all leave
federal records. A small department with an armored vehicle acquired through
1033 is a fact with a form number behind it.

### 10 · Publish the table, then the story

Build the comparison first — every department, the same rows. **Then** the
narrative, on the outliers your own table found.

```
bin/sentinel case new police "Franklin County police records — comparison"
bin/sentinel case add police EX-1 <document> --kind policy --pages <n>
bin/sentinel case status police
```

The gate applies here exactly as it does everywhere else: an open question
blocks publication, and there is no override.

---

## What to do when a department stonewalls

That IS the finding, and it is provable. Log every non-response with dates and
transmission method. A pattern of unanswered statutory records requests across
several small departments is a stronger, cleaner story than any single
incident — and R.C. 149.43(C) gives it teeth that an anecdote never has.

## What not to publish

- An officer's home address, family, or vehicle. Ever, for any reason.
- A complaint as though it were a finding.
- A settlement as though it were an admission. Most explicitly are not.
- Anything from a source who would be identifiable by what only they knew.
