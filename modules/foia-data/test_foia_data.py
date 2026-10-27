#!/usr/bin/env python3
import csv, io, os, sys, tempfile, unittest, urllib.error
sys.path.insert(0, os.path.dirname(__file__))
import foia_data as F

HDR = ["Agency", "Component", "Fiscal Year", F.PEND_S, F.RECV, F.PROC, F.PEND_E]
RT = ["Agency", "Component", "Fiscal Year", F.RT_SIMPLE, F.RT_COMPLEX]


def write(path, header, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(header); w.writerows(rows)


class Fx(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        write(os.path.join(self.d, "y2025", "foia-received-processed-and-pending-foia-requests (14).csv"), HDR, [
            ["Dept A", "Agency Overall", "2025", "10", "1,000", "900", "110"],
            ["Dept A", "Sub unit", "2025", "5", "400", "300", "105"],
            ["Dept B", "Agency Overall", "2025", "0", "100", "100", "0"],
            ["All agencies", "Agency Overall", "2025", "10", "1,100", "1,000", "110"]])
        write(os.path.join(self.d, "y2025", "foia-processed-requests-response-time-for-all-processed-perfected-requests (2).csv"), RT, [
            ["Dept A", "Agency Overall", "2025", "<1", "40"], ["Dept B", "Agency Overall", "2025", "N/A", "N/A"]])

    def test_total_row_excluded(self):
        t = F.totals(self.d, "2025")
        self.assertEqual((t["agencies"], t["received"], t["processed"]), (2, 1100, 1000))

    def test_components_not_summed(self):
        self.assertEqual(F.totals(self.d, "2025")["pending_end"], 110)

    def test_non_numeric_cells_kept_as_text(self):
        sb = {r["agency"]: r for r in F.scoreboard(self.d, "2025")}
        self.assertEqual(sb["Dept A"]["simple_median_days"], "<1")
        self.assertEqual(sb["Dept B"]["complex_median_days"], "N/A")

    def test_percent_and_sort(self):
        sb = F.scoreboard(self.d, "2025")
        self.assertEqual(sb[0]["agency"], "Dept A")
        self.assertEqual(sb[0]["processed_pct"], 90.0)

    def test_missing_year_is_empty_not_zero_success(self):
        t = F.totals(self.d, "1999")
        self.assertIsNone(t["source"]); self.assertEqual(t["received"], 0)

    def test_source_hash_present(self):
        self.assertEqual(len(F.totals(self.d, "2025")["sha256"]), 64)


class Api(unittest.TestCase):
    def test_no_key(self):
        r = F.api_check(env={}); self.assertFalse(r["ok"]); self.assertIsNone(r["status"])

    def test_key_never_in_result(self):
        class Resp:
            status = 200
            def read(self, n=0): return b'{"data": []}'
            def __enter__(self): return self
            def __exit__(self, *a): return False
        r = F.api_check(opener=lambda req, timeout=0: Resp(), env={"FOIA_API_KEY": "SECRETSECRET"})
        self.assertTrue(r["ok"]); self.assertNotIn("SECRETSECRET", str(r))

    def test_403_reports_status(self):
        def boom(req, timeout=0):
            raise urllib.error.HTTPError("u", 403, "Forbidden", {}, io.BytesIO(b""))
        r = F.api_check(opener=boom, env={"FOIA_API_KEY": "k" * 40})
        self.assertFalse(r["ok"]); self.assertEqual(r["status"], 403)

    def test_200_wrong_shape_is_not_ok(self):
        class Resp:
            status = 200
            def read(self, n=0): return b"<html>"
            def __enter__(self): return self
            def __exit__(self, *a): return False
        r = F.api_check(opener=lambda req, timeout=0: Resp(), env={"FOIA_API_KEY": "k"})
        self.assertFalse(r["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
