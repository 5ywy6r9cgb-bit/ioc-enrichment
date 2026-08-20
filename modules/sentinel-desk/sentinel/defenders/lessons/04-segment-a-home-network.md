---
id: segment-a-home-network
level: 2
minutes: 90
prerequisites: [baseline-your-own-network]
tools: [router admin interface]
nist_csf: [PR.IR-01, PR.AA-05, ID.AM-03]
attack_context: [T1021, T1210]
teaches_offense: false
scope: the student's own home network only
---

# Lesson 4 — Segment a home network

## Why this matters

Segmentation does more for a small network than any product you can buy, and
it is free. It is also the clearest example in the course of **containment as
a design property** rather than a detection: you are not trying to notice the
compromise, you are arranging things so the compromise reaches less.

The realistic threat in a home is not a targeted attacker. It is a smart TV
with firmware nobody has patched since 2021, a relative who clicks a link, and
a work laptop on the same flat network as both.

## What you need

Your router's admin page. That is all.

## Workflow

**1. Inventory first.** Use Lesson 1's device list. If you skipped it, do it
now — you cannot segment a network you have not enumerated.

**2. Sort every device into exactly one tier.**

| Tier | What goes there | Why |
|---|---|---|
| **Work** | The machine your research and credentials live on | Highest value, smallest population |
| **Personal** | Phones, personal laptops | Ordinary use, ordinary risk |
| **IoT** | TVs, speakers, cameras, appliances | Unpatchable, chatty, most likely to be compromised |
| **Guest** | Visitors' devices, anything you don't administer | Unknown state by definition |

The rule that does the work: **IoT and Guest must not be able to reach Work.**
Everything else is refinement.

**3. Create the networks.** Most consumer routers offer at least a guest
network with client isolation. That single switch gets you most of the benefit.
Better routers do VLANs. Use what you have — a partial segmentation done today
beats a perfect one planned indefinitely.

**4. Enable client isolation** on Guest and IoT. Without it, devices on the
same guest network can still reach each other, which is most of what you were
trying to prevent.

**5. Move devices.** Expect two hours of small breakages: a printer that only
works from one network, a casting device that needs discovery traffic. Each
one is a real lesson about why flat networks persist — convenience is the
reason segmentation is rare, not ignorance.

**6. Test it, rather than assuming it.**

From a device on Guest, try to reach your work machine:

```bash
ping -c 2 <work-machine-ip>          # should fail
```

Untested segmentation is a diagram, not a control. This step is the lesson.

**7. Re-baseline.** Run Lesson 1 again per network. The IoT segment's traffic
in isolation is often startling, and much easier to read once it is not mixed
with everything else.

## Verification

1. A table of every device and its tier.
2. Evidence of a *failed* connection attempt from Guest to Work.
3. A written note of what broke and how you resolved it.

## Where students get it wrong

- **Segmenting without isolation.** A guest network without client isolation
  still lets guest devices talk to each other.
- **Never testing.** By far the most common. The router said it worked.
- **Putting the work machine on IoT for convenience** because the printer is
  there. Move the printer, or accept printing from Personal.
- **Treating this as one-time.** Every new device is a tier decision. Ask it
  at purchase, not after.

## Write it up

Standard template. **Evidence** must include the failed connection test. A
report claiming segmentation without a demonstrated denial has claimed a
control it has not shown.

## Instructor notes

- Students with landlord-provided or ISP-locked routers may only have a guest
  network. That is fine — teach the reasoning, and have them document the
  constraint. Working within a limitation you can name is a real skill.
- Good discussion: who else is on their network that they do not administer?
  This is where students realise segmentation is partly a *social* problem,
  and that "ask your roommate to move their console" is a legitimate control.

## Framework mapping

| Framework | ID | Relationship |
|---|---|---|
| NIST CSF 2.0 | `PR.IR-01` | Networks and environments are protected from unauthorised logical access |
| NIST CSF 2.0 | `PR.AA-05` | Access permissions incorporate least privilege and separation of duties |
| NIST CSF 2.0 | `ID.AM-03` | Representations of authorised network communication are maintained |
| MITRE ATT&CK | `T1021` | Remote Services — the lateral movement segmentation constrains |
| MITRE ATT&CK | `T1210` | Exploitation of Remote Services |

> Verify IDs against the current framework release before using them in
> assessed work.
