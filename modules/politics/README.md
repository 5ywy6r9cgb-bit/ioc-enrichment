# Political pack, seed 1: lobbying filings from the 22 Oct 2026 terminal log

What this is: 75 Senate LDA filing rows (7 searches) pulled out of your saved terminal log with
`parse_lda_log.py`, each kept with its filing id, filing URL and the SHA-256 of the capture file it came from.
Grade for every row: REPORTED (API capture). Open the filing print page before anything goes on air.

Rules built into the data:
- Income (outside firms) and expenses (in-house filings) are labeled and never added together.
- The log prints 15 of 25 rows per search, so every total is a FLOOR.
- "In-house" is inferred from matching client and registrant names. It is DERIVED, not stated by the filing.
- LDA amounts are not allocable to a bill. Specific bills appear only in each filing's issues text.

Run: python3 -I parse_lda_log.py YOUR_LOG.txt out   then   python3 -I test_lda.py
