# Learn the law through local records

Updated October 11, 2026. The desk's immediate purpose is private learning: understand a question, find its governing authority, examine the records, and explain what the evidence supports. Publishing is optional. Nothing in this workflow requires social media, a cloud deployment or a new paid service.

## Start with one question

Choose one concrete decision: a development agreement, a utility proposal, a school budget or a surveillance purchase. Work through the same six steps:

1. **Question.** State what you want to understand without assuming the answer: “Who authorized this expense, under what authority, and what was actually paid?”
2. **Authority.** Read the relevant statute, rule, ordinance or contract. Save its section/paragraph, jurisdiction, version and effective date. A bill or proposed rule is not an effective law. The version applying when an event occurred may differ from today's text.
3. **Procedure.** Identify who decides, the public process, required documents and the decision's current stage. Distinguish an agenda item, recommendation, adopted ordinance, signed agreement and payment.
4. **Evidence.** Read the actual record, not only its headline or search snippet. Record a page/paragraph, original URL, retrieval date and capture hash. A complaint contains allegations; a court's holding requires the opinion and procedural context. Check later appeals or amendments before calling a result final.
5. **Context.** Choose the correct geography, time period, units and denominator. Keep administrative records, forecasts and survey estimates separate. Ask what the numbers leave out.
6. **Explanation.** Write five sentences: what happened; what authority governs; what the records establish; the strongest alternative explanation; what remains unknown. Add one question to investigate next. Review the explanation a week later without looking at your notes.

## Official starting points

| Learning task | Primary source | What to save |
|---|---|---|
| Understand public-record access | [Ohio Revised Code 149.43](https://codes.ohio.gov/ohio-revised-code/section-149.43) | Exact subsection, applicable version and stated exceptions |
| Understand public meetings | [Ohio Revised Code 121.22](https://codes.ohio.gov/ohio-revised-code/section-121.22) | Definitions, applicable duties/exceptions, meeting records and dates |
| Read a judicial explanation | [Ohio judicial opinion search](https://www.supremecourt.ohio.gov/rod/docs/) | Court, case citation, date, issue, holding, reasoning and procedural posture |
| Follow a bill's development | [Ohio Legislature](https://www.legislature.ohio.gov/) | General Assembly, chamber, bill ID, version, votes and status |
| Understand community conditions | The local Census context report | ACS 2020–2024, GEOID, universe, component counts, uncertainty and receipts |

The records and meetings statutes and opinion-search page were accessible during this review. The Legislature landing/search pages timed out, so no current bill-status review is claimed here. These links are starting points, not a completed search of the law or proof that an agency complied with it.

**A useful first lesson in version control:** the current official 149.43 page displays an effective date of September 7, 2026 and identifies House Bill 31 of the 136th General Assembly. An older checklist discussing April 2025 cannot establish the current text. Compare the relevant provisions and their applicability before relying on procedural advice; this guide does not prescribe a lawsuit or filing deadline. [Official section](https://codes.ohio.gov/ohio-revised-code/section-149.43).

## Use the working data now

```bash
cd "$HOME/sentinel"
./bin/sentinel connect census context list
./bin/sentinel connect census context plan
```

Those commands show the available measures and planned geography without network calls or writes. To check a saved run, use `./bin/sentinel connect census context verify` followed by its directory. A new collection is optional; a recent retained capture is enough for learning the method.

Begin with **rent burden**. Explain why the numerator covers four categories, why the denominator excludes not-computed cases, why vacant housing is a different universe, and why county averages cannot describe a named person or prove a development's effect. Then read one governing local agreement and ask what additional records would connect its obligations to actual outcomes.

## Build outward in this order

- **Now working:** private Census collection, reproducible calculations, charts, source receipts and verification. Use these to practice reading evidence.
- **Next bounded addition:** one source-linked study card using `STUDY-CARD.md`, followed by a dated timeline for one local decision. A saved link alone never earns a “reviewed” label.
- **Later integrations:** aggregate school records, parcel/agreement/payment records, utility dockets and environmental permits, each with its own coverage check. The source inventory is a plan, not installed collection.
- **Later cloud learning:** a separately approved Azure pilot. No credits were spent for this review.

The desk can organize what you know and expose gaps. It cannot certify complete knowledge of current law or world events. Keep a visible “last checked” date and treat unreviewed or unavailable sources as unresolved.
