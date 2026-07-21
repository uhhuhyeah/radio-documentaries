import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as nd from "./navidrome";

describe("subsonicToken", () => {
  it("is md5(password + salt)", () => {
    const expected = createHash("md5").update("sesamec19b2d").digest("hex");
    expect(nd.subsonicToken("sesame", "c19b2d")).toBe(expected);
  });

  it("changes with the salt", () => {
    expect(nd.subsonicToken("pw", "aaaa")).not.toBe(nd.subsonicToken("pw", "bbbb"));
  });
});

describe("authParams", () => {
  it("has the expected shape", () => {
    const p = nd.authParams("david", "pw", "salt123", "c", "1.16.1");
    expect(p.u).toBe("david");
    expect(p.s).toBe("salt123");
    expect(p.f).toBe("json");
    expect(p.c).toBe("c");
    expect(p.v).toBe("1.16.1");
    expect(p.t).toBe(nd.subsonicToken("pw", "salt123"));
  });
});

describe("checkResponse", () => {
  it("returns the inner object on ok", () => {
    const inner = { status: "ok", version: "1.16.1", searchResult3: {} };
    expect(nd.checkResponse({ "subsonic-response": inner })).toBe(inner);
  });

  it("throws with the code on failed", () => {
    const payload = { "subsonic-response": { status: "failed", error: { code: 40, message: "Wrong username or password" } } };
    expect(() => nd.checkResponse(payload)).toThrow(/40/);
  });

  it("throws on a missing envelope", () => {
    expect(() => nd.checkResponse({ "something-else": {} })).toThrow(nd.SubsonicError);
  });
});

describe("asList", () => {
  it("wraps a single object", () => expect(nd.asList({ id: "1" })).toEqual([{ id: "1" }]));
  it("passes a list through", () => expect(nd.asList([1, 2])).toEqual([1, 2]));
  it("maps nullish to empty", () => {
    expect(nd.asList(null)).toEqual([]);
    expect(nd.asList(undefined)).toEqual([]);
  });
});

describe("matchAlbum", () => {
  const albums: nd.Album[] = [
    { id: "a1", name: "Punisher", artist: "Phoebe Bridgers" },
    { id: "a2", name: "Punisher", artist: "Tribute Band" },
  ];
  it("case-insensitive name", () => expect(nd.matchAlbum(albums, "punisher")!.id).toBe("a1"));
  it("artist disambiguates", () => expect(nd.matchAlbum(albums, "Punisher", "Tribute Band")!.id).toBe("a2"));
  it("no match returns null", () => expect(nd.matchAlbum(albums, "Nonesuch")).toBeNull());
});

describe("songs + match", () => {
  it("songsOfAlbum collapses a single song", () => {
    expect(nd.songsOfAlbum({ song: { id: "s1", title: "Kyoto" } })).toEqual([{ id: "s1", title: "Kyoto" }]);
  });
  it("songsOfAlbum handles missing", () => expect(nd.songsOfAlbum({})).toEqual([]));
  it("matchSong by title/album/artist", () => {
    const songs: nd.Song[] = [
      { id: "s1", title: "Kyoto", album: "Punisher", artist: "Phoebe Bridgers" },
      { id: "s2", title: "Kyoto", album: "Other", artist: "Someone" },
    ];
    expect(nd.matchSong(songs, "kyoto", "Punisher", "Phoebe Bridgers")!.id).toBe("s1");
  });
  it("matchSong no match", () => expect(nd.matchSong([], "Kyoto")).toBeNull());
});

describe("loadDotenv", () => {
  it("is a no-op for a missing file", () => {
    expect(() => nd.loadDotenv("/nonexistent/path/.env")).not.toThrow();
  });
});
