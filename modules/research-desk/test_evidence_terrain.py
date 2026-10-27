#!/usr/bin/env python3
import os, sys, tempfile, unittest, csv
sys.path.insert(0, os.path.dirname(__file__))
import evidence_terrain as T


class Terrain(unittest.TestCase):
    def test_edge_needs_type_and_distinct_ends(self):
        rows = [{"source": "A", "target": "B", "relationship": "FILED_FOR"},
                {"source": "A", "target": "A", "relationship": "x"},
                {"source": "A", "target": "C", "relationship": ""},
                {"source": "", "target": "C", "relationship": "x"}]
        ok, err = T.parse_edges(rows)
        self.assertEqual(len(ok), 1); self.assertEqual(len(err), 3)

    def test_unsafe_urls_dropped(self):
        self.assertEqual(T.uclean("javascript:alert(1)"), "")
        self.assertEqual(T.uclean("https://example.gov/x"), "https://example.gov/x")

    def test_html_cannot_be_broken_out_of(self):
        html = T.make_html({"edges": [{"a": "</script><b>", "b": "x", "kind": "k", "grade": "g", "url": "", "evidence_id": "", "as_of": "", "amount": "", "note": ""}],
                            "sites": [], "ads": [], "limitations": []})
        self.assertNotIn("</script><b>", html)

    def test_bad_coordinates_rejected(self):
        ok, err = T.parse_sites([{"name": "p", "latitude": "99", "longitude": "10"}, {"name": "q", "latitude": "40", "longitude": "-83"}])
        self.assertEqual(len(ok), 1); self.assertEqual(len(err), 1)

    def test_cli_returns_3_on_zero_accepted(self):
        d = tempfile.mkdtemp(); p = os.path.join(d, "e.csv")
        with open(p, "w", newline="") as f:
            csv.writer(f).writerows([["foo", "bar"], ["1", "2"]])
        self.assertEqual(sys.modules["evidence_terrain"].main.__name__, "main")
        sys.argv = ["x", "--edges", p, "--out", os.path.join(d, "o.html")]
        self.assertEqual(T.main(), 3)


if __name__ == "__main__":
    unittest.main(verbosity=1)
