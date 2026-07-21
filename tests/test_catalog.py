"""Tests for pipeline.catalog — reading and mutating seasons.md.

Uses real temp files (no mocks). The sample deliberately includes a *fenced*
illustrative table whose heading collides with a real season, to guard the
fence-masking bug found during manual testing.
"""

import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from pipeline import catalog  # noqa: E402

SAMPLE = """# SUB/WAVE Documentaries — Catalog

**Active season: 2**

Some prose paragraph that must be preserved verbatim.

Format reference (illustrative — not live episodes):

```
## Season 1 — <optional theme>

| Ep | Album | Artist | Host | Status | Dir | Published |
| -- | ----- | ------ | ---- | ------ | --- | --------- |
| 01 | Fake | Nobody | Cara | published | S01E01-fake | 2020-01-01 |
| 02 | Fake2 | Nobody | Cara | planned | — | — |
```

## Season 1

| Ep | Album | Artist | Host | Status | Dir | Published |
| -- | ----- | ------ | ---- | ------ | --- | --------- |
| *(no episodes yet — the first production becomes Ep 01)* | | | | | | |

## Season 2

| Ep | Album | Artist | Host | Status | Dir | Published |
| -- | ----- | ------ | ---- | ------ | --- | --------- |
| 01 | Real One | Someone | Jools | published | S02E01-real-one | 2026-01-01 |
"""


def tmp_catalog(content=SAMPLE):
    fd, path = tempfile.mkstemp(suffix=".md")
    os.close(fd)
    pathlib.Path(path).write_text(content, encoding="utf-8")
    return path


class Slug(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(catalog.slug("In Rainbows"), "in-rainbows")

    def test_punctuation_and_case(self):
        self.assertEqual(catalog.slug("OK Computer!!!"), "ok-computer")

    def test_empty_falls_back(self):
        self.assertEqual(catalog.slug("   "), "untitled")


class Read(unittest.TestCase):
    def setUp(self):
        self.p = tmp_catalog()
        self.text = catalog.read(self.p)

    def tearDown(self):
        os.unlink(self.p)

    def test_active_season(self):
        self.assertEqual(catalog.active_season(self.text), 2)

    def test_fenced_example_ignored_for_season1(self):
        # Real Season 1 is empty; the fenced example's rows must not count.
        self.assertEqual(catalog.next_episode(self.text, 1), 1)
        self.assertEqual(catalog.rows_for_season(self.text, 1), [])

    def test_next_episode_season2(self):
        self.assertEqual(catalog.next_episode(self.text, 2), 2)

    def test_rows_for_season2(self):
        rows = catalog.rows_for_season(self.text, 2)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].album, "Real One")
        self.assertEqual(rows[0].ep, 1)
        self.assertEqual(rows[0].status, "published")

    def test_missing_season_raises(self):
        with self.assertRaises(catalog.CatalogError):
            catalog.rows_for_season(self.text, 9)


class AssignAppend(unittest.TestCase):
    def setUp(self):
        self.p = tmp_catalog()

    def tearDown(self):
        os.unlink(self.p)

    def test_append_replaces_placeholder(self):
        res = catalog.assign("In Rainbows", "Radiohead", "Cara", 1, self.p)
        self.assertEqual(res["action"], "appended")
        self.assertEqual(res["episode"], 1)
        self.assertEqual(res["dir"], "S01E01-in-rainbows")
        rows = catalog.rows_for_season(catalog.read(self.p), 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].status, "in-production")
        self.assertEqual(rows[0].host, "Cara")

    def test_second_append_increments(self):
        catalog.assign("A", "B", "Cara", 1, self.p)
        res = catalog.assign("C", "D", "Jools", 1, self.p)
        self.assertEqual(res["episode"], 2)
        self.assertEqual(len(catalog.rows_for_season(catalog.read(self.p), 1)), 2)

    def test_default_season_is_active(self):
        res = catalog.assign("X", "Y", "Cara", path=self.p)  # active season == 2
        self.assertEqual(res["season"], 2)
        self.assertEqual(res["episode"], 2)  # season 2 already had E01


class AssignClaim(unittest.TestCase):
    def setUp(self):
        self.p = tmp_catalog()

    def tearDown(self):
        os.unlink(self.p)

    def test_claim_planned_row(self):
        catalog.assign("Blonde", "Frank Ocean", "Cara", 2, self.p)  # appends E02
        catalog.set_status(2, 2, "planned", path=self.p)            # mark planned
        res = catalog.assign("blonde", "FRANK OCEAN", "Jools", 2, self.p)  # claim
        self.assertEqual(res["action"], "claimed")
        self.assertEqual(res["episode"], 2)
        rows = catalog.rows_for_season(catalog.read(self.p), 2)
        blonde = [r for r in rows if r.album.lower() == "blonde"]
        self.assertEqual(len(blonde), 1)          # no duplicate appended
        self.assertEqual(blonde[0].host, "Jools")  # trigger host overrides
        self.assertEqual(blonde[0].status, "in-production")
        self.assertEqual(blonde[0].dir, "S02E02-blonde")


class SetStatus(unittest.TestCase):
    def setUp(self):
        self.p = tmp_catalog()

    def tearDown(self):
        os.unlink(self.p)

    def test_status_and_published(self):
        catalog.set_status(2, 1, "published", "2026-07-20", self.p)
        row = catalog.rows_for_season(catalog.read(self.p), 2)[0]
        self.assertEqual(row.status, "published")
        self.assertEqual(row.published, "2026-07-20")

    def test_missing_episode_raises(self):
        with self.assertRaises(catalog.CatalogError):
            catalog.set_status(2, 99, "published", path=self.p)


class ProsePreserved(unittest.TestCase):
    def setUp(self):
        self.p = tmp_catalog()

    def tearDown(self):
        os.unlink(self.p)

    def test_mutation_leaves_prose_and_fence_intact(self):
        catalog.assign("In Rainbows", "Radiohead", "Cara", 1, self.p)
        after = catalog.read(self.p)
        self.assertIn("Some prose paragraph that must be preserved verbatim.", after)
        self.assertIn("Active season: 2", after)
        self.assertIn("## Season 1 — <optional theme>", after)   # fenced example heading
        self.assertIn("| 01 | Fake | Nobody", after)             # fenced example row
        # The real Season 1 placeholder is gone, replaced by the new episode.
        real_s1 = after.split("## Season 1\n", 1)[1].split("## Season 2", 1)[0]
        self.assertNotIn("no episodes yet", real_s1)
        self.assertIn("In Rainbows", real_s1)


if __name__ == "__main__":
    unittest.main()
