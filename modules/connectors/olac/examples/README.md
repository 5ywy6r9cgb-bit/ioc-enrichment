# Synthetic examples — NOT EVIDENCE

The two JSON files here are **invented**. No such filings exist. They are here
so `amendment_detect.js` can be run and understood before you have captured a
real pair, and so the difference the tool looks for is visible in one screen.

Every file carries `"_synthetic": true`. Never copy one into `evidence/`, never
cite one, and never let one reach the database. A synthetic filing that gets
mistaken for a capture is worse than no example at all.

Run:

    node ../amendment_detect.js example_original.json example_amended.json
