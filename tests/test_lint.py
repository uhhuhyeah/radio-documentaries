"""Tests for pipeline.lint — the script-format.md contract gate."""

import contextlib
import io
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from pipeline import lint  # noqa: E402

FIX = pathlib.Path(__file__).resolve().parent / "fixtures"


def errors(findings):
    return [f for f in findings if f.level == "ERROR"]


def has(findings, level, substr):
    return any(f.level == level and substr in f.msg for f in findings)


# A minimal otherwise-valid script; individual tests mutate one thing.
def script(front="", slots=None):
    fm = front or (
        'season: 1\nepisode: 1\nalbum: "A"\nartist: "B"\n'
        "host: p_jools\nhost_name: \"Jools\"\nmodel: eleven_flash_v2_5\n"
        "target_minutes: 25\nreference_tracks: 1\n"
    )
    body = slots or (
        "## [01] SPOKEN · intro\nSome words here to fill the spoken body nicely.\n"
        '## [02] SONG · song-1\n- title: "X"\n- artist: "Y"\n- album: "Z"\n'
    )
    return f"---\n{fm}---\n\n{body}"


class Clean(unittest.TestCase):
    def test_clean_fixture_has_no_errors(self):
        findings = lint.lint_file(FIX / "clean_script.md")
        self.assertEqual(errors(findings), [], msg=str([str(f) for f in findings]))


class BrokenFixture(unittest.TestCase):
    def setUp(self):
        self.f = lint.lint_file(FIX / "broken_script.md")

    def test_malformed_heading(self):
        self.assertTrue(has(self.f, "ERROR", "malformed slot heading"))

    def test_missing_required_key(self):
        self.assertTrue(has(self.f, "ERROR", "missing required key: artist"))

    def test_invalid_host(self):
        self.assertTrue(has(self.f, "ERROR", "not a documentary persona"))

    def test_noncontiguous_indices(self):
        self.assertTrue(has(self.f, "ERROR", "contiguous"))

    def test_song_missing_title(self):
        self.assertTrue(has(self.f, "ERROR", "missing 'title'"))

    def test_empty_spoken_body(self):
        self.assertTrue(has(self.f, "ERROR", "SPOKEN body is empty"))

    def test_reference_tracks_mismatch(self):
        self.assertTrue(has(self.f, "ERROR", "reference_tracks"))


class IndividualRules(unittest.TestCase):
    def test_host_name_mismatch_warns_not_errors(self):
        f = lint.lint_text(script(front=(
            'season: 1\nepisode: 1\nalbum: "A"\nartist: "B"\n'
            'host: p_jools\nhost_name: "Wrong"\nmodel: eleven_flash_v2_5\n'
            "target_minutes: 25\nreference_tracks: 1\n"
        )))
        self.assertTrue(has(f, "WARN", "host_name"))
        self.assertEqual(errors(f), [])

    def test_unknown_model_warns(self):
        f = lint.lint_text(script(front=(
            'season: 1\nepisode: 1\nalbum: "A"\nartist: "B"\n'
            'host: p_jools\nhost_name: "Jools"\nmodel: eleven_bogus_v9\n'
            "target_minutes: 25\nreference_tracks: 1\n"
        )))
        self.assertTrue(has(f, "WARN", "not in known set"))

    def test_first_slot_song_warns(self):
        f = lint.lint_text(script(slots=(
            '## [01] SONG · song-1\n- title: "X"\n- artist: "Y"\n- album: "Z"\n'
            "## [02] SPOKEN · outro\nSome closing words for the body.\n"
        )))
        self.assertTrue(has(f, "WARN", "first slot is not SPOKEN"))

    def test_non_kebab_label_warns(self):
        f = lint.lint_text(script(slots=(
            "## [01] SPOKEN · Intro_One\nSome words here.\n"
            '## [02] SONG · song-1\n- title: "X"\n- artist: "Y"\n- album: "Z"\n'
        )))
        self.assertTrue(has(f, "WARN", "kebab-case"))

    def test_song_missing_optional_album_warns(self):
        f = lint.lint_text(script(slots=(
            "## [01] SPOKEN · intro\nSome words here for the body.\n"
            '## [02] SONG · song-1\n- title: "X"\n- artist: "Y"\n'
        )))
        self.assertTrue(has(f, "WARN", "missing 'album'"))
        self.assertFalse(has(f, "ERROR", "missing 'title'"))

    def test_clean_minimal_script_passes(self):
        self.assertEqual(errors(lint.lint_text(script())), [])


class CliExit(unittest.TestCase):
    def _run(self, path):
        with contextlib.redirect_stdout(io.StringIO()):
            return lint.run_cli(path)

    def test_clean_returns_zero(self):
        self.assertEqual(self._run(str(FIX / "clean_script.md")), 0)

    def test_broken_returns_one(self):
        self.assertEqual(self._run(str(FIX / "broken_script.md")), 1)


if __name__ == "__main__":
    unittest.main()
