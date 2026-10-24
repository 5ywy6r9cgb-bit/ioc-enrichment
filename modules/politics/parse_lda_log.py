#!/usr/bin/env python3
"""Parse 'Senate LDA (lobbying) -- authorized run' blocks from a saved terminal log into
rows that keep the capture hash, filing id and filing URL. Reads one file, writes two files, runs nothing else.
Usage: python3 parse_lda_log.py LOG.txt OUT_DIR"""
import csv, hashlib, json, re, sys
from pathlib import Path
HEAD = re.compile(r'^Senate LDA \(lobbying\)')
ROW = re.compile(r'^\s{4}(\S.*?) — (.+?)\s*$')
KV = re.compile(r'^\s{6}(\w+)\s+(.*?)\s*$')

def norm(s): return re.sub(r'[^A-Z0-9]+', ' ', s.upper().replace('INC.', 'INC')).strip()

def parse(text):
    runs, cur, row = [], None, None
    for ln in text.splitlines():
        if HEAD.match(ln):
            cur = {'subject': None, 'capture': None, 'sha256': None, 'rows': [], 'reported_rows': None}; runs.append(cur); row = None; continue
        if cur is None: continue
        m = re.match(r'^  subject\s+(.*)$', ln)
        if m and cur['subject'] is None: cur['subject'] = m.group(1).strip(); continue
        m = re.match(r'^  capture\s+(\S+)', ln)
        if m: cur['capture'] = m.group(1); continue
        m = re.match(r'^  sha256\s+([0-9a-f]{64})', ln)
        if m: cur['sha256'] = m.group(1); continue
        m = re.search(r'·\s+(\d+) row\(s\) returned', ln)
        if m: cur['reported_rows'] = int(m.group(1)); continue
        if re.match(r'^\S', ln) and not HEAD.match(ln) and ln.strip() and cur['rows'] and not ln.startswith(('Senate', ' ')):
            cur = None; row = None; continue
        m = ROW.match(ln)
        if m and 'external_id' not in ln and not ln.lstrip().startswith(('request', 'asking', 'key', 'boundary')):
            row = {'client': m.group(1).strip(), 'registrant': m.group(2).strip()}; cur['rows'].append(row); continue
        m = KV.match(ln)
        if m and row is not None and m.group(1) in ('external_id', 'period', 'amount', 'issues', 'url'):
            row[m.group(1)] = m.group(2)
    return runs

def flatten(runs):
    out = []
    for r in runs:
        for x in r['rows']:
            if 'external_id' not in x: continue
            self_filed = norm(x['client']).split(' ')[0] == norm(x['registrant']).split(' ')[0] and norm(x['client'])[:6] == norm(x['registrant'])[:6]
            amt = x.get('amount')
            out.append({'search_subject': r['subject'], 'capture_file': r['capture'], 'capture_sha256': r['sha256'],
                        'client': x['client'], 'registrant': x['registrant'], 'period': x.get('period', ''),
                        'amount_usd': float(amt) if amt else None,
                        'amount_kind': ('EXPENSES_in_house (inferred from matching names)' if self_filed else 'INCOME_to_outside_firm') if amt else 'NO_AMOUNT_SHOWN',
                        'issues': x.get('issues', ''), 'filing_id': x['external_id'], 'filing_url': x.get('url', ''),
                        'grade': 'REPORTED (API capture; open the filing before air)'})
    return out

if __name__ == '__main__':
    log, outdir = Path(sys.argv[1]), Path(sys.argv[2]); outdir.mkdir(parents=True, exist_ok=True)
    text = log.read_text(encoding='utf-8', errors='replace')
    runs = parse(text); rows = flatten(runs)
    meta = {'source_log_sha256': hashlib.sha256(text.encode('utf-8', 'replace')).hexdigest(),
            'runs': [{'subject': r['subject'], 'capture': r['capture'], 'capture_sha256': r['sha256'], 'rows_returned_by_api': r['reported_rows'], 'rows_visible_in_log': len([x for x in r['rows'] if 'external_id' in x])} for r in runs],
            'note': 'The log prints at most 15 rows per run; rows_returned_by_api can be larger. Totals are FLOORS. Income (outside firms) and expenses (in-house) are never added.'}
    (outdir / 'lda_rows.json').write_text(json.dumps({'meta': meta, 'rows': rows}, indent=1))
    with (outdir / 'lda_rows.csv').open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print(len(runs), 'runs,', len(rows), 'rows')
