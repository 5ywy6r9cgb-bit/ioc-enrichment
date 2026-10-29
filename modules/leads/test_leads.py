#!/usr/bin/env python3
import copy, os, sys, unittest
sys.path.insert(0, os.path.dirname(__file__))
import leads as L


class T(unittest.TestCase):
    def setUp(self):
        self.cards = L.load()

    def test_shipped_cards_validate(self):
        self.assertEqual(L.validate(self.cards), [])

    def test_five_cards_and_none_documented(self):
        self.assertEqual(len(self.cards), 5)
        self.assertTrue(all(c["status"] == "HYPOTHESIS" for c in self.cards))

    def test_card_without_kill_condition_rejected(self):
        c = copy.deepcopy(self.cards[0]); c["kill_condition"] = ""
        self.assertTrue(any("kill_condition" in e for e in L.validate([c])))

    def test_card_without_innocent_explanation_rejected(self):
        c = copy.deepcopy(self.cards[0]); del c["innocent_explanation"]
        self.assertTrue(L.validate([c]))

    def test_cannot_mark_documented_without_ingested_documents(self):
        c = copy.deepcopy(self.cards[0]); c["status"] = "DOCUMENTED"
        self.assertTrue(any("documents_ingested" in e for e in L.validate([c])))

    def test_bad_status_and_duplicate_ids(self):
        c = copy.deepcopy(self.cards[0]); c["status"] = "PROVEN"
        self.assertTrue(L.validate([c, copy.deepcopy(self.cards[0])]))

    def test_request_is_a_draft_and_neutral(self):
        d = L.request_draft(self.cards[0])
        self.assertIn("DRAFT ONLY", d)
        for word in ("corrupt", "illegal", "fraud", "cover"):
            self.assertNotIn(word, d.lower())

    def test_gahanna_basis_says_memo_not_read(self):
        c = [x for x in self.cards if x["id"] == "gahanna-tirc-quorum"][0]
        self.assertIn("NOT been ingested", c["basis"])

    def test_statute_numbers_are_not_cited_from_memory(self):
        import re
        for c in self.cards:
            for s in c.get("statutes_to_verify") or []:
                self.assertIsNone(re.search(r"\d{4}\.\d+", s), c["id"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
