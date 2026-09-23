# ep03 — PRODUCTION SHEET

**NOT FOR PUBLICATION. Not on screen, not read aloud.**

## 1 — capture the exhibits, one at a time

```bash
bin/sentinel exhibits --edges edges.csv --entity "FIRSTENERGY" --side left --next
```

Then after each screenshot:

```bash
bin/sentinel exhibits --edges edges.csv --entity "FIRSTENERGY" --side left --done N
```

## 2 — draw the card deck

```bash
bin/sentinel cards --edges edges.csv --entity "FIRSTENERGY" --side left \
  --grade ASSERTED --limit 8 --seconds 50 \
  --theme bright --out ep03/assets --scenes ep03/cards.json
```

## 3 — check every asset the build will demand

```bash
bin/sentinel shots --spec ep03/episode.json --check
```

## 4 — the publication gate, before anything leaves

```bash
bin/sentinel redact --check ep03/SCRIPT.md
```

Exits 3 on a leak. If it exits 3, nothing ships until it exits 0.

## The exhibit list

| # | grade | side | source | document |
|---|---|---|---|---|
| 01 | ASSERTED | LR | Senate LDA quarterly filing (LD-2), 2 U.S.C. 1604 | a3f51d47-c52a-4a8b-a428-b9a2a88af9fd |
| 02 | ASSERTED | L | Senate LDA quarterly filing (LD-2), 2 U.S.C. 1604 | 9a13ba1a-b529-41c5-9ed4-6a5c57a0d70d |
| 03 | ASSERTED | L | Senate LDA quarterly filing (LD-2), 2 U.S.C. 1604 | 98e2bbc1-3b61-4a60-abf5-886fcc98a5ad |
| 04 | ASSERTED | L | Senate LDA quarterly filing (LD-2), 2 U.S.C. 1604 | 24e1c426-c544-414a-a299-767c544a4959 |
| 05 | ASSERTED | L | USAspending / FPDS-NG award record | 89243323FFE400492 |
| 06 | ASSERTED | L | USAspending / FPDS-NG award record | GS05P00GBC0013 |
| 07 | ASSERTED | L | USAspending / FPDS-NG award record | 75D30125F20383 |
| 08 | ASSERTED | L | USAspending / FPDS-NG award record | W911N226FA066 |
