#!/usr/bin/env python3
"""
TSR-FLOCK-CASENUM-001  |  Missing case-number breakdown BY AGENCY
The Sentinel Report  -  Named Sources. Public Documents. Verified Facts.

Answers ONE question: is the missing-case-number rate uniform across
agencies (=> field likely optional by design) or concentrated in
specific agencies (=> worth a closer look)? CATEGORIZATION ONLY.

Auto-excludes SUSPECT files (degenerate columns, e.g. the June parsing
artifact) from the aggregate and lists them, so bad data can't poison
the result.

Usage:  python3 tsr_flock_casenum.py [INPUT_DIR]
"""
import os, sys, glob, gc
from collections import Counter
from datetime import datetime
try:
    import pandas as pd
except ImportError:
    sys.exit("pandas not found. Run:  source ~/Downloads/tsr_env/bin/activate")

INPUT_DIR = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1
                               else "~/TSR/01_SOURCE_DOCUMENTS/Flock_Surveillance/")
OUT_DIR = os.path.expanduser("~/TSR/02_WORKING/")
CHUNK = 100_000
MIN_VOL = 500          # ignore tiny agencies when ranking by rate
NEEDED = ['Org_Name', 'Case_#', 'Reason']

def is_blank(v):
    if v is None: return True
    return str(v).strip().lower() in ('', 'null', 'nan', 'none', 'na')

def ftype(fn):
    f = fn.lower()
    if 'data returned' in f: return 'NN_Data_Returned'
    if 'organizational audit' in f: return 'CPD_Org_Audit'
    if 'all transactions' in f: return 'NN_All_Transactions'
    return 'other'

files = sorted(glob.glob(os.path.join(INPUT_DIR, "*.csv")))
if not files: sys.exit(f"No CSVs in {INPUT_DIR}")

# per-agency accumulators (only from clean NN_All_Transactions files)
ag_total = Counter(); ag_missing = Counter()
suspect = []; used = []
org_audit_total = 0; org_audit_missing = 0

for path in files:
    fn = os.path.basename(path); typ = ftype(fn)
    if typ not in ('NN_All_Transactions', 'CPD_Org_Audit'):
        continue
    try:
        head = pd.read_csv(path, nrows=0)
    except Exception as e:
        print(f"  !! header fail {fn}: {e}"); continue
    cols = [c for c in NEEDED if c in head.columns]
    if 'Org_Name' not in cols or 'Case_#' not in cols:
        suspect.append((fn, "missing Org_Name/Case_# column")); continue

    rows = miss = 0; uniq_reason = set()
    tmp_total = Counter(); tmp_missing = Counter()
    for ch in pd.read_csv(path, usecols=cols, dtype=str, keep_default_na=False,
                          chunksize=CHUNK, encoding_errors='replace', on_bad_lines='skip'):
        rows += len(ch)
        org = ch['Org_Name'].fillna('')
        miss_mask = ch['Case_#'].apply(is_blank)
        miss += int(miss_mask.sum())
        for o in org[~miss_mask]:
            if not is_blank(o): tmp_total[o.strip()] += 1
        for o in org[miss_mask]:
            if not is_blank(o): tmp_total[o.strip()] += 1; tmp_missing[o.strip()] += 1
        if 'Reason' in ch:
            uniq_reason.update(x for x in ch['Reason'].unique() if not is_blank(x))
        del ch
    gc.collect()

    # SUSPECT test: degenerate reason diversity or impossible 0% missing on big file
    mpct = (miss/rows) if rows else 0
    if rows > 1000 and (len(uniq_reason) < 5 or mpct == 0):
        suspect.append((fn, f"degenerate: rows={rows:,}, uniq_reasons={len(uniq_reason)}, missing%={mpct*100:.1f}"))
        continue

    used.append((fn, typ, rows, miss))
    if typ == 'NN_All_Transactions':
        ag_total.update(tmp_total); ag_missing.update(tmp_missing)
    else:  # CPD_Org_Audit -> single agency, track separately
        org_audit_total += rows; org_audit_missing += miss
    print(f"  ✓ {fn:60s} rows={rows:>9,} missing={mpct*100:5.1f}%")

# ---------------- report ----------------
os.makedirs(OUT_DIR, exist_ok=True)
stamp = datetime.now().strftime('%Y-%m-%d_%H%M')
out = os.path.join(OUT_DIR, f"TSR-FLOCK-CASENUM-001_{stamp}.md")
L=[]; w=lambda s='': L.append(s)
def pct(a,b): return f"{100*a/b:.1f}%" if b else "n/a"

tot = sum(ag_total.values()); tmiss = sum(ag_missing.values())
w("# TSR-FLOCK-CASENUM-001  —  Missing case numbers by agency")
w(f"_Generated {datetime.now():%Y-%m-%d %H:%M} | source: {INPUT_DIR}_\n")
w("> CATEGORIZATION ONLY. Aggregate is from CLEAN National Network")
w("> All-Transactions files only. Suspect files listed + excluded.\n")

w("## Files excluded as SUSPECT (not counted)")
if suspect:
    for fn,why in suspect: w(f"- `{fn}` — {why}")
else: w("- none")

w("\n## Aggregate (clean National Network files)")
w(f"- Rows: **{tot:,}** | Missing case#: **{tmiss:,}** ({pct(tmiss,tot)})")
w(f"- Distinct agencies: **{len(ag_total):,}**")
w(f"\n**CPD Organizational Audit (Columbus only):** {org_audit_missing:,} of "
  f"{org_audit_total:,} missing ({pct(org_audit_missing,org_audit_total)})")

w("\n## Top 25 agencies by search volume — with their missing%")
w("| Agency | Searches | Missing | Missing% |")
w("|---|---:|---:|---:|")
for a,c in ag_total.most_common(25):
    m = ag_missing.get(a,0)
    w(f"| {a} | {c:,} | {m:,} | {pct(m,c)} |")

w(f"\n## Agencies with HIGH missing% (>=90%, min {MIN_VOL} searches)")
w("_Candidates for a closer look — do they never record case numbers?_\n")
w("| Agency | Searches | Missing% |")
w("|---|---:|---:|")
hi = sorted(((a, ag_total[a], 100*ag_missing.get(a,0)/ag_total[a])
             for a in ag_total if ag_total[a]>=MIN_VOL and ag_missing.get(a,0)/ag_total[a]>=0.90),
            key=lambda x:-x[1])
for a,c,p in hi[:25]: w(f"| {a} | {c:,} | {p:.1f}% |")
if not hi: w("| (none) | | |")

w(f"\n## Agencies with LOW missing% (<=10%, min {MIN_VOL} searches)")
w("_These agencies DO record case numbers — the counter-example._\n")
w("| Agency | Searches | Missing% |")
w("|---|---:|---:|")
lo = sorted(((a, ag_total[a], 100*ag_missing.get(a,0)/ag_total[a])
             for a in ag_total if ag_total[a]>=MIN_VOL and ag_missing.get(a,0)/ag_total[a]<=0.10),
            key=lambda x:-x[1])
for a,c,p in lo[:25]: w(f"| {a} | {c:,} | {p:.1f}% |")
if not lo: w("| (none) | | |")

# interpretation aid (still categorization, not conclusion)
rates = [ag_missing.get(a,0)/ag_total[a] for a in ag_total if ag_total[a]>=MIN_VOL]
if rates:
    import statistics as st
    spread = st.pstdev(rates)
    w("\n## Reading aid (not a conclusion)")
    w(f"- Spread of missing% across agencies (std dev): **{spread*100:.1f} points**")
    w("- LOW spread => rate is uniform => field is likely optional by design.")
    w("- HIGH spread => rate concentrates in some agencies => worth a closer look.")

with open(out,'w') as fh: fh.write("\n".join(L))
print(f"\n=== DONE ===\nAgencies: {len(ag_total):,} | Report: {out}")
print(f"open \"{out}\"")
