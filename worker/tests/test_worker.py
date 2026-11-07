import unittest
from unittest.mock import patch
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import argus_supply as worker


class FdaTests(unittest.TestCase):
    def test_normalization_is_replay_stable(self):
        row = {"package_ndc": "1234-5678-90", "generic_name": "Drug A",
               "company_name": "Maker", "presentation": "Vial", "status": "Current"}
        first = worker.normalize_fda(row)
        self.assertEqual(first, worker.normalize_fda(dict(row)))
        self.assertEqual(len(first["key"]), 24)
        self.assertEqual(first["packageNdc"], "1234-5678-90")

    def test_full_feed_must_complete_before_import(self):
        first = {"meta": {"last_updated": "2026-11-06", "results": {"total": 2}},
                 "results": [{"generic_name": "A", "status": "Current"}]}
        with patch.object(worker, "fda_get", side_effect=[first, {"results": []}]):
            with self.assertRaisesRegex(RuntimeError, "pagination ended"):
                worker.fetch_fda()


class ForecastTests(unittest.TestCase):
    def test_distribution_is_deterministic_and_ordered(self):
        a = worker.days_distribution(35, 5, 10, 7, "site:revision")
        self.assertEqual(a, worker.days_distribution(35, 5, 10, 7, "site:revision"))
        self.assertGreater(a[0], 0)
        self.assertLessEqual(a[1], a[2])
        self.assertLessEqual(a[2], a[3])

    def test_zero_baseline_without_history_is_unknown(self):
        self.assertEqual(worker.days_distribution(100, 0, 0, 0, "x"), (0, 0, 0, 0))


if __name__ == "__main__":
    unittest.main()
