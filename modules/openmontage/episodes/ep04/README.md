# ep04 — Ohio Senate money, from the filings
Built only from GREEN cards in docs/EVIDENCE_CARDS.json (generated 2026-09-10). Every caveat is pulled verbatim from its card.
Rebuild (from modules/openmontage/episodes/ep04):
  python3 verify_cards.py && python3 make_charts.py && python3 make_spec.py
  python3 ../../engine/openmontage.py --spec episode.json --check-safe
  python3 make_cards.py
  python3 ../../engine/openmontage.py --spec episode.json --out builds/ep04_ohio_money.mp4
Before posting: open each card's `verify` URL and re-confirm the figure against the FEC (this build checks the arithmetic, not the register).
Not used on purpose: HUSTED-01 (RETRACTED), AMBER cards, and the 15.70x ceiling on BROWN-01.
