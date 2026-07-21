"""Subsonic client for Navidrome — resolve album/track IDs, scan, build playlists.

Covers the publish half of the pipeline (flow step 7b). Uses only the stdlib
(urllib), so it needs no venv. The auth, envelope-checking, and matching logic
are split out as pure functions so they unit-test without touching the network;
``Subsonic`` is the thin HTTP wrapper around them.

Credentials come from the environment (NAVIDROME_URL/USER/PASS; see .env.example).
Read-only in normal use here — the shared `david` account must never be rotated
from this repo (it fans out to SUB/WAVE + Homepage; see the vault note).
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CLIENT = "subwave-docs"
API_VERSION = "1.16.1"


class SubsonicError(Exception):
    pass


# --- pure helpers (no network; directly unit-tested) -------------------------

def subsonic_token(password: str, salt: str) -> str:
    """Subsonic token auth: md5(password + salt)."""
    return hashlib.md5((password + salt).encode("utf-8")).hexdigest()


def auth_params(user: str, password: str, salt: str,
                client: str = DEFAULT_CLIENT, version: str = API_VERSION) -> dict:
    return {
        "u": user,
        "t": subsonic_token(password, salt),
        "s": salt,
        "v": version,
        "c": client,
        "f": "json",
    }


def check_response(payload: dict) -> dict:
    """Unwrap the ``subsonic-response`` envelope, raising on a failed status."""
    resp = payload.get("subsonic-response")
    if resp is None:
        raise SubsonicError("malformed response: no 'subsonic-response' envelope")
    if resp.get("status") == "failed":
        err = resp.get("error", {})
        raise SubsonicError(f"Subsonic error {err.get('code')}: {err.get('message')}")
    return resp


def as_list(x) -> list:
    """Subsonic JSON collapses single-element arrays to a bare object."""
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def match_album(albums: list, album: str, artist: str | None = None) -> dict | None:
    for a in albums:
        if a.get("name", "").lower() == album.lower() and (
            artist is None or a.get("artist", "").lower() == artist.lower()
        ):
            return a
    return None


def songs_of_album(album_obj: dict) -> list:
    return as_list(album_obj.get("song"))


def match_song(songs: list, title: str,
               album: str | None = None, artist: str | None = None) -> dict | None:
    for s in songs:
        if (s.get("title", "").lower() == title.lower()
                and (album is None or s.get("album", "").lower() == album.lower())
                and (artist is None or s.get("artist", "").lower() == artist.lower())):
            return s
    return None


# --- minimal .env loader (avoids a python-dotenv dependency) -----------------

def load_dotenv(path: str | Path) -> None:
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip())


# --- client ------------------------------------------------------------------

@dataclass
class Subsonic:
    base_url: str
    user: str
    password: str
    client: str = DEFAULT_CLIENT
    version: str = API_VERSION
    timeout: int = 15

    def _request(self, method: str, **params) -> dict:
        salt = secrets.token_hex(8)
        query = {**auth_params(self.user, self.password, salt, self.client, self.version),
                 **params}
        url = (f"{self.base_url.rstrip('/')}/rest/{method}.view?"
               + urllib.parse.urlencode(query, doseq=True))
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as r:
                payload = json.loads(r.read().decode("utf-8"))
        except urllib.error.URLError as e:
            raise SubsonicError(f"HTTP error calling {method}: {e}") from e
        return check_response(payload)

    # read
    def ping(self) -> dict:
        return self._request("ping")

    def search3(self, query: str, album_count: int = 20,
                song_count: int = 30, artist_count: int = 0) -> dict:
        r = self._request("search3", query=query, albumCount=album_count,
                          songCount=song_count, artistCount=artist_count)
        return r.get("searchResult3", {})

    def find_album(self, album: str, artist: str | None = None) -> dict | None:
        res = self.search3(album, album_count=50)
        return match_album(as_list(res.get("album")), album, artist)

    def get_album(self, album_id: str) -> dict:
        return self._request("getAlbum", id=album_id).get("album", {})

    def find_song(self, title: str, album: str | None = None,
                  artist: str | None = None) -> dict | None:
        res = self.search3(title, song_count=50)
        return match_song(as_list(res.get("song")), title, album, artist)

    def scan_status(self) -> dict:
        return self._request("getScanStatus").get("scanStatus", {})

    def get_playlists(self) -> list:
        return as_list(self._request("getPlaylists").get("playlists", {}).get("playlist"))

    # write (used only by the prompted playlist-build step)
    def start_scan(self, full: bool = False) -> dict:
        params = {"fullScan": "true"} if full else {}
        return self._request("startScan", **params).get("scanStatus", {})

    def create_playlist(self, name: str, song_ids: list[str]) -> dict:
        # Navidrome preserves the submitted songId order.
        return self._request("createPlaylist", name=name, songId=list(song_ids)).get("playlist", {})


def client_from_env(dotenv: str | Path | None = None) -> Subsonic:
    if dotenv:
        load_dotenv(dotenv)
    url = os.environ.get("NAVIDROME_URL")
    user = os.environ.get("NAVIDROME_USER")
    pw = os.environ.get("NAVIDROME_PASS")
    if not (url and user and pw):
        raise SubsonicError("NAVIDROME_URL / NAVIDROME_USER / NAVIDROME_PASS not set (see .env.example)")
    return Subsonic(url, user, pw)


# --- cli (read-only smoke commands; run against the live homelab) ------------

def run_cli(args) -> int:
    repo_root = Path(__file__).resolve().parent.parent
    client = client_from_env(dotenv=repo_root / ".env")
    cmd = args.navidrome_cmd
    if cmd == "ping":
        client.ping()
        print("ok — Navidrome reachable and auth valid")
    elif cmd == "find-album":
        a = client.find_album(args.album, args.artist)
        if not a:
            print("album not found")
            return 1
        print(f"{a['name']} — {a.get('artist')}  id={a['id']}  songs={a.get('songCount')}")
    elif cmd == "album-songs":
        for s in songs_of_album(client.get_album(args.id)):
            print(f"  {int(s.get('track', 0)):>2}. {s.get('title')}  id={s['id']}")
    elif cmd == "scan-status":
        print(client.scan_status())
    return 0
