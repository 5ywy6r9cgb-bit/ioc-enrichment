#!/usr/bin/env python3
import json, os, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
import publish as P
from sentinel import store

XSS = "<script>alert(1)</script>"


def seed(root):
    c = store.open_db(root)
    c.execute("INSERT INTO cases (slug,title,jurisdiction,status) VALUES ('demo-case',?, 'Ohio','OPEN')", ("Demo " + XSS,))
    cid = c.execute("SELECT id FROM cases").fetchone()["id"]
    for i, (cust, sha) in enumerate([("City Clerk", "a" * 64), ("County Auditor", "b" * 64)]):
        c.execute("INSERT INTO documents (case_id,title,custodian,shelf,sha256,bytes,received) VALUES (?,?,?,?,?,?,?)",
                  (cid, f"Doc {i}", cust, "PRIMARY", sha, 10, "2026-01-01"))
    def claim(text, tier="GREEN", docs=(1,), **kw):
        cur = c.execute("INSERT INTO claims (case_id,text,tier,origin,disposed_by,disposed_at,closing_gate,formula,outlet,resolution) "
                        "VALUES (?,?,?,'human','op','2026-01-01',?,?,?,?)",
                        (cid, text, tier, kw.get("gate"), kw.get("formula"), kw.get("outlet"), kw.get("resolution")))
        for d in docs:
            c.execute("INSERT INTO citations (claim_id,doc_id,locator,quote) VALUES (?,?,?,?)", (cur.lastrowid, d, "p.1", None))
        return cur.lastrowid
    ids = {"ok2": claim("The minutes record 4 members present.", docs=(1, 2)),
           "ok1": claim("The contract states $5,000."),
           "xss": claim("The record lists " + XSS + " as the vendor."),
           "acc": claim("The mayor committed fraud with the contract.", docs=(1,)),
           "uncited": claim("The invoice total is $9,999.", docs=())}
    return c, cid, ids


class T(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory(); self.root = Path(self.d.name) / "desk"
        self.conn, self.cid, self.ids = seed(self.root)
        self.out = Path(self.d.name) / "site"
        self.r = P.build(self.root, self.out, domain="example.org")
        self.html = (self.out / "demo-case" / "index.html").read_text()
    def tearDown(self): self.d.cleanup()

    def test_gated_claims_published_others_absent(self):
        self.assertIn("4 members present", self.html)
        self.assertNotIn("invoice total", self.html)          # uncited -> held
        self.assertNotIn("committed fraud", self.html)        # accusatory -> held
        self.assertIn("accusatory wording (fraud)", self.html)

    def test_withheld_text_not_in_findings_json(self):
        fj = (self.out / "demo-case" / "findings.json").read_text()
        self.assertNotIn("committed fraud", fj); self.assertNotIn("9,999", fj)
        self.assertTrue(json.loads(fj)["_withheld"])

    def test_everything_escaped(self):
        self.assertNotIn(XSS, self.html)
        self.assertIn("&lt;script&gt;", self.html)

    def test_single_source_flagged_and_two_source_counted(self):
        self.assertIn("Independent custodians: 2", self.html)
        self.assertIn("single-source", self.html)

    def test_subdomain_ready(self):
        self.assertEqual((self.out / "demo-case" / "CNAME").read_text().strip(), "demo-case.example.org")
        routes = json.loads((self.out / "routes.json").read_text())
        self.assertEqual(routes["sites"][0]["host"], "demo-case.example.org")
        self.assertNotIn('src="http', self.html); self.assertNotIn("<script", self.html.replace(XSS, ""))

    def test_no_external_requests_and_csp(self):
        self.assertIn("Content-Security-Policy", self.html)
        self.assertIn("default-src 'none'", self.html)

    def test_bad_domain_and_slug_rejected(self):
        with self.assertRaises(ValueError): P.build(self.root, self.out, domain="bad domain")
        self.conn.execute("INSERT INTO cases (slug,title) VALUES ('Bad_Slug','x')")
        with self.assertRaises(ValueError): P.build(self.root, self.out)

    def test_denominators_computed_and_validated(self):
        p = self.root / "publish" / "demo-case"; p.mkdir(parents=True)
        (p / "denominators.json").write_text(json.dumps([
            {"label": "Requests per 1,000 residents", "numerator": 50, "denominator": 25000, "source": "Census ACS 2023"},
            {"label": "no source", "numerator": 1, "denominator": 2},
            {"label": "zero", "numerator": 1, "denominator": 0, "source": "x"}]))
        P.build(self.root, self.out)
        h = (self.out / "demo-case" / "index.html").read_text()
        self.assertIn("0.002", h); self.assertIn("Census ACS 2023", h)
        self.assertIn("a guess", h); self.assertIn("denominator must be", h)

    def test_leads_noindex_and_never_in_index(self):
        P.build(self.root, self.out, with_leads=True)
        lh = (self.out / "leads" / "gahanna-tirc-quorum" / "index.html").read_text()
        self.assertIn("noindex", lh); self.assertIn("HYPOTHESIS", lh)
        self.assertNotIn("leads/", (self.out / "index.html").read_text())
        self.assertIn("Disallow: /leads/", (self.out / "robots.txt").read_text())

    def test_unknown_case_rejected(self):
        with self.assertRaises(KeyError): P.build(self.root, self.out, only=["nope"])

    def test_language_flags(self):
        self.assertEqual(P.language_flags("a Fraud and a cover-up"), ["cover-up", "fraud"])
        self.assertEqual(P.language_flags("The minutes record 4 members."), [])


if __name__ == "__main__":
    unittest.main()
