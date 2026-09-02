---
id: baseline-your-own-network
level: 1
minutes: 90
prerequisites: []
tools: [tcpdump, wireshark, python3]
nist_csf: [DE.CM-01, ID.AM-03, DE.AE-02]
attack_context: [T1071, T1071.004, T1573]
teaches_offense: false
scope: student's own machine and own network only
---

# Lesson 1 — Baseline your own network

## Why this matters

Almost every real detection is the same sentence: **"that wasn't there before."**

Not a signature, not a threat feed, not an alert from a product. Someone knew
what normal looked like, saw something that wasn't it, and pulled the thread.

Students consistently want to skip this lesson. It looks like data entry. It is
the single highest-leverage hour in the course, because a student without a
baseline has no way to evaluate anything they see later — every unfamiliar
domain looks alarming and every real intrusion looks like more of the same
noise.

## What you need

- Your own laptop, on your own network. Nothing else.
- `tcpdump` (macOS ships it) or Wireshark.
- Thirty minutes of *ordinary* usage while capturing. Not clean-room usage —
  ordinary. A baseline of an artificially quiet machine is worthless.

> **Boundary.** Capture only on a network you control, and only traffic to and
> from your own devices. On shared or institutional networks, don't. This is
> not a formality: packet capture on a network you don't own is illegal in
> most jurisdictions and it is the fastest way to end a security career before
> it starts.

## Workflow

**1. Record what you think is true, before you look.**

Open a file. Write down, from memory: how many devices are on your network,
which ones talk to the internet constantly, and which companies you expect to
see in the traffic.

Do this *first*. The gap between this list and reality is the lesson.

**2. Inventory the devices.**

```bash
# macOS — your own subnet only
arp -a
```

Record each device: IP, MAC, what you believe it is. Mark the ones you cannot
identify — those are the interesting ones, and "I don't know" is a legitimate
and important entry.

**3. Capture thirty minutes of ordinary traffic.**

```bash
sudo tcpdump -i en0 -w ~/baseline-$(date +%Y%m%d).pcap
```

Use your machine normally. Email, a browser, whatever you actually do. Stop
with Ctrl-C.

**4. Extract the DNS queries — where the story usually is.**

```bash
tcpdump -r ~/baseline-*.pcap -n port 53 2>/dev/null \
  | grep -oE 'A\? [a-zA-Z0-9._-]+' \
  | awk '{print $2}' | sort | uniq -c | sort -rn | head -40
```

**5. Build the frequency table.**

For the top forty domains, record: the domain, how many times, which device,
and **who you believe operates it.** That last column is the work. Anything
you cannot attribute goes in the write-up as an open question — not as a
threat.

**6. Look at timing.**

```bash
tcpdump -r ~/baseline-*.pcap -n 'port 53' 2>/dev/null \
  | awk '{print substr($1,1,5)}' | uniq -c
```

Human traffic is bursty. Software that checks in on a fixed interval produces
a flat line. Most flat lines are software updaters — which is exactly why
knowing *your* flat lines matters, because malware beaconing looks identical
and the only way to tell is that one of them is new.

## Verification

You have completed this lesson when you can answer, from your own notes:

1. How many devices are on your network, and how many can you name?
2. What are your ten most-contacted domains, and who operates each?
3. Which of your devices produces the most regular, machine-like traffic?
4. Name one thing in the capture you could not explain.

If you cannot answer #4, you have not looked hard enough. Every real capture
contains something unexplained. A student reporting a perfectly understood
network has stopped early.

## Where students get it wrong

- **Alarm at unfamiliar domains.** CDN and telemetry hostnames look sinister
  and are almost always mundane. Unfamiliar is not suspicious. Unfamiliar
  means unresearched.
- **Capturing a clean machine.** Baselining a laptop you just rebooted and
  didn't use produces a baseline of nothing.
- **Skipping step 1.** The predicted-vs-actual gap is the entire pedagogical
  payload. Students who skip it learn a tool instead of a lesson.
- **Treating volume as severity.** The noisiest host is usually your browser.
- **Capturing on campus or café Wi-Fi.** See the boundary note. This is the
  one error that is not merely a learning mistake.

## Write it up

Use the standard template. Two rows decide the grade:

- **Known facts** — only what the capture shows. "Device at 192.168.1.42
  issued 1,204 DNS queries for `example-cdn.net` over 30 minutes."
- **Assumptions** — everything else. "I *believe* 192.168.1.42 is the smart TV,
  based on the MAC prefix." That belongs here, not above.

A student who writes "the TV is beaconing to an ad network" has merged those
two rows and produced an accusation out of an inference. That is the failure
this course exists to prevent.

## Instructor notes

- Run this yourself on your own machine first and bring your results. Students
  respond to a real capture with real unexplained entries far better than to a
  sanitised example.
- The highest-value discussion: put two students' top-ten domain lists side by
  side. They will differ enormously. That is the point — "normal" is per-network,
  which is why baselines cannot be bought.
- Watch for the student who reports zero anomalies. Ask them to show you the
  timing table. There is always something.
- **Grading trap to enforce:** a beautifully formatted report with one
  assumption in the facts column scores below a plain report with the columns
  kept clean.

## Framework mapping

| Framework | ID | Relationship |
|---|---|---|
| NIST CSF 2.0 | `DE.CM-01` | Networks monitored to find adverse events — this lesson builds the reference point that makes monitoring meaningful |
| NIST CSF 2.0 | `ID.AM-03` | Representations of authorised network communication are maintained |
| NIST CSF 2.0 | `DE.AE-02` | Adverse events analysed to understand activity |
| MITRE ATT&CK | `T1071` | Application Layer Protocol — the behaviour a DNS baseline surfaces |
| MITRE ATT&CK | `T1071.004` | DNS specifically |

> **On framework versions.** ATT&CK and CSF revise their identifiers between
> releases. Before using these mappings in anything assessed or published,
> check the IDs against the current release rather than trusting this table.
> Citing a retired technique ID is the same class of error as citing a
> superseded ordinance.
