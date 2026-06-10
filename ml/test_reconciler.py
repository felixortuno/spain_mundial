import unittest

from reconciler import canonical_team, reconcile


class ReconcilerTests(unittest.TestCase):
    def test_alias_and_swapped_orientation(self):
        fixtures = [
            {
                "fixture_id": 1,
                "home": "Uruguay",
                "away": "España",
                "kickoff_utc": "2026-06-27T00:00:00Z",
            }
        ]
        events = [
            {
                "event_id": "a1",
                "home_team": "Spain",
                "away_team": "Uruguay",
                "commence_time": "2026-06-27T00:30:00Z",
            }
        ]

        matched, unmatched_fixtures, unmatched_events = reconcile(
            fixtures, events
        )

        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0].method, "alias")
        self.assertEqual(matched[0].orientation, "swapped")
        self.assertEqual(unmatched_fixtures, [])
        self.assertEqual(unmatched_events, [])

    def test_unmatched_are_preserved(self):
        fixtures = [
            {
                "fixture_id": 1,
                "home": "Spain",
                "away": "France",
                "kickoff_utc": "2026-07-10T19:00:00Z",
            }
        ]
        events = [
            {
                "event_id": "a9",
                "home_team": "Portugal",
                "away_team": "Morocco",
                "commence_time": "2026-07-10T19:00:00Z",
            }
        ]

        matched, unmatched_fixtures, unmatched_events = reconcile(
            fixtures, events
        )

        self.assertEqual(matched, [])
        self.assertEqual(len(unmatched_fixtures), 1)
        self.assertEqual(len(unmatched_events), 1)

    def test_known_aliases_share_canonical_name(self):
        self.assertEqual(canonical_team("Arabia Saudí"), "saudi arabia")
        self.assertEqual(canonical_team("Corea del Sur"), "south korea")


if __name__ == "__main__":
    unittest.main()
