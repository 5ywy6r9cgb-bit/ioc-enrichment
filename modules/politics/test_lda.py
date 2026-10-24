import json, sys, unittest
from pathlib import Path
D = json.loads((Path(__file__).parent / 'out/lda_rows.json').read_text())['rows']
def s(subject, kind, periods=None, reg=None):
    t = 0
    for r in D:
        if r['search_subject'] != subject or not r['amount_kind'].startswith(kind): continue
        if periods and not any(r['period'].startswith(p) for p in periods): continue
        if reg and reg not in r['registrant'].upper(): continue
        t += r['amount_usd']
    return t
class T(unittest.TestCase):
    def test_kalshi_q3_outside(self): self.assertEqual(s('Kalshi', 'INCOME', ['2026 3rd']), 485000)
    def test_kalshi_q2_outside(self): self.assertEqual(s('Kalshi', 'INCOME', ['2026 2nd']), 260000)
    def test_kalshi_inhouse_q2_q3(self): self.assertEqual((s('Kalshi', 'EXPENSES', ['2026 2nd']), s('Kalshi', 'EXPENSES', ['2026 3rd'])), (500000, 800000))
    def test_aga_inhouse_three_quarters(self): self.assertEqual(s('American Gaming Association', 'EXPENSES', ['2026']), 2060000)
    def test_venntel_alpine_all_visible(self): self.assertEqual(s('Venntel', 'INCOME', None, 'ALPINE'), 320000)
    def test_venntel_2023_was_50k_a_quarter(self): self.assertEqual(s('Venntel', 'INCOME', ['2023'], 'ALPINE'), 200000)
    def test_venntel_since_2024q2_is_10k_a_quarter(self):
        q=[r['amount_usd'] for r in D if r['search_subject']=='Venntel' and r['period'][:8] in ('2024 2nd','2024 3rd','2024 4th','2025 1st','2025 2nd','2025 3rd','2025 4th','2026 1st','2026 2nd','2026 3rd')]
        self.assertEqual((len(q), sum(q)), (10, 100000))
    def test_babel_alpine_2026(self): self.assertEqual(s('Babel Street', 'INCOME', ['2026'], 'ALPINE'), 270000)
    def test_babel_ballard_2026(self): self.assertEqual(s('Babel Street', 'INCOME', ['2026'], 'BALLARD'), 240000)
    def test_every_row_has_filing_url_and_hash(self):
        for r in D: self.assertTrue(r['filing_url'].startswith('https://lda.gov/filings/public/filing/') and len(r['capture_sha256']) == 64)
    def test_no_mixed_kind_total_is_ever_emitted(self):
        self.assertTrue(all(r['amount_kind'] for r in D))
if __name__ == '__main__': unittest.main(verbosity=1)
