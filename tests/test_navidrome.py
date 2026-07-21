"""Tests for pipeline.navidrome — pure Subsonic helpers (no network).

The HTTP path (Subsonic._request) is covered by a live read-only smoke test
against the homelab, not by mocks.
"""

import hashlib
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from pipeline import navidrome as nd  # noqa: E402


class Token(unittest.TestCase):
    def test_token_is_md5_password_plus_salt(self):
        expected = hashlib.md5(b"sesamec19b2d").hexdigest()
        self.assertEqual(nd.subsonic_token("sesame", "c19b2d"), expected)

    def test_salt_changes_token(self):
        self.assertNotEqual(
            nd.subsonic_token("pw", "aaaa"), nd.subsonic_token("pw", "bbbb"))


class AuthParams(unittest.TestCase):
    def test_shape(self):
        p = nd.auth_params("david", "pw", "salt123", client="c", version="1.16.1")
        self.assertEqual(p["u"], "david")
        self.assertEqual(p["s"], "salt123")
        self.assertEqual(p["f"], "json")
        self.assertEqual(p["c"], "c")
        self.assertEqual(p["v"], "1.16.1")
        self.assertEqual(p["t"], nd.subsonic_token("pw", "salt123"))


class CheckResponse(unittest.TestCase):
    def test_ok_returns_inner(self):
        inner = {"status": "ok", "version": "1.16.1", "searchResult3": {}}
        self.assertIs(nd.check_response({"subsonic-response": inner}), inner)

    def test_failed_raises_with_code(self):
        payload = {"subsonic-response": {
            "status": "failed", "error": {"code": 40, "message": "Wrong username or password"}}}
        with self.assertRaises(nd.SubsonicError) as cm:
            nd.check_response(payload)
        self.assertIn("40", str(cm.exception))

    def test_missing_envelope_raises(self):
        with self.assertRaises(nd.SubsonicError):
            nd.check_response({"something-else": {}})


class AsList(unittest.TestCase):
    def test_none(self):
        self.assertEqual(nd.as_list(None), [])

    def test_single_object_wrapped(self):
        self.assertEqual(nd.as_list({"id": "1"}), [{"id": "1"}])

    def test_list_passthrough(self):
        self.assertEqual(nd.as_list([1, 2]), [1, 2])


class MatchAlbum(unittest.TestCase):
    ALBUMS = [
        {"id": "a1", "name": "Punisher", "artist": "Phoebe Bridgers"},
        {"id": "a2", "name": "Punisher", "artist": "Tribute Band"},
    ]

    def test_case_insensitive_name(self):
        self.assertEqual(nd.match_album(self.ALBUMS, "punisher")["id"], "a1")

    def test_artist_disambiguates(self):
        self.assertEqual(
            nd.match_album(self.ALBUMS, "Punisher", "Tribute Band")["id"], "a2")

    def test_no_match_returns_none(self):
        self.assertIsNone(nd.match_album(self.ALBUMS, "Nonesuch"))


class SongsAndMatch(unittest.TestCase):
    def test_songs_of_album_single_collapsed(self):
        album = {"song": {"id": "s1", "title": "Kyoto"}}
        self.assertEqual(nd.songs_of_album(album), [{"id": "s1", "title": "Kyoto"}])

    def test_songs_of_album_missing(self):
        self.assertEqual(nd.songs_of_album({}), [])

    def test_match_song_by_title_album_artist(self):
        songs = [
            {"id": "s1", "title": "Kyoto", "album": "Punisher", "artist": "Phoebe Bridgers"},
            {"id": "s2", "title": "Kyoto", "album": "Other", "artist": "Someone"},
        ]
        hit = nd.match_song(songs, "kyoto", album="Punisher", artist="Phoebe Bridgers")
        self.assertEqual(hit["id"], "s1")

    def test_match_song_no_match(self):
        self.assertIsNone(nd.match_song([], "Kyoto"))


class DotEnv(unittest.TestCase):
    def test_missing_file_is_noop(self):
        nd.load_dotenv("/nonexistent/path/.env")  # must not raise


if __name__ == "__main__":
    unittest.main()
