"""Tests for pipeline.budget — ElevenLabs credit estimation."""

import contextlib
import io
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from pipeline import budget  # noqa: E402

FIX = pathlib.Path(__file__).resolve().parent / "fixtures"

# Two SPOKEN slots + one SONG. Spoken text totals a known char count.
SPOKEN_A = "abcde fghij"          # 11 chars, 2 words
SPOKEN_B = "one two three"        # 13 chars, 3 words
SAMPLE = (
    "---\nmodel: eleven_flash_v2_5\nreference_tracks: 1\n---\n\n"
    f"## [01] SPOKEN · intro\n{SPOKEN_A}\n"
    '## [02] SONG · song-1\n- title: "X"\n'
    f"## [03] SPOKEN · outro\n{SPOKEN_B}\n"
)
TOTAL_CHARS = len(SPOKEN_A) + len(SPOKEN_B)   # 24
TOTAL_WORDS = 5


class Estimate(unittest.TestCase):
    def setUp(self):
        self.e = budget.estimate_text(SAMPLE)

    def test_counts_only_spoken_chars(self):
        self.assertEqual(self.e.chars, TOTAL_CHARS)

    def test_word_count(self):
        self.assertEqual(self.e.words, TOTAL_WORDS)

    def test_credits_by_model(self):
        self.assertAlmostEqual(self.e.credits_by_model["eleven_flash_v2_5"], TOTAL_CHARS * 0.5)
        self.assertAlmostEqual(self.e.credits_by_model["eleven_multilingual_v2"], TOTAL_CHARS * 1.0)

    def test_chosen_model_credits(self):
        self.assertEqual(self.e.chosen_model, "eleven_flash_v2_5")
        self.assertAlmostEqual(self.e.chosen_credits, TOTAL_CHARS * 0.5)

    def test_song_text_excluded(self):
        # The SONG slot's title "X" would push chars to 25 if songs were billed.
        self.assertEqual(self.e.chars, TOTAL_CHARS)


class ChosenModelUnknown(unittest.TestCase):
    def test_unknown_model_has_no_chosen_credits(self):
        text = SAMPLE.replace("eleven_flash_v2_5", "eleven_bogus")
        e = budget.estimate_text(text)
        self.assertIsNone(e.chosen_credits)


class CapGate(unittest.TestCase):
    def _run(self, cap):
        with contextlib.redirect_stdout(io.StringIO()):
            return budget.run_cli(str(FIX / "clean_script.md"), cap)

    def test_under_cap_returns_zero(self):
        self.assertEqual(self._run(999_999), 0)

    def test_over_cap_returns_two(self):
        self.assertEqual(self._run(1), 2)

    def test_no_cap_returns_zero(self):
        self.assertEqual(self._run(None), 0)


if __name__ == "__main__":
    unittest.main()
