# Publication One — "One Bill"

## Why this one, and not the bigger ones

Four stories are on the board. Three are strong and already published by
somebody else:

| Story | Strength | Problem |
|---|---|---|
| Tax-exemption forecast off by 11x ($1.57B) | High | Signal Ohio broke it |
| AEP double-counted data-center load into the Secondary Service class | High | Utility Dive and Ohio Capital Journal reported it |
| Behind-the-meter cluster in New Albany serving one customer | High | Farm and Dairy, DCD, APPA covered it |
| **HB 15 and HB 695 have inverted coverage** | **Medium-high** | **Nobody has written it** |

A first publication should be the one that is *ours*, small enough to be
airtight, and provable from documents anyone can re-pull. That is the fourth.

Re-reporting the first three is worth doing later, with our own primary pulls.
Leading with them means competing on somebody else's scoop with weaker
sourcing than they had.

---

## The claim, stated so it can be attacked

**Ohio removed local authority over data-center power plants from every local
government, then wrote its transparency fix so it does not reach cities.**

Two supporting facts, each from one document:

**A. HB 15 (136th G.A.)** creates the behind-the-meter siting pathway. Power
generation over 50 MW falls under the exclusive jurisdiction of the Ohio Power
Siting Board; no local government may require a permit. *And the same bill
repeals parts of H.B. 6 of the 133rd General Assembly* — the statute at the
center of the FirstEnergy prosecution.

**B. HB 695** enacts R.C. **305.44** (county commissioners), **505.96**
(township trustees), **731.142** (village legislative authorities), and
**733.241** (village mayors). Four sections. No city.

**The consequence, which is arithmetic on those two facts:** Hilliard is a
city. It is the one local government on the record that fought a
behind-the-meter approval and lost — AEP withdrew its zoning application and
told the city no further review was necessary. Under HB 15 it had no
authority. Under HB 695 as introduced it has no disclosure protection either.
The Worthington City Council JEDD amendment that added Cologix COL6 is in the
same excluded class, while the Delaware County CRA approving the same project
is covered.

---

## What this piece does NOT claim

State these in the piece, not just in the notes. A story that names its own
limits is the one that survives being checked.

- **No intent.** That two mechanisms ride in one bill is a fact about the
  bill's scope. It is not evidence of a deal, a favor, or coordination.
- **Not a new HB6.** Nothing found across seven research passes shows
  undisclosed money into candidate-electing PACs or a bribe to a regulator.
  The HB6 material is structural context for readers — what capture looked
  like last time — never an implied equivalence.
- **Not "hidden ownership."** Cologix's structure is disclosed private equity
  with a named parent and LLCs that litigate under their own names. Shell-LLC
  land assembly is ordinary and legal. Say so; asserting otherwise would be
  false and would discredit the parts that hold.
- **The city exclusion may be deliberate and defensible.** Home rule is a
  constitutional constraint, not a loophole someone slipped in. The story is
  the *effect*, not an accusation about the drafting.

---

## The three documents that carry it

Nothing else is required. Every other source in the file is background.

1. HB 15 bill text — `legislature.ohio.gov/legislation/136/hb15`
2. HB 695 bill text — `legislature.ohio.gov/legislation/136/hb695`
3. LSC analysis of HB 695 — `legislature.ohio.gov/download?key=27372`

The LSC analysis matters because it is the legislature's own neutral drafting
body. A sponsor's press release and an advocacy read are both interested; the
LSC is the one summary no one will argue is spun.

Supporting, already reachable, for the Hilliard illustration: Ohio Capital
Journal's on-scene reporting, and the OPSB orders for the New Albany and Wood
County plants.

---

## What would kill it

Check these before drafting a sentence. Any one of them ends the piece, and
finding that out yourself is far better than finding it out in a correction.

- **HB 695 covers cities somewhere else.** A general municipal section, or
  R.C. 731.142 turning out to reach city legislative authorities rather than
  villages only. Read the enacted sections; do not infer from the summary.
- **A later substitute version added cities.** Check the bill's status and
  documents tabs, not just the as-introduced text.
- **HB 15 does not actually preempt city zoning** for the facility class at
  issue, or carves out an exception. Read R.C. 4906.13(B) as amended.
- **The HB6 repeal is trivial** — a stale cross-reference rather than
  substantive. Read what is actually repealed before characterizing it. If it
  is housekeeping, drop that thread entirely rather than shading it.

---

## The gate sequence

```
bin/sentinel case new onebill "One bill: HB 15, HB 695, and who is left covered"
bin/sentinel case add onebill EX-1 <hb15 text file> --kind statute --pages <n>
bin/sentinel case add onebill EX-2 <hb695 text file> --kind statute --pages <n>
bin/sentinel case add onebill EX-3 <LSC analysis file> --kind analysis --pages <n>
bin/sentinel case read onebill EX-1 --pages <n>
bin/sentinel case read onebill EX-2 --pages <n>
bin/sentinel case read onebill EX-3 --pages <n>
bin/sentinel case ask onebill "Does any enacted section of HB 695 reach city councils or city mayors?"
bin/sentinel case ask onebill "Does HB 15 preempt CITY zoning for 50MW+ behind-the-meter generation, or only township and county?"
bin/sentinel case ask onebill "What specifically does HB 15 repeal from H.B. 6 of the 133rd G.A. — substantive provisions or cross-references?"
bin/sentinel case status onebill
```

Three questions, and the piece is only publishable when all three are answered
from the exhibits. Answer them with what the text says, not with what would be
convenient:

```
bin/sentinel case answer onebill Q-1 "<what the bill text actually says>"
```

Then:

```
bin/sentinel sdesk ready onebill
bin/sentinel sdesk export onebill
```

---

## Length and shape

Eight hundred words. A structural finding does not need three thousand, and
padding it with the background threads is how a tight piece becomes an
unfalsifiable one.

- **Lede:** Hilliard asked for review and was told none was necessary.
- **Turn:** the bill that made that legal, and what else was in it.
- **The finding:** four section numbers, and the word that is not among them.
- **The limits:** everything under "What this piece does NOT claim."
- **The open question, put to the sponsors:** was the city exclusion
  deliberate, and does home rule actually prevent it? Ask Bird and Stewart
  before publishing, and print the answer or print that they did not respond.

That last step is not optional. A piece about transparency that did not ask
the people it names is not the piece.
