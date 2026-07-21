"""Tests for pipeline.scriptmodel — the script.md parser."""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from pipeline import scriptmodel as sm  # noqa: E402

FIX = pathlib.Path(__file__).resolve().parent / "fixtures"


class FrontMatter(unittest.TestCase):
    def test_quoted_string_and_int(self):
        fm = sm.parse_front_matter('album: "Punisher"\nseason: 1\n')
        self.assertEqual(fm["album"], "Punisher")
        self.assertEqual(fm["season"], 1)
        self.assertIsInstance(fm["season"], int)

    def test_inline_comment_stripped_on_unquoted(self):
        fm = sm.parse_front_matter("host: p_jools   # persona id\n")
        self.assertEqual(fm["host"], "p_jools")

    def test_hash_inside_quotes_preserved(self):
        fm = sm.parse_front_matter('album: "Sharp #1"\n')
        self.assertEqual(fm["album"], "Sharp #1")

    def test_negative_int(self):
        self.assertEqual(sm.parse_front_matter("x: -3\n")["x"], -3)


class SplitFrontMatter(unittest.TestCase):
    def test_absent_returns_empty_block(self):
        block, body = sm._split_front_matter("no front matter here")
        self.assertEqual(block, "")
        self.assertEqual(body, "no front matter here")

    def test_unclosed_raises(self):
        with self.assertRaises(sm.ScriptError):
            sm._split_front_matter("---\nkey: val\nno closing line")


class ParseSlots(unittest.TestCase):
    def setUp(self):
        self.ep = sm.load(FIX / "clean_script.md")

    def test_slot_count_and_kinds(self):
        self.assertEqual(len(self.ep.slots), 6)
        self.assertEqual(
            [s.kind for s in self.ep.slots],
            ["SPOKEN", "SPOKEN", "SONG", "SPOKEN", "SONG", "SPOKEN"],
        )

    def test_indices_contiguous(self):
        self.assertEqual([s.index for s in self.ep.slots], [1, 2, 3, 4, 5, 6])

    def test_spoken_body_is_verbatim_and_leaks_no_heading(self):
        intro = self.ep.slots[0]
        self.assertEqual(intro.kind, "SPOKEN")
        self.assertTrue(intro.body.startswith("Some records"))
        self.assertNotIn("##", intro.body)
        self.assertNotIn("[01]", intro.body)

    def test_multiline_spoken_body_preserved(self):
        # part-1 body spans two source lines joined by newline
        part1 = self.ep.slots[1]
        self.assertIn("\n", part1.body)

    def test_song_meta_parsed(self):
        song = self.ep.slots[2]
        self.assertEqual(song.meta["title"], "Kyoto")
        self.assertEqual(song.meta["artist"], "Phoebe Bridgers")
        self.assertEqual(song.meta["album"], "Punisher")
        self.assertEqual(song.body, "")  # SONG slots carry no spoken body

    def test_filename(self):
        s = self.ep.slots[1]  # index 02, label part-1
        self.assertEqual(s.filename(1, 1), "s01e01_02_part-1.mp3")

    def test_partitions(self):
        self.assertEqual(len(self.ep.spoken_slots), 4)
        self.assertEqual(len(self.ep.song_slots), 2)

    def test_front_matter_loaded(self):
        self.assertEqual(self.ep.front_matter["host"], "p_jools")
        self.assertEqual(self.ep.front_matter["reference_tracks"], 2)


class MalformedHeadings(unittest.TestCase):
    def test_detects_typo_heading(self):
        text = "## [01] SPOKEN · ok\nhi\n## [02] SPKOEN · typo\nbad\n"
        found = sm.find_malformed_headings(text)
        self.assertEqual(len(found), 1)
        self.assertIn("SPKOEN", found[0][1])

    def test_clean_script_has_no_malformed(self):
        text = (FIX / "clean_script.md").read_text(encoding="utf-8")
        self.assertEqual(sm.find_malformed_headings(text), [])


if __name__ == "__main__":
    unittest.main()
